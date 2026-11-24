import { BitchatPacket, MessageType, isBroadcastRecipient } from '../../protocol/BitchatPacket';
import { BitchatConnection } from '../BitchatConnection';
import { SeededRandom, hashString32 } from '../SeededRandom';

/**
 * Pluggable mesh protocol policy allowing Android-faithful baseline simulation,
 * iOS flood-control preset comparison, mixed fleets, and custom A/B experiments.
 *
 * Upstream references:
 * - Android: PacketRelayManager.kt, SecurityManager.kt, PeerManager.kt,
 *   BluetoothPacketBroadcaster.kt, PowerManager.kt, AppConstants.kt
 * - iOS: RelayController.swift, BLEFanoutSelector.swift,
 *   BLESourceRouteOriginationPolicy.swift, TransportConfig.swift
 */

export type MeshPolicyPreset = 'android' | 'ios';

export interface MeshPolicy {
    preset: MeshPolicyPreset;
    maxTtl: number;

    // Relay & flood control
    /** Android drops only at ttl === 0 (relays down to ttl 0 -> 8 hops). iOS drops at ttl <= 1 (7 hops). */
    relayWhenTtlReachesZero: boolean;
    /** Android probabilistic relay for low TTL (< 4) in networks > 10 peers. */
    useProbabilisticRelay: boolean;
    /** iOS degree-based TTL clamping (dense >= 6 clamps broadcast TTL to 5). */
    useDegreeTtlClamping: boolean;
    highDegreeThreshold: number;
    /** iOS randomized relay jitter (10-220ms by degree); Android only jitters VOICE_FRAME (8-25ms). */
    useBroadcastRelayJitter: boolean;
    /** iOS cancels a pending jittered relay if a duplicate arrives before transmission. */
    cancelScheduledRelayOnDuplicate: boolean;
    /** iOS deterministic ~log2(degree) link subsetting for non-announce/non-fragment broadcasts. */
    useFanoutSubsetting: boolean;
    /** iOS collapses dual-role duplicate links to the same peer before sending. */
    collapseDuplicatePeerLinks: boolean;
    /** Unicast directly to recipient when directly connected instead of flooding (Android & iOS). */
    useDirectRecipientShortcut: boolean;
    /** Android prefers server notifications over client writes for unicast; iOS prefers peripheral writes. */
    preferServerLinkForUnicast: boolean;

    // Security & dedup
    /** Drop MESSAGE/FILE_TRANSFER/VOICE_FRAME/LEAVE from senders without a verified ANNOUNCE key. */
    requireVerifiedAnnounceBeforeRelay: boolean;
    /** Android SecurityManager re-admits direct (ttl >= maxTtl) duplicate ANNOUNCE to bind new links. */
    readmitDirectAnnounceDuplicates: boolean;
    dedupMaxEntries: number;
    dedupWindowMs: number;

    // Presence, topology & source routing
    maxNeighborsInAnnounce: number;
    /** Max intermediate hops for originated source routes (Infinity on Android, 4 on iOS). */
    maxSourceRouteHops: number;
    /** iOS source-route confirmation & suppression windows (0 = disabled on Android). */
    sourceRouteConfirmationWindowMs: number;
    sourceRouteSuppressionMs: number;
    /** Android UnifiedMeshService only sends periodic announces when hasDirectPeers is true. */
    announceOnlyWhenConnected: boolean;
    announceOnConnectClientDelayMs: number;
    announceOnConnectServerDelayMs: number;
    /** Base periodic announce interval in ms (power-mode scaled on Android). */
    announceIntervalConnectedMs: number;
    announceIntervalIsolatedMs: number;
    disconnectGraceMs: number;
    stalePeerTimeoutMs: number;
    peerCleanupIntervalMs: number;
    sendLeaveOnStop: boolean;
}

export const ANDROID_DEFAULT_POLICY: MeshPolicy = {
    preset: 'android',
    maxTtl: 7,

    relayWhenTtlReachesZero: true,
    useProbabilisticRelay: true,
    useDegreeTtlClamping: false,
    highDegreeThreshold: 6,
    useBroadcastRelayJitter: false,
    cancelScheduledRelayOnDuplicate: false,
    useFanoutSubsetting: false,
    collapseDuplicatePeerLinks: false,
    useDirectRecipientShortcut: true,
    preferServerLinkForUnicast: true,

    requireVerifiedAnnounceBeforeRelay: true,
    readmitDirectAnnounceDuplicates: true,
    dedupMaxEntries: 10_000,
    dedupWindowMs: 300_000,

    maxNeighborsInAnnounce: 10,
    maxSourceRouteHops: Number.POSITIVE_INFINITY,
    sourceRouteConfirmationWindowMs: 0,
    sourceRouteSuppressionMs: 0,
    announceOnlyWhenConnected: true,
    announceOnConnectClientDelayMs: 200,
    announceOnConnectServerDelayMs: 1200,
    announceIntervalConnectedMs: 30_000,
    announceIntervalIsolatedMs: 30_000,
    disconnectGraceMs: 10_000,
    stalePeerTimeoutMs: 180_000,
    peerCleanupIntervalMs: 60_000,
    sendLeaveOnStop: true,
};

export const IOS_POLICY: MeshPolicy = {
    preset: 'ios',
    maxTtl: 7,

    relayWhenTtlReachesZero: false,
    useProbabilisticRelay: false,
    useDegreeTtlClamping: true,
    highDegreeThreshold: 6,
    useBroadcastRelayJitter: true,
    cancelScheduledRelayOnDuplicate: true,
    useFanoutSubsetting: true,
    collapseDuplicatePeerLinks: true,
    useDirectRecipientShortcut: true,
    preferServerLinkForUnicast: false,

    requireVerifiedAnnounceBeforeRelay: true,
    readmitDirectAnnounceDuplicates: true,
    dedupMaxEntries: 1_000,
    dedupWindowMs: 300_000,

    maxNeighborsInAnnounce: 10,
    maxSourceRouteHops: 4,
    sourceRouteConfirmationWindowMs: 10_000,
    sourceRouteSuppressionMs: 60_000,
    announceOnlyWhenConnected: false,
    announceOnConnectClientDelayMs: 600,
    announceOnConnectServerDelayMs: 400,
    announceIntervalConnectedMs: 15_000,
    announceIntervalIsolatedMs: 4_000,
    disconnectGraceMs: 8_000,
    stalePeerTimeoutMs: 60_000,
    peerCleanupIntervalMs: 15_000,
    sendLeaveOnStop: true,
};

export function createMeshPolicy(
    preset: MeshPolicyPreset = 'android',
    overrides?: Partial<MeshPolicy>
): MeshPolicy {
    const base = preset === 'ios' ? IOS_POLICY : ANDROID_DEFAULT_POLICY;
    return { ...base, ...overrides };
}

export interface RelayContext {
    networkSize: number;
    degree: number;
    senderIsSelf: boolean;
    recipientIsSelf: boolean;
}

export interface RelayDecision {
    shouldRelay: boolean;
    newTtl: number;
    delayMs: number;
    dropReason?: 'ttl_expired' | 'probabilistic_relay';
}

/**
 * Computes relay decision according to the active MeshPolicy.
 * - Android: PacketRelayManager.kt (exact TTL, voice dense clamp + 8-25ms jitter,
 *   network-size probabilistic relay for newTtl < 4).
 * - iOS: RelayController.swift (degree-based TTL clamping + jitter window).
 */
export function evaluateRelayDecision(
    packet: BitchatPacket,
    ctx: RelayContext,
    policy: MeshPolicy,
    rng: SeededRandom
): RelayDecision {
    // REQUEST_SYNC is strictly link-local on both platforms
    if (packet.type === MessageType.REQUEST_SYNC) {
        return { shouldRelay: false, newTtl: 0, delayMs: 0 };
    }

    if (ctx.senderIsSelf || ctx.recipientIsSelf) {
        return { shouldRelay: false, newTtl: packet.ttl, delayMs: 0 };
    }

    const ttlCap = Math.min(packet.ttl, policy.maxTtl);

    if (policy.relayWhenTtlReachesZero) {
        // Android PacketRelayManager.kt: drop only at ttl == 0; decrement and allow ttl == 0 emission
        if (ttlCap <= 0) {
            return { shouldRelay: false, newTtl: 0, delayMs: 0, dropReason: 'ttl_expired' };
        }
        let newTtl = ttlCap - 1;
        let delayMs = 0;

        if (packet.type === MessageType.VOICE_FRAME) {
            if (ctx.networkSize > policy.highDegreeThreshold) {
                newTtl = Math.min(newTtl, 5);
            }
            delayMs = rng.nextInt(8, 25);
        }

        if (policy.useProbabilisticRelay && newTtl < 4 && ctx.networkSize > 10) {
            const prob = androidRelayProbability(ctx.networkSize);
            if (!rng.nextBool(prob)) {
                return {
                    shouldRelay: false,
                    newTtl,
                    delayMs: 0,
                    dropReason: 'probabilistic_relay',
                };
            }
        }

        return { shouldRelay: true, newTtl, delayMs };
    }

    // iOS RelayController.swift semantics
    if (ttlCap <= 1) {
        return { shouldRelay: false, newTtl: ttlCap, delayMs: 0, dropReason: 'ttl_expired' };
    }

    const isHandshake = packet.type === MessageType.NOISE_HANDSHAKE;
    const isDirected = !isBroadcastRecipient(packet.recipientID);
    const isDirectedEncrypted = packet.type === MessageType.NOISE_ENCRYPTED && isDirected;
    const isFragment = packet.type === MessageType.FRAGMENT;
    const isDirectedFragment = isFragment && isDirected;
    const isVoice = packet.type === MessageType.VOICE_FRAME;
    const isAnnounce = packet.type === MessageType.ANNOUNCE;

    if (isHandshake || isDirectedFragment || isDirectedEncrypted) {
        const delayMs = policy.useBroadcastRelayJitter
            ? isHandshake
                ? rng.nextInt(10, 35)
                : rng.nextInt(20, 60)
            : 0;
        return { shouldRelay: true, newTtl: ttlCap - 1, delayMs };
    }

    if (isFragment || isVoice) {
        const cap =
            policy.useDegreeTtlClamping && ctx.degree >= policy.highDegreeThreshold ? 5 : 7;
        const limit = Math.min(ttlCap, cap);
        if (limit <= 1) {
            return { shouldRelay: false, newTtl: limit, delayMs: 0, dropReason: 'ttl_expired' };
        }
        const delayMs = rng.nextInt(8, 25);
        return { shouldRelay: true, newTtl: limit - 1, delayMs };
    }

    let ttlLimit = ttlCap;
    if (policy.useDegreeTtlClamping) {
        if (ctx.degree >= policy.highDegreeThreshold) {
            ttlLimit = Math.max(2, Math.min(ttlCap, 5));
        } else if (ctx.degree <= 2) {
            ttlLimit = ttlCap;
        } else {
            const preferred = isAnnounce ? 7 : 6;
            ttlLimit = Math.max(2, Math.min(ttlCap, preferred));
        }
    }

    let delayMs = 0;
    if (policy.useBroadcastRelayJitter) {
        if (ctx.degree <= 2) delayMs = rng.nextInt(10, 40);
        else if (ctx.degree <= 5) delayMs = rng.nextInt(60, 150);
        else if (ctx.degree <= 9) delayMs = rng.nextInt(80, 180);
        else delayMs = rng.nextInt(100, 220);
    }

    return { shouldRelay: true, newTtl: ttlLimit - 1, delayMs };
}

export function androidRelayProbability(networkSize: number): number {
    if (networkSize <= 10) return 1.0;
    if (networkSize <= 30) return 0.85;
    if (networkSize <= 50) return 0.7;
    if (networkSize <= 100) return 0.55;
    return 0.4;
}

/**
 * Selects egress links for a broadcast/relay transmission:
 * - Excludes ingress link (split horizon) and links bound to packet originator
 * - Optionally collapses duplicate links to the same peer (iOS BLEFanoutSelector)
 * - Optionally subsets broadcast links to ~log2(degree) deterministically seeded by packetId
 */
export function selectFanoutLinks(params: {
    ownerPeerId: string;
    connections: BitchatConnection[];
    ingressLinkId?: string;
    originatorPeerId?: string;
    linkPeerBindings: Map<string, string>;
    packetType: number;
    isDirected: boolean;
    packetId: string;
    policy: MeshPolicy;
}): BitchatConnection[] {
    const {
        ownerPeerId,
        connections,
        ingressLinkId,
        originatorPeerId,
        linkPeerBindings,
        packetType,
        isDirected,
        packetId,
        policy,
    } = params;

    // 1. Split horizon + originator exclusion
    let candidates = connections.filter(conn => {
        if (!conn.isActive || !conn.isReady) return false;
        if (ingressLinkId && conn.linkID === ingressLinkId) return false;
        const boundPeer = linkPeerBindings.get(conn.linkID);
        if (originatorPeerId && boundPeer === originatorPeerId) return false;
        return true;
    });

    // 2. Optional duplicate-peer link collapse (iOS collapses for non-announce traffic)
    if (policy.collapseDuplicatePeerLinks && packetType !== MessageType.ANNOUNCE) {
        const seenPeers = new Set<string>();
        const collapsed: BitchatConnection[] = [];
        // Prefer client (peripheral write) links like iOS BLEFanoutSelector
        const ordered = [...candidates].sort((a, b) => {
            const aClient = a.initiator.peerIDHex === ownerPeerId ? 0 : 1;
            const bClient = b.initiator.peerIDHex === ownerPeerId ? 0 : 1;
            return aClient - bClient;
        });
        for (const conn of ordered) {
            const boundPeer = linkPeerBindings.get(conn.linkID);
            if (boundPeer) {
                if (seenPeers.has(boundPeer)) continue;
                seenPeers.add(boundPeer);
            }
            collapsed.push(conn);
        }
        candidates = collapsed;
    }

    // 3. Optional deterministic ~log2(n) broadcast fanout subsetting (iOS BLEFanoutSelector.swift:78-89)
    // Subsets client (peripheral-write) links and server (central-notify) links separately, matching iOS.
    const shouldSubset =
        policy.useFanoutSubsetting &&
        !isDirected &&
        packetType !== MessageType.ANNOUNCE &&
        packetType !== MessageType.FRAGMENT &&
        packetType !== MessageType.REQUEST_SYNC;

    if (!shouldSubset || candidates.length <= 2) {
        return candidates;
    }

    const subsetBucket = (bucket: BitchatConnection[]): BitchatConnection[] => {
        const k = iosSubsetSize(bucket.length);
        if (k >= bucket.length) return bucket;
        const scored = bucket.map(conn => ({
            conn,
            score: hashString32(`${packetId}::${conn.linkID}`),
        }));
        scored.sort((a, b) =>
            a.score !== b.score ? a.score - b.score : a.conn.linkID.localeCompare(b.conn.linkID)
        );
        return scored.slice(0, k).map(s => s.conn);
    };

    const clientBucket = candidates.filter(c => c.initiator.peerIDHex === ownerPeerId);
    const serverBucket = candidates.filter(c => c.initiator.peerIDHex !== ownerPeerId);
    return [...subsetBucket(clientBucket), ...subsetBucket(serverBucket)];
}

export function iosSubsetSize(count: number): number {
    if (count <= 0) return 0;
    if (count <= 2) return count;
    let value = count - 1;
    let bits = 0;
    while (value > 0) {
        value >>= 1;
        bits++;
    }
    return Math.min(count, Math.max(1, bits + 1));
}
