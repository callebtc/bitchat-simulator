import { BitchatPacket } from './BitchatPacket';

const HEADER_SIZE_V1 = 14; // Corrected from 13 based on field sum
const SENDER_ID_SIZE = 8;
const RECIPIENT_ID_SIZE = 8;
const SIGNATURE_SIZE = 64;

enum Flags {
    HAS_RECIPIENT = 0x01,
    HAS_SIGNATURE = 0x02,
    IS_COMPRESSED = 0x04,
    HAS_ROUTE = 0x08
}

export const BinaryProtocol = {
    encode(packet: BitchatPacket): Uint8Array | null {
        try {
            const version = packet.version;
            const isV2 = version >= 2;
            const payload = packet.payload; // Assuming no compression for now
            const isCompressed = false;
            
            // Calculate sizes
            let headerSize = HEADER_SIZE_V1;
            if (isV2) {
                headerSize = 16; // V1(14) - 2(short) + 4(int) = 16
            }

            const recipientBytes = packet.recipientID ? RECIPIENT_ID_SIZE : 0;
            const signatureBytes = packet.signature ? SIGNATURE_SIZE : 0;
            const routeBytes = (packet.route && packet.route.length > 0 && isV2) 
                ? (1 + packet.route.length * SENDER_ID_SIZE) 
                : 0;
            
            const totalSize = headerSize + SENDER_ID_SIZE + recipientBytes + payload.length + signatureBytes + routeBytes;
            
            const buffer = new Uint8Array(totalSize);
            const view = new DataView(buffer.buffer);
            let offset = 0;

            // Header
            view.setUint8(offset++, version);
            view.setUint8(offset++, packet.type);
            view.setUint8(offset++, packet.ttl);
            
            // Timestamp (BigInt 64)
            view.setBigUint64(offset, packet.timestamp, false); // Big Endian
            offset += 8;

            // Flags
            let flags = 0;
            if (packet.recipientID) flags |= Flags.HAS_RECIPIENT;
            if (packet.signature) flags |= Flags.HAS_SIGNATURE;
            if (isCompressed) flags |= Flags.IS_COMPRESSED;
            if (packet.route && packet.route.length > 0 && isV2) flags |= Flags.HAS_ROUTE;
            view.setUint8(offset++, flags);

            // Payload Length
            if (isV2) {
                view.setUint32(offset, payload.length, false);
                offset += 4;
            } else {
                view.setUint16(offset, payload.length, false);
                offset += 2;
            }

            // Sender ID
            buffer.set(packet.senderID.subarray(0, SENDER_ID_SIZE), offset);
            offset += SENDER_ID_SIZE;

            // Recipient ID
            if (packet.recipientID) {
                buffer.set(packet.recipientID.subarray(0, RECIPIENT_ID_SIZE), offset);
                offset += RECIPIENT_ID_SIZE;
            }

            // Route (V2+)
            if (packet.route && packet.route.length > 0 && isV2) {
                view.setUint8(offset++, packet.route.length);
                packet.route.forEach(hop => {
                    buffer.set(hop.subarray(0, SENDER_ID_SIZE), offset);
                    offset += SENDER_ID_SIZE;
                });
            }

            // Payload
            buffer.set(payload, offset);
            offset += payload.length;

            // Signature
            if (packet.signature) {
                buffer.set(packet.signature.subarray(0, SIGNATURE_SIZE), offset);
                offset += SIGNATURE_SIZE;
            }

            return buffer;
        } catch (e) {
            console.error("Encoding error", e);
            return null;
        }
    },

    decode(data: Uint8Array): BitchatPacket | null {
        try {
            if (data.length < HEADER_SIZE_V1 + SENDER_ID_SIZE) return null;

            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            let offset = 0;

            const version = view.getUint8(offset++);
            if (version !== 1 && version !== 2) return null;

            const type = view.getUint8(offset++);
            const ttl = view.getUint8(offset++);
            const timestamp = view.getBigUint64(offset, false); // Big Endian
            offset += 8;

            const flags = view.getUint8(offset++);
            const hasRecipient = (flags & Flags.HAS_RECIPIENT) !== 0;
            const hasSignature = (flags & Flags.HAS_SIGNATURE) !== 0;
            const isCompressed = (flags & Flags.IS_COMPRESSED) !== 0; // Not supported yet
            const hasRoute = (version >= 2) && (flags & Flags.HAS_ROUTE) !== 0;

            let payloadLength = 0;
            if (version >= 2) {
                payloadLength = view.getUint32(offset, false);
                offset += 4;
            } else {
                payloadLength = view.getUint16(offset, false);
                offset += 2;
            }

            // Read SenderID
            const senderID = data.slice(offset, offset + SENDER_ID_SIZE);
            offset += SENDER_ID_SIZE;

            // Read RecipientID
            let recipientID: Uint8Array | undefined;
            if (hasRecipient) {
                recipientID = data.slice(offset, offset + RECIPIENT_ID_SIZE);
                offset += RECIPIENT_ID_SIZE;
            }

            // Read Route
            let route: Uint8Array[] | undefined;
            if (hasRoute) {
                const count = view.getUint8(offset++);
                if (count > 0) {
                    route = [];
                    for (let i = 0; i < count; i++) {
                        route.push(data.slice(offset, offset + SENDER_ID_SIZE));
                        offset += SENDER_ID_SIZE;
                    }
                }
            }

            // Read Payload
            if (isCompressed) {
                // TODO: Decompression support
                return null;
            }
            
            const payload = data.slice(offset, offset + payloadLength);
            offset += payloadLength;

            // Read Signature
            let signature: Uint8Array | undefined;
            if (hasSignature) {
                signature = data.slice(offset, offset + SIGNATURE_SIZE);
                offset += SIGNATURE_SIZE;
            }

            return {
                version,
                type,
                ttl,
                timestamp,
                senderID,
                recipientID,
                payload,
                signature,
                route
            };

        } catch (e) {
            console.error("Decoding error", e);
            return null;
        }
    }
};
