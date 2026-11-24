import { BitchatConnection } from './BitchatConnection';
import { BitchatPacket, getPacketCanonicalRoot, toHex } from '../protocol/BitchatPacket';
import { BinaryProtocol } from '../protocol/BinaryProtocol';
import { BitchatDevice } from './BitchatDevice';
import { EnvironmentManager, calculateLineAttenuationStats } from './environment';
import { SeededRandom } from './SeededRandom';
import { RadioMedium } from './RadioMedium';

const wifiWireSizeCache = new WeakMap<BitchatPacket, number>();

function getWifiWireBytes(packet: BitchatPacket): number {
    const root = getPacketCanonicalRoot(packet);
    const cached = wifiWireSizeCache.get(root);
    if (cached !== undefined) return cached;
    const encoded = BinaryProtocol.encode(packet, { padding: false });
    const bytes = encoded ? encoded.length : packet.payload.length + 22;
    wifiWireSizeCache.set(root, bytes);
    return bytes;
}

/**
 * Wi-Fi Aware (NAN + IPv6 TCP) link model aligned with BitChat Android's
 * `wifi-aware/WifiAwareMeshService.kt`
 * (https://github.com/permissionlesstech/bitchat-android).
 *
 * Characteristics vs. BLE:
 * - 5 GHz band (orthogonal to 2.4 GHz BLE; zero cross-band RF interference)
 * - Longer open-air range (~150 m connect / ~165 m disconnect), higher wall attenuation
 *   (+5 dB extra per wall over 2.4 GHz BLE = ~20 dB/wall)
 * - High throughput (~25 Mbps effective TCP stream), low per-packet latency (~4 ms base)
 * - Large MTU (65,535 B — does not require 512 B BLE fragmentation)
 * - NAN attach + NDP + IPv6 TCP handshake latency (~1,200 ms modeled by SimulationEngine)
 */

export const WIFI_AWARE_CONFIG = {
    /** Reference signal power at 1 m on 5 GHz NAN in dBm */
    AT_1M: -32,
    /** Open-air 5 GHz path loss exponent */
    PATH_LOSS_EXPONENT: 2.4,
    /** Extra attenuation per building wall at 5 GHz compared to 2.4 GHz (dB) */
    EXTRA_WALL_LOSS_DB: 5,
    /** Connect RSSI threshold in dBm */
    CONNECT_THRESHOLD: -82,
    /** Disconnect RSSI threshold in dBm */
    DISCONNECT_THRESHOLD: -88,
    /** Discovery / connection radii in meters */
    CONNECT_RADIUS_M: 150,
    DISCONNECT_RADIUS_M: 165,
    /** Effective application-layer TCP throughput over Wi-Fi Aware NDP (bits/sec) */
    EFFECTIVE_BITRATE_BPS: 25_000_000,
    /** Base TCP + NAN scheduling latency in ms */
    BASE_LATENCY_MS: 4,
    /** NAN + NDP + TCP handshake duration in ms */
    HANDSHAKE_MS: 1_200,
    /** Number of 5 GHz channels modeled for AFH/SINR */
    CHANNELS: 8,
    /** Max TCP send buffer depth */
    MAX_PENDING_SENDS: 512,
    MAX_PENDING_BYTES: 8 * 1_048_576,
    TCP_RETRY_DELAY_MS: 12,
    MAX_TCP_RETRIES: 3,
} as const;

interface PendingTcpSend {
    packet: BitchatPacket;
    from: BitchatDevice;
    wireBytes: number;
    retries: number;
}

interface TcpDirectionQueue {
    items: PendingTcpSend[];
    head: number;
    pendingBytes: number;
    inFlight: boolean;
}

export class BitchatConnectionWifiAware extends BitchatConnection {
    rssi: number = WIFI_AWARE_CONFIG.AT_1M;
    lastSinrDb: number | null = null;
    lastMeasuredLatencyMs: number = WIFI_AWARE_CONFIG.BASE_LATENCY_MS;
    environment: EnvironmentManager | null = null;
    radioMedium: RadioMedium | null = null;

    private dirAtoB: TcpDirectionQueue = { items: [], head: 0, pendingBytes: 0, inFlight: false };
    private dirBtoA: TcpDirectionQueue = { items: [], head: 0, pendingBytes: 0, inFlight: false };
    private cachedPosAX: number = NaN;
    private cachedPosAY: number = NaN;
    private cachedPosBX: number = NaN;
    private cachedPosBY: number = NaN;
    private cachedBuildingCount: number = -1;

    constructor(
        endpointA: BitchatDevice,
        endpointB: BitchatDevice,
        initiator?: BitchatDevice,
        rng?: SeededRandom,
        linkID?: string
    ) {
        super(endpointA, endpointB, initiator, 'WIFI_AWARE', linkID);
        this.rng = rng;
        this.latencyMs = WIFI_AWARE_CONFIG.BASE_LATENCY_MS;

        if (endpointA.position && endpointB.position) {
            this.rssi = BitchatConnectionWifiAware.estimateRSSI(
                endpointA.position,
                endpointB.position,
                null
            );
        }
    }

    static estimateRSSI(
        posA: { x: number; y: number },
        posB: { x: number; y: number },
        environment: EnvironmentManager | null
    ): number {
        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const distance = Math.max(0.5, Math.sqrt(dx * dx + dy * dy));

        const pathLoss = 10 * WIFI_AWARE_CONFIG.PATH_LOSS_EXPONENT * Math.log10(distance);
        let wallLoss = 0;
        let materialLoss = 0;

        if (environment) {
            const buildings = environment.getBuildingsInPath(posA, posB);
            if (buildings.length > 0) {
                const stats = calculateLineAttenuationStats(posA, posB, buildings);
                wallLoss =
                    stats.wallLoss + stats.wallsCrossed * WIFI_AWARE_CONFIG.EXTRA_WALL_LOSS_DB;
                materialLoss = stats.materialLoss;
            }
        }

        return WIFI_AWARE_CONFIG.AT_1M - pathLoss - wallLoss - materialLoss;
    }

    updateRSSI(): boolean {
        const posA = this.endpointA.position;
        const posB = this.endpointB.position;
        if (!posA || !posB) return true;

        const bCount = this.environment ? this.environment.getBuildingCount() : 0;
        const movedASq =
            (posA.x - this.cachedPosAX) * (posA.x - this.cachedPosAX) +
            (posA.y - this.cachedPosAY) * (posA.y - this.cachedPosAY);
        const movedBSq =
            (posB.x - this.cachedPosBX) * (posB.x - this.cachedPosBX) +
            (posB.y - this.cachedPosBY) * (posB.y - this.cachedPosBY);

        if (
            this.cachedBuildingCount !== bCount ||
            movedASq >= 0.5625 ||
            movedBSq >= 0.5625
        ) {
            this.rssi = BitchatConnectionWifiAware.estimateRSSI(posA, posB, this.environment);
            this.cachedPosAX = posA.x;
            this.cachedPosAY = posA.y;
            this.cachedPosBX = posB.x;
            this.cachedPosBY = posB.y;
            this.cachedBuildingCount = bCount;
        }
        return this.rssi > WIFI_AWARE_CONFIG.DISCONNECT_THRESHOLD;
    }

    send(packet: BitchatPacket, from: BitchatDevice, nowMs?: number): boolean {
        if (!this.isActive || !this.isReady) return false;

        const now = nowMs ?? this.clock();
        const wireBytes = getWifiWireBytes(packet);

        if (this.scheduler) {
            const queue = from === this.endpointA ? this.dirAtoB : this.dirBtoA;
            if (
                queue.items.length - queue.head >= WIFI_AWARE_CONFIG.MAX_PENDING_SENDS ||
                queue.pendingBytes + wireBytes > WIFI_AWARE_CONFIG.MAX_PENDING_BYTES
            ) {
                this.packetsDropped++;
                this.telemetry?.recordDrop('queue_full');
                return false;
            }
            queue.items.push({ packet, from, wireBytes, retries: 0 });
            queue.pendingBytes += wireBytes;
            if (!queue.inFlight) {
                this.startNextTcpOp(queue, now);
            }
            return true;
        }

        // Standalone fallback
        this.packetsSent++;
        this.bytesSent += wireBytes;
        this.lastActivityAtMs = now;
        const isRelay = from.peerIDHex !== toHex(packet.senderID);
        this.telemetry?.recordPacketTransmitted(now, wireBytes, isRelay);
        this.onPacketSent?.(packet, from);
        this.packetQueue.push({ packet, from, deliverAt: now + this.latencyMs });
        return true;
    }

    private startNextTcpOp(queue: TcpDirectionQueue, nowMs: number): void {
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
        const serializationMs = (head.wireBytes * 8 * 1000) / WIFI_AWARE_CONFIG.EFFECTIVE_BITRATE_BPS;
        const airtimeMs = Math.max(1, WIFI_AWARE_CONFIG.BASE_LATENCY_MS + serializationMs);
        const medium = this.radioMedium;

        const window = medium
            ? medium.reserveDeviceRadio(head.from.peerIDHex, '5GHz', nowMs, airtimeMs)
            : { startMs: nowMs, endMs: nowMs + airtimeMs };

        const channel = this.rng ? this.rng.nextInt(0, WIFI_AWARE_CONFIG.CHANNELS - 1) : 0;
        const txPos = head.from.position ?? { x: 0, y: 0 };
        const txId = medium
            ? medium.registerTransmission({
                  band: '5GHz',
                  txDeviceId: head.from.peerIDHex,
                  txPosition: txPos,
                  txStrength: 75,
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
        this.onPacketSent?.(head.packet, head.from);

        const target = this.getOtherParty(head.from);
        this.scheduler.scheduleAtFast(
            window.endMs,
            fireNow => {
                if (!this.isActive) {
                    queue.inFlight = false;
                    return;
                }

                let failed = false;
                if (medium) {
                    const rxPos = target.position ?? { x: 0, y: 0 };
                    const evalRes = medium.evaluateReception({
                        txId,
                        band: '5GHz',
                        rssiDbm: this.rssi,
                        rxPosition: rxPos,
                        rxStrength: 75,
                        channel,
                        wireBytes: head.wireBytes,
                        startMs: window.startMs,
                        endMs: window.endMs,
                        environment: this.environment,
                    });
                    this.lastSinrDb = evalRes.sinrDb;
                    if (evalRes.packetErrorRate > 0) {
                        const roll = this.rng ? this.rng.next() : 0;
                        if (roll < evalRes.packetErrorRate) {
                            failed = true;
                        }
                    }
                }

                if (failed) {
                    head.retries++;
                    if (head.retries <= WIFI_AWARE_CONFIG.MAX_TCP_RETRIES) {
                        this.scheduler?.scheduleInFast(
                            WIFI_AWARE_CONFIG.TCP_RETRY_DELAY_MS,
                            retryNow => this.startNextTcpOp(queue, retryNow)
                        );
                        return;
                    }
                    this.packetsDropped++;
                    this.telemetry?.recordDrop('rf_per');
                    queue.head++;
                    if (queue.head >= queue.items.length) {
                        queue.items.length = 0;
                        queue.head = 0;
                    } else if (queue.head > 64 && queue.head * 2 >= queue.items.length) {
                        queue.items = queue.items.slice(queue.head);
                        queue.head = 0;
                    }
                    queue.pendingBytes = Math.max(0, queue.pendingBytes - head.wireBytes);
                    queue.inFlight = false;
                    this.startNextTcpOp(queue, fireNow);
                    return;
                }

                queue.head++;
                if (queue.head >= queue.items.length) {
                    queue.items.length = 0;
                    queue.head = 0;
                } else if (queue.head > 64 && queue.head * 2 >= queue.items.length) {
                    queue.items = queue.items.slice(queue.head);
                    queue.head = 0;
                }
                queue.pendingBytes = Math.max(0, queue.pendingBytes - head.wireBytes);
                this.packetsReceived++;
                this.lastActivityAtMs = fireNow;
                this.lastMeasuredLatencyMs = Math.max(1, fireNow - window.startMs);
                this.telemetry?.recordPacketDeliveredOnLink();
                queue.inFlight = false;

                target.receivePacket(head.packet, head.from, this);
                this.startNextTcpOp(queue, fireNow);
            }
        );
    }

    override close(): void {
        super.close();
        this.dirAtoB.items.length = 0;
        this.dirAtoB.head = 0;
        this.dirAtoB.pendingBytes = 0;
        this.dirAtoB.inFlight = false;
        this.dirBtoA.items.length = 0;
        this.dirBtoA.head = 0;
        this.dirBtoA.pendingBytes = 0;
        this.dirBtoA.inFlight = false;
    }
}
