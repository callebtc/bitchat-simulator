import { MessageType } from './BitchatPacket';

/**
 * Privacy-preserving PKCS#7 padding matching upstream BitChat
 * (Android: protocol/MessagePadding.kt & mesh/BLEPacketPaddingPolicy.kt,
 *  iOS: BitFoundation MessagePadding & BLEOutboundPacketPolicy.swift).
 */

export const PADDING_BLOCK_SIZES = [256, 512, 1024, 2048] as const;

export const MessagePadding = {
    /**
     * Find optimal target block size for a frame.
     * Accounts for 16 bytes of encryption/tag headroom matching upstream clients.
     */
    optimalBlockSize(dataSize: number): number {
        const totalSize = dataSize + 16;
        for (const blockSize of PADDING_BLOCK_SIZES) {
            if (totalSize <= blockSize) {
                return blockSize;
            }
        }
        return dataSize;
    },

    /**
     * Add PKCS#7-style padding up to targetSize.
     * Because pad length is stored in a single byte, frames needing > 255 pad
     * bytes are emitted unpadded (matching upstream iOS and Android).
     */
    pad(data: Uint8Array, targetSize: number): Uint8Array {
        if (data.length >= targetSize) return data;
        const paddingNeeded = targetSize - data.length;
        if (paddingNeeded <= 0 || paddingNeeded > 255) return data;

        const result = new Uint8Array(targetSize);
        result.set(data, 0);
        result.fill(paddingNeeded, data.length, targetSize);
        return result;
    },

    /**
     * Remove PKCS#7-style padding after validating all trailing pad bytes.
     * Returns original slice unchanged if padding is invalid or absent.
     */
    unpad(data: Uint8Array): Uint8Array {
        if (data.length === 0) return data;
        const padLength = data[data.length - 1];
        if (padLength <= 0 || padLength > data.length) return data;

        const start = data.length - padLength;
        for (let i = start; i < data.length; i++) {
            if (data[i] !== padLength) {
                return data;
            }
        }
        return data.slice(0, start);
    },

    /**
     * Selective BLE padding policy (BLEPacketPaddingPolicy.kt / BLEOutboundPacketPolicy.swift):
     * only Noise frames are padded over BLE; all other packet types go out at natural length.
     */
    shouldPadForBLE(type: number): boolean {
        return type === MessageType.NOISE_HANDSHAKE || type === MessageType.NOISE_ENCRYPTED;
    },
};
