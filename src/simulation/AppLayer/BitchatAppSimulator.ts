import { BitchatDevice, DeviceRuntime, DeviceTickable } from '../BitchatDevice';
import { resolveBlePowerProfile } from '../PowerProfile';
import { BitchatConnection } from '../BitchatConnection';
import { PeerManager } from './PeerManager';
import { MeshGraph } from './MeshGraph';
import { SecurityManager } from './SecurityManager';
import { FRAGMENT_CONFIG, FragmentManager } from './FragmentManager';
import { GossipSyncManager } from './GossipSyncManager';
import { NoisePayloadType, NoiseSessionManager } from './NoiseSessionManager';
import { MessageRouter } from './MessageRouter';
import { TransportBridge } from '../TransportBridge';
import {
    MeshPolicy,
    MeshPolicyPreset,
    createMeshPolicy,
    evaluateRelayDecision,
    selectFanoutLinks,
} from './MeshPolicy';
import {
    BitchatPacket,
    MessageType,
    SpecialRecipients,
    clonePacketWithTtl,
    computePacketIdHex,
    createPacket,
    hexToBytes,
    isBroadcastRecipient,
    toHex,
} from '../../protocol/BitchatPacket';
import { TLV, TLVType } from '../../protocol/TLV';
import { LogManager } from '../LogManager';
import { ScheduledEventHandle } from '../EventScheduler';
import { getPeerColor } from '../../utils/colorUtils';

interface DecodedAnnounceCacheEntry {
    nickname: string;
    noiseKeyBytes?: Uint8Array;
    signingKeyBytes?: Uint8Array;
    neighborHexes: string[];
    capabilities?: number;
}

const decodedAnnounceCache = new WeakMap<Uint8Array, DecodedAnnounceCacheEntry>();

function decodeAnnounceCached(payload: Uint8Array): DecodedAnnounceCacheEntry {
    const cached = decodedAnnounceCache.get(payload);
    if (cached) return cached;
    const tlvs = TLV.decode(payload);
    const nickBytes = tlvs.get(TLVType.NICKNAME);
    const noiseKeyBytes = tlvs.get(TLVType.NOISE_PUBLIC_KEY);
    const signingKeyBytes = tlvs.get(TLVType.SIGNING_PUBLIC_KEY);
    const neighborsBytes = tlvs.get(TLVType.DIRECT_NEIGHBORS);
    const capBytes = tlvs.get(TLVType.CAPABILITIES);
    const entry: DecodedAnnounceCacheEntry = {
        nickname: nickBytes ? TLV.decodeNickname(nickBytes) : 'Unknown',
        noiseKeyBytes,
        signingKeyBytes,
        neighborHexes: neighborsBytes ? TLV.decodeNeighbors(neighborsBytes).map(toHex) : [],
        capabilities: capBytes ? TLV.decodeCapabilities(capBytes) : undefined,
    };
    decodedAnnounceCache.set(payload, entry);
    return entry;
}

/** Resend a DM if no DELIVERED ACK arrives within this window. */
const DM_ACK_TIMEOUT_MS = 8_000;
/** Total sends (original + resends) before a DM is abandoned. */
const DM_MAX_SEND_ATTEMPTS = 4;
/** How long ciphertext waits for an in-flight msg3 before being discarded. */
const PENDING_DECRYPT_TTL_MS = 10_000;
const PENDING_DECRYPT_MAX_PER_PEER = 16;
const RECOVERY_HANDSHAKE_COOLDOWN_MS = 5_000;
/** Fallback suppression window when the policy defines none (matches iOS 60 s). */
const SOURCE_ROUTE_FAILURE_SUPPRESS_MS = 60_000;

export interface ChatMessage {
    id: string;
    timestamp: number;
    senderId: string;
    recipientId?: string; // undefined = Broadcast
    text: string;
    isOutgoing: boolean;
}

export class BitchatAppSimulator implements DeviceTickable {
    device: BitchatDevice;
    peerManager: PeerManager;
    meshGraph: MeshGraph;
    securityManager: SecurityManager;
    fragmentManager: FragmentManager;
    gossipSync: GossipSyncManager;
    noiseManager: NoiseSessionManager;
    messageRouter: MessageRouter;
    transportBridge: TransportBridge;
    policy: MeshPolicy;
    messages: ChatMessage[] = [];
    /** IDs of outgoing private DMs confirmed by a Noise DELIVERED ACK. */
    deliveredMessageIds: Set<string> = new Set();

    /**
     * Outgoing PRIVATE_MESSAGEs sent over an established session but not yet
     * confirmed by a DELIVERED ACK. Resent on timeout; see `sweepUnackedDms`.
     */
    private awaitingAck: Map<
        string,
        { recipientHex: string; body: Uint8Array; lastSentAtMs: number; attempts: number; queued: boolean }
    > = new Map();
    /**
     * NOISE_ENCRYPTED frames that arrived while we were the responder waiting
     * for msg3 of the same handshake (multi-hop relay jitter can reorder msg3
     * and the first transport message). Replayed once the session completes.
     */
    private pendingDecrypt: Map<
        string,
        Array<{ packet: BitchatPacket; hops: number; transport: string; receivedAtMs: number }>
    > = new Map();
    /** Inbound DM ids already shown, so ACK-driven resends are not duplicated. */
    private receivedDmIds: Set<string> = new Set();
    /** Cooldown for handshakes we start because a peer sent undecryptable traffic. */
    private recoveryHandshakeAt: Map<string, number> = new Map();

    private lastAnnounceTime: number = -1;
    private currentAnnounceDelay: number = 0;
    private lastPeerCleanupTime: number = 0;
    private lastFragmentCleanupTime: number = 0;
    private lastPeriodicSyncTime: number = 0;
    private logger?: LogManager;
    private runtime?: DeviceRuntime;
    private currentNowMs: number = 0;

    /** Direct link binding: connection.linkID -> observed direct peerIDHex (bound on ttl === maxTtl ANNOUNCE). */
    private linkPeerBindings: Map<string, string> = new Map();
    /** Peers for which initial 1 s post-connect gossip sync has already been scheduled. */
    private initialSyncScheduledPeers: Set<string> = new Set();

    /** Pending coalesced announce-on-connect timer (avoids N-link boot announce storm). */
    private pendingConnectAnnounce: ScheduledEventHandle | null = null;
    private lastConnectAnnounceSentAtMs: number = -10_000;
    /** Pending jittered relays keyed by packetId so duplicates can cancel them (iOS policy). */
    private scheduledRelays: Map<string, ScheduledEventHandle> = new Map();

    /** iOS source-route failure suppression: recipientPeerHex -> suppressUntilMs. */
    private suppressedSourceRoutes: Map<string, number> = new Map();
    /** iOS pending confirmation timers: recipientPeerHex -> handle. */
    private pendingRouteConfirmations: Map<string, ScheduledEventHandle> = new Map();

    // Config
    isAnnouncing: boolean = true;
    isSyncEnabled: boolean = true;

    constructor(
        device: BitchatDevice,
        policyOrPreset: MeshPolicy | MeshPolicyPreset = 'android'
    ) {
        this.device = device;
        this.policy =
            typeof policyOrPreset === 'string'
                ? createMeshPolicy(policyOrPreset)
                : { ...policyOrPreset };
        this.peerManager = new PeerManager();
        this.meshGraph = new MeshGraph();
        this.securityManager = new SecurityManager(device.peerIDHex);
        this.fragmentManager = new FragmentManager();
        this.gossipSync = new GossipSyncManager();
        this.noiseManager = new NoiseSessionManager(device.peerIDHex);
        this.messageRouter = new MessageRouter();
        this.transportBridge = new TransportBridge();

        // Dynamic direct-link lookup matching Android BluetoothMeshService.kt:181
        this.peerManager.isPeerDirectlyConnected = (peerID: string) =>
            this.hasBoundDirectLink(peerID);

        // Cascade cleanup when a peer leaves or expires
        this.peerManager.onPeerRemoved = (peerID: string) => {
            this.meshGraph.removePeer(peerID);
            this.gossipSync.removeAnnouncementForPeer(peerID);
            this.noiseManager.removeSession(peerID);
            this.messageRouter.clearPeerRetryState(peerID);
            this.pendingDecrypt.delete(peerID);
            this.initialSyncScheduledPeers.delete(peerID);
            this.clearRouteConfirmation(peerID);
        };

        this.device.onPacketReceived = (p, from, conn) => this.handlePacket(p, from, conn);
    }

    setPolicy(policyOrPreset: MeshPolicy | MeshPolicyPreset): void {
        this.policy =
            typeof policyOrPreset === 'string'
                ? createMeshPolicy(policyOrPreset)
                : { ...policyOrPreset };
    }

    shouldCollapseDuplicateLinks(): boolean {
        return this.policy.collapseDuplicatePeerLinks;
    }

    attachRuntime(runtime: DeviceRuntime): void {
        this.runtime = runtime;
    }

    setLogger(logger: LogManager): void {
        this.logger = logger;
    }

    private now(): number {
        return this.runtime ? this.runtime.clock() : this.currentNowMs;
    }

    /**
     * Called by SimulationEngine when a physical link becomes ready.
     * Matches Android BluetoothMeshService.onDeviceConnected (+200ms client / +1200ms server),
     * coalesced per device so simultaneous multi-link handshakes do not flood duplicate announces.
     */
    onConnectionEstablished(connection: BitchatConnection, nowMs: number): void {
        this.currentNowMs = nowMs;
        if (!this.isAnnouncing) return;

        // Avoid redundant full-mesh announce flood if we just announced within the last 1.5 s
        if (nowMs - this.lastConnectAnnounceSentAtMs < 1_500) {
            return;
        }

        const isClient = connection.initiator === this.device;
        const delayMs = isClient
            ? this.policy.announceOnConnectClientDelayMs
            : this.policy.announceOnConnectServerDelayMs;

        if (this.runtime?.scheduler) {
            // Coalesce overlapping connect-announce timers on the same device
            if (this.pendingConnectAnnounce) {
                return;
            }
            this.pendingConnectAnnounce = this.runtime.scheduler.scheduleIn(
                delayMs,
                fireNow => {
                    this.pendingConnectAnnounce = null;
                    if (
                        this.isAnnouncing &&
                        this.device.connectionManager.getActiveConnections().length > 0
                    ) {
                        this.lastConnectAnnounceSentAtMs = fireNow;
                        this.sendAnnounce(fireNow);
                    }
                },
                `announce-on-connect:${this.device.peerIDHex}`
            );
        } else {
            this.lastConnectAnnounceSentAtMs = nowMs;
            this.sendAnnounce(nowMs);
        }
    }

    /**
     * Called by SimulationEngine when a physical link breaks.
     * Enforces Android's 10-second disconnect grace period before evicting the peer.
     */
    onConnectionBroken(connection: BitchatConnection, nowMs: number): void {
        this.currentNowMs = nowMs;
        const boundPeer = this.linkPeerBindings.get(connection.linkID);
        this.linkPeerBindings.delete(connection.linkID);

        if (!boundPeer) return;

        const disconnectedAt = nowMs;
        const checkEvict = (checkNow: number): void => {
            const linkBack = this.hasBoundDirectLink(boundPeer);
            const info = this.peerManager.getPeer(boundPeer);
            const seenAfter = (info?.lastSeen ?? 0) > disconnectedAt;
            if (!linkBack && !seenAfter) {
                this.peerManager.removePeer(boundPeer);
                this.log(
                    'Peer removed after disconnect grace',
                    { peer: boundPeer.substring(0, 8), at: checkNow },
                    'DEBUG'
                );
            }
        };

        if (this.runtime?.scheduler) {
            this.runtime.scheduler.scheduleIn(
                this.policy.disconnectGraceMs,
                checkEvict,
                `disconnect-grace:${this.device.peerIDHex}:${boundPeer}`
            );
        }
    }

    /**
     * Graceful departure: broadcasts a signed LEAVE (0x03) packet.
     */
    onGracefulStop(nowMs: number): void {
        if (!this.policy.sendLeaveOnStop) return;
        const packet = createPacket(
            MessageType.LEAVE,
            this.device.peerID,
            new Uint8Array(0),
            this.policy.maxTtl,
            SpecialRecipients.BROADCAST,
            nowMs
        );
        packet.signature = SecurityManager.signPacket(packet, this.device.signingPublicKey);
        this.securityManager.markSeen(packet, nowMs, this.policy);
        this.broadcastViaPolicy(packet, undefined, undefined, nowMs);
    }

    tick(now: number): void {
        this.currentNowMs = now;

        // 1. Periodic stale peer & fragment cleanup
        if (now - this.lastPeerCleanupTime >= this.policy.peerCleanupIntervalMs) {
            this.lastPeerCleanupTime = now;
            this.peerManager.cleanupStalePeers(now, this.policy.stalePeerTimeoutMs);
            this.securityManager.cleanup(now, this.policy);
            this.transportBridge.cleanup(now);
        }
        if (now - this.lastFragmentCleanupTime >= FRAGMENT_CONFIG.CLEANUP_INTERVAL_MS) {
            this.lastFragmentCleanupTime = now;
            const expired = this.fragmentManager.cleanupExpired(now);
            for (let i = 0; i < expired; i++) {
                this.runtime?.telemetry.recordDrop('fragment_timeout');
            }
        }

        // 2. Periodic MessageRouter outbox expiration & handshake retries (every 2 s)
        const routerTick = this.messageRouter.tick(now);
        for (let i = 0; i < routerTick.expiredCount; i++) {
            this.runtime?.telemetry.recordDrop('outbox_expired');
        }
        for (const peerHex of routerTick.peersToRetryHandshake) {
            if (
                !this.noiseManager.hasEstablishedSession(peerHex) &&
                this.peerManager.getPeer(peerHex)
            ) {
                this.initiateNoiseHandshake(peerHex, now, true);
            }
        }
        this.sweepUnackedDms(now);

        // 3. Periodic Gossip Sync (REQUEST_SYNC, ttl=0, every 30 s when connected)
        const hasDirectLinks = this.device.connectionManager.getActiveConnections().length > 0;
        if (
            this.isSyncEnabled &&
            hasDirectLinks &&
            now - this.lastPeriodicSyncTime >= this.gossipSync.config.periodicSyncIntervalMs
        ) {
            this.lastPeriodicSyncTime = now;
            this.sendSyncRequest(undefined, now);
        }

        // 4. Periodic ANNOUNCE scheduler
        if (!this.isAnnouncing) return;

        if (this.policy.announceOnlyWhenConnected && !hasDirectLinks) {
            return;
        }

        const baseInterval = this.getAnnounceIntervalMs(hasDirectLinks);

        if (this.lastAnnounceTime === -1) {
            this.lastAnnounceTime = now;
            this.currentAnnounceDelay = this.device.rng.next() * baseInterval;
        }

        if (now - this.lastAnnounceTime >= this.currentAnnounceDelay) {
            this.sendAnnounce(now);
            this.lastAnnounceTime = now;

            const jitter = (this.device.rng.next() - 0.5) * 0.4; // ±20%
            this.currentAnnounceDelay = baseInterval * (1 + jitter);
        }
    }

    private getAnnounceIntervalMs(hasDirectLinks: boolean): number {
        if (!hasDirectLinks) {
            return this.policy.announceIntervalIsolatedMs;
        }
        if (this.policy.preset === 'ios') {
            const degree = this.device.connectionManager.getActiveConnections().length;
            return degree >= this.policy.highDegreeThreshold ? 30_000 : 15_000;
        }
        // Android PowerManager.kt:338-345 (PowerProfileResolver)
        const profile = resolveBlePowerProfile(
            this.device.powerMode,
            this.device.isBackground,
            hasDirectLinks
        );
        return profile.announceIntervalMs;
    }

    private log(message: string, details?: Record<string, unknown>, level: 'INFO' | 'DEBUG' = 'INFO'): void {
        if (this.logger) {
            const hexId = this.device.peerIDHex;
            this.logger.log(level, 'PACKET', message, hexId, details, getPeerColor(hexId));
        }
    }

    sendAnnounce(nowMs: number = this.now()): void {
        // Keep periodic announce timer synchronized whenever an event-driven announce fires
        const hasDirectLinks = this.device.connectionManager.getActiveConnections().length > 0;
        const baseInterval = this.getAnnounceIntervalMs(hasDirectLinks);
        const jitter = (this.device.rng.next() - 0.5) * 0.4; // ±20%
        this.lastAnnounceTime = nowMs;
        this.currentAnnounceDelay = baseInterval * (1 + jitter);

        // Collect up to 10 verified direct neighbors (Android BluetoothMeshService.kt:1334-1349)
        const directNeighborHexes = this.getDirectNeighborHexesForGossip();
        const neighborBytes = directNeighborHexes.map(hex => hexToBytes(hex, 8));

        const payload = TLV.encodeIdentityAnnouncement({
            nickname: this.device.nickname,
            noisePublicKey: this.device.noisePublicKey,
            signingPublicKey: this.device.signingPublicKey,
            neighbors: neighborBytes,
            maxNeighbors: this.policy.maxNeighborsInAnnounce,
            capabilities: 0x0100,
        });

        const packet = createPacket(
            MessageType.ANNOUNCE,
            this.device.peerID,
            payload,
            this.policy.maxTtl,
            SpecialRecipients.BROADCAST,
            nowMs
        );
        packet.signature = SecurityManager.signPacket(packet, this.device.signingPublicKey);

        this.meshGraph.updateFromAnnouncement(
            this.device.peerIDHex,
            directNeighborHexes,
            packet.timestamp,
            this.policy.maxNeighborsInAnnounce
        );

        const packetId = this.securityManager.markSeen(packet, nowMs, this.policy);
        this.gossipSync.onPublicPacketSeen(packet, nowMs);
        const pop = Math.max(0, (this.runtime?.getPopulationCount?.() ?? 1) - 1);
        this.runtime?.telemetry.recordMessageOriginated(
            packetId,
            'announce',
            this.device.peerIDHex,
            nowMs,
            payload.length,
            pop
        );

        this.broadcastViaPolicy(packet, undefined, undefined, nowMs);

        this.log(
            'Broadcasting ANNOUNCE',
            { ttl: this.policy.maxTtl, neighbors: directNeighborHexes.length },
            'DEBUG'
        );
    }

    sendMessage(text: string, recipientIdHex?: string): string {
        if (recipientIdHex) {
            return this.sendPrivateMessage(text, recipientIdHex);
        }
        const nowMs = this.now();
        const payload = new TextEncoder().encode(text);
        const packet = this.buildAndOriginatePacket(
            MessageType.MESSAGE,
            payload,
            undefined,
            nowMs,
            'broadcast'
        );

        this.gossipSync.onPublicPacketSeen(packet, nowMs);

        const packetId = computePacketIdHex(packet);
        this.messages.push({
            id: packetId,
            timestamp: nowMs,
            senderId: this.device.peerIDHex,
            recipientId: undefined,
            text,
            isOutgoing: true,
        });
        return packetId;
    }

    /**
     * Send an end-to-end encrypted private DM over Noise XX (`NOISE_HANDSHAKE` + `NOISE_ENCRYPTED`).
     * Queues in `MessageRouter` outbox while the 3-step handshake completes, then flushes automatically.
     */
    sendPrivateMessage(text: string, recipientIdHex: string): string {
        const nowMs = this.now();
        const body = new TextEncoder().encode(text);
        const messageId = `dm-${this.device.peerIDHex.substring(0, 6)}-${Math.floor(nowMs)}-${this.device.rng.nextInt(0, 0xfffff)}`;

        this.messages.push({
            id: messageId,
            timestamp: nowMs,
            senderId: this.device.peerIDHex,
            recipientId: recipientIdHex,
            text,
            isOutgoing: true,
        });

        this.runtime?.telemetry.recordMessageOriginated(
            messageId,
            'dm',
            this.device.peerIDHex,
            nowMs,
            body.length,
            1,
            recipientIdHex
        );

        if (this.noiseManager.hasEstablishedSession(recipientIdHex)) {
            this.sendNoiseEncrypted(
                recipientIdHex,
                NoisePayloadType.PRIVATE_MESSAGE,
                messageId,
                body,
                nowMs
            );
        } else {
            this.messageRouter.enqueue({
                messageId,
                recipientHex: recipientIdHex,
                payloadType: NoisePayloadType.PRIVATE_MESSAGE,
                body,
                enqueuedAtMs: nowMs,
            });
            if (this.messageRouter.canAttemptHandshake(recipientIdHex, nowMs)) {
                this.initiateNoiseHandshake(recipientIdHex, nowMs, false);
            }
        }

        return messageId;
    }

    /**
     * Send a link-local `REQUEST_SYNC (0x21, ttl=0)` containing this node's GCS filter.
     * If `targetPeerHex` is provided, unicasts to that direct peer; otherwise broadcasts link-locally.
     */
    sendSyncRequest(targetPeerHex?: string, nowMs: number = this.now()): void {
        if (!this.isSyncEnabled) return;
        const payload = this.gossipSync.buildRequestSyncPayload(nowMs);
        const packet = createPacket(
            MessageType.REQUEST_SYNC,
            this.device.peerID,
            payload,
            0, // Strictly link-local (never relayed)
            targetPeerHex ? hexToBytes(targetPeerHex, 8) : SpecialRecipients.BROADCAST,
            nowMs
        );
        const packetId = this.securityManager.markSeen(packet, nowMs, this.policy);
        this.runtime?.telemetry.recordMessageOriginated(
            packetId,
            'sync',
            this.device.peerIDHex,
            nowMs,
            payload.length,
            targetPeerHex ? 1 : this.device.connectionManager.getActiveConnections().length,
            targetPeerHex
        );

        if (targetPeerHex) {
            this.sendToDirectPeer(targetPeerHex, packet, nowMs);
        } else {
            this.broadcastViaPolicy(packet, undefined, undefined, nowMs);
        }
    }

    /**
     * Delivery-ACK driven resend for private DMs (both upstream clients track
     * DELIVERED receipts for DMs and retry sends that never confirm).
     *  - 1st timeout on a live session: resend over the same session.
     *  - Repeated timeouts, or no session: assume the peer lost its session,
     *    re-key with a fresh Noise XX handshake and queue the DM in the outbox.
     *  - After DM_MAX_SEND_ATTEMPTS sends: give up (telemetry `dm_unacked`).
     * Also expires ciphertext held for handshakes that never completed.
     */
    private sweepUnackedDms(nowMs: number): void {
        for (const [peerHex, queue] of this.pendingDecrypt) {
            const kept = queue.filter(q => nowMs - q.receivedAtMs < PENDING_DECRYPT_TTL_MS);
            if (kept.length === 0) this.pendingDecrypt.delete(peerHex);
            else if (kept.length !== queue.length) this.pendingDecrypt.set(peerHex, kept);
        }

        if (this.awaitingAck.size === 0) return;
        for (const [messageId, entry] of this.awaitingAck) {
            if (entry.queued || nowMs - entry.lastSentAtMs < DM_ACK_TIMEOUT_MS) continue;
            // No ACK: the route (or the session) failed. Flood the next attempt.
            this.suppressSourceRoute(entry.recipientHex, nowMs);
            if (entry.attempts >= DM_MAX_SEND_ATTEMPTS) {
                this.awaitingAck.delete(messageId);
                this.runtime?.telemetry.recordDrop('dm_unacked');
                this.log('DM undelivered after retries', { to: entry.recipientHex.substring(0, 8), id: messageId });
                continue;
            }
            const session = this.noiseManager.getSession(entry.recipientHex);
            const freshSession =
                session?.state === 'established' && (session.establishedAtMs ?? 0) > entry.lastSentAtMs;
            if (session?.state === 'established' && (entry.attempts < 2 || freshSession)) {
                this.sendNoiseEncrypted(entry.recipientHex, NoisePayloadType.PRIVATE_MESSAGE, messageId, entry.body, nowMs);
                continue;
            }
            entry.queued = true;
            this.noiseManager.removeSession(entry.recipientHex);
            this.messageRouter.enqueue({
                messageId,
                recipientHex: entry.recipientHex,
                payloadType: NoisePayloadType.PRIVATE_MESSAGE,
                body: entry.body,
                enqueuedAtMs: nowMs,
            });
            this.initiateNoiseHandshake(entry.recipientHex, nowMs, true);
        }
    }

    private initiateNoiseHandshake(
        recipientIdHex: string,
        nowMs: number,
        forceRestart: boolean
    ): void {
        const isRetry = this.noiseManager.getSession(recipientIdHex)?.state === 'initiator_sent_msg1';
        const msg1 = this.noiseManager.initiateHandshake(recipientIdHex, nowMs, forceRestart);
        if (!msg1) return;
        if (isRetry) this.suppressSourceRoute(recipientIdHex, nowMs);
        this.messageRouter.recordHandshakeAttempt(recipientIdHex, nowMs);
        this.buildAndOriginatePacket(
            MessageType.NOISE_HANDSHAKE,
            msg1,
            recipientIdHex,
            nowMs,
            undefined,
            1,
            false
        );
    }

    private sendNoiseEncrypted(
        recipientIdHex: string,
        payloadType: NoisePayloadType,
        messageId: string,
        body: Uint8Array,
        nowMs: number
    ): void {
        if (payloadType === NoisePayloadType.PRIVATE_MESSAGE) {
            const prev = this.awaitingAck.get(messageId);
            this.awaitingAck.set(messageId, {
                recipientHex: recipientIdHex,
                body,
                lastSentAtMs: nowMs,
                attempts: (prev?.attempts ?? 0) + 1,
                queued: false,
            });
        }
        const encryptedPayload = NoiseSessionManager.encodeEncryptedPayload(
            payloadType,
            messageId,
            body
        );
        this.buildAndOriginatePacket(
            MessageType.NOISE_ENCRYPTED,
            encryptedPayload,
            recipientIdHex,
            nowMs,
            undefined,
            1,
            false
        );
    }

    sendVoiceFrame(payload: Uint8Array, recipientIdHex?: string): string {
        const nowMs = this.now();
        const packet = this.buildAndOriginatePacket(
            MessageType.VOICE_FRAME,
            payload,
            recipientIdHex,
            nowMs,
            'voice'
        );
        return computePacketIdHex(packet);
    }

    sendFile(payload: Uint8Array, recipientIdHex?: string): string {
        const nowMs = this.now();
        const packet = this.buildAndOriginatePacket(
            MessageType.FILE_TRANSFER,
            payload,
            recipientIdHex,
            nowMs,
            'file',
            2
        );
        return computePacketIdHex(packet);
    }

    private buildAndOriginatePacket(
        type: MessageType,
        payload: Uint8Array,
        recipientIdHex: string | undefined,
        nowMs: number,
        telemetryKind?: 'broadcast' | 'dm' | 'file' | 'voice',
        minVersion: number = 1,
        signPacket: boolean = true
    ): BitchatPacket {
        const recipientID = recipientIdHex ? hexToBytes(recipientIdHex, 8) : SpecialRecipients.BROADCAST;
        const packet = createPacket(
            type,
            this.device.peerID,
            payload,
            this.policy.maxTtl,
            recipientID,
            nowMs
        );
        packet.version = minVersion;

        // Source-route origination (Android BluetoothMeshService.applyRouteIfAvailable / iOS BLESourceRouteOriginationPolicy)
        let firstHopHex: string | undefined;
        if (recipientIdHex) {
            const isDirect = this.hasBoundDirectLink(recipientIdHex);
            const suppressedUntil = this.suppressedSourceRoutes.get(recipientIdHex) ?? 0;
            const routeAllowed = !isDirect && nowMs >= suppressedUntil;

            if (routeAllowed) {
                const path = this.meshGraph.getShortestPath(
                    this.device.peerIDHex,
                    recipientIdHex,
                    this.policy.maxSourceRouteHops
                );
                // Only attach v2 route when there is at least 1 intermediate hop (path.length >= 3)
                if (path && path.length >= 3) {
                    const intermediates = path.slice(1, path.length - 1);
                    packet.version = 2;
                    packet.route = intermediates.map(hex => hexToBytes(hex, 8));
                    firstHopHex = intermediates[0];
                    this.runtime?.telemetry.recordSourceRouteOriginated();
                    this.armRouteConfirmation(recipientIdHex, nowMs);
                    this.log('Computed Source Route', {
                        to: recipientIdHex.substring(0, 6),
                        hops: intermediates.length,
                    });
                }
            }
        }

        if (signPacket) {
            packet.signature = SecurityManager.signPacket(packet, this.device.signingPublicKey);
        }
        const packetId = this.securityManager.markSeen(packet, nowMs, this.policy);

        if (telemetryKind) {
            const expectedRecipients = recipientIdHex
                ? 1
                : Math.max(0, (this.runtime?.getPopulationCount?.() ?? 1) - 1);
            this.runtime?.telemetry.recordMessageOriginated(
                packetId,
                telemetryKind,
                this.device.peerIDHex,
                nowMs,
                payload.length,
                expectedRecipients,
                recipientIdHex
            );
        }

        // Fragment outbound packets exceeding 512 B BLE MTU, unless unicasting directly over Wi-Fi Aware
        const unicastTargetHex = firstHopHex ?? (recipientIdHex && this.policy.useDirectRecipientShortcut ? recipientIdHex : undefined);
        const bypassBleFragmentation =
            unicastTargetHex !== undefined &&
            this.device.connectionManager.hasActiveConnectionToPeer(unicastTargetHex, 'WIFI_AWARE');

        const frames = bypassBleFragmentation
            ? [packet]
            : this.fragmentManager.createFragments(packet, this.device.rng);
        if (frames.length === 0) return packet;

        const sendFrame = (frame: BitchatPacket, fireNow: number): void => {
            // Mark fragment seen so we don't re-relay our own fragments if looped
            if (frame.type === MessageType.FRAGMENT) {
                this.securityManager.markSeen(frame, fireNow, this.policy);
            }
            let sent = false;
            if (firstHopHex) {
                sent = this.sendToDirectPeer(firstHopHex, frame, fireNow);
                if (!sent) {
                    this.runtime?.telemetry.recordSourceRouteFallback();
                }
            }
            if (!sent && recipientIdHex && this.policy.useDirectRecipientShortcut) {
                sent = this.sendToDirectPeer(recipientIdHex, frame, fireNow);
                if (sent) {
                    this.runtime?.telemetry.recordDirectShortcutUnicast();
                }
            }
            if (!sent) {
                this.broadcastViaPolicy(frame, undefined, undefined, fireNow);
            }
        };

        if (frames.length === 1 || !this.runtime?.scheduler) {
            for (const f of frames) {
                sendFrame(f, nowMs);
            }
        } else {
            frames.forEach((f, idx) => {
                if (idx === 0) {
                    sendFrame(f, nowMs);
                } else {
                    this.runtime!.scheduler.scheduleIn(
                        idx * FRAGMENT_CONFIG.INTER_FRAGMENT_DELAY_MS,
                        fireNow => sendFrame(f, fireNow),
                        `frag-send:${this.device.peerIDHex}:${idx}/${frames.length}`
                    );
                }
            });
        }

        return packet;
    }

    private handlePacket(
        packet: BitchatPacket,
        from: BitchatDevice,
        ingressConnection?: BitchatConnection,
        options?: { overrideHops?: number; suppressRelay?: boolean }
    ): void {
        const nowMs = this.now();
        const senderHex = toHex(packet.senderID);

        // Any inbound traffic from a peer confirms its active source route (iOS)
        if (this.pendingRouteConfirmations.size > 0) {
            this.clearRouteConfirmation(senderHex);
        }

        // Cancel pending jittered relay if a duplicate arrives before our relay timer fires (iOS)
        if (this.policy.cancelScheduledRelayOnDuplicate && this.scheduledRelays.size > 0) {
            const prePacketId = computePacketIdHex(packet);
            const pendingHandle = this.scheduledRelays.get(prePacketId);
            if (pendingHandle && this.runtime?.scheduler.cancel(pendingHandle)) {
                this.scheduledRelays.delete(prePacketId);
                this.runtime.telemetry.recordDrop('cancelled_relay');
            }
        }

        // 0. SecurityManager validation (dedup + replay + verified-announce key gating)
        const validation = this.securityManager.validatePacket(
            packet,
            nowMs,
            this.policy,
            peerHex => this.peerManager.getPeer(peerHex)?.signingPublicKey,
            senderHex
        );

        if (!validation.valid) {
            if (validation.reason === 'duplicate') {
                this.runtime?.telemetry.recordDrop('duplicate');
            } else if (validation.reason === 'unknown_key') {
                this.runtime?.telemetry.recordDrop('unknown_key');
            }
            return;
        }

        const packetId = validation.packetId;
        const hops = options?.overrideHops ?? Math.max(1, this.policy.maxTtl - packet.ttl + 1);
        const transportName = ingressConnection?.transportType ?? 'BLE';

        // 1. Dispatch by packet type
        if (packet.type === MessageType.ANNOUNCE) {
            this.handleAnnounce(packet, from, ingressConnection, nowMs, packetId, hops, transportName);
        } else if (packet.type === MessageType.LEAVE) {
            this.peerManager.removePeer(senderHex);
        } else if (packet.type === MessageType.REQUEST_SYNC) {
            this.handleRequestSync(packet, senderHex, ingressConnection, nowMs);
            return; // Strictly link-local, never relayed
        } else if (packet.type === MessageType.NOISE_HANDSHAKE) {
            this.peerManager.updateLastSeen(senderHex, nowMs);
            if (this.isForMe(packet)) {
                this.handleNoiseHandshake(packet, senderHex, nowMs);
                return;
            }
        } else if (packet.type === MessageType.NOISE_ENCRYPTED) {
            this.peerManager.updateLastSeen(senderHex, nowMs);
            if (this.isForMe(packet)) {
                this.handleNoiseEncrypted(packet, senderHex, nowMs, hops, transportName);
                return;
            }
        } else if (packet.type === MessageType.FRAGMENT) {
            this.peerManager.updateLastSeen(senderHex, nowMs);
            if (this.isForMe(packet)) {
                const reassembled = this.fragmentManager.handleFragment(packet, nowMs);
                if (reassembled) {
                    // Reassembled packet has ttl=0 (processed locally; individual fragments relay below)
                    this.handlePacket(reassembled, from, ingressConnection, {
                        overrideHops: hops,
                        suppressRelay: true,
                    });
                }
            }
        } else if (
            packet.type === MessageType.MESSAGE ||
            packet.type === MessageType.FILE_TRANSFER ||
            packet.type === MessageType.VOICE_FRAME
        ) {
            this.peerManager.updateLastSeen(senderHex, nowMs);
            this.handleUserDataPacket(packet, senderHex, nowMs, packetId, hops, transportName);
        } else {
            this.peerManager.updateLastSeen(senderHex, nowMs);
        }

        // If this was a re-admitted duplicate direct ANNOUNCE or locally reassembled packet,
        // do not relay it again.
        if (validation.isDuplicateDirectAnnounce || options?.suppressRelay) {
            return;
        }

        // 2. Centralized Relay Logic (Android PacketRelayManager.kt / iOS RelayController.swift)
        const isForMe = this.isForMe(packet);
        if (isForMe && !isBroadcastRecipient(packet.recipientID)) {
            return; // Consumed by destination
        }

        const degree = this.device.connectionManager.getActiveConnections().length;
        const decision = evaluateRelayDecision(
            packet,
            {
                networkSize: Math.max(1, this.peerManager.getActivePeerCount()),
                degree,
                senderIsSelf: senderHex === this.device.peerIDHex,
                recipientIsSelf: isForMe && !isBroadcastRecipient(packet.recipientID),
            },
            this.policy,
            this.device.rng
        );

        if (!decision.shouldRelay) {
            if (decision.dropReason) {
                this.runtime?.telemetry.recordDrop(decision.dropReason);
            }
            return;
        }

        const relayPacket = clonePacketWithTtl(packet, decision.newTtl);

        const executeRelay = (relayNowMs: number): void => {
            this.scheduledRelays.delete(packetId);
            this.forwardRelayedPacket(relayPacket, senderHex, from, ingressConnection, relayNowMs);
        };

        if (decision.delayMs > 0 && this.runtime?.scheduler) {
            const handle = this.runtime.scheduler.scheduleIn(
                decision.delayMs,
                executeRelay,
                `relay:${this.device.peerIDHex}:${packetId.substring(0, 8)}`
            );
            this.scheduledRelays.set(packetId, handle);
        } else {
            executeRelay(nowMs);
        }
    }

    private forwardRelayedPacket(
        relayPacket: BitchatPacket,
        senderHex: string,
        from: BitchatDevice,
        ingressConnection: BitchatConnection | undefined,
        nowMs: number
    ): void {
        // 1. Source-based routing forwarding (PacketRelayManager.kt:77-106)
        if (relayPacket.route && relayPacket.route.length > 0 && relayPacket.version >= 2) {
            const routeHexes = relayPacket.route.map(toHex);
            // Duplicate-hop loop guard (PacketRelayManager.kt:80-83)
            if (new Set(routeHexes).size < routeHexes.length) {
                this.runtime?.telemetry.recordDrop('duplicate_hop');
                return;
            }

            const myIndex = routeHexes.indexOf(this.device.peerIDHex);
            if (myIndex !== -1) {
                const nextHopHex =
                    myIndex + 1 < routeHexes.length
                        ? routeHexes[myIndex + 1]
                        : relayPacket.recipientID
                          ? toHex(relayPacket.recipientID)
                          : undefined;

                if (nextHopHex && this.sendToDirectPeer(nextHopHex, relayPacket, nowMs)) {
                    this.runtime?.telemetry.recordSourceRouteHopForwarded();
                    return;
                }
                this.runtime?.telemetry.recordSourceRouteFallback();
            }
        }

        // 2. Direct-recipient unicast shortcut on relay (BluetoothPacketBroadcaster.kt:397-425)
        if (
            this.policy.useDirectRecipientShortcut &&
            relayPacket.recipientID &&
            !isBroadcastRecipient(relayPacket.recipientID)
        ) {
            const recipientHex = toHex(relayPacket.recipientID);
            if (this.sendToDirectPeer(recipientHex, relayPacket, nowMs)) {
                this.runtime?.telemetry.recordDirectShortcutUnicast();
                return;
            }
        }

        // 3. Policy broadcast (split horizon + originator exclusion + optional iOS fanout subsetting)
        this.broadcastViaPolicy(relayPacket, ingressConnection, from, nowMs, senderHex);
    }

    private handleUserDataPacket(
        packet: BitchatPacket,
        senderHex: string,
        nowMs: number,
        packetId: string,
        hops: number,
        transportName: string
    ): void {
        const isBroadcast = isBroadcastRecipient(packet.recipientID);
        const isForMe = this.isForMe(packet);
        if (!isBroadcast && !isForMe) return;

        this.runtime?.telemetry.recordMessageDelivered(
            packetId,
            this.device.peerIDHex,
            nowMs,
            hops,
            transportName
        );

        if (packet.type === MessageType.MESSAGE) {
            if (isBroadcast) {
                this.gossipSync.onPublicPacketSeen(packet, nowMs);
            }
            const text = new TextDecoder().decode(packet.payload);
            this.messages.push({
                id: packetId,
                timestamp: Number(packet.timestamp),
                senderId: senderHex,
                recipientId: isBroadcast ? undefined : this.device.peerIDHex,
                text,
                isOutgoing: false,
            });
        }
    }

    private handleRequestSync(
        packet: BitchatPacket,
        senderHex: string,
        ingressConnection: BitchatConnection | undefined,
        nowMs: number
    ): void {
        if (!this.isSyncEnabled || this.gossipSync.isResponding) return;
        const missing = this.gossipSync.computeMissingPackets(packet.payload, nowMs);
        if (missing.length === 0) return;

        const sendOne = (pkt: BitchatPacket, fireNow: number): void => {
            if (ingressConnection && ingressConnection.isActive && ingressConnection.isReady) {
                ingressConnection.send(pkt, this.device, fireNow);
            } else {
                this.sendToDirectPeer(senderHex, pkt, fireNow);
            }
        };

        if (!this.runtime?.scheduler || missing.length === 1) {
            for (const pkt of missing) {
                sendOne(pkt, nowMs);
            }
            return;
        }

        // Pace missing packets 20 ms apart under responseMutex (Android GossipSyncManager.kt)
        this.gossipSync.isResponding = true;
        const paceMs = this.gossipSync.config.responsePaceMs;
        missing.forEach((pkt, idx) => {
            const isLast = idx === missing.length - 1;
            const delayMs = idx * paceMs;
            if (delayMs === 0) {
                sendOne(pkt, nowMs);
                if (isLast) this.gossipSync.isResponding = false;
            } else {
                this.runtime!.scheduler.scheduleIn(
                    delayMs,
                    fireNow => {
                        sendOne(pkt, fireNow);
                        if (isLast) {
                            this.gossipSync.isResponding = false;
                        }
                    },
                    `sync-resp:${this.device.peerIDHex}:${idx}/${missing.length}`
                );
            }
        });
    }

    private handleNoiseHandshake(
        packet: BitchatPacket,
        senderHex: string,
        nowMs: number
    ): void {
        const priorState = this.noiseManager.getSession(senderHex)?.state;
        if (packet.payload[0] === 1 && priorState === 'responder_sent_msg2') {
            // Initiator is retrying msg1, so our msg2 never arrived: avoid the same route
            this.suppressSourceRoute(senderHex, nowMs);
        }
        const result = this.noiseManager.handleHandshakeMessage(senderHex, packet.payload, nowMs);
        if (result.responsePayload) {
            this.buildAndOriginatePacket(
                MessageType.NOISE_HANDSHAKE,
                result.responsePayload,
                senderHex,
                nowMs,
                undefined,
                1,
                false
            );
        }

        if (result.becameEstablished) {
            const flush = (fireNow: number): void => {
                const queued = this.messageRouter.flushForPeer(senderHex);
                for (const item of queued) {
                    this.sendNoiseEncrypted(
                        senderHex,
                        item.payloadType,
                        item.messageId,
                        item.body,
                        fireNow
                    );
                }
            };

            // Replay ciphertext that overtook msg3 on its way here
            const buffered = this.pendingDecrypt.get(senderHex);
            if (buffered) {
                this.pendingDecrypt.delete(senderHex);
                for (const b of buffered) {
                    this.handleNoiseEncrypted(b.packet, senderHex, nowMs, b.hops, b.transport);
                }
            }

            // If we just sent msg3 as initiator, pace outbox flush +25ms behind msg3
            if (result.responsePayload && this.runtime?.scheduler) {
                this.runtime.scheduler.scheduleIn(
                    25,
                    flush,
                    `noise-flush:${this.device.peerIDHex}:${senderHex}`
                );
            } else {
                flush(nowMs);
            }
        }
    }

    private handleNoiseEncrypted(
        packet: BitchatPacket,
        senderHex: string,
        nowMs: number,
        hops: number,
        transportName: string
    ): void {
        if (!this.noiseManager.hasEstablishedSession(senderHex)) {
            const session = this.noiseManager.getSession(senderHex);
            if (session?.state === 'responder_sent_msg2') {
                // Same handshake, msg3 still in flight: hold the ciphertext
                let queue = this.pendingDecrypt.get(senderHex);
                if (!queue) {
                    queue = [];
                    this.pendingDecrypt.set(senderHex, queue);
                }
                if (queue.length >= PENDING_DECRYPT_MAX_PER_PEER) queue.shift();
                queue.push({ packet, hops, transport: transportName, receivedAtMs: nowMs });
                return;
            }
            // No session for this ciphertext (peer expired us, or state desynced):
            // it cannot be decrypted. Re-key so the sender's ACK-timeout resend lands.
            const last = this.recoveryHandshakeAt.get(senderHex) ?? -Infinity;
            if (nowMs - last >= RECOVERY_HANDSHAKE_COOLDOWN_MS && session?.state !== 'initiator_sent_msg1') {
                this.recoveryHandshakeAt.set(senderHex, nowMs);
                this.log('Undecryptable DM, re-keying Noise session', { from: senderHex.substring(0, 8) });
                this.initiateNoiseHandshake(senderHex, nowMs, true);
            }
            return;
        }
        const inner = NoiseSessionManager.decodeEncryptedPayload(packet.payload);
        if (!inner) return;

        if (inner.payloadType === NoisePayloadType.PRIVATE_MESSAGE) {
            if (this.receivedDmIds.has(inner.messageId)) {
                // Resend of a DM we already have (our ACK was lost): just re-ACK
                this.sendNoiseEncrypted(senderHex, NoisePayloadType.DELIVERED, inner.messageId, new Uint8Array(0), nowMs);
                return;
            }
            if (this.receivedDmIds.size > 4096) this.receivedDmIds.clear();
            this.receivedDmIds.add(inner.messageId);
            const text = new TextDecoder().decode(inner.body);
            this.messages.push({
                id: inner.messageId,
                timestamp: Number(packet.timestamp),
                senderId: senderHex,
                recipientId: this.device.peerIDHex,
                text,
                isOutgoing: false,
            });
            this.runtime?.telemetry.recordMessageDelivered(
                inner.messageId,
                this.device.peerIDHex,
                nowMs,
                hops,
                transportName
            );
            // Send automatic DELIVERED ACK inside NOISE_ENCRYPTED
            this.sendNoiseEncrypted(
                senderHex,
                NoisePayloadType.DELIVERED,
                inner.messageId,
                new Uint8Array(0),
                nowMs
            );
        } else if (inner.payloadType === NoisePayloadType.DELIVERED) {
            this.awaitingAck.delete(inner.messageId);
            this.deliveredMessageIds.add(inner.messageId);
            this.log('DM DELIVERED ACK received', {
                from: senderHex.substring(0, 8),
                id: inner.messageId,
            });
        } else if (inner.payloadType === NoisePayloadType.VOICE_NOTE) {
            this.runtime?.telemetry.recordMessageDelivered(
                inner.messageId,
                this.device.peerIDHex,
                nowMs,
                hops,
                transportName
            );
        }
    }

    private handleAnnounce(
        packet: BitchatPacket,
        from: BitchatDevice,
        ingressConnection: BitchatConnection | undefined,
        nowMs: number,
        packetId: string,
        hops: number,
        transportName: string
    ): void {
        const decoded = decodeAnnounceCached(packet.payload);
        const senderHex = toHex(packet.senderID);
        const { nickname, noiseKeyBytes, signingKeyBytes, neighborHexes, capabilities } = decoded;

        // DirectLinkAnnouncementPolicy: direct observation ONLY when ttl === maxTtl
        const isDirectTtl = packet.ttl === this.policy.maxTtl;
        const wasVerifiedDirect = this.peerManager.isVerifiedDirectPeer(senderHex);
        if (isDirectTtl && ingressConnection) {
            this.linkPeerBindings.set(ingressConnection.linkID, senderHex);
            // Schedule initial peer gossip sync 1 s (+ small jitter) after direct peer binding
            if (
                this.isSyncEnabled &&
                this.runtime?.scheduler &&
                !this.initialSyncScheduledPeers.has(senderHex)
            ) {
                this.initialSyncScheduledPeers.add(senderHex);
                const staggerMs =
                    this.gossipSync.config.initialPeerSyncDelayMs +
                    Math.floor(this.device.rng.next() * 400);
                this.runtime.scheduler.scheduleIn(
                    staggerMs,
                    fireNow => {
                        if (this.hasBoundDirectLink(senderHex) && this.isSyncEnabled) {
                            this.sendSyncRequest(senderHex, fireNow);
                        }
                    },
                    `init-sync:${this.device.peerIDHex}:${senderHex}`
                );
            }
        }
        const isDirect = isDirectTtl && from.peerIDHex === senderHex;

        // Cache latest verified ANNOUNCE in GossipSyncManager for history reconciliation
        this.gossipSync.onPublicPacketSeen(packet, nowMs);

        // Update MeshGraph with timestamp ordering and 10-neighbor cap
        this.meshGraph.updateFromAnnouncement(
            senderHex,
            neighborHexes,
            packet.timestamp,
            this.policy.maxNeighborsInAnnounce
        );

        this.peerManager.updatePeer(
            senderHex,
            nickname,
            isDirect,
            Math.max(0, this.policy.maxTtl - packet.ttl),
            nowMs,
            {
                noisePublicKey: noiseKeyBytes,
                signingPublicKey: signingKeyBytes ?? from.signingPublicKey,
                isVerified: true,
                capabilities,
            }
        );

        // If a newly verified direct neighbor just appeared, schedule one debounced announce
        // so our updated DIRECT_NEIGHBORS TLV (0x04) propagates for bidirectional MeshGraph edges.
        if (isDirect && !wasVerifiedDirect && this.isAnnouncing && this.runtime?.scheduler) {
            if (!this.pendingConnectAnnounce) {
                const sinceLast = nowMs - this.lastConnectAnnounceSentAtMs;
                const delayMs = Math.max(300, 1_200 - sinceLast);
                this.pendingConnectAnnounce = this.runtime.scheduler.scheduleIn(
                    delayMs,
                    fireNow => {
                        this.pendingConnectAnnounce = null;
                        if (
                            this.isAnnouncing &&
                            this.device.connectionManager.getActiveConnections().length > 0
                        ) {
                            this.lastConnectAnnounceSentAtMs = fireNow;
                            this.sendAnnounce(fireNow);
                        }
                    },
                    `announce-neighbor-update:${this.device.peerIDHex}`
                );
            }
        }

        this.runtime?.telemetry.recordMessageDelivered(
            packetId,
            this.device.peerIDHex,
            nowMs,
            hops,
            transportName
        );
    }

    private broadcastViaPolicy(
        packet: BitchatPacket,
        ingressConnection: BitchatConnection | undefined,
        ingressDevice: BitchatDevice | undefined,
        nowMs: number,
        originatorPeerId?: string
    ): boolean {
        const active = this.device.connectionManager.getActiveConnections();
        if (active.length === 0) return false;

        // Zero-allocation fast path when duplicate collapse & iOS fanout subsetting do not apply
        const needsCollapse =
            this.policy.collapseDuplicatePeerLinks && packet.type !== MessageType.ANNOUNCE;
        const needsSubset =
            this.policy.useFanoutSubsetting &&
            packet.type !== MessageType.ANNOUNCE &&
            packet.type !== MessageType.FRAGMENT &&
            packet.type !== MessageType.REQUEST_SYNC &&
            isBroadcastRecipient(packet.recipientID);

        if (!needsCollapse && !needsSubset) {
            const ingressLinkId = ingressConnection?.linkID;
            let accepted = false;
            for (let i = 0; i < active.length; i++) {
                const conn = active[i];
                if (!conn.isActive || !conn.isReady) continue;
                if (ingressLinkId && conn.linkID === ingressLinkId) continue;
                if (
                    !ingressConnection &&
                    ingressDevice &&
                    conn.getOtherParty(this.device) === ingressDevice
                ) {
                    continue;
                }
                if (originatorPeerId) {
                    const boundPeer = this.linkPeerBindings.get(conn.linkID);
                    if (boundPeer === originatorPeerId) continue;
                }
                if (
                    ingressConnection &&
                    conn.transportType !== ingressConnection.transportType &&
                    !this.transportBridge.shouldBridge(
                        packet,
                        ingressConnection.transportType,
                        conn.transportType,
                        nowMs
                    )
                ) {
                    continue;
                }
                if (conn.send(packet, this.device, nowMs)) {
                    accepted = true;
                }
            }
            return accepted;
        }

        const targets = selectFanoutLinks({
            ownerPeerId: this.device.peerIDHex,
            connections: active,
            ingressLinkId: ingressConnection?.linkID,
            originatorPeerId,
            linkPeerBindings: this.linkPeerBindings,
            packetType: packet.type,
            isDirected: !isBroadcastRecipient(packet.recipientID),
            packetId: computePacketIdHex(packet),
            policy: this.policy,
        });

        let accepted = false;
        for (let i = 0; i < targets.length; i++) {
            const conn = targets[i];
            // Legacy fallback when ingressConnection wasn't supplied (unit tests)
            if (!ingressConnection && ingressDevice && conn.getOtherParty(this.device) === ingressDevice) {
                continue;
            }
            // Cross-transport bridging guard (Android TransportBridgeService.kt: 4096-entry / 5-min dedup)
            if (
                ingressConnection &&
                conn.transportType !== ingressConnection.transportType &&
                !this.transportBridge.shouldBridge(
                    packet,
                    ingressConnection.transportType,
                    conn.transportType,
                    nowMs
                )
            ) {
                continue;
            }
            if (conn.send(packet, this.device, nowMs)) {
                accepted = true;
            }
        }
        return accepted;
    }

    private sendToDirectPeer(
        targetPeerHex: string,
        packet: BitchatPacket,
        nowMs: number
    ): boolean {
        const active = this.device.connectionManager.getActiveConnections();
        // Match bound links first; fall back to physical peer match for standalone unit tests
        const matching = active.filter(conn => {
            if (!conn.isActive || !conn.isReady) return false;
            const bound = this.linkPeerBindings.get(conn.linkID);
            if (bound) return bound === targetPeerHex;
            return conn.getOtherParty(this.device).peerIDHex === targetPeerHex;
        });

        if (matching.length === 0) return false;

        // UnifiedMeshService: prefer high-throughput Wi-Fi Aware first; among BLE links,
        // Android prefers server notification links while iOS prefers client write links.
        matching.sort((a, b) => {
            const aWifi = a.transportType === 'WIFI_AWARE' ? 0 : 1;
            const bWifi = b.transportType === 'WIFI_AWARE' ? 0 : 1;
            if (aWifi !== bWifi) return aWifi - bWifi;
            const aIsServer = a.initiator !== this.device ? 0 : 1;
            const bIsServer = b.initiator !== this.device ? 0 : 1;
            return this.policy.preferServerLinkForUnicast
                ? aIsServer - bIsServer
                : bIsServer - aIsServer;
        });

        for (const conn of matching) {
            if (conn.send(packet, this.device, nowMs)) {
                return true;
            }
        }
        return false;
    }

    private hasBoundDirectLink(peerIDHex: string): boolean {
        const active = this.device.connectionManager.getActiveConnections();
        for (let i = 0; i < active.length; i++) {
            if (this.linkPeerBindings.get(active[i].linkID) === peerIDHex) {
                return true;
            }
        }
        return false;
    }

    private getDirectNeighborHexesForGossip(): string[] {
        const verifiedDirect = this.peerManager.getVerifiedDirectPeerIDs();
        if (verifiedDirect.length > 0) {
            return verifiedDirect.slice(0, this.policy.maxNeighborsInAnnounce);
        }
        // Before first round of verified announces completes, report active physical peers if any
        return this.device.connectionManager
            .getConnectedPeers()
            .map(p => p.peerIDHex)
            .slice(0, this.policy.maxNeighborsInAnnounce);
    }

    /**
     * Stop source-routing to `peerHex` and flood instead (iOS-style 60 s
     * suppression). Used when end-to-end evidence (missing DM ACK, stalled
     * handshake) shows the MeshGraph route is failing, for both presets: a
     * route through a dead or lossy hop would otherwise be reused on every retry.
     */
    private suppressSourceRoute(peerHex: string, nowMs: number): void {
        const ms = this.policy.sourceRouteSuppressionMs > 0 ? this.policy.sourceRouteSuppressionMs : SOURCE_ROUTE_FAILURE_SUPPRESS_MS;
        this.clearRouteConfirmation(peerHex);
        this.suppressedSourceRoutes.set(peerHex, nowMs + ms);
    }

    private armRouteConfirmation(recipientHex: string, _nowMs: number): void {
        if (this.policy.sourceRouteConfirmationWindowMs <= 0 || !this.runtime?.scheduler) return;
        this.clearRouteConfirmation(recipientHex);
        const handle = this.runtime.scheduler.scheduleIn(
            this.policy.sourceRouteConfirmationWindowMs,
            fireNow => {
                this.pendingRouteConfirmations.delete(recipientHex);
                this.suppressedSourceRoutes.set(
                    recipientHex,
                    fireNow + this.policy.sourceRouteSuppressionMs
                );
            },
            `sr-confirm:${this.device.peerIDHex}:${recipientHex}`
        );
        this.pendingRouteConfirmations.set(recipientHex, handle);
    }

    private clearRouteConfirmation(peerHex: string): void {
        const handle = this.pendingRouteConfirmations.get(peerHex);
        if (handle) {
            this.runtime?.scheduler.cancel(handle);
            this.pendingRouteConfirmations.delete(peerHex);
        }
    }

    private isForMe(packet: BitchatPacket): boolean {
        if (!packet.recipientID || isBroadcastRecipient(packet.recipientID)) return false;
        for (let i = 0; i < 8; i++) {
            if (packet.recipientID[i] !== this.device.peerID[i]) return false;
        }
        return true;
    }
}
