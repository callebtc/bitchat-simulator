/**
 * Golomb-Coded Set (GCS) probabilistic set filter matching BitChat Android's
 * `sync/GCSFilter.kt` (https://github.com/permissionlesstech/bitchat-android/blob/main/docs/sync.md).
 *
 * Used inside `REQUEST_SYNC (0x21)` packets (~400 B max, 1% FPR) so two peers
 * exchange compact summaries of seen packet IDs and reconcile missing history.
 */

export interface GcsParams {
    p: number;
    m: number;
    data: Uint8Array;
}

class BitWriter {
    private bytes: number[] = [];
    private currentByte: number = 0;
    private bitCount: number = 0;

    writeBit(bit: number): void {
        this.currentByte = (this.currentByte << 1) | (bit & 1);
        this.bitCount++;
        if (this.bitCount === 8) {
            this.bytes.push(this.currentByte);
            this.currentByte = 0;
            this.bitCount = 0;
        }
    }

    writeBits(value: number, count: number): void {
        for (let i = count - 1; i >= 0; i--) {
            this.writeBit((value >>> i) & 1);
        }
    }

    toUint8Array(): Uint8Array {
        if (this.bitCount > 0) {
            this.bytes.push(this.currentByte << (8 - this.bitCount));
        }
        return new Uint8Array(this.bytes);
    }
}

class BitReader {
    private byteIndex: number = 0;
    private bitOffset: number = 0;

    constructor(private readonly data: Uint8Array) {}

    readBit(): number {
        if (this.byteIndex >= this.data.length) return -1;
        const bit = (this.data[this.byteIndex] >>> (7 - this.bitOffset)) & 1;
        this.bitOffset++;
        if (this.bitOffset === 8) {
            this.bitOffset = 0;
            this.byteIndex++;
        }
        return bit;
    }

    readBits(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++) {
            const bit = this.readBit();
            if (bit < 0) return -1;
            value = (value << 1) | bit;
        }
        return value;
    }
}

export class GCSFilter {
    /** Derive Golomb-Rice parameter P = max(1, round(log2(1 / targetFpr))). For 1% FPR, P = 7. */
    static deriveP(targetFpr: number): number {
        const clamped = Math.max(1e-6, Math.min(0.5, targetFpr));
        return Math.max(1, Math.min(20, Math.round(Math.log2(1 / clamped))));
    }

    /** Estimate maximum elements that fit in `maxBytes` at Golomb parameter `p`. */
    static estimateMaxElements(maxBytes: number, p: number): number {
        return Math.max(1, Math.floor((maxBytes * 8) / (p + 2)));
    }

    /**
     * Map a 16-byte packet ID deterministically to `[0, m)`.
     * Uses the first 8 bytes (big-endian uint64) mixed with the second 8 bytes via XOR.
     */
    static hashToRange(idBytes: Uint8Array, m: number): number {
        if (m <= 1) return 0;
        let h1 = 0n;
        let h2 = 0n;
        const len = idBytes.length;
        for (let i = 0; i < Math.min(8, len); i++) {
            h1 = (h1 << 8n) | BigInt(idBytes[i]);
        }
        for (let i = 8; i < Math.min(16, len); i++) {
            h2 = (h2 << 8n) | BigInt(idBytes[i]);
        }
        const mixed = (h1 ^ (h2 * 0x9e3779b97f4a7c15n)) & 0xffffffffffffffffn;
        return Number(mixed % BigInt(m));
    }

    /**
     * Build a Golomb-Coded Set for the given 16-byte packet IDs, bounded to `maxBytes`.
     */
    static buildFilter(
        ids: Uint8Array[],
        maxBytes: number = 400,
        targetFpr: number = 0.01
    ): GcsParams {
        const p = this.deriveP(targetFpr);
        if (ids.length === 0) {
            return { p, m: 1 << p, data: new Uint8Array(0) };
        }

        const maxElems = this.estimateMaxElements(maxBytes, p);
        let count = Math.min(ids.length, maxElems);

        // Shrink count if Golomb-encoded payload exceeds maxBytes due to variance
        while (count > 0) {
            const slice = ids.slice(0, count);
            const m = Math.max(1, count * (1 << p));
            const data = this.encodeValues(slice, p, m);
            if (data.length <= maxBytes || count === 1) {
                return { p, m, data };
            }
            count = Math.max(1, Math.floor(count * 0.9));
        }

        return { p, m: 1 << p, data: new Uint8Array(0) };
    }

    private static encodeValues(ids: Uint8Array[], p: number, m: number): Uint8Array {
        const hashed = new Array<number>(ids.length);
        for (let i = 0; i < ids.length; i++) {
            hashed[i] = this.hashToRange(ids[i], m);
        }
        hashed.sort((a, b) => a - b);

        // Deduplicate identical hashed values
        const unique: number[] = [];
        for (let i = 0; i < hashed.length; i++) {
            if (i === 0 || hashed[i] !== hashed[i - 1]) {
                unique.push(hashed[i]);
            }
        }

        const writer = new BitWriter();
        const mask = (1 << p) - 1;
        let prev = 0;
        for (const v of unique) {
            const delta = v - prev;
            prev = v;
            const q = delta >>> p;
            const r = delta & mask;
            for (let i = 0; i < q; i++) {
                writer.writeBit(1);
            }
            writer.writeBit(0);
            writer.writeBits(r, p);
        }
        return writer.toUint8Array();
    }

    /** Decode a GCS bitstream into a sorted array of hashed range values. */
    static decodeToSortedSet(p: number, m: number, data: Uint8Array): number[] {
        if (data.length === 0 || p < 1 || p > 20 || m <= 0) return [];
        const reader = new BitReader(data);
        const result: number[] = [];
        let acc = 0;

        while (true) {
            let q = 0;
            let bit = reader.readBit();
            while (bit === 1) {
                q++;
                if (q > 1024) return result; // Safety guard against malformed stream
                bit = reader.readBit();
            }
            if (bit < 0) break;

            const r = reader.readBits(p);
            if (r < 0) break;

            const delta = (q << p) | r;
            acc += delta;
            if (acc >= m) break;
            result.push(acc);
        }

        return result;
    }

    /** Binary-search check for membership of a 16-byte packet ID in a decoded sorted GCS set. */
    static contains(sortedValues: number[], p: number, m: number, idBytes: Uint8Array): boolean {
        if (sortedValues.length === 0 || p < 1 || m <= 0) return false;
        const target = this.hashToRange(idBytes, m);
        let lo = 0;
        let hi = sortedValues.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const v = sortedValues[mid];
            if (v === target) return true;
            if (v < target) lo = mid + 1;
            else hi = mid - 1;
        }
        return false;
    }
}
