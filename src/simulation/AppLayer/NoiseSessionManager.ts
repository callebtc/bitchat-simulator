/**
 * Symbolic Noise XX handshake & encrypted payload codec matching BitChat Android's
 * `noise/NoiseEncryptionService.kt` and `model/NoisePayload.kt`
 * (https://github.com/permissionlesstech/bitchat-android).
 *
 * Models the exact 3-message Noise XX RTT state machine and wire payload sizes
 * (including 16-byte AEAD authentication tag and PKCS#7 padding buckets on the wire)
 * without performing real Curve25519/ChaCha20-Poly1305 math so large 500-node
 * deterministic simulations run fast.
 */

export enum NoisePayloadType {
    PRIVATE_MESSAGE = 0x01,
    READ_RECEIPT = 0x02,
    DELIVERED = 0x03,
    VERIFY_CHALLENGE = 0x04,
    VERIFY_RESPONSE = 0x05,
    FILE_TRANSFER = 0x07,
    VOICE_NOTE = 0x08,
}

export type NoiseSessionState =
    | 'none'
    | 'initiator_sent_msg1'
    | 'responder_sent_msg2'
    | 'established';

export interface NoiseSession {
    peerHex: string;
    state: NoiseSessionState;
    isInitiator: boolean;
    startedAtMs: number;
    establishedAtMs?: number;
}

export interface DecodedNoisePayload {
    payloadType: NoisePayloadType;
    messageId: string;
    body: Uint8Array;
}

/** Exact Noise XX handshake message payload sizes (before BinaryProtocol header + PKCS#7 padding). */
export const NOISE_HANDSHAKE_SIZES = {
    /** msg1: -> e (32 B Curve25519 ephemeral public key) */
    MSG1_BYTES: 32,
    /** msg2: <- e, ee, s, es (32 B e + 32 B encrypted s + 16 B tag + 16 B payload tag) */
    MSG2_BYTES: 96,
    /** msg3: -> s, se (32 B encrypted s + 16 B tag + 16 B payload tag) */
    MSG3_BYTES: 64,
} as const;

const NOISE_AEAD_TAG_BYTES = 16;

export class NoiseSessionManager {
    private sessions: Map<string, NoiseSession> = new Map();

    constructor(private readonly localPeerHex: string) {}

    hasEstablishedSession(peerHex: string): boolean {
        return this.sessions.get(peerHex)?.state === 'established';
    }

    getSession(peerHex: string): NoiseSession | undefined {
        return this.sessions.get(peerHex);
    }

    removeSession(peerHex: string): void {
        this.sessions.delete(peerHex);
    }

    /**
     * Initiate a Noise XX handshake with `peerHex`.
     * Returns the 32-byte `NOISE_HANDSHAKE` msg1 payload, or null if already established/in progress.
     */
    initiateHandshake(peerHex: string, nowMs: number, forceRestart: boolean = false): Uint8Array | null {
        const existing = this.sessions.get(peerHex);
        if (existing) {
            if (existing.state === 'established') return null;
            if (!forceRestart && existing.state === 'initiator_sent_msg1') return null;
        }

        this.sessions.set(peerHex, {
            peerHex,
            state: 'initiator_sent_msg1',
            isInitiator: true,
            startedAtMs: nowMs,
        });

        return this.buildHandshakePayload(1, NOISE_HANDSHAKE_SIZES.MSG1_BYTES);
    }

    /**
     * Process an incoming `NOISE_HANDSHAKE (0x10)` payload from `peerHex`.
     * Returns an optional response handshake payload to transmit and whether the
     * session just transitioned to `established`.
     */
    handleHandshakeMessage(
        peerHex: string,
        payload: Uint8Array,
        nowMs: number
    ): { responsePayload?: Uint8Array; becameEstablished: boolean } {
        if (payload.length < 1) return { becameEstablished: false };
        const step = payload[0];
        const existing = this.sessions.get(peerHex);

        if (step === 1) {
            // Glare resolution: if both initiated simultaneously, lexically smaller peerHex stays initiator
            if (existing?.state === 'initiator_sent_msg1' && this.localPeerHex < peerHex) {
                return { becameEstablished: false };
            }
            this.sessions.set(peerHex, {
                peerHex,
                state: 'responder_sent_msg2',
                isInitiator: false,
                startedAtMs: nowMs,
            });
            return {
                responsePayload: this.buildHandshakePayload(2, NOISE_HANDSHAKE_SIZES.MSG2_BYTES),
                becameEstablished: false,
            };
        }

        if (step === 2) {
            // Duplicate msg2 after we already finished: our msg3 was lost (or the
            // responder restarted). Re-send msg3 so the responder can complete.
            if (existing?.state === 'established' && existing.isInitiator) {
                return {
                    responsePayload: this.buildHandshakePayload(3, NOISE_HANDSHAKE_SIZES.MSG3_BYTES),
                    becameEstablished: false,
                };
            }
            if (!existing || existing.state !== 'initiator_sent_msg1') {
                return { becameEstablished: false };
            }
            existing.state = 'established';
            existing.establishedAtMs = nowMs;
            return {
                responsePayload: this.buildHandshakePayload(3, NOISE_HANDSHAKE_SIZES.MSG3_BYTES),
                becameEstablished: true,
            };
        }

        if (step === 3) {
            if (!existing || existing.state !== 'responder_sent_msg2') {
                return { becameEstablished: false };
            }
            existing.state = 'established';
            existing.establishedAtMs = nowMs;
            return { becameEstablished: true };
        }

        return { becameEstablished: false };
    }

    /**
     * Encode a symbolic `NOISE_ENCRYPTED (0x11)` payload with realistic 16-byte AEAD tag overhead.
     * Layout: [type: 1B][idLen: 1B][idBytes: N][bodyLen: 4B BE][body: M][aeadTag: 16B]
     */
    static encodeEncryptedPayload(
        payloadType: NoisePayloadType,
        messageId: string,
        body: Uint8Array
    ): Uint8Array {
        const idBytes = new TextEncoder().encode(messageId);
        const clampedIdLen = Math.min(255, idBytes.length);
        const total = 1 + 1 + clampedIdLen + 4 + body.length + NOISE_AEAD_TAG_BYTES;
        const out = new Uint8Array(total);
        const view = new DataView(out.buffer);
        let offset = 0;

        out[offset++] = payloadType;
        out[offset++] = clampedIdLen;
        out.set(idBytes.subarray(0, clampedIdLen), offset);
        offset += clampedIdLen;
        view.setUint32(offset, body.length, false);
        offset += 4;
        out.set(body, offset);
        // Trailing 16 bytes represent the Poly1305 AEAD tag
        return out;
    }

    static decodeEncryptedPayload(bytes: Uint8Array): DecodedNoisePayload | null {
        if (bytes.length < 1 + 1 + 4 + NOISE_AEAD_TAG_BYTES) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 0;

        const payloadType = bytes[offset++] as NoisePayloadType;
        const idLen = bytes[offset++];
        if (offset + idLen + 4 + NOISE_AEAD_TAG_BYTES > bytes.length) return null;

        const messageId = new TextDecoder().decode(bytes.subarray(offset, offset + idLen));
        offset += idLen;
        const bodyLen = view.getUint32(offset, false);
        offset += 4;
        if (offset + bodyLen + NOISE_AEAD_TAG_BYTES > bytes.length) return null;

        const body = bytes.slice(offset, offset + bodyLen);
        return { payloadType, messageId, body };
    }

    private buildHandshakePayload(step: 1 | 2 | 3, totalBytes: number): Uint8Array {
        const out = new Uint8Array(totalBytes);
        out[0] = step;
        return out;
    }

    clear(): void {
        this.sessions.clear();
    }
}
