import { Point } from './types';
import { EnvironmentManager, calculateLineAttenuationStats } from './environment';

/**
 * Shared RF Medium modeling:
 * 1. Per-device BLE radio serialization (a device shares one 2.4 GHz radio
 *    across all its active GATT links).
 * 2. Spatial 2.4 GHz / 5 GHz SINR interference: concurrent active transmissions
 *    nearby raise the effective noise floor at receivers, increasing packet
 *    error rate (PER) in dense crowds.
 *
 * BLE uses 37 data channels with adaptive frequency hopping, so co-channel
 * collision probability between two uncoordinated piconets is ~1/37 (plus
 * slight adjacent-channel leakage).
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
    /** Enable spatial RF interference & SNR-based packet loss (default: true). */
    enabled: boolean;
    /** Thermal noise floor for 1 MHz BLE receiver in dBm (default: -102 dBm). */
    bleNoiseFloorDbm: number;
    /** Thermal noise floor for 20 MHz 5 GHz Wi-Fi Aware receiver in dBm (default: -94 dBm). */
    wifiNoiseFloorDbm: number;
    /** Number of BLE data channels for AFH collision modeling (default: 37). */
    bleChannels: number;
    /** Adjacent channel rejection in dB (default: 15 dB). */
    adjacentChannelRejectionDb: number;
    /** Effective BLE GATT application-layer PHY bitrate in bits/sec (default: 250_000 bps). */
    bleEffectiveBitrateBps: number;
    /** Baseline BLE connection-interval scheduling latency in ms (default: 15 ms). */
    bleConnectionIntervalMs: number;
    /** Path loss exponent for interference estimation. */
    pathLossExponent: number;
    /** Reference power at 1 m for baseline device strength=50 (dBm). */
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

export class RadioMedium {
    config: RadioMediumConfig;
    private activeTransmissions: ActiveTransmission[] = [];
    private deviceRadioBusyUntil: Map<string, number> = new Map();
    private nextTxId: number = 1;

    constructor(config: Partial<RadioMediumConfig> = {}) {
        this.config = { ...DEFAULT_RADIO_MEDIUM_CONFIG, ...config };
    }

    reset(): void {
        this.activeTransmissions = [];
        this.deviceRadioBusyUntil.clear();
        this.nextTxId = 1;
    }

    /**
     * Reserve airtime on a device's shared radio for a specific band.
     * Returns the exact [startMs, endMs] window when the radio transmits.
     */
    reserveDeviceRadio(
        deviceId: string,
        band: RadioBand,
        nowMs: number,
        airtimeMs: number
    ): { startMs: number; endMs: number } {
        const key = `${deviceId}:${band}`;
        const busyUntil = this.deviceRadioBusyUntil.get(key) ?? 0;
        const startMs = Math.max(nowMs, busyUntil);
        const endMs = startMs + Math.max(1, airtimeMs);
        this.deviceRadioBusyUntil.set(key, endMs);
        return { startMs, endMs };
    }

    /**
     * Compute on-air BLE 1M PHY transmission duration in milliseconds (excludes
     * per-link connection-interval wait, which is interleaved across links by the
     * BLE controller rather than blocking the shared radio).
     */
    computeBleAirtimeMs(wireBytes: number): number {
        // BLE 1M PHY (~1 Mbps raw, ~400 kbps effective with L2CAP/ATT/IFS overhead)
        const onAirMs = 1.5 + (wireBytes * 8 * 1000) / Math.max(this.config.bleEffectiveBitrateBps, 400_000);
        return Math.max(1.5, onAirMs);
    }

    /**
     * Register an on-air transmission so concurrent nearby receivers experience interference.
     */
    registerTransmission(params: {
        band: RadioBand;
        txDeviceId: string;
        txPosition: Point;
        txStrength: number;
        channel: number;
        startMs: number;
        endMs: number;
    }): number {
        this.pruneCompleted(params.startMs);
        const id = this.nextTxId++;
        this.activeTransmissions.push({ id, ...params });
        return id;
    }

    /**
     * Evaluate SINR and packet error rate at receiver for a transmission covering [startMs, endMs].
     */
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

        let interferenceMw = 0;
        let interfererCount = 0;

        for (const tx of this.activeTransmissions) {
            if (tx.id === params.txId) continue;
            if (tx.band !== params.band) continue;
            // Time overlap check
            if (tx.endMs <= params.startMs || tx.startMs >= params.endMs) continue;

            // Channel overlap weighting: co-channel = 0 dB penalty, adjacent (±1) = 15 dB rejection
            const chDiff = Math.abs(tx.channel - params.channel);
            let channelAttenuationDb = 0;
            if (chDiff === 0) {
                channelAttenuationDb = 0;
            } else if (chDiff === 1) {
                channelAttenuationDb = this.config.adjacentChannelRejectionDb;
            } else {
                continue; // Orthogonal channel
            }

            const dx = tx.txPosition.x - params.rxPosition.x;
            const dy = tx.txPosition.y - params.rxPosition.y;
            const dist = Math.max(0.5, Math.sqrt(dx * dx + dy * dy));
            if (dist > 150) continue;

            let rxInterferenceDbm =
                this.config.refPowerAt1mDbm -
                10 * this.config.pathLossExponent * Math.log10(dist) +
                10 * Math.log10(Math.max(1, tx.txStrength) / 50) +
                10 * Math.log10(Math.max(1, params.rxStrength) / 50) -
                channelAttenuationDb;

            if (params.environment) {
                const buildings = params.environment.getBuildingsInPath(
                    tx.txPosition,
                    params.rxPosition
                );
                if (buildings.length > 0) {
                    const att = calculateLineAttenuationStats(
                        tx.txPosition,
                        params.rxPosition,
                        buildings
                    );
                    rxInterferenceDbm -= att.total;
                }
            }

            interferenceMw += dbmToMw(rxInterferenceDbm);
            interfererCount++;
        }

        const totalNoiseMw = dbmToMw(baseNoiseDbm) + interferenceMw;
        const totalNoiseDbm = mwToDbm(totalNoiseMw);
        const sinrDb = params.rssiDbm - totalNoiseDbm;

        // Smooth BLE GFSK / 5GHz OFDM BER -> PER approximation
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
        this.pruneCompleted(nowMs);
        return this.activeTransmissions.length;
    }

    private pruneCompleted(nowMs: number): void {
        if (this.activeTransmissions.length === 0) return;
        // Keep slightly past endMs so receptions finishing at the same tick still see overlapping tx
        const cutoff = nowMs - 100;
        if (this.activeTransmissions.length > 64) {
            this.activeTransmissions = this.activeTransmissions.filter(tx => tx.endMs >= cutoff);
        }
    }
}

/**
 * Physics-grounded SINR -> Packet Error Rate mapping using the standard
 * non-coherent GFSK / coded-OFDM exponential Eb/N0 waterfall curve:
 *   BER = 0.5 * exp(-alpha * 10^(sinrDb / 10))
 *
 * - BLE 1M GFSK (alpha = 0.55): clean (<0.1% PER) above ~14 dB SINR,
 *   rapid waterfall between 9–13 dB, ~100% loss under strong co-channel interference (<8 dB).
 * - 5 GHz Wi-Fi Aware MCS0 with 1/2-rate FEC coding gain (alpha = 0.85):
 *   clean above ~11.5 dB SINR (supports full 120–150 m open-air range),
 *   rapid waterfall below ~8 dB SINR.
 */
export function computePacketErrorRate(
    sinrDb: number,
    wireBytes: number,
    band: RadioBand
): number {
    if (sinrDb <= -10) return 1;
    const linearSinr = Math.pow(10, sinrDb / 10);
    const alpha = band === '5GHz' ? 0.85 : 0.55;
    const exponent = -alpha * linearSinr;
    if (exponent < -40) return 0; // BER < 2e-18
    const ber = 0.5 * Math.exp(exponent);
    const bits = Math.max(8, wireBytes * 8);
    if (ber * bits < 1e-6) return 0;
    if (ber >= 0.5) return 1;
    const per = 1 - Math.pow(1 - ber, bits);
    return Math.max(0, Math.min(1, per));
}
