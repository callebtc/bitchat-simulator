import {
    BitchatPacket,
    MessageType,
    computePacketIdBytes,
    computePacketIdHex,
    isBroadcastRecipient,
    toHex,
} from '../../protocol/BitchatPacket';
import { GCSFilter } from '../../protocol/GCSFilter';
import { RequestSyncPacket } from '../../protocol/RequestSyncPacket';

/**
 * Gossip history reconciliation manager matching BitChat Android's
 * `sync/GossipSyncManager.kt` (https://github.com/permissionlesstech/bitchat-android/blob/main/docs/sync.md).
 *
 * - Stores latest `ANNOUNCE` per peer and up to `seenCapacity` (500) broadcast `MESSAGE`s
 * - Builds dependency-closed GCS filters (~400 B, 1% FPR) so receivers always get
 *   a sender's `ANNOUNCE` (public signing key) before or alongside their `MESSAGE`s
 * - Link-local only (`ttl = 0` for both `REQUEST_SYNC` and response packets)
 * - Responds with announcements first, then chronological messages, paced 20 ms apart
 *   under a single-active-response guard (`isResponding`, modeling Android `responseMutex`)
 */

export interface GossipSyncConfig {
    seenCapacity: number;
    gcsMaxBytes: number;
    gcsTargetFpr: number;
    periodicSyncIntervalMs: number;
    initialPeerSyncDelayMs: number;
    responsePaceMs: number;
    staleAnnouncementTimeoutMs: number;
}

export const DEFAULT_GOSSIP_SYNC_CONFIG: GossipSyncConfig = {
    seenCapacity: 500,
    gcsMaxBytes: 400,
    gcsTargetFpr: 0.01,
    periodicSyncIntervalMs: 30_000,
    initialPeerSyncDelayMs: 1_000,
    responsePaceMs: 20,
    staleAnnouncementTimeoutMs: 180_000,
};

interface CachedAnnouncement {
    senderHex: string;
    packet: BitchatPacket;
    idBytes: Uint8Array;
    idHex: string;
    timestampMs: number;
    cachedAtMs: number;
}

interface CachedMessage {
    senderHex: string;
    packet: BitchatPacket;
    idBytes: Uint8Array;
    idHex: string;
    timestampMs: number;
    cachedAtMs: number;
}

export class GossipSyncManager {
    readonly config: GossipSyncConfig;
    private announcements: Map<string, CachedAnnouncement> = new Map();
    private messages: Map<string, CachedMessage> = new Map();
    isResponding: boolean = false;

    constructor(config: Partial<GossipSyncConfig> = {}) {
        this.config = { ...DEFAULT_GOSSIP_SYNC_CONFIG, ...config };
    }

    /** Record a public ANNOUNCE or broadcast MESSAGE into the local gossip cache. */
    onPublicPacketSeen(packet: BitchatPacket, nowMs: number): void {
        const senderHex = toHex(packet.senderID);

        if (packet.type === MessageType.ANNOUNCE) {
            const tsMs = Number(packet.timestamp);
            const existing = this.announcements.get(senderHex);
            if (existing && tsMs < existing.timestampMs) {
                return;
            }
            const idBytes = computePacketIdBytes(packet);
            this.announcements.set(senderHex, {
                senderHex,
                packet: { ...packet },
                idBytes,
                idHex: toHex(idBytes),
                timestampMs: tsMs,
                cachedAtMs: nowMs,
            });
            return;
        }

        if (packet.type === MessageType.MESSAGE && isBroadcastRecipient(packet.recipientID)) {
            const idBytes = computePacketIdBytes(packet);
            const idHex = toHex(idBytes);
            if (this.messages.has(idHex)) return;

            this.messages.set(idHex, {
                senderHex,
                packet: { ...packet },
                idBytes,
                idHex,
                timestampMs: Number(packet.timestamp),
                cachedAtMs: nowMs,
            });

            // FIFO eviction past seenCapacity
            while (this.messages.size > this.config.seenCapacity) {
                const oldestKey = this.messages.keys().next().value;
                if (oldestKey !== undefined) {
                    this.messages.delete(oldestKey);
                } else {
                    break;
                }
            }
        }
    }

    removeAnnouncementForPeer(peerHex: string): void {
        this.announcements.delete(peerHex);
    }

    pruneStaleAnnouncements(nowMs: number): void {
        const cutoff = nowMs - this.config.staleAnnouncementTimeoutMs;
        for (const [peerHex, entry] of this.announcements) {
            if (entry.cachedAtMs < cutoff) {
                this.announcements.delete(peerHex);
            }
        }
    }

    /**
     * Build a dependency-closed GCS `REQUEST_SYNC` payload.
     * Reserves room for all cached announcements first, then admits newest messages
     * whose sender announcement is present (or always includes them in dependency-closed order).
     */
    buildRequestSyncPayload(nowMs: number): Uint8Array {
        this.pruneStaleAnnouncements(nowMs);

        const p = GCSFilter.deriveP(this.config.gcsTargetFpr);
        const maxElements = GCSFilter.estimateMaxElements(this.config.gcsMaxBytes, p);

        const includedIds: Uint8Array[] = [];
        const includedSenders = new Set<string>();

        // 1. Include newest announcements first
        const sortedAnnounces = Array.from(this.announcements.values()).sort(
            (a, b) => b.timestampMs - a.timestampMs
        );
        for (const ann of sortedAnnounces) {
            if (includedIds.length >= maxElements) break;
            includedIds.push(ann.idBytes);
            includedSenders.add(ann.senderHex);
        }

        // 2. Include newest messages whose sender announcement is accounted for (dependency-closed)
        const sortedMsgs = Array.from(this.messages.values()).sort(
            (a, b) => b.timestampMs - a.timestampMs
        );
        for (const msg of sortedMsgs) {
            if (includedIds.length >= maxElements) break;
            if (!this.announcements.has(msg.senderHex) || includedSenders.has(msg.senderHex)) {
                includedIds.push(msg.idBytes);
            }
        }

        const gcs = GCSFilter.buildFilter(
            includedIds,
            this.config.gcsMaxBytes,
            this.config.gcsTargetFpr
        );
        return RequestSyncPacket.encode(gcs);
    }

    /**
     * Given a peer's `REQUEST_SYNC` payload, compute all locally cached packets missing
     * from the peer's GCS filter.
     * Returns announcements first (so receiver learns signing keys), then messages chronologically,
     * all cloned with `ttl = 0` (strictly link-local).
     */
    computeMissingPackets(requestPayload: Uint8Array, nowMs: number): BitchatPacket[] {
        this.pruneStaleAnnouncements(nowMs);
        const req = RequestSyncPacket.decode(requestPayload);
        if (!req) return [];

        const peerSet = GCSFilter.decodeToSortedSet(req.p, req.m, req.data);
        const missingAnnounces: BitchatPacket[] = [];
        const missingMessages: BitchatPacket[] = [];
        const announcedSendersSent = new Set<string>();

        // 1. Missing announcements first
        const announces = Array.from(this.announcements.values()).sort(
            (a, b) => a.timestampMs - b.timestampMs
        );
        for (const ann of announces) {
            if (!GCSFilter.contains(peerSet, req.p, req.m, ann.idBytes)) {
                missingAnnounces.push({ ...ann.packet, ttl: 0 });
                announcedSendersSent.add(ann.senderHex);
            }
        }

        // 2. Missing messages in chronological order
        const msgs = Array.from(this.messages.values()).sort(
            (a, b) => a.timestampMs - b.timestampMs
        );
        for (const msg of msgs) {
            if (!GCSFilter.contains(peerSet, req.p, req.m, msg.idBytes)) {
                // Dependency closure: if we also have the sender's announce and haven't queued it yet,
                // ensure the receiver has the signing key even on a GCS false positive for the announce.
                const senderAnn = this.announcements.get(msg.senderHex);
                if (senderAnn && !announcedSendersSent.has(msg.senderHex)) {
                    missingAnnounces.push({ ...senderAnn.packet, ttl: 0 });
                    announcedSendersSent.add(msg.senderHex);
                }
                missingMessages.push({ ...msg.packet, ttl: 0 });
            }
        }

        return [...missingAnnounces, ...missingMessages];
    }

    getCachedAnnouncementCount(): number {
        return this.announcements.size;
    }

    getCachedMessageCount(): number {
        return this.messages.size;
    }

    hasCachedMessage(packet: BitchatPacket): boolean {
        return this.messages.has(computePacketIdHex(packet));
    }

    clear(): void {
        this.announcements.clear();
        this.messages.clear();
        this.isResponding = false;
    }
}
