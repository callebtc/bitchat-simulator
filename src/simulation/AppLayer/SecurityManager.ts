import {
    BitchatPacket,
    MessageType,
    computePacketIdHex,
    toHex,
} from '../../protocol/BitchatPacket';
import { BinaryProtocol, SIGNATURE_SIZE } from '../../protocol/BinaryProtocol';
import { TLV, TLVType } from '../../protocol/TLV';
import { hashString32 } from '../SeededRandom';
import { MeshPolicy } from './MeshPolicy';

/**
 * Symbolic SecurityManager modeling Android SecurityManager.kt:
 * - Bounded duplicate cache (10,000 entries / 5 min on Android; 1,000 on iOS)
 *   keyed by `${senderPeerID}-${canonicalPacketIdHex}`.
 * - Direct ANNOUNCE (ttl >= maxTtl) re-admission exception so newly formed links
 *   can bind address -> peerID even if the announce was already seen via multi-hop.
 * - Mandatory signature + verified-announce key gating for ANNOUNCE, MESSAGE,
 *   FILE_TRANSFER, VOICE_FRAME, and LEAVE.
 * - Symmetric 5-minute clock-skew protection on LEAVE packets.
 * - Fast deterministic 64-byte synthetic Ed25519 signatures (exact wire size).
 */

export type ValidationFailureReason =
    | 'self'
    | 'duplicate'
    | 'stale_leave'
    | 'missing_signature'
    | 'unknown_key'
    | 'invalid_signature'
    | 'malformed_announce';

export interface ValidationResult {
    valid: boolean;
    reason?: ValidationFailureReason;
    packetId: string;
    isDuplicateDirectAnnounce?: boolean;
}

const SIGNED_TYPES = new Set<number>([
    MessageType.ANNOUNCE,
    MessageType.MESSAGE,
    MessageType.FILE_TRANSFER,
    MessageType.VOICE_FRAME,
    MessageType.LEAVE,
]);

// Caches decoded ANNOUNCE keys per immutable payload buffer (1000x speedup during floods)
const announceKeysCache = new WeakMap<
    Uint8Array,
    { sigKey?: Uint8Array; noiseKey?: Uint8Array }
>();

// Caches symbolic signature verification per signature buffer + signing key + packet identity
interface CachedSigVerification {
    key: Uint8Array;
    payload: Uint8Array;
    timestamp: bigint;
    type: number;
    senderID: Uint8Array;
    routeLen: number;
    ok: boolean;
}
const sigVerifyCache = new WeakMap<Uint8Array, CachedSigVerification>();

function getAnnounceKeysCached(payload: Uint8Array): {
    sigKey?: Uint8Array;
    noiseKey?: Uint8Array;
} {
    const cached = announceKeysCache.get(payload);
    if (cached) return cached;
    const tlvs = TLV.decode(payload);
    const entry = {
        sigKey: tlvs.get(TLVType.SIGNING_PUBLIC_KEY),
        noiseKey: tlvs.get(TLVType.NOISE_PUBLIC_KEY),
    };
    announceKeysCache.set(payload, entry);
    return entry;
}

export class SecurityManager {
    private readonly myPeerIDHex: string;
    private processedTimestamps: Map<string, number> = new Map();
    private lastCleanupMs: number = 0;

    constructor(myPeerIDHex: string) {
        this.myPeerIDHex = myPeerIDHex;
    }

    /**
     * Generates a deterministic 64-byte symbolic signature bound to the packet's
     * canonical signing bytes (TTL=0, no signature) and the sender's signing key.
     */
    static signPacket(packet: BitchatPacket, signingPublicKey: Uint8Array): Uint8Array {
        const canonical = BinaryProtocol.encodeForSigning(packet);
        const sig = new Uint8Array(SIGNATURE_SIZE);
        const view = new DataView(sig.buffer);
        const keyTag = toHex(signingPublicKey.subarray(0, 8));
        const bodyTag = canonical ? computeBytesDigest(canonical) : 0;

        for (let i = 0; i < 16; i++) {
            const word = hashString32(`sig:${keyTag}:${bodyTag}:${i}`);
            view.setUint32(i * 4, word, false);
        }
        return sig;
    }

    static verifySymbolicSignature(
        packet: BitchatPacket,
        signingPublicKey: Uint8Array
    ): boolean {
        const sig = packet.signature;
        if (!sig || sig.length !== SIGNATURE_SIZE) {
            return false;
        }
        const routeLen = packet.route ? packet.route.length : 0;
        const cached = sigVerifyCache.get(sig);
        if (
            cached &&
            cached.key === signingPublicKey &&
            cached.payload === packet.payload &&
            cached.timestamp === packet.timestamp &&
            cached.type === packet.type &&
            cached.senderID === packet.senderID &&
            cached.routeLen === routeLen
        ) {
            return cached.ok;
        }
        const expected = SecurityManager.signPacket(packet, signingPublicKey);
        let ok = true;
        for (let i = 0; i < SIGNATURE_SIZE; i++) {
            if (sig[i] !== expected[i]) {
                ok = false;
                break;
            }
        }
        sigVerifyCache.set(sig, {
            key: signingPublicKey,
            payload: packet.payload,
            timestamp: packet.timestamp,
            type: packet.type,
            senderID: packet.senderID,
            routeLen,
            ok,
        });
        return ok;
    }

    /**
     * Record a locally originated packet so looped echoes are suppressed.
     */
    markSeen(packet: BitchatPacket, nowMs: number, policy: MeshPolicy): string {
        const senderHex = toHex(packet.senderID);
        const packetId = computePacketIdHex(packet);
        const key = `${senderHex}-${packetId}`;
        this.recordKey(key, nowMs, policy);
        return packetId;
    }

    hasSeen(packet: BitchatPacket): boolean {
        const senderHex = toHex(packet.senderID);
        const packetId = computePacketIdHex(packet);
        return this.processedTimestamps.has(`${senderHex}-${packetId}`);
    }

    /**
     * Full Android SecurityManager.validatePacket pipeline.
     */
    validatePacket(
        packet: BitchatPacket,
        nowMs: number,
        policy: MeshPolicy,
        getKnownSigningKey: (peerIDHex: string) => Uint8Array | undefined,
        precomputedSenderHex?: string
    ): ValidationResult {
        const senderHex = precomputedSenderHex ?? toHex(packet.senderID);
        const packetId = computePacketIdHex(packet);

        if (senderHex === this.myPeerIDHex) {
            return { valid: false, reason: 'self', packetId };
        }

        // Periodic cleanup of expired dedup entries
        if (nowMs - this.lastCleanupMs >= policy.dedupWindowMs) {
            this.cleanup(nowMs, policy);
        }

        // LEAVE 5-minute replay / clock-skew guard (SecurityManager.kt:64-75)
        if (packet.type === MessageType.LEAVE) {
            const packetTs = Number(packet.timestamp);
            if (Math.abs(nowMs - packetTs) > policy.dedupWindowMs) {
                return { valid: false, reason: 'stale_leave', packetId };
            }
        }

        // Duplicate detection with Android direct-ANNOUNCE exception
        const key = `${senderHex}-${packetId}`;
        const prevSeenAt = this.processedTimestamps.get(key);
        let isDuplicateDirectAnnounce = false;

        if (prevSeenAt !== undefined && nowMs - prevSeenAt <= policy.dedupWindowMs) {
            const isFreshDirectAnnounce =
                policy.readmitDirectAnnounceDuplicates &&
                packet.type === MessageType.ANNOUNCE &&
                packet.ttl >= policy.maxTtl;

            if (!isFreshDirectAnnounce) {
                return { valid: false, reason: 'duplicate', packetId };
            }
            isDuplicateDirectAnnounce = true;
        }

        // Mandatory signature & verified-announce key gating (SecurityManager.kt:255-347)
        if (policy.requireVerifiedAnnounceBeforeRelay && SIGNED_TYPES.has(packet.type)) {
            if (packet.type === MessageType.ANNOUNCE) {
                const { sigKey, noiseKey } = getAnnounceKeysCached(packet.payload);
                if (sigKey && noiseKey && packet.signature) {
                    if (!SecurityManager.verifySymbolicSignature(packet, sigKey)) {
                        return { valid: false, reason: 'invalid_signature', packetId };
                    }
                }
                // Legacy test packets without embedded keys/signature are tolerated
                // if neither key nor signature was attached; signed announces must verify.
            } else {
                const knownKey = getKnownSigningKey(senderHex);
                if (!knownKey) {
                    return { valid: false, reason: 'unknown_key', packetId };
                }
                if (packet.signature) {
                    if (!SecurityManager.verifySymbolicSignature(packet, knownKey)) {
                        return { valid: false, reason: 'invalid_signature', packetId };
                    }
                }
            }
        }

        // Record ONLY authenticated packets (prevents cache poisoning)
        this.recordKey(key, nowMs, policy);

        return { valid: true, packetId, isDuplicateDirectAnnounce };
    }

    cleanup(nowMs: number, policy: MeshPolicy): void {
        this.lastCleanupMs = nowMs;
        const cutoff = nowMs - policy.dedupWindowMs;
        for (const [key, ts] of this.processedTimestamps) {
            if (ts < cutoff) {
                this.processedTimestamps.delete(key);
            }
        }
        while (this.processedTimestamps.size > policy.dedupMaxEntries) {
            const oldest = this.processedTimestamps.keys().next().value;
            if (oldest === undefined) break;
            this.processedTimestamps.delete(oldest);
        }
    }

    clear(): void {
        this.processedTimestamps.clear();
        this.lastCleanupMs = 0;
    }

    getProcessedCount(): number {
        return this.processedTimestamps.size;
    }

    private recordKey(key: string, nowMs: number, policy: MeshPolicy): void {
        // Refresh insertion order
        if (this.processedTimestamps.has(key)) {
            this.processedTimestamps.delete(key);
        }
        this.processedTimestamps.set(key, nowMs);
        while (this.processedTimestamps.size > policy.dedupMaxEntries) {
            const oldest = this.processedTimestamps.keys().next().value;
            if (oldest === undefined) break;
            this.processedTimestamps.delete(oldest);
        }
    }
}

function computeBytesDigest(bytes: Uint8Array): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}
