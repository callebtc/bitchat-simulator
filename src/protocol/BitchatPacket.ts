/**
 * BitChat wire packet definitions aligned with upstream BitChat
 * (iOS: localPackages/BitFoundation/Sources/BitFoundation/MessageType.swift,
 *  Android: app/src/main/java/com/bitchat/android/protocol/BinaryProtocol.kt).
 */

export enum MessageType {
    ANNOUNCE = 0x01,
    MESSAGE = 0x02,
    LEAVE = 0x03,
    COURIER_ENVELOPE = 0x04,
    NOISE_HANDSHAKE = 0x10,
    NOISE_ENCRYPTED = 0x11,
    FRAGMENT = 0x20,
    REQUEST_SYNC = 0x21,
    FILE_TRANSFER = 0x22,
    BOARD_POST = 0x23,
    PREKEY_BUNDLE = 0x24,
    GROUP_MESSAGE = 0x25,
    PING = 0x26,
    PONG = 0x27,
    NOSTR_CARRIER = 0x28,
    VOICE_FRAME = 0x29,
}

export const SpecialRecipients = {
    BROADCAST: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
};

export interface BitchatPacket {
    version: number; // UByte (1 or 2)
    type: number; // UByte
    senderID: Uint8Array; // 8 bytes
    recipientID?: Uint8Array; // 8 bytes
    timestamp: bigint; // ULong (ms)
    payload: Uint8Array; // Variable
    signature?: Uint8Array; // 64 bytes (Ed25519)
    ttl: number; // UByte
    route?: Uint8Array[]; // List of 8-byte intermediate hop peerIDs (v2+)
}

const HEX_LUT: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(arr: Uint8Array): string {
    let out = '';
    for (let i = 0; i < arr.length; i++) {
        out += HEX_LUT[arr[i]];
    }
    return out;
}

export function hexToBytes(hex: string, byteLength: number = 8): Uint8Array {
    const clean = hex.toLowerCase();
    const out = new Uint8Array(byteLength);
    let idx = 0;
    for (let i = 0; i + 1 < clean.length && idx < byteLength; i += 2) {
        const parsed = parseInt(clean.substring(i, i + 2), 16);
        out[idx++] = Number.isNaN(parsed) ? 0 : parsed;
    }
    return out;
}

export function isBroadcastRecipient(recipientID?: Uint8Array): boolean {
    if (!recipientID || recipientID.length < 8) return true;
    for (let i = 0; i < 8; i++) {
        if (recipientID[i] !== 0xff) return false;
    }
    return true;
}

export function createPacket(
    type: MessageType,
    senderID: Uint8Array,
    payload: Uint8Array,
    ttl: number = 7,
    recipientID?: Uint8Array,
    timestampMs?: number
): BitchatPacket {
    const ts = timestampMs !== undefined ? Math.max(0, Math.floor(timestampMs)) : Date.now();
    return {
        version: 1,
        type,
        senderID,
        recipientID,
        timestamp: BigInt(ts),
        payload,
        signature: undefined,
        ttl,
        route: undefined,
    };
}

/**
 * Deterministic 128-bit (16-byte) packet ID aligned with Android PacketIdUtil:
 * hashes canonical [type(1B) | senderID(8B) | timestamp(8B BE) | payload]
 * excluding mutable/hop fields (ttl, route, signature, recipientID).
 *
 * Uses four independent 32-bit FNV-1a/Murmur-mixed lanes so it runs
 * synchronously in both browser and Node with zero dependencies.
 */
const packetIdCache = new WeakMap<BitchatPacket, { bytes: Uint8Array; hex: string }>();
const packetCanonicalRoot = new WeakMap<BitchatPacket, BitchatPacket>();

/**
 * Returns the canonical root packet for WeakMap caches (packet ID, wire size)
 * when a packet was cloned across hops with only a changed TTL.
 */
export function getPacketCanonicalRoot(packet: BitchatPacket): BitchatPacket {
    return packetCanonicalRoot.get(packet) ?? packet;
}

/**
 * Clone a packet with an updated TTL while preserving its canonical cache root
 * (TTL is a fixed 1-byte header field excluded from packet ID and wire size).
 */
export function clonePacketWithTtl(packet: BitchatPacket, newTtl: number): BitchatPacket {
    const cloned: BitchatPacket = { ...packet, ttl: newTtl };
    const root = packetCanonicalRoot.get(packet) ?? packet;
    packetCanonicalRoot.set(cloned, root);
    return cloned;
}

function computePacketIdEntry(packet: BitchatPacket): { bytes: Uint8Array; hex: string } {
    const root = packetCanonicalRoot.get(packet) ?? packet;
    const cached = packetIdCache.get(root);
    if (cached) return cached;

    const tsBig = packet.timestamp;
    const tsHi = Number((tsBig >> 32n) & 0xffffffffn) >>> 0;
    const tsLo = Number(tsBig & 0xffffffffn) >>> 0;
    const t0 = (tsHi >>> 24) & 0xff;
    const t1 = (tsHi >>> 16) & 0xff;
    const t2 = (tsHi >>> 8) & 0xff;
    const t3 = tsHi & 0xff;
    const t4 = (tsLo >>> 24) & 0xff;
    const t5 = (tsLo >>> 16) & 0xff;
    const t6 = (tsLo >>> 8) & 0xff;
    const t7 = tsLo & 0xff;

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    const primes = [0x01000193, 0x1b873593, 0x27d4eb2f, 0x165667b1];
    const sender = packet.senderID;
    const senderLen = sender.length;
    const payload = packet.payload;
    const payloadLen = payload.length;
    const typeByte = packet.type & 0xff;

    for (let lane = 0; lane < 4; lane++) {
        let h = seeds[lane] >>> 0;
        const p = primes[lane];

        h = Math.imul(h ^ typeByte, p) >>> 0;
        for (let i = 0; i < 8; i++) {
            h = Math.imul(h ^ (i < senderLen ? sender[i] : 0), p) >>> 0;
        }
        h = Math.imul(h ^ t0, p) >>> 0;
        h = Math.imul(h ^ t1, p) >>> 0;
        h = Math.imul(h ^ t2, p) >>> 0;
        h = Math.imul(h ^ t3, p) >>> 0;
        h = Math.imul(h ^ t4, p) >>> 0;
        h = Math.imul(h ^ t5, p) >>> 0;
        h = Math.imul(h ^ t6, p) >>> 0;
        h = Math.imul(h ^ t7, p) >>> 0;

        for (let i = 0; i < payloadLen; i++) {
            h = Math.imul(h ^ payload[i], p) >>> 0;
        }

        h ^= h >>> 16;
        h = Math.imul(h, 0x85ebca6b) >>> 0;
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35) >>> 0;
        h ^= h >>> 16;
        outView.setUint32(lane * 4, h >>> 0, false);
    }

    const entry = { bytes: out, hex: toHex(out) };
    packetIdCache.set(root, entry);
    return entry;
}

export function computePacketIdBytes(packet: BitchatPacket): Uint8Array {
    return computePacketIdEntry(packet).bytes;
}

export function computePacketIdHex(packet: BitchatPacket): string {
    return computePacketIdEntry(packet).hex;
}

export function calculatePacketHash(packet: BitchatPacket): string {
    return computePacketIdHex(packet);
}
