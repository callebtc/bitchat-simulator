import { NoisePayloadType } from './NoiseSessionManager';

/**
 * Private-message outbox & Noise XX handshake retry coordinator matching BitChat
 * Android's `services/MessageRouter.kt` (https://github.com/permissionlesstech/bitchat-android).
 *
 * - Queues outbound encrypted messages per peer while Noise XX session is established
 * - Bounded to 100 messages/peer and 24-hour TTL
 * - Retries stalled handshakes on exponential backoff `[5s, 15s, 30s, 60s]`
 * - Flushes queued outbox immediately once `onSessionEstablished(peerHex)` fires
 */

export const MESSAGE_ROUTER_CONFIG = {
    MAX_OUTBOX_PER_PEER: 100,
    OUTBOX_TTL_MS: 24 * 60 * 60 * 1_000,
    RETRY_TICK_MS: 2_000,
    HANDSHAKE_BACKOFF_MS: [5_000, 15_000, 30_000, 60_000] as readonly number[],
} as const;

export interface QueuedPrivateMessage {
    messageId: string;
    recipientHex: string;
    payloadType: NoisePayloadType;
    body: Uint8Array;
    enqueuedAtMs: number;
}

interface HandshakeRetryState {
    attempts: number;
    nextRetryAtMs: number;
}

export class MessageRouter {
    private outbox: Map<string, QueuedPrivateMessage[]> = new Map();
    private handshakeRetries: Map<string, HandshakeRetryState> = new Map();
    private lastTickMs: number = 0;

    /** Queue a private message for `recipientHex`. Returns true if enqueued. */
    enqueue(entry: QueuedPrivateMessage): boolean {
        let queue = this.outbox.get(entry.recipientHex);
        if (!queue) {
            queue = [];
            this.outbox.set(entry.recipientHex, queue);
        }
        if (queue.length >= MESSAGE_ROUTER_CONFIG.MAX_OUTBOX_PER_PEER) {
            queue.shift(); // Evict oldest queued message for this peer
        }
        queue.push(entry);
        return true;
    }

    /** Record that a handshake attempt was started now; schedules next backoff retry. */
    recordHandshakeAttempt(peerHex: string, nowMs: number): void {
        const prev = this.handshakeRetries.get(peerHex);
        const attempts = (prev?.attempts ?? 0) + 1;
        const schedule = MESSAGE_ROUTER_CONFIG.HANDSHAKE_BACKOFF_MS;
        const delayMs = schedule[Math.min(attempts - 1, schedule.length - 1)];
        this.handshakeRetries.set(peerHex, {
            attempts,
            nextRetryAtMs: nowMs + delayMs,
        });
    }

    /** Should we initiate a handshake right now for `peerHex`? */
    canAttemptHandshake(peerHex: string, nowMs: number): boolean {
        const state = this.handshakeRetries.get(peerHex);
        if (!state) return true;
        return nowMs >= state.nextRetryAtMs;
    }

    /** Drain and return all queued outbox messages for `peerHex` when its Noise session opens. */
    flushForPeer(peerHex: string): QueuedPrivateMessage[] {
        this.handshakeRetries.delete(peerHex);
        const queued = this.outbox.get(peerHex);
        if (!queued || queued.length === 0) return [];
        this.outbox.delete(peerHex);
        return queued;
    }

    /**
     * Periodic tick (every 2 s):
     * 1. Expire outbox messages older than 24 h (returns expired count).
     * 2. Return list of peerHexes that have queued messages and are due for a handshake retry.
     */
    tick(nowMs: number): { expiredCount: number; peersToRetryHandshake: string[] } {
        if (nowMs - this.lastTickMs < MESSAGE_ROUTER_CONFIG.RETRY_TICK_MS) {
            return { expiredCount: 0, peersToRetryHandshake: [] };
        }
        this.lastTickMs = nowMs;

        let expiredCount = 0;
        const peersToRetryHandshake: string[] = [];
        const cutoff = nowMs - MESSAGE_ROUTER_CONFIG.OUTBOX_TTL_MS;

        for (const [peerHex, queue] of this.outbox) {
            const kept: QueuedPrivateMessage[] = [];
            for (const msg of queue) {
                if (msg.enqueuedAtMs < cutoff) {
                    expiredCount++;
                } else {
                    kept.push(msg);
                }
            }
            if (kept.length === 0) {
                this.outbox.delete(peerHex);
                this.handshakeRetries.delete(peerHex);
                continue;
            }
            this.outbox.set(peerHex, kept);

            if (this.canAttemptHandshake(peerHex, nowMs)) {
                peersToRetryHandshake.push(peerHex);
            }
        }

        return { expiredCount, peersToRetryHandshake };
    }

    getOutboxCount(peerHex?: string): number {
        if (peerHex) {
            return this.outbox.get(peerHex)?.length ?? 0;
        }
        let total = 0;
        for (const q of this.outbox.values()) total += q.length;
        return total;
    }

    clearPeerRetryState(peerHex: string): void {
        this.handshakeRetries.delete(peerHex);
    }

    clear(): void {
        this.outbox.clear();
        this.handshakeRetries.clear();
        this.lastTickMs = 0;
    }
}
