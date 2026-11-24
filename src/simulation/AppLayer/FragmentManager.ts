import { BitchatPacket, MessageType } from '../../protocol/BitchatPacket';
import { BinaryProtocol } from '../../protocol/BinaryProtocol';
import { MessagePadding } from '../../protocol/MessagePadding';
import { FRAGMENT_HEADER_SIZE, FragmentPayload } from '../../protocol/FragmentPayload';
import { SeededRandom } from '../SeededRandom';

/**
 * Packet fragmentation and reassembly manager matching Android FragmentManager.kt
 * and FragmentingPacketSender.kt:
 * - MTU threshold: 512 bytes; max fragment data chunk: 469 bytes (reduced by v2 route overhead)
 * - Fragments inherit version = 2 and `route` from routed parent packets (SOURCE_ROUTING.md §5)
 * - Paced 20 ms apart on Android (`INTER_FRAGMENT_DELAY_MS = 20`)
 * - Reassembly bounds: 30 s timeout, 64 concurrent sets, 256 fragments/ID,
 *   1 MiB/set, 4 MiB global cap.
 * - Reassembled packet returned with `ttl = 0` so fragments relay individually
 *   without triggering a second whole-packet flood.
 */

export const FRAGMENT_CONFIG = {
    FRAGMENT_SIZE_THRESHOLD: 512,
    MAX_FRAGMENT_SIZE: 469,
    FRAGMENT_TIMEOUT_MS: 30_000,
    CLEANUP_INTERVAL_MS: 10_000,
    MAX_FRAGMENTS_PER_ID: 256,
    MAX_FRAGMENT_TOTAL_BYTES: 1_048_576,
    MAX_ACTIVE_FRAGMENT_SETS: 64,
    MAX_GLOBAL_FRAGMENT_TOTAL_BYTES: 4 * 1_048_576,
    INTER_FRAGMENT_DELAY_MS: 20,
} as const;

interface AssemblyState {
    originalType: number;
    total: number;
    createdAtMs: number;
    chunks: Map<number, Uint8Array>;
    cumulativeBytes: number;
}

export class FragmentManager {
    private assemblies: Map<string, AssemblyState> = new Map();
    private globalBufferedBytes: number = 0;

    /**
     * Split a packet into <= 512 B BLE fragments if its unpadded wire frame exceeds 512 B.
     * Returns `[packet]` unchanged if no fragmentation is required.
     */
    createFragments(
        packet: BitchatPacket,
        rng: SeededRandom,
        maxFragments: number = FRAGMENT_CONFIG.MAX_FRAGMENTS_PER_ID
    ): BitchatPacket[] {
        if (packet.type === MessageType.FRAGMENT) {
            return [packet];
        }
        const encoded = BinaryProtocol.encode(packet, { padding: false });
        if (!encoded) return [];

        const fullData = MessagePadding.unpad(encoded);
        if (fullData.length <= FRAGMENT_CONFIG.FRAGMENT_SIZE_THRESHOLD) {
            return [packet];
        }

        const hasRoute = Boolean(packet.route && packet.route.length > 0);
        const version = hasRoute ? 2 : 1;
        const headerSize = version === 2 ? 16 : 14;
        const senderSize = 8;
        const recipientSize = packet.recipientID ? 8 : 0;
        const routeSize = hasRoute ? 1 + packet.route!.length * 8 : 0;
        const paddingBuffer = 16;

        const overhead =
            headerSize + senderSize + recipientSize + routeSize + FRAGMENT_HEADER_SIZE + paddingBuffer;
        const maxDataSize = Math.min(
            FRAGMENT_CONFIG.MAX_FRAGMENT_SIZE,
            FRAGMENT_CONFIG.FRAGMENT_SIZE_THRESHOLD - overhead
        );

        if (maxDataSize <= 0) {
            return [];
        }

        const totalFragments = Math.ceil(fullData.length / maxDataSize);
        if (totalFragments > maxFragments) {
            return [];
        }

        const fragmentID = FragmentPayload.generateFragmentID(rng);
        const fragments: BitchatPacket[] = [];

        for (let index = 0; index < totalFragments; index++) {
            const start = index * maxDataSize;
            const end = Math.min(start + maxDataSize, fullData.length);
            const chunk = fullData.slice(start, end);

            const fragPayload = FragmentPayload.encode({
                fragmentID,
                index,
                total: totalFragments,
                originalType: packet.type,
                data: chunk,
            });

            fragments.push({
                version,
                type: MessageType.FRAGMENT,
                ttl: packet.ttl,
                senderID: packet.senderID,
                recipientID: packet.recipientID,
                timestamp: packet.timestamp,
                payload: fragPayload,
                route: packet.route,
                signature: undefined,
            });
        }

        return fragments;
    }

    /**
     * Ingest one incoming FRAGMENT packet.
     * Returns the reassembled parent packet with `ttl = 0` once all fragments arrive.
     */
    handleFragment(packet: BitchatPacket, nowMs: number): BitchatPacket | null {
        const frag = FragmentPayload.decode(packet.payload);
        if (!frag) return null;
        if (frag.total > FRAGMENT_CONFIG.MAX_FRAGMENTS_PER_ID) return null;

        const idHex = FragmentPayload.getFragmentIDHex(frag.fragmentID);
        let state = this.assemblies.get(idHex);
        const isNewSet = !state;

        if (state) {
            if (state.total !== frag.total || state.originalType !== frag.originalType) {
                return null; // Reject inconsistent header without destroying active assembly
            }
        } else {
            if (this.assemblies.size >= FRAGMENT_CONFIG.MAX_ACTIVE_FRAGMENT_SETS) {
                return null;
            }
            state = {
                originalType: frag.originalType,
                total: frag.total,
                createdAtMs: nowMs,
                chunks: new Map(),
                cumulativeBytes: 0,
            };
            this.assemblies.set(idHex, state);
        }

        const existingChunk = state.chunks.get(frag.index);
        if (existingChunk) {
            // Protect already-held index bytes against conflicting duplicates
            if (existingChunk.length !== frag.data.length) return null;
            for (let i = 0; i < existingChunk.length; i++) {
                if (existingChunk[i] !== frag.data[i]) return null;
            }
            return null; // Already have identical chunk
        }

        const nextSize = state.cumulativeBytes + frag.data.length;
        if (nextSize > FRAGMENT_CONFIG.MAX_FRAGMENT_TOTAL_BYTES) {
            if (isNewSet) this.removeAssembly(idHex);
            return null;
        }
        if (this.globalBufferedBytes + frag.data.length > FRAGMENT_CONFIG.MAX_GLOBAL_FRAGMENT_TOTAL_BYTES) {
            if (isNewSet) this.removeAssembly(idHex);
            return null;
        }

        state.chunks.set(frag.index, frag.data);
        state.cumulativeBytes = nextSize;
        this.globalBufferedBytes += frag.data.length;

        if (state.chunks.size === state.total) {
            const combined = new Uint8Array(state.cumulativeBytes);
            let offset = 0;
            for (let i = 0; i < state.total; i++) {
                const c = state.chunks.get(i);
                if (!c) return null;
                combined.set(c, offset);
                offset += c.length;
            }
            this.removeAssembly(idHex);
            const original = BinaryProtocol.decode(combined);
            if (!original) return null;
            // Suppress TTL so reassembled packet is processed locally only (fragments relay independently)
            return { ...original, ttl: 0 };
        }

        return null;
    }

    /**
     * Evict incomplete assemblies older than 30 seconds. Returns count evicted.
     */
    cleanupExpired(nowMs: number): number {
        const cutoff = nowMs - FRAGMENT_CONFIG.FRAGMENT_TIMEOUT_MS;
        let expired = 0;
        for (const [id, state] of this.assemblies) {
            if (state.createdAtMs < cutoff) {
                this.removeAssembly(id);
                expired++;
            }
        }
        return expired;
    }

    getActiveAssemblyCount(): number {
        return this.assemblies.size;
    }

    clear(): void {
        this.assemblies.clear();
        this.globalBufferedBytes = 0;
    }

    private removeAssembly(idHex: string): void {
        const state = this.assemblies.get(idHex);
        if (!state) return;
        this.globalBufferedBytes = Math.max(0, this.globalBufferedBytes - state.cumulativeBytes);
        this.assemblies.delete(idHex);
    }
}
