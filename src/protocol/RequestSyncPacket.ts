import { GcsParams } from './GCSFilter';

/**
 * Binary TLV codec for `REQUEST_SYNC (0x21)` payloads matching BitChat Android's
 * `sync/RequestSyncPacket.kt` (https://github.com/permissionlesstech/bitchat-android/blob/main/docs/sync.md).
 *
 * TLV layout (2-byte big-endian length):
 * - 0x01: P    (1 byte, uint8)
 * - 0x02: M    (4 bytes, uint32 big-endian)
 * - 0x03: DATA (N bytes, Golomb-coded bitstream)
 */

const TAG_P = 0x01;
const TAG_M = 0x02;
const TAG_DATA = 0x03;

export class RequestSyncPacket {
    static encode(params: GcsParams): Uint8Array {
        // Total = (1 + 2 + 1) + (1 + 2 + 4) + (1 + 2 + data.length)
        const totalSize = 4 + 7 + 3 + params.data.length;
        const buffer = new Uint8Array(totalSize);
        const view = new DataView(buffer.buffer);
        let offset = 0;

        // TAG_P
        view.setUint8(offset++, TAG_P);
        view.setUint16(offset, 1, false);
        offset += 2;
        view.setUint8(offset++, params.p & 0xff);

        // TAG_M
        view.setUint8(offset++, TAG_M);
        view.setUint16(offset, 4, false);
        offset += 2;
        view.setUint32(offset, params.m >>> 0, false);
        offset += 4;

        // TAG_DATA
        view.setUint8(offset++, TAG_DATA);
        view.setUint16(offset, params.data.length, false);
        offset += 2;
        buffer.set(params.data, offset);

        return buffer;
    }

    static decode(bytes: Uint8Array): GcsParams | null {
        if (bytes.length < 11) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 0;

        let p: number | null = null;
        let m: number | null = null;
        let data: Uint8Array | null = null;

        while (offset + 3 <= bytes.length) {
            const tag = view.getUint8(offset);
            const len = view.getUint16(offset + 1, false);
            offset += 3;
            if (offset + len > bytes.length) return null;

            if (tag === TAG_P && len === 1) {
                p = view.getUint8(offset);
            } else if (tag === TAG_M && len === 4) {
                m = view.getUint32(offset, false);
            } else if (tag === TAG_DATA) {
                data = bytes.slice(offset, offset + len);
            }
            offset += len;
        }

        if (p === null || m === null || data === null) return null;
        return { p, m, data };
    }
}
