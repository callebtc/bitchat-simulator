export enum TLVType {
    NICKNAME = 0x01,
    // NOISE_PUBLIC_KEY = 0x02, (Excluded for Sim)
    // SIGNING_PUBLIC_KEY = 0x03, (Excluded for Sim)
    DIRECT_NEIGHBORS = 0x04
}

export const TLV = {
    encode(type: TLVType, value: Uint8Array): Uint8Array {
        if (value.length > 255) {
            console.warn(`TLV value too large for type ${type}: ${value.length}`);
            return new Uint8Array(0); // Fail safe
        }
        const buffer = new Uint8Array(2 + value.length);
        buffer[0] = type;
        buffer[1] = value.length;
        buffer.set(value, 2);
        return buffer;
    },

    encodeNickname(nickname: string): Uint8Array {
        const encoder = new TextEncoder();
        return TLV.encode(TLVType.NICKNAME, encoder.encode(nickname));
    },

    encodeNeighbors(peerIDs: Uint8Array[]): Uint8Array {
        // Flatten list of 8-byte IDs
        const totalSize = peerIDs.length * 8;
        const value = new Uint8Array(totalSize);
        peerIDs.forEach((id, index) => {
            value.set(id.subarray(0, 8), index * 8);
        });
        return TLV.encode(TLVType.DIRECT_NEIGHBORS, value);
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
        for (let i = 0; i < value.length; i += 8) {
            if (i + 8 <= value.length) {
                neighbors.push(value.slice(i, i + 8));
            }
        }
        return neighbors;
    }
};
