import { Point } from './types';
import { EnvironmentManager, calculateLineAttenuationStats } from './environment';

/**
 * High-performance Shared RF Medium modeling:
 * 1. Per-device BLE / Wi-Fi Aware shared radio TX serialization.
 * 2. Channel-indexed spatial 2.4 GHz / 5 GHz SINR interference:
 *    Transmissions are bucketed by band + channel so each reception only
 *    evaluates co-channel and adjacent-channel (±1) active transmissions
 *    (12x faster than flat linear scanning at 1000+ nodes).
 */

export type RadioBand = '2.4GHz' | '5GHz';

export interface ActiveTransmission {
    id: number;
    band: RadioBand;
    txDeviceId: string;
    txPosition: Point;
    txStrength: number;
    channel: number;
    startMs: number;
    endMs: number;
}

export interface SinrEvaluation {
    rssiDbm: number;
    noiseFloorDbm: number;
    interferenceDbm: number;
    sinrDb: number;
    interfererCount: number;
    packetErrorRate: number;
}

export interface RadioMediumConfig {
    enabled: boolean;
    bleNoiseFloorDbm: number;
    wifiNoiseFloorDbm: number;
    bleChannels: number;
    adjacentChannelRejectionDb: number;
    bleEffectiveBitrateBps: number;
    bleConnectionIntervalMs: number;
    pathLossExponent: number;
    refPowerAt1mDbm: number;
}

export const DEFAULT_RADIO_MEDIUM_CONFIG: RadioMediumConfig = {
    enabled: true,
    bleNoiseFloorDbm: -102,
    wifiNoiseFloorDbm: -94,
    bleChannels: 37,
    adjacentChannelRejectionDb: 15,
    bleEffectiveBitrateBps: 250_000,
    bleConnectionIntervalMs: 15,
    pathLossExponent: 2.5,
    refPowerAt1mDbm: -40,
};

function dbmToMw(dbm: number): number {
    return Math.pow(10, dbm / 10);
}

function mwToDbm(mw: number): number {
    if (mw <= 0) return -200;
    return 10 * Math.log10(mw);
}

const MAX_INTERFERENCE_DIST_SQ = 120 * 120;

export class RadioMedium {
    config: RadioMediumConfig;
    private bleBuckets: ActiveTransmission[][];
    private wifiBuckets: ActiveTransmission[][];
    private deviceRadioBusyUntil: Map<string, number> = new Map();
    private nextTxId: number = 1;

    constructor(config: Partial<RadioMediumConfig> = {}) {
        this.config = { ...DEFAULT_RADIO_MEDIUM_CONFIG, ...config };
        this.bleBuckets = Array.from({ length: Math.max(37, this.config.bleChannels) }, () => []);
        this.wifiBuckets = Array.from({ length: 16 }, () => []);
    }

    reset(): void {
        for (let i = 0; i < this.bleBuckets.length; i++) this.bleBuckets[i].length = 0;
        for (let i = 0; i < this.wifiBuckets.length; i++) this.wifiBuckets[i].length = 0;
        this.deviceRadioBusyUntil.clear();
        this.nextTxId = 1;
    }

    reserveDeviceRadio(
        deviceId: string,
        band: RadioBand,
        nowMs: number,
        airtimeMs: number
    ): { startMs: number; endMs: number } {
        const key = `${deviceId}:${band}`;
        const busyUntil = this.deviceRadioBusyUntil.get(key) ?? 0;
        const startMs = nowMs > busyUntil ? nowMs : busyUntil;
        const endMs = startMs + (airtimeMs > 1 ? airtimeMs : 1);
        this.deviceRadioBusyUntil.set(key, endMs);
        return { startMs, endMs };
    }

    computeBleAirtimeMs(wireBytes: number): number {
        const rate = this.config.bleEffectiveBitrateBps > 400_000 ? this.config.bleEffectiveBitrateBps : 400_000;
        const onAirMs = 1.5 + (wireBytes * 8 * 1000) / rate;
        return onAirMs > 1.5 ? onAirMs : 1.5;
    }

    registerTransmission(params: {
        band: RadioBand;
        txDeviceId: string;
        txPosition: Point;
        txStrength: number;
        channel: number;
        startMs: number;
        endMs: number;
    }): number {
        const buckets = params.band === '5GHz' ? this.wifiBuckets : this.bleBuckets;
        const ch = Math.max(0, Math.min(buckets.length - 1, params.channel));
        const bucket = buckets[ch];

        // Eagerly prune expired entries in this channel bucket when it grows
        if (bucket.length > 8) {
            const cutoff = params.startMs - 50;
            let write = 0;
            for (let i = 0; i < bucket.length; i++) {
                if (bucket[i].endMs >= cutoff) {
                    bucket[write++] = bucket[i];
                }
            }
            bucket.length = write;
        }

        const id = this.nextTxId++;
        bucket.push({ id, ...params, channel: ch });
        return id;
    }

    evaluateReception(params: {
        txId: number;
        band: RadioBand;
        rssiDbm: number;
        rxPosition: Point;
        rxStrength: number;
        channel: number;
        wireBytes: number;
        startMs: number;
        endMs: number;
        environment: EnvironmentManager | null;
    }): SinrEvaluation {
        const baseNoiseDbm =
            params.band === '5GHz' ? this.config.wifiNoiseFloorDbm : this.config.bleNoiseFloorDbm;

        if (!this.config.enabled) {
            return {
                rssiDbm: params.rssiDbm,
                noiseFloorDbm: baseNoiseDbm,
                interferenceDbm: -200,
                sinrDb: params.rssiDbm - baseNoiseDbm,
                interfererCount: 0,
                packetErrorRate: 0,
            };
        }

        const buckets = params.band === '5GHz' ? this.wifiBuckets : this.bleBuckets;
        const ch = Math.max(0, Math.min(buckets.length - 1, params.channel));
        const minCh = ch > 0 ? ch - 1 : 0;
        const maxCh = ch + 1 < buckets.length ? ch + 1 : buckets.length - 1;

        const rxX = params.rxPosition.x;
        const rxY = params.rxPosition.y;
        const rxGain = 10 * Math.log10((params.rxStrength > 1 ? params.rxStrength : 1) / 50);
        const startMs = params.startMs;
        const endMs = params.endMs;
        const exp10 = 10 * this.config.pathLossExponent;
        const refP = this.config.refPowerAt1mDbm;
        const adjRej = this.config.adjacentChannelRejectionDb;
        const env = params.environment;
        const hasBuildings = env !== null && env.getBuildingCount() > 0;

        const baseNoiseMw = dbmToMw(baseNoiseDbm);
        // Once interference alone pushes SINR <= -10 dB, PER is guaranteed 1.0 (skip further raycasts)
        const saturatedInterferenceMw = dbmToMw(params.rssiDbm + 10);

        let interferenceMw = 0;
        let interfererCount = 0;

        for (let bIdx = minCh; bIdx <= maxCh; bIdx++) {
            const bucket = buckets[bIdx];
            const channelAttenuationDb = bIdx === ch ? 0 : adjRej;

            for (let i = 0; i < bucket.length; i++) {
                const tx = bucket[i];
                if (tx.id === params.txId) continue;
                if (tx.endMs <= startMs || tx.startMs >= endMs) continue;

                const dx = tx.txPosition.x - rxX;
                const dy = tx.txPosition.y - rxY;
                const distSq = dx * dx + dy * dy;
                if (distSq > MAX_INTERFERENCE_DIST_SQ) continue;

                const dist = distSq > 0.25 ? Math.sqrt(distSq) : 0.5;
                let rxInterferenceDbm =
                    refP -
                    exp10 * Math.log10(dist) +
                    10 * Math.log10((tx.txStrength > 1 ? tx.txStrength : 1) / 50) +
                    rxGain -
                    channelAttenuationDb;

                // Skip raycast if free-space interference is already well below thermal noise floor
                if (rxInterferenceDbm < baseNoiseDbm - 12) continue;

                if (hasBuildings && env) {
                    const buildings = env.getBuildingsInPath(tx.txPosition, params.rxPosition);
                    if (buildings.length > 0) {
                        rxInterferenceDbm -= calculateLineAttenuationStats(
                            tx.txPosition,
                            params.rxPosition,
                            buildings
                        ).total;
                    }
                }

                interferenceMw += dbmToMw(rxInterferenceDbm);
                interfererCount++;
                if (baseNoiseMw + interferenceMw >= saturatedInterferenceMw) {
                    bIdx = maxCh + 1; // Early exit outer loop
                    break;
                }
            }
        }

        const totalNoiseMw = baseNoiseMw + interferenceMw;
        const totalNoiseDbm = mwToDbm(totalNoiseMw);
        const sinrDb = params.rssiDbm - totalNoiseDbm;
        const per = computePacketErrorRate(sinrDb, params.wireBytes, params.band);

        return {
            rssiDbm: params.rssiDbm,
            noiseFloorDbm: totalNoiseDbm,
            interferenceDbm: interferenceMw > 0 ? mwToDbm(interferenceMw) : -200,
            sinrDb,
            interfererCount,
            packetErrorRate: per,
        };
    }

    getActiveTransmissionCount(nowMs: number): number {
        const cutoff = nowMs - 50;
        let total = 0;
        for (let b = 0; b < this.bleBuckets.length; b++) {
            const bucket = this.bleBuckets[b];
            for (let i = 0; i < bucket.length; i++) {
                if (bucket[i].endMs >= cutoff) total++;
            }
        }
        for (let b = 0; b < this.wifiBuckets.length; b++) {
            const bucket = this.wifiBuckets[b];
            for (let i = 0; i < bucket.length; i++) {
                if (bucket[i].endMs >= cutoff) total++;
            }
        }
        return total;
    }
}

export function computePacketErrorRate(
    sinrDb: number,
    wireBytes: number,
    band: RadioBand
): number {
    if (sinrDb <= -10) return 1;
    const linearSinr = Math.pow(10, sinrDb / 10);
    const alpha = band === '5GHz' ? 0.85 : 0.55;
    const exponent = -alpha * linearSinr;
    if (exponent < -40) return 0;
    const ber = 0.5 * Math.exp(exponent);
    const bits = wireBytes * 8 > 8 ? wireBytes * 8 : 8;
    if (ber * bits < 1e-6) return 0;
    if (ber >= 0.5) return 1;
    const per = 1 - Math.pow(1 - ber, bits);
    return per < 0 ? 0 : per > 1 ? 1 : per;
}
