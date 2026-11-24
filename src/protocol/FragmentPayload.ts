import { toHex } from './BitchatPacket';
import { SeededRandom } from '../simulation/SeededRandom';

/**
 * BitChat FragmentPayload wire codec matching Android FragmentPayload.kt & iOS:
 * 13-byte fixed header + variable fragment data:
 *   [fragmentID: 8B] [index: 2B BE] [total: 2B BE] [originalType: 1B] [data...]
 */

export const FRAGMENT_HEADER_SIZE = 13;

export interface FragmentPayloadData {
    fragmentID: Uint8Array; // 8 bytes
    index: number; // UInt16
    total: number; // UInt16
    originalType: number; // UByte
    data: Uint8Array;
}

export const FragmentPayload = {
    generateFragmentID(rng: SeededRandom): Uint8Array {
        return rng.nextBytes(8);
    },

    encode(frag: FragmentPayloadData): Uint8Array {
        const buf = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
        const view = new DataView(buf.buffer);
        buf.set(frag.fragmentID.subarray(0, 8), 0);
        view.setUint16(8, frag.index, false);
        view.setUint16(10, frag.total, false);
        view.setUint8(12, frag.originalType);
        buf.set(frag.data, FRAGMENT_HEADER_SIZE);
        return buf;
    },

    decode(payload: Uint8Array): FragmentPayloadData | null {
        if (payload.length < FRAGMENT_HEADER_SIZE) return null;
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const fragmentID = payload.slice(0, 8);
        const index = view.getUint16(8, false);
        const total = view.getUint16(10, false);
        const originalType = view.getUint8(12);
        const data = payload.slice(FRAGMENT_HEADER_SIZE);

        if (total <= 0 || index >= total || data.length === 0) {
            return null;
        }
        return { fragmentID, index, total, originalType, data };
    },

    getFragmentIDHex(fragmentID: Uint8Array): string {
        return toHex(fragmentID.subarray(0, 8));
    },
};
