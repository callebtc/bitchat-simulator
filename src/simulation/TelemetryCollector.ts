/**
 * Authoritative simulation-layer telemetry collector.
 *
 * Consumed by both headless deterministic benchmark runners and the reactive UI
 * HUD so metrics (delivery ratio, end-to-end latency percentiles, goodput vs.
 * wire amplification, drops, source-routing hit rate, convergence) have a
 * single source of truth independent of React.
 */

export type LogicalMessageKind =
    | 'broadcast'
    | 'dm'
    | 'file'
    | 'voice'
    | 'announce'
    | 'sync';

export type DropReason =
    | 'duplicate'
    | 'ttl_expired'
    | 'unknown_key'
    | 'queue_full'
    | 'rf_per'
    | 'probabilistic_relay'
    | 'cancelled_relay'
    | 'duplicate_hop'
    | 'fragment_timeout'
    | 'outbox_expired';

export interface DeliveryRecord {
    recipientId: string;
    deliveredAtMs: number;
    latencyMs: number;
    hops: number;
    transport: string;
}

export interface TrackedMessage {
    id: string;
    kind: LogicalMessageKind;
    senderId: string;
    recipientId?: string;
    originatedAtMs: number;
    payloadBytes: number;
    expectedRecipients: number;
    deliveries: Map<string, DeliveryRecord>;
}

export interface LatencyStats {
    count: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
}

export interface TelemetrySnapshot {
    simTimeMs: number;
    packetsSent: number;
    packetsDelivered: number;
    wireBytesSent: number;
    goodputBytesDelivered: number;
    relayTransmissions: number;
    directShortcutUnicasts: number;
    sourceRouteOriginated: number;
    sourceRouteHopForwarded: number;
    sourceRouteFallbacks: number;
    sourceRouteHitRate: number;
    drops: Record<DropReason, number>;
    connectionsInitiated: number;
    connectionsFormed: number;
    connectionsFailed: number;
    connectionsBroken: number;
    dualLinksObserved: number;
    originatedByKind: Record<LogicalMessageKind, number>;
    deliveryRatio: {
        broadcast: number;
        dm: number;
        file: number;
        voice: number;
    };
    latencyMs: {
        all: LatencyStats;
        broadcast: LatencyStats;
        dm: LatencyStats;
        file: LatencyStats;
        voice: LatencyStats;
    };
    packetAmplification: number;
    byteAmplification: number;
    recentPackets1s: number;
    recentPackets10s: number;
    recentPackets60s: number;
    recentWireBytes1s: number;
}

function emptyDropRecord(): Record<DropReason, number> {
    return {
        duplicate: 0,
        ttl_expired: 0,
        unknown_key: 0,
        queue_full: 0,
        rf_per: 0,
        probabilistic_relay: 0,
        cancelled_relay: 0,
        duplicate_hop: 0,
        fragment_timeout: 0,
        outbox_expired: 0,
    };
}

function emptyKindRecord(): Record<LogicalMessageKind, number> {
    return {
        broadcast: 0,
        dm: 0,
        file: 0,
        voice: 0,
        announce: 0,
        sync: 0,
    };
}

function computeLatencyStats(samples: number[]): LatencyStats {
    if (samples.length === 0) {
        return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < sorted.length; i++) sum += sorted[i];
    const at = (q: number): number => {
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
        return sorted[idx];
    };
    return {
        count: sorted.length,
        mean: sum / sorted.length,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: sorted[sorted.length - 1],
    };
}

export class TelemetryCollector {
    private trackedMessages: Map<string, TrackedMessage> = new Map();
    private maxTrackedMessages: number = 5000;

    private packetsSent: number = 0;
    private packetsDelivered: number = 0;
    private wireBytesSent: number = 0;
    private goodputBytesDelivered: number = 0;
    private relayTransmissions: number = 0;
    private directShortcutUnicasts: number = 0;
    private sourceRouteOriginated: number = 0;
    private sourceRouteHopForwarded: number = 0;
    private sourceRouteFallbacks: number = 0;

    private drops: Record<DropReason, number> = emptyDropRecord();
    private originatedByKind: Record<LogicalMessageKind, number> = emptyKindRecord();

    private connectionsInitiated: number = 0;
    private connectionsFormed: number = 0;
    private connectionsFailed: number = 0;
    private connectionsBroken: number = 0;
    private dualLinksObserved: number = 0;

    // Sliding window of (simTimeMs, wireBytes) for recent rates (up to 60s)
    private recentTransmissions: Array<{ timeMs: number; bytes: number }> = [];

    reset(): void {
        this.trackedMessages.clear();
        this.packetsSent = 0;
        this.packetsDelivered = 0;
        this.wireBytesSent = 0;
        this.goodputBytesDelivered = 0;
        this.relayTransmissions = 0;
        this.directShortcutUnicasts = 0;
        this.sourceRouteOriginated = 0;
        this.sourceRouteHopForwarded = 0;
        this.sourceRouteFallbacks = 0;
        this.drops = emptyDropRecord();
        this.originatedByKind = emptyKindRecord();
        this.connectionsInitiated = 0;
        this.connectionsFormed = 0;
        this.connectionsFailed = 0;
        this.connectionsBroken = 0;
        this.dualLinksObserved = 0;
        this.recentTransmissions = [];
    }

    recordMessageOriginated(
        id: string,
        kind: LogicalMessageKind,
        senderId: string,
        originatedAtMs: number,
        payloadBytes: number,
        expectedRecipients: number,
        recipientId?: string
    ): void {
        this.originatedByKind[kind]++;
        if (this.trackedMessages.has(id)) return;
        this.trackedMessages.set(id, {
            id,
            kind,
            senderId,
            recipientId,
            originatedAtMs,
            payloadBytes,
            expectedRecipients: Math.max(0, expectedRecipients),
            deliveries: new Map(),
        });
        if (this.trackedMessages.size > this.maxTrackedMessages) {
            const oldestKey = this.trackedMessages.keys().next().value;
            if (oldestKey !== undefined) {
                this.trackedMessages.delete(oldestKey);
            }
        }
    }

    recordMessageDelivered(
        id: string,
        recipientId: string,
        deliveredAtMs: number,
        hops: number,
        transport: string = 'BLE'
    ): void {
        const msg = this.trackedMessages.get(id);
        if (!msg) return;
        if (recipientId === msg.senderId) return;
        if (msg.deliveries.has(recipientId)) return;

        const latencyMs = Math.max(0, deliveredAtMs - msg.originatedAtMs);
        msg.deliveries.set(recipientId, {
            recipientId,
            deliveredAtMs,
            latencyMs,
            hops,
            transport,
        });
        this.goodputBytesDelivered += msg.payloadBytes;
    }

    recordPacketTransmitted(
        simTimeMs: number,
        wireBytes: number,
        isRelay: boolean
    ): void {
        this.packetsSent++;
        this.wireBytesSent += wireBytes;
        if (isRelay) {
            this.relayTransmissions++;
        }
        this.recentTransmissions.push({ timeMs: simTimeMs, bytes: wireBytes });
        this.pruneRecent(simTimeMs);
    }

    recordPacketDeliveredOnLink(): void {
        this.packetsDelivered++;
    }

    recordDrop(reason: DropReason): void {
        this.drops[reason]++;
    }

    recordDirectShortcutUnicast(): void {
        this.directShortcutUnicasts++;
    }

    recordSourceRouteOriginated(): void {
        this.sourceRouteOriginated++;
    }

    recordSourceRouteHopForwarded(): void {
        this.sourceRouteHopForwarded++;
    }

    recordSourceRouteFallback(): void {
        this.sourceRouteFallbacks++;
    }

    recordConnectionInitiated(): void {
        this.connectionsInitiated++;
    }

    recordConnectionFormed(isDualLink: boolean = false): void {
        this.connectionsFormed++;
        if (isDualLink) this.dualLinksObserved++;
    }

    recordConnectionFailed(): void {
        this.connectionsFailed++;
    }

    recordConnectionBroken(): void {
        this.connectionsBroken++;
    }

    getTrackedMessage(id: string): TrackedMessage | undefined {
        return this.trackedMessages.get(id);
    }

    getSnapshot(simTimeMs: number): TelemetrySnapshot {
        this.pruneRecent(simTimeMs);

        const deliveryExpected: Record<'broadcast' | 'dm' | 'file' | 'voice', number> = {
            broadcast: 0,
            dm: 0,
            file: 0,
            voice: 0,
        };
        const deliveryActual: Record<'broadcast' | 'dm' | 'file' | 'voice', number> = {
            broadcast: 0,
            dm: 0,
            file: 0,
            voice: 0,
        };
        const latenciesAll: number[] = [];
        const latenciesByKind: Record<'broadcast' | 'dm' | 'file' | 'voice', number[]> = {
            broadcast: [],
            dm: [],
            file: [],
            voice: [],
        };

        for (const msg of this.trackedMessages.values()) {
            if (
                msg.kind === 'broadcast' ||
                msg.kind === 'dm' ||
                msg.kind === 'file' ||
                msg.kind === 'voice'
            ) {
                deliveryExpected[msg.kind] += msg.expectedRecipients;
                deliveryActual[msg.kind] += msg.deliveries.size;
                for (const d of msg.deliveries.values()) {
                    latenciesAll.push(d.latencyMs);
                    latenciesByKind[msg.kind].push(d.latencyMs);
                }
            }
        }

        const ratio = (actual: number, expected: number): number =>
            expected > 0 ? Math.min(1, actual / expected) : 0;

        const totalOriginatedUser =
            this.originatedByKind.broadcast +
            this.originatedByKind.dm +
            this.originatedByKind.file +
            this.originatedByKind.voice;
        const totalOriginatedAll =
            totalOriginatedUser +
            this.originatedByKind.announce +
            this.originatedByKind.sync;

        const srTotal = this.sourceRouteHopForwarded + this.sourceRouteFallbacks;

        let recent1s = 0;
        let recent10s = 0;
        let recentWireBytes1s = 0;
        const cut1s = simTimeMs - 1000;
        const cut10s = simTimeMs - 10000;
        for (let i = this.recentTransmissions.length - 1; i >= 0; i--) {
            const entry = this.recentTransmissions[i];
            if (entry.timeMs >= cut10s) {
                recent10s++;
                if (entry.timeMs >= cut1s) {
                    recent1s++;
                    recentWireBytes1s += entry.bytes;
                }
            } else {
                break;
            }
        }

        return {
            simTimeMs,
            packetsSent: this.packetsSent,
            packetsDelivered: this.packetsDelivered,
            wireBytesSent: this.wireBytesSent,
            goodputBytesDelivered: this.goodputBytesDelivered,
            relayTransmissions: this.relayTransmissions,
            directShortcutUnicasts: this.directShortcutUnicasts,
            sourceRouteOriginated: this.sourceRouteOriginated,
            sourceRouteHopForwarded: this.sourceRouteHopForwarded,
            sourceRouteFallbacks: this.sourceRouteFallbacks,
            sourceRouteHitRate: srTotal > 0 ? this.sourceRouteHopForwarded / srTotal : 0,
            drops: { ...this.drops },
            connectionsInitiated: this.connectionsInitiated,
            connectionsFormed: this.connectionsFormed,
            connectionsFailed: this.connectionsFailed,
            connectionsBroken: this.connectionsBroken,
            dualLinksObserved: this.dualLinksObserved,
            originatedByKind: { ...this.originatedByKind },
            deliveryRatio: {
                broadcast: ratio(deliveryActual.broadcast, deliveryExpected.broadcast),
                dm: ratio(deliveryActual.dm, deliveryExpected.dm),
                file: ratio(deliveryActual.file, deliveryExpected.file),
                voice: ratio(deliveryActual.voice, deliveryExpected.voice),
            },
            latencyMs: {
                all: computeLatencyStats(latenciesAll),
                broadcast: computeLatencyStats(latenciesByKind.broadcast),
                dm: computeLatencyStats(latenciesByKind.dm),
                file: computeLatencyStats(latenciesByKind.file),
                voice: computeLatencyStats(latenciesByKind.voice),
            },
            packetAmplification:
                totalOriginatedAll > 0 ? this.packetsSent / totalOriginatedAll : 0,
            byteAmplification:
                this.goodputBytesDelivered > 0
                    ? this.wireBytesSent / this.goodputBytesDelivered
                    : 0,
            recentPackets1s: recent1s,
            recentPackets10s: recent10s,
            recentPackets60s: this.recentTransmissions.length,
            recentWireBytes1s,
        };
    }

    private pruneRecent(simTimeMs: number): void {
        const cutoff = simTimeMs - 60_000;
        let firstValid = 0;
        while (
            firstValid < this.recentTransmissions.length &&
            this.recentTransmissions[firstValid].timeMs < cutoff
        ) {
            firstValid++;
        }
        if (firstValid > 0) {
            this.recentTransmissions = this.recentTransmissions.slice(firstValid);
        }
    }
}
