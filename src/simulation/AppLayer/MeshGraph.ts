export class MeshGraph {
    // Adjacency list: PeerID -> Set of Neighbor PeerIDs
    // We only store confirmed edges (A->B and B->A) or just raw announcements?
    // The spec says: "An edge is only then CONFIRMED if it has been reported by both peers"
    // So we store raw announcements and derive confirmed edges for routing.
    
    // PeerID -> Set of announced neighbors
    private announcements: Map<string, Set<string>> = new Map();

    constructor() {}

    /**
     * Update the graph with a new announcement from a peer.
     * Newer announcements overwrite previous ones completely.
     */
    updateFromAnnouncement(originPeerID: string, neighbors: string[]) {
        // Filter out self-references
        const neighborSet = new Set(neighbors.filter(n => n !== originPeerID));
        this.announcements.set(originPeerID, neighborSet);
    }

    /**
     * Get all confirmed edges in the graph.
     * An edge (A, B) is confirmed if A announces B AND B announces A.
     */
    getConfirmedEdges(): { a: string, b: string }[] {
        const edges: { a: string, b: string }[] = [];
        const processedPairs = new Set<string>();

        for (const [a, neighbors] of this.announcements) {
            for (const b of neighbors) {
                // Check confirmation
                const bNeighbors = this.announcements.get(b);
                if (bNeighbors && bNeighbors.has(a)) {
                    // Create canonical pair key to avoid duplicates
                    const pair = [a, b].sort().join(':');
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
     * Compute shortest path using Dijkstra's algorithm on CONFIRMED edges only.
     * Returns full path including start and end: [start, hop1, hop2, ..., end]
     * Returns null if no path found.
     */
    getShortestPath(start: string, end: string): string[] | null {
        if (start === end) return [start];

        // Build adjacency list of confirmed edges for easier traversal
        const adj = new Map<string, string[]>();
        const confirmedEdges = this.getConfirmedEdges();
        
        for (const { a, b } of confirmedEdges) {
            if (!adj.has(a)) adj.set(a, []);
            if (!adj.has(b)) adj.set(b, []);
            adj.get(a)!.push(b);
            adj.get(b)!.push(a);
        }

        // Standard BFS (since weights are 1) is sufficient and optimal for unweighted graphs.
        // Dijkstra is same as BFS for unweighted.
        const queue: string[] = [start];
        const visited = new Set<string>([start]);
        const parent = new Map<string, string>();

        while (queue.length > 0) {
            const current = queue.shift()!;

            if (current === end) {
                // Reconstruct path
                const path: string[] = [end];
                let curr = end;
                while (curr !== start) {
                    curr = parent.get(curr)!;
                    path.unshift(curr);
                }
                return path;
            }

            const neighbors = adj.get(current) || [];
            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    parent.set(neighbor, current);
                    queue.push(neighbor);
                }
            }
        }

        return null;
    }

    clear() {
        this.announcements.clear();
    }
}
