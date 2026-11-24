import { BitchatPacket, MessageType, computePacketIdHex } from '../protocol/BitchatPacket';
import { TransportKind } from './BitchatConnection';

/**
 * Cross-transport bridge matching BitChat Android's `services/TransportBridgeService.kt`
 * (https://github.com/permissionlesstech/bitchat-android).
 *
 * Bridges packets between BLE and Wi-Fi Aware meshes with:
 * - Bounded 4,096-entry / 5-minute bridge dedup cache to prevent cross-transport ping-pong loops
 * - Never bridges link-local `REQUEST_SYNC (0x21)` packets
 * - Enforces `ttl > 0` before forwarding across transport boundaries
 */

export const TRANSPORT_BRIDGE_CONFIG = {
    MAX_DEDUP_ENTRIES: 4_096,
    DEDUP_EXPIRY_MS: 300_000,
} as const;

export class TransportBridge {
    private bridgedCache: Map<string, number> = new Map();
    bridgedCount: number = 0;

    /**
     * Check whether `packet` arriving on `fromTransport` may be bridged to `toTransport`.
     * Records the packet ID in the 4,096-entry / 5-minute bridge dedup table if allowed.
     */
    shouldBridge(
        packet: BitchatPacket,
        fromTransport: TransportKind,
        toTransport: TransportKind,
        nowMs: number
    ): boolean {
        if (fromTransport === toTransport) return true;
        if (packet.type === MessageType.REQUEST_SYNC) return false;
        if (packet.ttl < 0) return false;

        const key = `${computePacketIdHex(packet)}:${toTransport}`;
        const existing = this.bridgedCache.get(key);
        if (existing !== undefined && nowMs - existing < TRANSPORT_BRIDGE_CONFIG.DEDUP_EXPIRY_MS) {
            return false;
        }

        this.bridgedCache.set(key, nowMs);
        this.bridgedCount++;

        while (this.bridgedCache.size > TRANSPORT_BRIDGE_CONFIG.MAX_DEDUP_ENTRIES) {
            const oldest = this.bridgedCache.keys().next().value;
            if (oldest !== undefined) {
                this.bridgedCache.delete(oldest);
            } else {
                break;
            }
        }
        return true;
    }

    cleanup(nowMs: number): void {
        const cutoff = nowMs - TRANSPORT_BRIDGE_CONFIG.DEDUP_EXPIRY_MS;
        for (const [key, ts] of this.bridgedCache) {
            if (ts < cutoff) {
                this.bridgedCache.delete(key);
            }
        }
    }

    clear(): void {
        this.bridgedCache.clear();
        this.bridgedCount = 0;
    }
}
