// Packet Types - matching BinaryProtocol.kt
export enum MessageType {
    ANNOUNCE = 0x01,
    MESSAGE = 0x02,
    LEAVE = 0x03,
    NOISE_HANDSHAKE = 0x10,
    NOISE_ENCRYPTED = 0x11,
    FRAGMENT = 0x20,
    REQUEST_SYNC = 0x21,
    FILE_TRANSFER = 0x22
}

// Special Recipient IDs
export const SpecialRecipients = {
    BROADCAST: new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
};

export interface BitchatPacket {
    version: number; // UByte
    type: number; // UByte
    senderID: Uint8Array; // 8 bytes
    recipientID?: Uint8Array; // 8 bytes
    timestamp: bigint; // ULong (BigInt in JS)
    payload: Uint8Array; // Variable
    signature?: Uint8Array; // 64 bytes
    ttl: number; // UByte
    route?: Uint8Array[]; // List of 8-byte peerIDs
}

// Helper to create a new packet
export function createPacket(
    type: MessageType,
    senderID: Uint8Array,
    payload: Uint8Array,
    ttl: number = 7,
    recipientID?: Uint8Array
): BitchatPacket {
    return {
        version: 1,
        type,
        senderID,
        recipientID,
        timestamp: BigInt(Date.now()),
        payload,
        signature: undefined,
        ttl,
        route: undefined
    };
}

function toHex(arr: Uint8Array): string {
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function calculatePacketHash(packet: BitchatPacket): string {
    const parts = [
        packet.version.toString(),
        packet.type.toString(),
        toHex(packet.senderID),
        packet.recipientID ? toHex(packet.recipientID) : '',
        packet.timestamp.toString(),
        toHex(packet.payload),
        packet.signature ? toHex(packet.signature) : '',
        packet.route ? packet.route.map(toHex).join('') : ''
    ];
    
    const input = parts.join('|');
    
    // Simple FNV-1a hash implementation
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}
