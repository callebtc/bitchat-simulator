/**
 * Synchronous, zero-dependency payload compression helper aligned with
 * upstream BitChat's compression policy (CompressionUtil.kt / CompressionUtil.swift):
 * - Compresses payloads >= 100 bytes with unique-byte ratio < 0.9.
 * - Only returns compressed bytes when strictly smaller than original.
 * - Uses a compact lossless LZSS token codec so both browser and Node/Vitest
 *   execute synchronously with realistic wire-size reduction.
 */

export const COMPRESSION_THRESHOLD_BYTES = 100;
const MAX_EXPANDED_SIZE = 10 * 1024 * 1024;
const WINDOW_SIZE = 255;
const MIN_MATCH = 3;
const MAX_MATCH = 18;

export const CompressionUtil = {
    shouldCompress(data: Uint8Array): boolean {
        if (data.length < COMPRESSION_THRESHOLD_BYTES) return false;

        const seen = new Uint8Array(256);
        let unique = 0;
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            if (seen[b] === 0) {
                seen[b] = 1;
                unique++;
            }
        }
        const denom = Math.min(data.length, 256);
        return unique / denom < 0.9;
    },

    compress(data: Uint8Array): Uint8Array | null {
        if (data.length < COMPRESSION_THRESHOLD_BYTES) return null;

        const out: number[] = [];
        let pos = 0;

        while (pos < data.length) {
            const flagIndex = out.length;
            out.push(0);
            let flags = 0;

            for (let bit = 0; bit < 8 && pos < data.length; bit++) {
                const searchStart = Math.max(0, pos - WINDOW_SIZE);
                let bestLen = 0;
                let bestDist = 0;

                const maxLen = Math.min(MAX_MATCH, data.length - pos);
                if (maxLen >= MIN_MATCH) {
                    for (let cand = pos - 1; cand >= searchStart; cand--) {
                        if (data[cand] !== data[pos]) continue;
                        let matchLen = 1;
                        while (
                            matchLen < maxLen &&
                            data[cand + matchLen] === data[pos + matchLen]
                        ) {
                            matchLen++;
                        }
                        if (matchLen > bestLen) {
                            bestLen = matchLen;
                            bestDist = pos - cand;
                            if (bestLen === maxLen) break;
                        }
                    }
                }

                if (bestLen >= MIN_MATCH) {
                    flags |= 1 << bit;
                    out.push(bestDist & 0xff);
                    out.push((bestLen - MIN_MATCH) & 0xff);
                    pos += bestLen;
                } else {
                    out.push(data[pos]);
                    pos++;
                }
            }

            out[flagIndex] = flags;
            if (out.length >= data.length) {
                return null; // Not beneficial
            }
        }

        if (out.length === 0 || out.length >= data.length) {
            return null;
        }
        return new Uint8Array(out);
    },

    decompress(compressed: Uint8Array, originalSize: number): Uint8Array | null {
        if (compressed.length === 0) return null;
        if (originalSize <= 0 || originalSize > MAX_EXPANDED_SIZE) return null;

        const out = new Uint8Array(originalSize);
        let inPos = 0;
        let outPos = 0;

        while (inPos < compressed.length && outPos < originalSize) {
            const flags = compressed[inPos++];
            for (let bit = 0; bit < 8 && inPos < compressed.length && outPos < originalSize; bit++) {
                if ((flags & (1 << bit)) !== 0) {
                    if (inPos + 1 >= compressed.length) return null;
                    const dist = compressed[inPos++];
                    const len = compressed[inPos++] + MIN_MATCH;
                    if (dist === 0 || dist > outPos || outPos + len > originalSize) {
                        return null;
                    }
                    for (let k = 0; k < len; k++) {
                        out[outPos] = out[outPos - dist];
                        outPos++;
                    }
                } else {
                    out[outPos++] = compressed[inPos++];
                }
            }
        }

        if (outPos !== originalSize || inPos !== compressed.length) {
            return null;
        }
        return out;
    },
};
