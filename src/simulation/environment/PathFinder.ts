/**
 * PathFinder
 * Visibility graph-based pathfinding around building obstacles.
 * Uses lazy initialization and inflated polygons for proper wall margins.
 */

import { Building, Point2D } from './types';
import { hasLineOfSight } from './LineOfSight';

/** Default padding distance from building walls (meters) */
const DEFAULT_PADDING = 3;

/** Minimum gap width for paths (narrower gaps are blocked) */
const MIN_GAP_WIDTH = 4;

/** Result of a pathfinding query */
export interface PathResult {
    /** Waypoints from start to goal (includes start and goal) */
    waypoints: Point2D[];
    /** Total path distance in meters */
    totalDistance: number;
    /** Whether a valid path was found */
    found: boolean;
}

/** A node in the visibility graph */
interface GraphNode {
    point: Point2D;
    /** Indices of connected nodes */
    neighbors: number[];
    /** Distances to each neighbor */
    distances: number[];
}

/**
 * PathFinder using visibility graph and A* algorithm.
 * Finds shortest paths around building obstacles.
 */
export class PathFinder {
    private nodes: GraphNode[] = [];
    private buildings: Building[] = [];
    private padding: number = DEFAULT_PADDING;
    private graphBuilt: boolean = false;
    private needsRebuild: boolean = false;
    
    /** Inflated polygons for visibility checks (maintains wall margin) */
    private inflatedPolygons: Point2D[][] = [];

    /**
     * Prepare to build the visibility graph from buildings.
     * Actual building is deferred until first findPath() call (lazy init).
     */
    buildVisibilityGraph(buildings: Building[], padding: number = DEFAULT_PADDING): void {
        this.buildings = buildings;
        this.padding = padding;
        this.nodes = [];
        this.inflatedPolygons = [];
        
        // For empty buildings, mark as ready immediately
        if (buildings.length === 0) {
            this.graphBuilt = true;
            this.needsRebuild = false;
        } else {
            this.graphBuilt = false;
            this.needsRebuild = true;  // Mark for lazy rebuild
        }
    }

    /**
     * Ensure the visibility graph is built (lazy initialization).
     */
    private ensureGraphBuilt(): void {
        if (this.graphBuilt && !this.needsRebuild) return;
        
        this.nodes = [];
        this.inflatedPolygons = [];

        if (this.buildings.length === 0) {
            this.graphBuilt = true;
            this.needsRebuild = false;
            return;
        }

        // Build inflated polygons for visibility checks
        for (const building of this.buildings) {
            const inflated = this.getInflatedPolygon(building.vertices, this.padding);
            if (inflated.length >= 3) {
                this.inflatedPolygons.push(inflated);
            }
        }

        // Extract padded corner points from all buildings
        const cornerPoints: Point2D[] = [];
        for (const building of this.buildings) {
            const padded = this.getPaddedVertices(building.vertices);
            cornerPoints.push(...padded);
        }

        // Create nodes for each corner point
        for (const point of cornerPoints) {
            this.nodes.push({
                point,
                neighbors: [],
                distances: [],
            });
        }

        // Build edges between visible pairs
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const a = this.nodes[i].point;
                const b = this.nodes[j].point;

                if (this.canSee(a, b)) {
                    const dist = this.distance(a, b);
                    this.nodes[i].neighbors.push(j);
                    this.nodes[i].distances.push(dist);
                    this.nodes[j].neighbors.push(i);
                    this.nodes[j].distances.push(dist);
                }
            }
        }

        this.graphBuilt = true;
        this.needsRebuild = false;
    }

    /**
     * Find the shortest path from start to goal.
     */
    findPath(start: Point2D, goal: Point2D): PathResult {
        // Ensure graph is built (lazy init)
        this.ensureGraphBuilt();
        
        // If no buildings, return direct path
        if (this.buildings.length === 0) {
            const dist = this.distance(start, goal);
            return {
                waypoints: [start, goal],
                totalDistance: dist,
                found: true,
            };
        }

        // Check if direct path is possible
        if (this.canSee(start, goal)) {
            return {
                waypoints: [start, goal],
                totalDistance: this.distance(start, goal),
                found: true,
            };
        }

        // Add start and goal as temporary nodes
        const startIdx = this.nodes.length;
        const goalIdx = this.nodes.length + 1;

        const startNode: GraphNode = { point: start, neighbors: [], distances: [] };
        const goalNode: GraphNode = { point: goal, neighbors: [], distances: [] };

        // Track edges to add to existing nodes (will be removed after A*)
        const addedEdges: { nodeIdx: number; neighborIdx: number }[] = [];

        // Connect start and goal to visible graph nodes
        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            
            if (this.canSee(start, node.point)) {
                const dist = this.distance(start, node.point);
                startNode.neighbors.push(i);
                startNode.distances.push(dist);
            }
            
            if (this.canSee(goal, node.point)) {
                const dist = this.distance(goal, node.point);
                // Add edge from this node to goal
                node.neighbors.push(goalIdx);
                node.distances.push(dist);
                addedEdges.push({ nodeIdx: i, neighborIdx: goalIdx });
            }
        }

        // Check start-goal visibility
        if (this.canSee(start, goal)) {
            startNode.neighbors.push(goalIdx);
            startNode.distances.push(this.distance(start, goal));
        }

        // Temporarily add nodes
        this.nodes.push(startNode);
        this.nodes.push(goalNode);

        // Run A*
        const path = this.astar(startIdx, goalIdx);

        // Remove temporary nodes
        this.nodes.pop();
        this.nodes.pop();
        
        // Remove added edges from existing nodes
        for (const edge of addedEdges) {
            const node = this.nodes[edge.nodeIdx];
            const idx = node.neighbors.indexOf(edge.neighborIdx);
            if (idx !== -1) {
                node.neighbors.splice(idx, 1);
                node.distances.splice(idx, 1);
            }
        }

        if (!path) {
            // No path found - return direct path anyway (collision will handle it)
            return {
                waypoints: [start, goal],
                totalDistance: this.distance(start, goal),
                found: false,
            };
        }

        // Convert indices to waypoints
        const waypoints: Point2D[] = path.map(idx => {
            if (idx === startIdx) return start;
            if (idx === goalIdx) return goal;
            return this.nodes[idx].point;
        });

        // Calculate total distance
        let totalDistance = 0;
        for (let i = 1; i < waypoints.length; i++) {
            totalDistance += this.distance(waypoints[i - 1], waypoints[i]);
        }

        return { waypoints, totalDistance, found: true };
    }

    /**
     * A* pathfinding algorithm.
     */
    private astar(startIdx: number, goalIdx: number): number[] | null {
        const goal = goalIdx < this.nodes.length ? this.nodes[goalIdx].point : 
            (goalIdx === this.nodes.length + 1 ? this.nodes[this.nodes.length - 1].point : null);
        
        if (!goal) return null;

        const openSet = new Set<number>([startIdx]);
        const cameFrom = new Map<number, number>();
        
        const gScore = new Map<number, number>();
        gScore.set(startIdx, 0);
        
        const fScore = new Map<number, number>();
        const startPoint = startIdx < this.nodes.length ? this.nodes[startIdx].point : 
            this.nodes[this.nodes.length - 2].point;
        fScore.set(startIdx, this.distance(startPoint, goal));

        while (openSet.size > 0) {
            // Find node with lowest fScore
            let current = -1;
            let lowestF = Infinity;
            for (const idx of openSet) {
                const f = fScore.get(idx) ?? Infinity;
                if (f < lowestF) {
                    lowestF = f;
                    current = idx;
                }
            }

            if (current === goalIdx) {
                // Reconstruct path
                const path: number[] = [current];
                while (cameFrom.has(current)) {
                    current = cameFrom.get(current)!;
                    path.unshift(current);
                }
                return path;
            }

            openSet.delete(current);
            const currentNode = this.nodes[current];

            for (let i = 0; i < currentNode.neighbors.length; i++) {
                const neighbor = currentNode.neighbors[i];
                const dist = currentNode.distances[i];
                
                const tentativeG = (gScore.get(current) ?? Infinity) + dist;
                
                if (tentativeG < (gScore.get(neighbor) ?? Infinity)) {
                    cameFrom.set(neighbor, current);
                    gScore.set(neighbor, tentativeG);
                    
                    const neighborPoint = neighbor < this.nodes.length - 2 ? 
                        this.nodes[neighbor].point :
                        (neighbor === this.nodes.length - 2 ? this.nodes[this.nodes.length - 2].point :
                         this.nodes[this.nodes.length - 1].point);
                    fScore.set(neighbor, tentativeG + this.distance(neighborPoint, goal));
                    
                    openSet.add(neighbor);
                }
            }
        }

        return null; // No path found
    }

    /**
     * Get inflated polygon - expands the building polygon outward by padding.
     * This creates a buffer zone around the building for visibility checks.
     */
    private getInflatedPolygon(vertices: Point2D[], padding: number): Point2D[] {
        const n = vertices.length;
        if (n < 3) return [];

        const inflated: Point2D[] = [];

        for (let i = 0; i < n; i++) {
            const prev = vertices[(i - 1 + n) % n];
            const curr = vertices[i];
            const next = vertices[(i + 1) % n];

            // Calculate edge vectors
            const e1 = { x: curr.x - prev.x, y: curr.y - prev.y };
            const e2 = { x: next.x - curr.x, y: next.y - curr.y };

            // Normalize
            const len1 = Math.sqrt(e1.x * e1.x + e1.y * e1.y);
            const len2 = Math.sqrt(e2.x * e2.x + e2.y * e2.y);
            
            if (len1 < 0.001 || len2 < 0.001) {
                inflated.push(curr);
                continue;
            }

            e1.x /= len1; e1.y /= len1;
            e2.x /= len2; e2.y /= len2;

            // Outward normals (perpendicular, pointing out)
            const n1 = { x: e1.y, y: -e1.x };
            const n2 = { x: e2.y, y: -e2.x };

            // Average normal (bisector direction)
            let bisector = { x: n1.x + n2.x, y: n1.y + n2.y };
            const bisectorLen = Math.sqrt(bisector.x * bisector.x + bisector.y * bisector.y);
            
            if (bisectorLen < 0.001) {
                bisector = n1;
            } else {
                bisector.x /= bisectorLen;
                bisector.y /= bisectorLen;
            }

            // Calculate offset distance (account for angle)
            const dot = n1.x * bisector.x + n1.y * bisector.y;
            const offsetDist = dot > 0.1 ? padding / dot : padding * 2;
            const clampedOffset = Math.min(offsetDist, padding * 3);

            inflated.push({
                x: curr.x + bisector.x * clampedOffset,
                y: curr.y + bisector.y * clampedOffset,
            });
        }

        return inflated;
    }

    /**
     * Get padded vertices for a building polygon.
     * Offsets each vertex outward to create clearance for waypoints.
     */
    private getPaddedVertices(vertices: Point2D[]): Point2D[] {
        // Use the same inflation algorithm
        return this.getInflatedPolygon(vertices, this.padding);
    }

    /**
     * Check if two points can see each other (no building in the way).
     * Also checks that the path doesn't pass through narrow gaps.
     */
    private canSee(a: Point2D, b: Point2D): boolean {
        // Use a slightly shrunk line to avoid edge cases at vertices
        const shrink = 0.01;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        
        if (len < shrink * 2) return true;
        
        const aShrunk = { x: a.x + (dx / len) * shrink, y: a.y + (dy / len) * shrink };
        const bShrunk = { x: b.x - (dx / len) * shrink, y: b.y - (dy / len) * shrink };
        
        // Basic line-of-sight check against original buildings
        if (!hasLineOfSight(aShrunk, bShrunk, this.buildings)) {
            return false;
        }
        
        // Additional check: ensure path doesn't pass through narrow gaps
        // Check if the path midpoint is too close to any building
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const midpoint = { x: midX, y: midY };
        
        for (const building of this.buildings) {
            const dist = this.pointToPolygonDistance(midpoint, building.vertices);
            if (dist < MIN_GAP_WIDTH / 2) {
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * Calculate minimum distance from a point to a polygon.
     */
    private pointToPolygonDistance(p: Point2D, polygon: Point2D[]): number {
        // If point is inside polygon, return 0
        if (this.pointInPolygon(p, polygon)) {
            return 0;
        }
        
        let minDist = Infinity;
        const n = polygon.length;
        
        for (let i = 0; i < n; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % n];
            const dist = this.pointToSegmentDistance(p, p1, p2);
            if (dist < minDist) {
                minDist = dist;
            }
        }
        
        return minDist;
    }
    
    /**
     * Calculate distance from a point to a line segment.
     */
    private pointToSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        
        if (lenSq === 0) {
            // Segment is a point
            return this.distance(p, a);
        }
        
        // Project p onto the line, clamping to segment
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        
        const proj = { x: a.x + t * dx, y: a.y + t * dy };
        return this.distance(p, proj);
    }

    /**
     * Check if a point is inside a polygon using ray casting.
     */
    private pointInPolygon(p: Point2D, polygon: Point2D[]): boolean {
        const n = polygon.length;
        if (n < 3) return false;

        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const pi = polygon[i];
            const pj = polygon[j];
            
            if (((pi.y > p.y) !== (pj.y > p.y)) &&
                (p.x < (pj.x - pi.x) * (p.y - pi.y) / (pj.y - pi.y) + pi.x)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /**
     * Euclidean distance between two points.
     */
    private distance(a: Point2D, b: Point2D): number {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Get the number of nodes in the visibility graph.
     */
    getNodeCount(): number {
        this.ensureGraphBuilt();
        return this.nodes.length;
    }

    /**
     * Check if graph has been built.
     */
    isReady(): boolean {
        return this.graphBuilt && !this.needsRebuild;
    }
}
