import { BitchatConnection } from './BitchatConnection';
import { BitchatPacket, toHex } from '../protocol/BitchatPacket';
import { BinaryProtocol } from '../protocol/BinaryProtocol';
import { BitchatDevice } from './BitchatDevice';
import { EnvironmentManager, calculateLineAttenuationStats } from './environment';
import type { AttenuationStats } from './environment/LineOfSight';
import { SeededRandom } from './SeededRandom';
import { RadioMedium } from './RadioMedium';

const bleWireSizeCache = new WeakMap<BitchatPacket, number>();

function getBleWireBytes(packet: BitchatPacket): number {
    const cached = bleWireSizeCache.get(packet);
    if (cached !== undefined) return cached;
    const encoded = BinaryProtocol.encode(packet);
    const bytes = encoded ? encoded.length : packet.payload.length + 22;
    bleWireSizeCache.set(packet, bytes);
    return bytes;
}

/**
 * BLE GATT Link Model aligned with Android BluetoothPacketBroadcaster.kt:
 * - Log-distance path loss + building wall/material attenuation + sinusoidal fading
 * - Serialized per-direction GATT queue (1 outstanding op at a time per direction)
 * - Bounded queue (256 packets / 1 MiB per direction), 15 ms retry delay, max 3 retries
 * - Per-device shared 2.4 GHz radio airtime & spatial SINR packet error rate via RadioMedium
 */

export const RSSI_CONFIG = {
    /** RSSI at 1 meter distance (typical BLE) in dBm */
    AT_1M: -40,
    /** Path loss exponent (2.0 = free space, 2.5-3.0 = indoor) */
    PATH_LOSS_EXPONENT: 2.5,
    /** Disconnect threshold in dBm */
    DISCONNECT_THRESHOLD: -85,
    /** Maximum good RSSI (for color scaling) */
    MAX_RSSI: -30,
    /** Noise amplitude in dB (can be modified at runtime) */
    NOISE_AMPLITUDE: 3,
    /** Noise period in milliseconds (slower = more stable signal) */
    NOISE_PERIOD: 15000,
    /** Smoothing factor for RSSI updates (0-1, higher = faster) */
    SMOOTHING_FACTOR: 0.3,
};

export const BLE_QUEUE_CONFIG = {
    MAX_PENDING_SENDS_PER_LINK: 256,
    MAX_PENDING_BYTES_PER_LINK: 1_048_576,
    SEND_RETRY_DELAY_MS: 15,
    MAX_CALLBACK_RETRIES: 3,
} as const;

export interface RSSIStats {
    distance: number;
    pathLoss: number;
    wallLoss: number;
    materialLoss: number;
    wallsCrossed: number;
    gain: number;
    totalLoss: number;
    targetRSSI: number;
}

interface PendingGattSend {
    packet: BitchatPacket;
    from: BitchatDevice;
    wireBytes: number;
    enqueuedAtMs: number;
    retries: number;
}

interface DirectionQueue {
    items: PendingGattSend[];
    head: number;
    pendingBytes: number;
    inFlight: boolean;
}

/** Update RSSI config at runtime */
export function setRssiNoiseAmplitude(amplitude: number): void {
    RSSI_CONFIG.NOISE_AMPLITUDE = Math.max(0, Math.min(10, amplitude));
}

export class BitchatConnectionBLE extends BitchatConnection {
    // RSSI Properties
    rssi: number = RSSI_CONFIG.AT_1M;
    private rssiTarget: number = RSSI_CONFIG.AT_1M;
    private noisePhase: number = 0;
    private lastRssiUpdateMs: number | null = null;

    // Detailed stats for UI
    lastStats: RSSIStats | null = null;
    lastSinrDb: number | null = null;
    lastMeasuredLatencyMs: number = 20;

    // Cached building line-of-sight attenuation (invalidated when either endpoint moves >= 0.75 m)
    private cachedAtten: AttenuationStats | null = null;
    private cachedPosAX: number = NaN;
    private cachedPosAY: number = NaN;
    private cachedPosBX: number = NaN;
    private cachedPosBY: number = NaN;
    private cachedBuildingCount: number = -1;

    // Environment & shared RF medium references (set by SimulationEngine)
    environment: EnvironmentManager | null = null;
    radioMedium: RadioMedium | null = null;

    // Separate serialized FIFO queues for client-write and server-notify directions (O(1) head pointer)
    private clientWriteQueue: DirectionQueue = { items: [], head: 0, pendingBytes: 0, inFlight: false };
    private serverNotifyQueue: DirectionQueue = { items: [], head: 0, pendingBytes: 0, inFlight: false };

    constructor(
        endpointA: BitchatDevice,
        endpointB: BitchatDevice,
        initiator?: BitchatDevice,
        rng?: SeededRandom,
        linkID?: string
    ) {
        super(endpointA, endpointB, initiator, 'BLE', linkID);
        this.rng = rng;
        this.noisePhase = (rng ? rng.next() : Math.random()) * Math.PI * 2;

        if (endpointA.position && endpointB.position) {
            const { targetRSSI } = BitchatConnectionBLE.calculateTargetRSSI(
                endpointA.position,
                endpointB.position,
                endpointA.bluetoothStrength,
                endpointB.bluetoothStrength,
                null
            );
            this.rssi = targetRSSI;
            this.rssiTarget = targetRSSI;
        }
    }

    static calculateTargetRSSI(
        posA: { x: number; y: number },
        posB: { x: number; y: number },
        strengthA: number,
        strengthB: number,
        environment: EnvironmentManager | null
    ): RSSIStats {
        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const effectiveDistance = Math.max(distance, 0.1);

        const pathLoss = 10 * RSSI_CONFIG.PATH_LOSS_EXPONENT * Math.log10(effectiveDistance);
        let targetRSSI = RSSI_CONFIG.AT_1M - pathLoss;

        let wallLoss = 0;
        let materialLoss = 0;
        let wallsCrossed = 0;

        if (environment) {
            const buildingsInPath = environment.getBuildingsInPath(posA, posB);
            const stats = calculateLineAttenuationStats(posA, posB, buildingsInPath);
            wallLoss = stats.wallLoss;
            materialLoss = stats.materialLoss;
            wallsCrossed = stats.wallsCrossed;
            targetRSSI -= stats.total;
        }

        const gainA = 10 * Math.log10(Math.max(1, strengthA) / 50);
        const gainB = 10 * Math.log10(Math.max(1, strengthB) / 50);
        const totalGain = gainA + gainB;

        targetRSSI += totalGain;

        return {
            distance: effectiveDistance,
            pathLoss,
            wallLoss,
            materialLoss,
            wallsCrossed,
            gain: totalGain,
            totalLoss: pathLoss + wallLoss + materialLoss - totalGain,
            targetRSSI,
        };
    }

    static estimateRSSI(
        posA: { x: number; y: number },
        posB: { x: number; y: number },
        strengthA: number,
        strengthB: number,
        environment: EnvironmentManager | null
    ): number {
        if (!posA || !posB) return RSSI_CONFIG.DISCONNECT_THRESHOLD - 10;
        return this.calculateTargetRSSI(posA, posB, strengthA, strengthB, environment).targetRSSI;
    }

    getQueueDepth(): number {
        return (
            this.clientWriteQueue.items.length -
            this.clientWriteQueue.head +
            (this.serverNotifyQueue.items.length - this.serverNotifyQueue.head)
        );
    }

    send(packet: BitchatPacket, from: BitchatDevice, nowMs?: number): boolean {
        if (!this.isActive || !this.isReady) return false;

        const now = nowMs ?? this.clock();
        const wireBytes = getBleWireBytes(packet);

        // If scheduler is attached (full SimulationEngine run), use serialized GATT queue + RadioMedium
        if (this.scheduler) {
            const queue =
                from === this.initiator ? this.clientWriteQueue : this.serverNotifyQueue;

            const depth = queue.items.length - queue.head;
            if (
                depth >= BLE_QUEUE_CONFIG.MAX_PENDING_SENDS_PER_LINK ||
                queue.pendingBytes + wireBytes > BLE_QUEUE_CONFIG.MAX_PENDING_BYTES_PER_LINK
            ) {
                this.packetsDropped++;
                this.telemetry?.recordDrop('queue_full');
                return false;
            }

            queue.items.push({
                packet,
                from,
                wireBytes,
                enqueuedAtMs: now,
                retries: 0,
            });
            queue.pendingBytes += wireBytes;

            if (!queue.inFlight) {
                this.startNextGattOp(queue, now);
            }
            return true;
        }

        // Standalone fallback (direct unit tests without EventScheduler)
        this.packetsSent++;
        this.bytesSent += wireBytes;
        this.lastActivityAtMs = now;
        const isRelay = from.peerIDHex !== toHex(packet.senderID);
        this.telemetry?.recordPacketTransmitted(now, wireBytes, isRelay);
        if (this.onPacketSent) {
            this.onPacketSent(packet, from);
        }
        this.packetQueue.push({
            packet,
            from,
            deliverAt: now + this.latencyMs,
        });
        return true;
    }

    private startNextGattOp(queue: DirectionQueue, nowMs: number): void {
        if (!this.isActive || !this.scheduler) {
            queue.inFlight = false;
            return;
        }
        const head = queue.items[queue.head];
        if (!head) {
            queue.inFlight = false;
            return;
        }

        queue.inFlight = true;
        const medium = this.radioMedium;
        const onAirMs = medium
            ? medium.computeBleAirtimeMs(head.wireBytes)
            : 1.5 + (head.wireBytes * 8 * 1000) / 400_000;
        const connIntervalWaitMs = medium ? medium.config.bleConnectionIntervalMs : 15;

        // Reserve per-device shared BLE radio ONLY for actual on-air TX duration;
        // per-link connection-interval wait is interleaved across links by the BLE controller.
        const window = medium
            ? medium.reserveDeviceRadio(head.from.peerIDHex, '2.4GHz', nowMs, onAirMs)
            : { startMs: nowMs, endMs: nowMs + onAirMs };

        const channel = this.rng ? this.rng.nextInt(0, 36) : 0;
        const txPos = head.from.position ?? { x: 0, y: 0 };
        const txId = medium
            ? medium.registerTransmission({
                  band: '2.4GHz',
                  txDeviceId: head.from.peerIDHex,
                  txPosition: txPos,
                  txStrength: head.from.bluetoothStrength,
                  channel,
                  startMs: window.startMs,
                  endMs: window.endMs,
              })
            : 0;

        this.packetsSent++;
        this.bytesSent += head.wireBytes;
        this.lastActivityAtMs = window.startMs;

        const isRelay = head.from.peerIDHex !== toHex(head.packet.senderID);
        this.telemetry?.recordPacketTransmitted(window.startMs, head.wireBytes, isRelay);
        if (this.onPacketSent) {
            this.onPacketSent(head.packet, head.from);
        }

        this.scheduler.scheduleAt(
            window.endMs + connIntervalWaitMs,
            doneMs => {
                if (!this.isActive) {
                    queue.inFlight = false;
                    return;
                }

                const target = this.getOtherParty(head.from);
                const rxPos = target.position ?? { x: 0, y: 0 };

                let failed = false;
                if (medium) {
                    const evalResult = medium.evaluateReception({
                        txId,
                        band: '2.4GHz',
                        rssiDbm: this.rssi,
                        rxPosition: rxPos,
                        rxStrength: target.bluetoothStrength,
                        channel,
                        wireBytes: head.wireBytes,
                        startMs: window.startMs,
                        endMs: window.endMs,
                        environment: this.environment,
                    });
                    this.lastSinrDb = evalResult.sinrDb;
                    if (evalResult.packetErrorRate > 0) {
                        const roll = this.rng ? this.rng.next() : 0.5;
                        if (roll < evalResult.packetErrorRate) {
                            failed = true;
                        }
                    }
                }

                if (failed && head.retries < BLE_QUEUE_CONFIG.MAX_CALLBACK_RETRIES) {
                    head.retries++;
                    this.scheduler?.scheduleAt(
                        doneMs + BLE_QUEUE_CONFIG.SEND_RETRY_DELAY_MS,
                        retryMs => this.startNextGattOp(queue, retryMs),
                        `ble-retry:${this.linkID}`
                    );
                    return;
                }

                // Pop completed (or exhausted) head item in O(1)
                queue.head++;
                if (queue.head >= queue.items.length) {
                    queue.items.length = 0;
                    queue.head = 0;
                } else if (queue.head > 64 && queue.head * 2 >= queue.items.length) {
                    queue.items = queue.items.slice(queue.head);
                    queue.head = 0;
                }
                queue.pendingBytes = Math.max(0, queue.pendingBytes - head.wireBytes);

                if (failed) {
                    this.packetsDropped++;
                    this.telemetry?.recordDrop('rf_per');
                } else {
                    this.packetsReceived++;
                    this.lastActivityAtMs = doneMs;
                    this.lastMeasuredLatencyMs = Math.max(1, doneMs - head.enqueuedAtMs);
                    this.telemetry?.recordPacketDeliveredOnLink();
                    target.receivePacket(head.packet, head.from, this);
                }

                if (queue.head < queue.items.length) {
                    this.startNextGattOp(queue, doneMs);
                } else {
                    queue.inFlight = false;
                }
            },
            `ble-tx-done:${this.linkID}`
        );
    }

    updateRSSI(now: number): boolean {
        if (!this.isActive) return false;

        const posA = this.endpointA.position;
        const posB = this.endpointB.position;
        if (!posA || !posB) return true;

        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const effectiveDistance = distance > 0.1 ? distance : 0.1;
        const pathLoss = 10 * RSSI_CONFIG.PATH_LOSS_EXPONENT * Math.log10(effectiveDistance);

        let wallLoss = 0;
        let materialLoss = 0;
        let wallsCrossed = 0;

        if (this.environment) {
            const bCount = this.environment.getBuildingCount();
            if (bCount > 0) {
                const movedASq =
                    (posA.x - this.cachedPosAX) * (posA.x - this.cachedPosAX) +
                    (posA.y - this.cachedPosAY) * (posA.y - this.cachedPosAY);
                const movedBSq =
                    (posB.x - this.cachedPosBX) * (posB.x - this.cachedPosBX) +
                    (posB.y - this.cachedPosBY) * (posB.y - this.cachedPosBY);

                // Recompute building raycast only when an endpoint moved >= 0.75 m or map changed
                if (
                    this.cachedAtten === null ||
                    this.cachedBuildingCount !== bCount ||
                    movedASq >= 0.5625 ||
                    movedBSq >= 0.5625
                ) {
                    const buildingsInPath = this.environment.getBuildingsInPath(posA, posB);
                    this.cachedAtten =
                        buildingsInPath.length > 0
                            ? calculateLineAttenuationStats(posA, posB, buildingsInPath)
                            : { total: 0, wallLoss: 0, materialLoss: 0, wallsCrossed: 0 };
                    this.cachedPosAX = posA.x;
                    this.cachedPosAY = posA.y;
                    this.cachedPosBX = posB.x;
                    this.cachedPosBY = posB.y;
                    this.cachedBuildingCount = bCount;
                }
                wallLoss = this.cachedAtten.wallLoss;
                materialLoss = this.cachedAtten.materialLoss;
                wallsCrossed = this.cachedAtten.wallsCrossed;
            }
        }

        const gainA = 10 * Math.log10(Math.max(1, this.endpointA.bluetoothStrength) / 50);
        const gainB = 10 * Math.log10(Math.max(1, this.endpointB.bluetoothStrength) / 50);
        const totalGain = gainA + gainB;
        const targetRSSI = RSSI_CONFIG.AT_1M - pathLoss - wallLoss - materialLoss + totalGain;

        this.lastStats = {
            distance: effectiveDistance,
            pathLoss,
            wallLoss,
            materialLoss,
            wallsCrossed,
            gain: totalGain,
            totalLoss: pathLoss + wallLoss + materialLoss - totalGain,
            targetRSSI,
        };
        this.rssiTarget = targetRSSI;

        const dtSec =
            this.lastRssiUpdateMs !== null ? Math.max(0, (now - this.lastRssiUpdateMs) * 0.001) : 0;
        this.lastRssiUpdateMs = now;
        this.noisePhase =
            (this.noisePhase + dtSec * ((Math.PI * 2) / (RSSI_CONFIG.NOISE_PERIOD / 1000))) %
            (Math.PI * 2);

        const noise = Math.sin(this.noisePhase) * RSSI_CONFIG.NOISE_AMPLITUDE;
        const targetWithNoise = this.rssiTarget + noise;
        this.rssi = this.rssi + (targetWithNoise - this.rssi) * RSSI_CONFIG.SMOOTHING_FACTOR;

        if (this.rssi < RSSI_CONFIG.DISCONNECT_THRESHOLD) {
            return false;
        }
        return true;
    }

    getRSSINormalized(): number {
        const range = RSSI_CONFIG.MAX_RSSI - RSSI_CONFIG.DISCONNECT_THRESHOLD;
        const value = (this.rssi - RSSI_CONFIG.DISCONNECT_THRESHOLD) / range;
        return Math.max(0, Math.min(1, value));
    }

    getTargetRSSI(): number {
        return this.rssiTarget;
    }

    override close(): void {
        super.close();
        this.clientWriteQueue.items.length = 0;
        this.clientWriteQueue.head = 0;
        this.clientWriteQueue.pendingBytes = 0;
        this.clientWriteQueue.inFlight = false;
        this.serverNotifyQueue.items.length = 0;
        this.serverNotifyQueue.head = 0;
        this.serverNotifyQueue.pendingBytes = 0;
        this.serverNotifyQueue.inFlight = false;
    }
}
