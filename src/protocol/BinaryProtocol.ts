import { BitchatPacket } from './BitchatPacket';
import { CompressionUtil } from './CompressionUtil';
import { MessagePadding } from './MessagePadding';

/**
 * BitChat binary wire codec aligned with upstream iOS (BinaryProtocol.swift)
 * and Android (BinaryProtocol.kt):
 * - v1 fixed header: 14 bytes (2-byte payload length)
 * - v2 fixed header: 16 bytes (4-byte payload length, HAS_ROUTE support)
 * - Optional compression (IS_COMPRESSED = 0x04) prepends original payload size
 *   (2 bytes BE for v1, 4 bytes BE for v2) before compressed bytes.
 * - Optional PKCS#7 padding to 256/512/1024/2048 B buckets (BLE Noise frames).
 */

export const HEADER_SIZE_V1 = 14;
export const HEADER_SIZE_V2 = 16;
export const SENDER_ID_SIZE = 8;
export const RECIPIENT_ID_SIZE = 8;
export const SIGNATURE_SIZE = 64;

export enum PacketFlags {
    HAS_RECIPIENT = 0x01,
    HAS_SIGNATURE = 0x02,
    IS_COMPRESSED = 0x04,
    HAS_ROUTE = 0x08,
    IS_RSR = 0x10,
}

export interface EncodeOptions {
    /** Apply PKCS#7 padding to optimal block size (default: selective BLE policy) */
    padding?: boolean;
    /** Compress payloads >= 100 B when beneficial (default: true) */
    compress?: boolean;
}

export const BinaryProtocol = {
    encode(packet: BitchatPacket, options: EncodeOptions = {}): Uint8Array | null {
        try {
            const version = packet.version;
            if (version !== 1 && version !== 2) return null;
            const isV2 = version >= 2;

            const shouldCompress = options.compress ?? true;
            const shouldPad = options.padding ?? MessagePadding.shouldPadForBLE(packet.type);

            let wirePayload = packet.payload;
            let isCompressed = false;
            let originalPayloadSize = 0;

            if (shouldCompress && CompressionUtil.shouldCompress(packet.payload)) {
                const maxRepresentable = isV2 ? 0xffffffff : 0xffff;
                if (packet.payload.length <= maxRepresentable) {
                    const compressed = CompressionUtil.compress(packet.payload);
                    if (compressed && compressed.length + (isV2 ? 4 : 2) < packet.payload.length) {
                        originalPayloadSize = packet.payload.length;
                        wirePayload = compressed;
                        isCompressed = true;
                    }
                }
            }

            const headerSize = isV2 ? HEADER_SIZE_V2 : HEADER_SIZE_V1;
            const origSizeFieldBytes = isCompressed ? (isV2 ? 4 : 2) : 0;
            const payloadSectionLength = origSizeFieldBytes + wirePayload.length;

            if (!isV2 && payloadSectionLength > 0xffff) {
                return null;
            }

            const hasRecipient = Boolean(packet.recipientID);
            const hasSignature = Boolean(packet.signature);
            const hasRoute = Boolean(isV2 && packet.route && packet.route.length > 0);

            const recipientBytes = hasRecipient ? RECIPIENT_ID_SIZE : 0;
            const signatureBytes = hasSignature ? SIGNATURE_SIZE : 0;
            const routeBytes = hasRoute ? 1 + packet.route!.length * SENDER_ID_SIZE : 0;

            const totalSize =
                headerSize +
                SENDER_ID_SIZE +
                recipientBytes +
                routeBytes +
                payloadSectionLength +
                signatureBytes;

            const buffer = new Uint8Array(totalSize);
            const view = new DataView(buffer.buffer);
            let offset = 0;

            // Fixed Header
            view.setUint8(offset++, version);
            view.setUint8(offset++, packet.type);
            view.setUint8(offset++, packet.ttl);
            view.setBigUint64(offset, packet.timestamp, false);
            offset += 8;

            let flags = 0;
            if (hasRecipient) flags |= PacketFlags.HAS_RECIPIENT;
            if (hasSignature) flags |= PacketFlags.HAS_SIGNATURE;
            if (isCompressed) flags |= PacketFlags.IS_COMPRESSED;
            if (hasRoute) flags |= PacketFlags.HAS_ROUTE;
            view.setUint8(offset++, flags);

            if (isV2) {
                view.setUint32(offset, payloadSectionLength, false);
                offset += 4;
            } else {
                view.setUint16(offset, payloadSectionLength, false);
                offset += 2;
            }

            // Sender ID
            buffer.set(packet.senderID.subarray(0, SENDER_ID_SIZE), offset);
            offset += SENDER_ID_SIZE;

            // Recipient ID
            if (hasRecipient && packet.recipientID) {
                buffer.set(packet.recipientID.subarray(0, RECIPIENT_ID_SIZE), offset);
                offset += RECIPIENT_ID_SIZE;
            }

            // Route (v2+)
            if (hasRoute && packet.route) {
                view.setUint8(offset++, packet.route.length);
                for (const hop of packet.route) {
                    buffer.set(hop.subarray(0, SENDER_ID_SIZE), offset);
                    offset += SENDER_ID_SIZE;
                }
            }

            // Payload (with original size prefix if compressed)
            if (isCompressed) {
                if (isV2) {
                    view.setUint32(offset, originalPayloadSize, false);
                    offset += 4;
                } else {
                    view.setUint16(offset, originalPayloadSize, false);
                    offset += 2;
                }
            }
            buffer.set(wirePayload, offset);
            offset += wirePayload.length;

            // Signature
            if (hasSignature && packet.signature) {
                buffer.set(packet.signature.subarray(0, SIGNATURE_SIZE), offset);
                offset += SIGNATURE_SIZE;
            }

            if (shouldPad) {
                const targetSize = MessagePadding.optimalBlockSize(buffer.length);
                return MessagePadding.pad(buffer, targetSize);
            }

            return buffer;
        } catch {
            return null;
        }
    },

    /**
     * Canonical packet serialization for signing/verification:
     * sets TTL = 0 and omits signature so relays can decrement TTL without
     * invalidating the signature (matches Android toBinaryDataForSigning).
     */
    encodeForSigning(packet: BitchatPacket): Uint8Array | null {
        const unsigned: BitchatPacket = {
            ...packet,
            ttl: 0,
            signature: undefined,
        };
        return this.encode(unsigned, { padding: false });
    },

    decode(rawData: Uint8Array): BitchatPacket | null {
        try {
            // Try decoding raw first; if trailing PKCS#7 padding exists, unpad
            const parsedRaw = this.decodeCore(rawData);
            if (parsedRaw) return parsedRaw;
            const unpadded = MessagePadding.unpad(rawData);
            if (unpadded.length !== rawData.length) {
                return this.decodeCore(unpadded);
            }
            return null;
        } catch {
            return null;
        }
    },

    decodeCore(data: Uint8Array): BitchatPacket | null {
        if (data.length < HEADER_SIZE_V1 + SENDER_ID_SIZE) return null;

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = 0;

        const version = view.getUint8(offset++);
        if (version !== 1 && version !== 2) return null;
        const isV2 = version >= 2;
        const headerSize = isV2 ? HEADER_SIZE_V2 : HEADER_SIZE_V1;
        if (data.length < headerSize + SENDER_ID_SIZE) return null;

        const type = view.getUint8(offset++);
        const ttl = view.getUint8(offset++);
        const timestamp = view.getBigUint64(offset, false);
        offset += 8;

        const flags = view.getUint8(offset++);
        const hasRecipient = (flags & PacketFlags.HAS_RECIPIENT) !== 0;
        const hasSignature = (flags & PacketFlags.HAS_SIGNATURE) !== 0;
        const isCompressed = (flags & PacketFlags.IS_COMPRESSED) !== 0;
        const hasRoute = isV2 && (flags & PacketFlags.HAS_ROUTE) !== 0;

        const payloadLength = isV2
            ? view.getUint32(offset, false)
            : view.getUint16(offset, false);
        offset += isV2 ? 4 : 2;

        if (offset + SENDER_ID_SIZE > data.length) return null;
        const senderID = data.slice(offset, offset + SENDER_ID_SIZE);
        offset += SENDER_ID_SIZE;

        let recipientID: Uint8Array | undefined;
        if (hasRecipient) {
            if (offset + RECIPIENT_ID_SIZE > data.length) return null;
            recipientID = data.slice(offset, offset + RECIPIENT_ID_SIZE);
            offset += RECIPIENT_ID_SIZE;
        }

        let route: Uint8Array[] | undefined;
        if (hasRoute) {
            if (offset + 1 > data.length) return null;
            const count = view.getUint8(offset++);
            if (offset + count * SENDER_ID_SIZE > data.length) return null;
            if (count > 0) {
                route = [];
                for (let i = 0; i < count; i++) {
                    route.push(data.slice(offset, offset + SENDER_ID_SIZE));
                    offset += SENDER_ID_SIZE;
                }
            }
        }

        if (offset + payloadLength > data.length) return null;
        let payload: Uint8Array;
        if (isCompressed) {
            const origSizeBytes = isV2 ? 4 : 2;
            if (payloadLength <= origSizeBytes) return null;
            const originalSize = isV2
                ? view.getUint32(offset, false)
                : view.getUint16(offset, false);
            const compressedSlice = data.slice(offset + origSizeBytes, offset + payloadLength);
            const decompressed = CompressionUtil.decompress(compressedSlice, originalSize);
            if (!decompressed) return null;
            payload = decompressed;
        } else {
            payload = data.slice(offset, offset + payloadLength);
        }
        offset += payloadLength;

        let signature: Uint8Array | undefined;
        if (hasSignature) {
            if (offset + SIGNATURE_SIZE > data.length) return null;
            signature = data.slice(offset, offset + SIGNATURE_SIZE);
            offset += SIGNATURE_SIZE;
        }

        // Reject if trailing non-pad bytes remain (unpad fallback will handle padded frames)
        if (offset !== data.length) {
            return null;
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
            route,
        };
    },
};
