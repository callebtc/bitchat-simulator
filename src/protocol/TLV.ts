import { toHex } from './BitchatPacket';

/**
 * Announcement TLV codec aligned with upstream docs/ANNOUNCEMENT_GOSSIP.md:
 * - 0x01 NICKNAME (UTF-8 <= 255 B)
 * - 0x02 NOISE_PUBLIC_KEY (32 B X25519)
 * - 0x03 SIGNING_PUBLIC_KEY (32 B Ed25519)
 * - 0x04 DIRECT_NEIGHBORS (up to 10 unique 8-byte peer IDs, no inner count)
 * - 0x05 CAPABILITIES (little-endian bitfield)
 */

export enum TLVType {
    NICKNAME = 0x01,
    NOISE_PUBLIC_KEY = 0x02,
    SIGNING_PUBLIC_KEY = 0x03,
    DIRECT_NEIGHBORS = 0x04,
    CAPABILITIES = 0x05,
}

export const MAX_DIRECT_NEIGHBORS = 10;

export const TLV = {
    encode(type: TLVType, value: Uint8Array): Uint8Array {
        if (value.length > 255) {
            return new Uint8Array(0);
        }
        const buffer = new Uint8Array(2 + value.length);
        buffer[0] = type;
        buffer[1] = value.length;
        buffer.set(value, 2);
        return buffer;
    },

    encodeNickname(nickname: string): Uint8Array {
        const encoder = new TextEncoder();
        const encoded = encoder.encode(nickname);
        const truncated = encoded.length > 255 ? encoded.subarray(0, 255) : encoded;
        return TLV.encode(TLVType.NICKNAME, truncated);
    },

    encodeNoisePublicKey(key: Uint8Array): Uint8Array {
        return TLV.encode(TLVType.NOISE_PUBLIC_KEY, key.subarray(0, 32));
    },

    encodeSigningPublicKey(key: Uint8Array): Uint8Array {
        return TLV.encode(TLVType.SIGNING_PUBLIC_KEY, key.subarray(0, 32));
    },

    /**
     * Encode up to maxCount (default 10) unique 8-byte direct neighbor peer IDs.
     */
    encodeNeighbors(peerIDs: Uint8Array[], maxCount: number = MAX_DIRECT_NEIGHBORS): Uint8Array {
        const seen = new Set<string>();
        const unique: Uint8Array[] = [];
        for (const id of peerIDs) {
            const chunk = id.subarray(0, 8);
            const hex = toHex(chunk);
            if (!seen.has(hex)) {
                seen.add(hex);
                unique.push(chunk);
                if (unique.length >= maxCount) break;
            }
        }
        const value = new Uint8Array(unique.length * 8);
        unique.forEach((id, index) => {
            value.set(id, index * 8);
        });
        return TLV.encode(TLVType.DIRECT_NEIGHBORS, value);
    },

    encodeCapabilities(bitmask: number): Uint8Array {
        if (bitmask === 0) {
            return TLV.encode(TLVType.CAPABILITIES, new Uint8Array(0));
        }
        const bytes: number[] = [];
        let remaining = bitmask >>> 0;
        while (remaining > 0) {
            bytes.push(remaining & 0xff);
            remaining >>>= 8;
        }
        return TLV.encode(TLVType.CAPABILITIES, new Uint8Array(bytes));
    },

    /**
     * Build a full wire-sized IdentityAnnouncement payload matching Android/iOS:
     * nickname + 32B Noise key + 32B Ed25519 key + optional direct neighbors + optional capabilities.
     */
    encodeIdentityAnnouncement(params: {
        nickname: string;
        noisePublicKey?: Uint8Array;
        signingPublicKey?: Uint8Array;
        neighbors?: Uint8Array[];
        maxNeighbors?: number;
        capabilities?: number;
    }): Uint8Array {
        const chunks: Uint8Array[] = [TLV.encodeNickname(params.nickname)];
        if (params.noisePublicKey) {
            chunks.push(TLV.encodeNoisePublicKey(params.noisePublicKey));
        }
        if (params.signingPublicKey) {
            chunks.push(TLV.encodeSigningPublicKey(params.signingPublicKey));
        }
        if (params.neighbors && params.neighbors.length > 0) {
            chunks.push(
                TLV.encodeNeighbors(
                    params.neighbors,
                    params.maxNeighbors ?? MAX_DIRECT_NEIGHBORS
                )
            );
        }
        if (params.capabilities !== undefined) {
            chunks.push(TLV.encodeCapabilities(params.capabilities));
        }

        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    },

    decode(payload: Uint8Array): Map<TLVType, Uint8Array> {
        const results = new Map<TLVType, Uint8Array>();
        let offset = 0;

        while (offset + 2 <= payload.length) {
            const type = payload[offset];
            const length = payload[offset + 1];
            offset += 2;

            if (offset + length > payload.length) break;

            const value = payload.slice(offset, offset + length);
            results.set(type as TLVType, value);
            offset += length;
        }
        return results;
    },

    decodeNickname(value: Uint8Array): string {
        const decoder = new TextDecoder();
        return decoder.decode(value);
    },

    decodeNeighbors(value: Uint8Array): Uint8Array[] {
        const neighbors: Uint8Array[] = [];
        for (let i = 0; i + 8 <= value.length; i += 8) {
            neighbors.push(value.slice(i, i + 8));
        }
        return neighbors;
    },

    decodeCapabilities(value: Uint8Array): number {
        let mask = 0;
        const limit = Math.min(value.length, 4);
        for (let i = 0; i < limit; i++) {
            mask |= value[i] << (8 * i);
        }
        return mask >>> 0;
    },
};
