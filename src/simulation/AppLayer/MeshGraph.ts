import { MAX_DIRECT_NEIGHBORS } from '../../protocol/TLV';

/**
 * Mesh topology graph built from ANNOUNCE neighbor gossip (TLV 0x04),
 * aligned with Android MeshGraphService.kt & RoutePlanner.kt:
 * - Enforces timestamp ordering (`prevTs >= timestamp` ignored when supplied).
 * - Caps neighbor lists at 10 unique direct neighbors (excluding self-loops).
 * - Removes stale peers and their incident edges cleanly via `removePeer`.
 * - Computes shortest paths strictly over bidirectionally confirmed edges
 *   (A announces B AND B announces A), with optional max intermediate hop cap.
 */
export class MeshGraph {
    private announcements: Map<string, Set<string>> = new Map();
    private lastUpdateTs: Map<string, bigint> = new Map();

    /**
     * Update the graph with a new announcement from a peer.
     * When `timestamp` is provided, older or equal updates are ignored.
     */
    updateFromAnnouncement(
        originPeerID: string,
        neighbors: string[],
        timestamp?: bigint,
        maxNeighbors: number = MAX_DIRECT_NEIGHBORS
    ): boolean {
        if (timestamp !== undefined) {
            const prev = this.lastUpdateTs.get(originPeerID);
            if (prev !== undefined && prev >= timestamp) {
                return false;
            }
            this.lastUpdateTs.set(originPeerID, timestamp);
        }

        const neighborSet = new Set<string>();
        for (const n of neighbors) {
            if (n === originPeerID) continue;
            neighborSet.add(n);
            if (neighborSet.size >= maxNeighbors) break;
        }
        this.announcements.set(originPeerID, neighborSet);
        return true;
    }

    /**
     * Remove a peer completely from the graph (Android MeshGraphService.removePeer).
     */
    removePeer(peerID: string): void {
        this.announcements.delete(peerID);
        this.lastUpdateTs.delete(peerID);
        for (const neighbors of this.announcements.values()) {
            neighbors.delete(peerID);
        }
    }

    /**
     * Get all confirmed edges in the graph.
     * An edge (A, B) is confirmed if A announces B AND B announces A.
     */
    getConfirmedEdges(): { a: string; b: string }[] {
        const edges: { a: string; b: string }[] = [];
        const processedPairs = new Set<string>();

        for (const [a, neighbors] of this.announcements) {
            for (const b of neighbors) {
                const bNeighbors = this.announcements.get(b);
                if (bNeighbors && bNeighbors.has(a)) {
                    const pair = a < b ? `${a}:${b}` : `${b}:${a}`;
                    if (!processedPairs.has(pair)) {
                        processedPairs.add(pair);
                        edges.push({ a, b });
                    }
                }
            }
        }
        return edges;
    }

    /**
     * Compute shortest unweighted path using BFS on CONFIRMED edges only.
     * Returns full path [start, hop1, ..., end], or null if unreachable or
     * if intermediate hop count exceeds maxIntermediateHops.
     */
    getShortestPath(
        start: string,
        end: string,
        maxIntermediateHops: number = Number.POSITIVE_INFINITY
    ): string[] | null {
        if (start === end) return [start];
        if (!this.announcements.has(start) || !this.announcements.has(end)) return null;

        // Direct on-the-fly BFS over bidirectionally confirmed edges (avoids O(V*d) full-graph rebuild)
        const maxEdges =
            Number.isFinite(maxIntermediateHops) ? maxIntermediateHops + 1 : Number.POSITIVE_INFINITY;
        const queue: string[] = [start];
        const depth: number[] = [0];
        let head = 0;
        const visited = new Set<string>([start]);
        const parent = new Map<string, string>();

        while (head < queue.length) {
            const current = queue[head];
            const currDepth = depth[head];
            head++;

            if (currDepth >= maxEdges) continue;

            const neighbors = this.announcements.get(current);
            if (!neighbors) continue;

            for (const neighbor of neighbors) {
                if (visited.has(neighbor)) continue;
                // Edge (current, neighbor) is confirmed iff neighbor also announces current
                const reverse = this.announcements.get(neighbor);
                if (!reverse || !reverse.has(current)) continue;

                visited.add(neighbor);
                parent.set(neighbor, current);

                if (neighbor === end) {
                    const path: string[] = [end];
                    let curr = end;
                    while (curr !== start) {
                        curr = parent.get(curr)!;
                        path.push(curr);
                    }
                    path.reverse();
                    return path;
                }

                queue.push(neighbor);
                depth.push(currDepth + 1);
            }
        }

        return null;
    }

    hasNeighbor(origin: string, neighbor: string): boolean {
        return this.announcements.get(origin)?.has(neighbor) ?? false;
    }

    clear(): void {
        this.announcements.clear();
        this.lastUpdateTs.clear();
    }
}
