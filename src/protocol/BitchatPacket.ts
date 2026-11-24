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

export function toHex(arr: Uint8Array): string {
    let out = '';
    for (let i = 0; i < arr.length; i++) {
        out += arr[i].toString(16).padStart(2, '0');
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
export function computePacketIdBytes(packet: BitchatPacket): Uint8Array {
    const tsBytes = new Uint8Array(8);
    const tsView = new DataView(tsBytes.buffer);
    tsView.setBigUint64(0, packet.timestamp, false);

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    const primes = [0x01000193, 0x1b873593, 0x27d4eb2f, 0x165667b1];

    for (let lane = 0; lane < 4; lane++) {
        let h = seeds[lane] >>> 0;
        const p = primes[lane];

        const mix = (byte: number): void => {
            h ^= byte & 0xff;
            h = Math.imul(h, p) >>> 0;
        };

        mix(packet.type);
        for (let i = 0; i < 8; i++) {
            mix(i < packet.senderID.length ? packet.senderID[i] : 0);
        }
        for (let i = 0; i < 8; i++) {
            mix(tsBytes[i]);
        }
        for (let i = 0; i < packet.payload.length; i++) {
            mix(packet.payload[i]);
        }
        // Final avalanche
        h ^= h >>> 16;
        h = Math.imul(h, 0x85ebca6b) >>> 0;
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35) >>> 0;
        h ^= h >>> 16;
        outView.setUint32(lane * 4, h >>> 0, false);
    }

    return out;
}

export function computePacketIdHex(packet: BitchatPacket): string {
    return toHex(computePacketIdBytes(packet));
}

export function calculatePacketHash(packet: BitchatPacket): string {
    return computePacketIdHex(packet);
}
