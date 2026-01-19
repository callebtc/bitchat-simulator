import { describe, it, expect } from 'vitest';
import { MeshGraph } from './MeshGraph';

describe('MeshGraph', () => {
    it('should confirm bidirectional edges', () => {
        const graph = new MeshGraph();
        
        // A announces B
        graph.updateFromAnnouncement('A', ['B']);
        expect(graph.getConfirmedEdges().length).toBe(0);

        // B announces A
        graph.updateFromAnnouncement('B', ['A']);
        const edges = graph.getConfirmedEdges();
        expect(edges.length).toBe(1);
        // We can't guarantee order of a/b in the object, but we know the pair
        const edge = edges[0];
        const participants = [edge.a, edge.b].sort();
        expect(participants).toEqual(['A', 'B']);
    });

    it('should ignore unconfirmed edges in routing', () => {
        const graph = new MeshGraph();
        graph.updateFromAnnouncement('A', ['B']); // One way
        
        const path = graph.getShortestPath('A', 'B');
        expect(path).toBeNull();
    });

    it('should find shortest path (BFS)', () => {
        const graph = new MeshGraph();
        // A <-> B <-> C
        graph.updateFromAnnouncement('A', ['B']);
        graph.updateFromAnnouncement('B', ['A', 'C']);
        graph.updateFromAnnouncement('C', ['B']);

        const path = graph.getShortestPath('A', 'C');
        expect(path).toEqual(['A', 'B', 'C']);
    });

    it('should handle updates (overwriting edges)', () => {
        const graph = new MeshGraph();
        // A <-> B
        graph.updateFromAnnouncement('A', ['B']);
        graph.updateFromAnnouncement('B', ['A']);
        expect(graph.getConfirmedEdges().length).toBe(1);

        // A updates: no neighbors
        graph.updateFromAnnouncement('A', []);
        expect(graph.getConfirmedEdges().length).toBe(0);
    });

    it('should find path in complex graph', () => {
        // A - B - D
        // |   | /
        // C - E
        const graph = new MeshGraph();
        const edges = [
            ['A', 'B'], ['A', 'C'],
            ['B', 'A'], ['B', 'D'], ['B', 'E'],
            ['C', 'A'], ['C', 'E'],
            ['D', 'B'], ['D', 'E'],
            ['E', 'B'], ['E', 'C'], ['E', 'D']
        ];
        
        // Helper to populate
        const adj = new Map<string, string[]>();
        edges.forEach(([u, v]) => {
            if (!adj.has(u)) adj.set(u, []);
            adj.get(u)!.push(v);
        });
        
        adj.forEach((neighbors, u) => graph.updateFromAnnouncement(u, neighbors));

        // Path A -> D
        // Options: A-B-D (2 hops), A-C-E-D (3 hops), A-B-E-D (3 hops)
        const path = graph.getShortestPath('A', 'D');
        expect(path).toEqual(['A', 'B', 'D']);
    });
});
