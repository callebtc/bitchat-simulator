/**
 * Deterministic, injectable pseudo-random number generator (Mulberry32).
 *
 * All simulation and protocol randomness should flow through a SeededRandom
 * instance owned by SimulationEngine so benchmark runs are 100% reproducible.
 */

export function hashString32(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export class SeededRandom {
    private state: number;
    readonly initialSeed: number;

    constructor(seed: number = 0x5eed1234) {
        this.initialSeed = seed >>> 0;
        this.state = this.initialSeed;
    }

    /** Returns a uniformly distributed float in [0, 1). */
    next(): number {
        let t = (this.state += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** Returns a float in [min, max). */
    nextRange(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    /** Returns an integer in [min, maxInclusive]. */
    nextInt(min: number, maxInclusive: number): number {
        if (maxInclusive <= min) return min;
        return min + Math.floor(this.next() * (maxInclusive - min + 1));
    }

    /** Returns true with the given probability in [0, 1]. */
    nextBool(probability: number): boolean {
        if (probability <= 0) return false;
        if (probability >= 1) return true;
        return this.next() < probability;
    }

    /** Generates deterministic random bytes. */
    nextBytes(length: number): Uint8Array {
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            out[i] = Math.floor(this.next() * 256) & 0xff;
        }
        return out;
    }

    /** Generates a lowercase hex string representing byteLength random bytes. */
    nextHex(byteLength: number): string {
        const bytes = this.nextBytes(byteLength);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, '0');
        }
        return hex;
    }

    /**
     * Derives an independent deterministic child PRNG stream from this seed
     * and a label without advancing this generator's state.
     */
    fork(label: string): SeededRandom {
        const mixed = (this.initialSeed ^ hashString32(label)) >>> 0;
        return new SeededRandom(mixed === 0 ? 0x9e3779b9 : mixed);
    }
}
