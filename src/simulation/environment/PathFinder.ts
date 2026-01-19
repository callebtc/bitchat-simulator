/**
 * PathFinder
 * Visibility graph-based pathfinding around building obstacles.
 * Uses lazy initialization and inflated polygons for proper wall margins.
 */

import { Building, Point2D } from './types';
import { hasLineOfSight, hasClearance, isPointStrictlyInside } from './LineOfSight';

/** Default padding distance from building walls (meters) */
const DEFAULT_PADDING = 3;

/** Maximum distance to consider for visibility edges (optimization) */
const MAX_VISIBILITY_DISTANCE = 150;

/** Result of a pathfinding query */
export interface PathResult {
    /** Waypoints from start to goal (includes start and goal) */
    waypoints: Point2D[];
    /** Total path distance in meters */
    totalDistance: number;
    /** Whether a valid path was found */
    found: boolean;
}

/** Progress callback for async graph building */
export type GraphBuildProgress = (progress: number, status: string) => void;

/** A node in the visibility graph */
interface GraphNode {
    point: Point2D;
    /** Indices of connected nodes */
    neighbors: number[];
    /** Distances to each neighbor */
    distances: number[];
}

/** How many edge checks to do before yielding to UI */
const CHUNK_SIZE = 2000;

/** localStorage key prefix for visibility graph cache */
const GRAPH_CACHE_PREFIX = 'bitchat_visgraph_';

/** Cache entry structure */
interface GraphCacheEntry {
    timestamp: number;
    padding: number;
    nodes: GraphNode[];
    inflatedPolygons: Point2D[][];
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
    private isBuilding: boolean = false;
    private buildPromise: Promise<void> | null = null;
    
    /** Inflated polygons for visibility checks (maintains wall margin) */
    private inflatedPolygons: Point2D[][] = [];
    
    /** Progress callback */
    onProgress?: GraphBuildProgress;

    /**
     * Prepare to build the visibility graph from buildings.
     * Tries to load from cache first. If not cached, defers building until needed.
     * Returns true if loaded from cache, false if needs building.
     */
    buildVisibilityGraph(buildings: Building[], padding: number = DEFAULT_PADDING): boolean {
        // For empty buildings, mark as ready immediately
        if (buildings.length === 0) {
            this.buildings = buildings;
            this.padding = padding;
            this.nodes = [];
            this.inflatedPolygons = [];
            this.graphBuilt = true;
            this.needsRebuild = false;
            return true;
        }
        
        // Try to load from cache first
        if (this.tryLoadFromCache(buildings, padding)) {
            return true;
        }
        
        // Cache miss - prepare for lazy build
        this.buildings = buildings;
        this.padding = padding;
        this.nodes = [];
        this.inflatedPolygons = [];
        this.graphBuilt = false;
        this.needsRebuild = true;  // Mark for lazy rebuild
        return false;
    }

    /**
     * Pre-build the visibility graph asynchronously.
     * Call this after loading buildings to avoid blocking when first path is needed.
     */
    async buildGraphAsync(): Promise<void> {
        if (this.graphBuilt && !this.needsRebuild) return;
        if (this.isBuilding && this.buildPromise) {
            return this.buildPromise;
        }
        
        this.isBuilding = true;
        this.buildPromise = this.doBuildGraphAsync();
        
        try {
            await this.buildPromise;
        } finally {
            this.isBuilding = false;
            this.buildPromise = null;
        }
    }
    
    /**
     * Internal async graph building with progress reporting.
     */
    private async doBuildGraphAsync(): Promise<void> {
        this.nodes = [];
        this.inflatedPolygons = [];

        if (this.buildings.length === 0) {
            this.graphBuilt = true;
            this.needsRebuild = false;
            this.onProgress?.(1, 'Ready');
            return;
        }

        this.onProgress?.(0, 'Preparing buildings...');
        await this.yieldToUI();

        // Build inflated polygons for visibility checks
        for (const building of this.buildings) {
            const inflated = this.getInflatedPolygon(building.vertices, this.padding);
            if (inflated.length >= 3) {
                this.inflatedPolygons.push(inflated);
            }
        }

        // Extract padded corner points from all buildings
        let cornerPoints: Point2D[] = [];
        for (const building of this.buildings) {
            const padded = this.getPaddedVertices(building.vertices);
            cornerPoints.push(...padded);
        }

        // Filter out points that are strictly inside other inflated polygons
        cornerPoints = cornerPoints.filter(p => {
            for (const inflated of this.inflatedPolygons) {
                if (isPointStrictlyInside(p, inflated)) {
                    return false;
                }
            }
            return true;
        });

        // Create nodes for each corner point
        for (const point of cornerPoints) {
            this.nodes.push({
                point,
                neighbors: [],
                distances: [],
            });
        }

        this.onProgress?.(0.1, `Building visibility graph (${this.nodes.length} nodes)...`);
        await this.yieldToUI();

        // Build edges between visible pairs (the expensive O(n²) part)
        // Optimized: skip pairs that are too far apart
        const totalPairs = (this.nodes.length * (this.nodes.length - 1)) / 2;
        let pairCount = 0;
        let lastProgressUpdate = 0;
        
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const a = this.nodes[i].point;
                const b = this.nodes[j].point;
                
                // Early distance check - skip very distant pairs
                const dist = this.distance(a, b);
                if (dist <= MAX_VISIBILITY_DISTANCE && this.canSee(a, b)) {
                    this.nodes[i].neighbors.push(j);
                    this.nodes[i].distances.push(dist);
                    this.nodes[j].neighbors.push(i);
                    this.nodes[j].distances.push(dist);
                }
                
                pairCount++;
                
                // Yield periodically to keep UI responsive
                if (pairCount % CHUNK_SIZE === 0) {
                    const progress = 0.1 + (pairCount / totalPairs) * 0.9;
                    // Only update progress every 5%
                    if (progress - lastProgressUpdate > 0.05) {
                        lastProgressUpdate = progress;
                        this.onProgress?.(progress, `Building visibility graph (${Math.round(progress * 100)}%)...`);
                    }
                    await this.yieldToUI();
                }
            }
        }

        this.graphBuilt = true;
        this.needsRebuild = false;
        
        // Save to cache for next time
        this.saveToCache();
        
        this.onProgress?.(1, 'Ready');
    }
    
    /**
     * Yield to the UI thread.
     */
    private yieldToUI(): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, 0));
    }
    
    /**
     * Ensure the visibility graph is built (synchronous fallback).
     */
    private ensureGraphBuilt(): void {
        if (this.graphBuilt && !this.needsRebuild) return;
        
        // If currently building async, wait for it (but this is a sync call so we can't)
        // Fall back to synchronous build
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
        let cornerPoints: Point2D[] = [];
        for (const building of this.buildings) {
            const padded = this.getPaddedVertices(building.vertices);
            cornerPoints.push(...padded);
        }

        // Filter out points that are strictly inside other inflated polygons
        cornerPoints = cornerPoints.filter(p => {
            for (const inflated of this.inflatedPolygons) {
                if (isPointStrictlyInside(p, inflated)) {
                    return false;
                }
            }
            return true;
        });

        // Create nodes for each corner point
        for (const point of cornerPoints) {
            this.nodes.push({
                point,
                neighbors: [],
                distances: [],
            });
        }

        // Build edges between visible pairs (with distance culling)
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const a = this.nodes[i].point;
                const b = this.nodes[j].point;
                
                const dist = this.distance(a, b);
                if (dist <= MAX_VISIBILITY_DISTANCE && this.canSee(a, b)) {
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
     * Check if graph is currently being built.
     */
    isBuildingGraph(): boolean {
        return this.isBuilding;
    }

    /**
     * Check if a point is inside any building.
     */
    private isInsideAnyBuilding(p: Point2D): boolean {
        for (const building of this.buildings) {
            if (this.pointInPolygon(p, building.vertices)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Validate that all segments of a path are clear (multi-sample check).
     * Returns true if the entire path maintains proper clearance.
     */
    private validatePath(waypoints: Point2D[]): boolean {
        for (let i = 0; i < waypoints.length - 1; i++) {
            if (!this.canSee(waypoints[i], waypoints[i + 1])) {
                return false;
            }
        }
        return true;
    }

    /**
     * Find the shortest path from start to goal.
     */
    findPath(start: Point2D, goal: Point2D): PathResult {
        // Ensure graph is built (lazy init)
        this.ensureGraphBuilt();
        
        const dist = this.distance(start, goal);
        
        // If no buildings, return direct path
        if (this.buildings.length === 0) {
            return {
                waypoints: [start, goal],
                totalDistance: dist,
                found: true,
            };
        }

        // Zone validation: both start and goal must be in compatible zones
        // (both inside same building, or both outside all buildings)
        const startInside = this.isInsideAnyBuilding(start);
        const goalInside = this.isInsideAnyBuilding(goal);
        
        if (startInside !== goalInside) {
            // Cannot path from inside to outside or vice versa
            return {
                waypoints: [start, goal],
                totalDistance: dist,
                found: false,
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
            // No path found
            return {
                waypoints: [],
                totalDistance: 0,
                found: false,
            };
        }

        // Convert indices to waypoints
        const waypoints: Point2D[] = path.map(idx => {
            if (idx === startIdx) return start;
            if (idx === goalIdx) return goal;
            return this.nodes[idx].point;
        });

        // Post-validation: verify the complete path maintains clearance
        // This catches any edge cases that slipped through individual segment checks
        if (!this.validatePath(waypoints)) {
            // Path validation failed - return as not found
            // The collision detection system will handle it at runtime
            return {
                waypoints: [start, goal],
                totalDistance: this.distance(start, goal),
                found: false,
            };
        }

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
     * Optimized: uses inflated polygons for clearance (skips expensive distance calc).
     */
    private canSee(a: Point2D, b: Point2D): boolean {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        
        // Very short distances are always visible
        if (len < 0.1) return true;
        
        // Check basic line-of-sight against original buildings first (fast rejection)
        const shrink = 0.01;
        const aShrunk = { x: a.x + (dx / len) * shrink, y: a.y + (dy / len) * shrink };
        const bShrunk = { x: b.x - (dx / len) * shrink, y: b.y - (dy / len) * shrink };
        
        if (!hasLineOfSight(aShrunk, bShrunk, this.buildings)) {
            return false;
        }
        
        // Check if the path maintains clearance (using inflated polygons)
        // This ensures the path doesn't cut through the safety margin
        if (!hasClearance(a, b, this.inflatedPolygons)) {
            return false;
        }
        
        return true;
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
     * Returns 0 if graph hasn't been built yet (lazy init).
     */
    getNodeCount(): number {
        return this.nodes.length;
    }

    /**
     * Check if graph has been built.
     */
    isReady(): boolean {
        return this.graphBuilt && !this.needsRebuild;
    }

    /**
     * Generate a cache key from buildings data.
     */
    private generateCacheKey(buildings: Building[]): string {
        // Create a simple hash from building count and first few building coordinates
        if (buildings.length === 0) return '';
        
        let hash = buildings.length.toString();
        for (let i = 0; i < Math.min(5, buildings.length); i++) {
            const b = buildings[i];
            if (b.vertices.length > 0) {
                hash += `_${b.vertices[0].x.toFixed(1)}_${b.vertices[0].y.toFixed(1)}`;
            }
        }
        // Also include total vertex count for uniqueness
        const totalVertices = buildings.reduce((sum, b) => sum + b.vertices.length, 0);
        hash += `_v${totalVertices}`;
        
        return GRAPH_CACHE_PREFIX + hash;
    }

    /**
     * Try to load visibility graph from cache.
     * Returns true if cache was loaded, false if not found or invalid.
     */
    tryLoadFromCache(buildings: Building[], padding: number): boolean {
        if (typeof localStorage === 'undefined') return false;
        if (buildings.length === 0) return false;
        
        const cacheKey = this.generateCacheKey(buildings);
        if (!cacheKey) return false;
        
        try {
            const cached = localStorage.getItem(cacheKey);
            if (!cached) return false;
            
            const entry: GraphCacheEntry = JSON.parse(cached);
            
            // Validate padding matches
            if (entry.padding !== padding) {
                console.log('[PathFinder] Cache padding mismatch, rebuilding');
                return false;
            }
            
            // Load cached data
            this.buildings = buildings;
            this.padding = padding;
            this.nodes = entry.nodes;
            this.inflatedPolygons = entry.inflatedPolygons;
            this.graphBuilt = true;
            this.needsRebuild = false;
            
            console.log(`[PathFinder] Loaded graph from cache (${this.nodes.length} nodes)`);
            return true;
        } catch (e) {
            console.warn('[PathFinder] Cache load error:', e);
            return false;
        }
    }

    /**
     * Save visibility graph to cache.
     */
    saveToCache(): void {
        if (typeof localStorage === 'undefined') return;
        if (!this.graphBuilt || this.buildings.length === 0) return;
        
        const cacheKey = this.generateCacheKey(this.buildings);
        if (!cacheKey) return;
        
        try {
            const entry: GraphCacheEntry = {
                timestamp: Date.now(),
                padding: this.padding,
                nodes: this.nodes,
                inflatedPolygons: this.inflatedPolygons,
            };
            
            localStorage.setItem(cacheKey, JSON.stringify(entry));
            console.log(`[PathFinder] Saved graph to cache (${this.nodes.length} nodes)`);
        } catch (e) {
            console.warn('[PathFinder] Cache save error:', e);
        }
    }

    /**
     * Clear all visibility graph caches.
     */
    static clearCache(): void {
        const keysToRemove: string[] = [];
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(GRAPH_CACHE_PREFIX)) {
                keysToRemove.push(key);
            }
        }
        
        for (const key of keysToRemove) {
            localStorage.removeItem(key);
        }
        
        console.log(`[PathFinder] Cleared ${keysToRemove.length} cached graphs`);
    }
}
