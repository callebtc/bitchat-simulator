import { BitchatDevice, DeviceRuntime, DeviceTickable, PowerMode } from '../BitchatDevice';
import { BitchatConnection } from '../BitchatConnection';
import { PeerManager } from './PeerManager';
import { MeshGraph } from './MeshGraph';
import { SecurityManager } from './SecurityManager';
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
    policy: MeshPolicy;
    messages: ChatMessage[] = [];

    private lastAnnounceTime: number = -1;
    private currentAnnounceDelay: number = 0;
    private lastPeerCleanupTime: number = 0;
    private logger?: LogManager;
    private runtime?: DeviceRuntime;
    private currentNowMs: number = 0;

    /** Direct link binding: connection.linkID -> observed direct peerIDHex (bound on ttl === maxTtl ANNOUNCE). */
    private linkPeerBindings: Map<string, string> = new Map();

    /** Pending jittered relays keyed by packetId so duplicates can cancel them (iOS policy). */
    private scheduledRelays: Map<string, ScheduledEventHandle> = new Map();

    /** iOS source-route failure suppression: recipientPeerHex -> suppressUntilMs. */
    private suppressedSourceRoutes: Map<string, number> = new Map();
    /** iOS pending confirmation timers: recipientPeerHex -> handle. */
    private pendingRouteConfirmations: Map<string, ScheduledEventHandle> = new Map();

    // Config
    isAnnouncing: boolean = true;

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

        // Dynamic direct-link lookup matching Android BluetoothMeshService.kt:181
        this.peerManager.isPeerDirectlyConnected = (peerID: string) =>
            this.hasBoundDirectLink(peerID);

        // Cascade cleanup when a peer leaves or expires
        this.peerManager.onPeerRemoved = (peerID: string) => {
            this.meshGraph.removePeer(peerID);
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
     * Matches Android BluetoothMeshService.onDeviceConnected (+200ms client / +1200ms server).
     */
    onConnectionEstablished(connection: BitchatConnection, nowMs: number): void {
        this.currentNowMs = nowMs;
        if (!this.isAnnouncing) return;

        const isClient = connection.initiator === this.device;
        const delayMs = isClient
            ? this.policy.announceOnConnectClientDelayMs
            : this.policy.announceOnConnectServerDelayMs;

        if (this.runtime?.scheduler) {
            this.runtime.scheduler.scheduleIn(
                delayMs,
                fireNow => {
                    if (connection.isActive && this.isAnnouncing) {
                        this.sendAnnounce(fireNow);
                    }
                },
                `announce-on-connect:${this.device.peerIDHex}`
            );
        } else {
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

        // 1. Periodic stale peer cleanup (Android: every 60s, evict > 180s; iOS: 15s / 60s)
        if (now - this.lastPeerCleanupTime >= this.policy.peerCleanupIntervalMs) {
            this.lastPeerCleanupTime = now;
            this.peerManager.cleanupStalePeers(now, this.policy.stalePeerTimeoutMs);
            this.securityManager.cleanup(now, this.policy);
        }

        // 2. Periodic ANNOUNCE scheduler
        if (!this.isAnnouncing) return;

        const hasDirectLinks = this.device.connectionManager.getActiveConnections().length > 0;
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
        // Android PowerManager.kt:338-345
        switch (this.device.powerMode) {
            case PowerMode.ECO:
                return 60_000;
            case PowerMode.NORMAL:
                return this.policy.announceIntervalConnectedMs;
            case PowerMode.PERFORMANCE:
            default:
                return this.policy.announceIntervalConnectedMs;
        }
    }

    private log(message: string, details?: Record<string, unknown>, level: 'INFO' | 'DEBUG' = 'INFO'): void {
        if (this.logger) {
            const hexId = this.device.peerIDHex;
            this.logger.log(level, 'PACKET', message, hexId, details, getPeerColor(hexId));
        }
    }

    sendAnnounce(nowMs: number = this.now()): void {
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
        const nowMs = this.now();
        const payload = new TextEncoder().encode(text);
        const packet = this.buildAndOriginatePacket(
            MessageType.MESSAGE,
            payload,
            recipientIdHex,
            nowMs,
            recipientIdHex ? 'dm' : 'broadcast'
        );

        const packetId = computePacketIdHex(packet);
        this.messages.push({
            id: packetId,
            timestamp: nowMs,
            senderId: this.device.peerIDHex,
            recipientId: recipientIdHex,
            text,
            isOutgoing: true,
        });
        return packetId;
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
        telemetryKind: 'broadcast' | 'dm' | 'file' | 'voice',
        minVersion: number = 1
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

        packet.signature = SecurityManager.signPacket(packet, this.device.signingPublicKey);
        const packetId = this.securityManager.markSeen(packet, nowMs, this.policy);

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

        // 1. Source-routed first-hop unicast
        let sent = false;
        if (firstHopHex) {
            sent = this.sendToDirectPeer(firstHopHex, packet, nowMs);
            if (!sent) {
                this.runtime?.telemetry.recordSourceRouteFallback();
            }
        }

        // 2. Direct-recipient unicast shortcut (Android BluetoothPacketBroadcaster.kt:397-425)
        if (!sent && recipientIdHex && this.policy.useDirectRecipientShortcut) {
            sent = this.sendToDirectPeer(recipientIdHex, packet, nowMs);
            if (sent) {
                this.runtime?.telemetry.recordDirectShortcutUnicast();
            }
        }

        // 3. Fallback to policy broadcast
        if (!sent) {
            this.broadcastViaPolicy(packet, undefined, undefined, nowMs);
        }

        return packet;
    }

    private handlePacket(
        packet: BitchatPacket,
        from: BitchatDevice,
        ingressConnection?: BitchatConnection
    ): void {
        const nowMs = this.now();
        const senderHex = toHex(packet.senderID);

        // Any inbound traffic from a peer confirms its active source route (iOS)
        this.clearRouteConfirmation(senderHex);

        // Cancel pending jittered relay if a duplicate arrives before our relay timer fires (iOS)
        const prePacketId = computePacketIdHex(packet);
        if (this.policy.cancelScheduledRelayOnDuplicate) {
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
            peerHex => this.peerManager.getPeer(peerHex)?.signingPublicKey
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
        const hops = Math.max(1, this.policy.maxTtl - packet.ttl + 1);
        const transportName = ingressConnection?.transportType ?? 'BLE';

        // 1. Dispatch by packet type
        if (packet.type === MessageType.ANNOUNCE) {
            this.handleAnnounce(packet, from, ingressConnection, nowMs, packetId, hops, transportName);
        } else if (packet.type === MessageType.LEAVE) {
            this.peerManager.removePeer(senderHex);
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

        // If this was a re-admitted duplicate direct ANNOUNCE, we refreshed link binding above;
        // do not re-relay it again to avoid redundant floods.
        if (validation.isDuplicateDirectAnnounce) {
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

        const relayPacket: BitchatPacket = { ...packet, ttl: decision.newTtl };

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

    private handleAnnounce(
        packet: BitchatPacket,
        from: BitchatDevice,
        ingressConnection: BitchatConnection | undefined,
        nowMs: number,
        packetId: string,
        hops: number,
        transportName: string
    ): void {
        const tlvs = TLV.decode(packet.payload);
        const nickBytes = tlvs.get(TLVType.NICKNAME);
        const noiseKeyBytes = tlvs.get(TLVType.NOISE_PUBLIC_KEY);
        const signingKeyBytes = tlvs.get(TLVType.SIGNING_PUBLIC_KEY);
        const neighborsBytes = tlvs.get(TLVType.DIRECT_NEIGHBORS);
        const capBytes = tlvs.get(TLVType.CAPABILITIES);
        const senderHex = toHex(packet.senderID);

        const nickname = nickBytes ? TLV.decodeNickname(nickBytes) : 'Unknown';
        const capabilities = capBytes ? TLV.decodeCapabilities(capBytes) : undefined;

        // DirectLinkAnnouncementPolicy: direct observation ONLY when ttl === maxTtl
        const isDirectTtl = packet.ttl === this.policy.maxTtl;
        if (isDirectTtl && ingressConnection) {
            this.linkPeerBindings.set(ingressConnection.linkID, senderHex);
        }
        const isDirect = isDirectTtl && from.peerIDHex === senderHex;

        // Update MeshGraph with timestamp ordering and 10-neighbor cap
        const neighborHexes = neighborsBytes
            ? TLV.decodeNeighbors(neighborsBytes).map(toHex)
            : [];
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
        for (const conn of targets) {
            // Legacy fallback when ingressConnection wasn't supplied (unit tests)
            if (!ingressConnection && ingressDevice && conn.getOtherParty(this.device) === ingressDevice) {
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

        // Android prefers server-side notification links; iOS prefers client/peripheral write links
        matching.sort((a, b) => {
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
        const activeIds = new Set(
            this.device.connectionManager.getActiveConnections().map(c => c.linkID)
        );
        for (const [linkID, peer] of this.linkPeerBindings) {
            if (peer === peerIDHex && activeIds.has(linkID)) {
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
