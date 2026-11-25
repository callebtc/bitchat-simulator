/**
 * PathFinder
 * High-performance visibility graph pathfinding around building obstacles.
 * Uses 2D spatial grids for buildings, clearance polygons, and graph nodes,
 * normalizes CW/CCW OpenStreetMap polygon winding, generates nodes only at
 * convex outer corners, connects start/goal via real-building line-of-sight
 * (so agents near walls never get stranded), and smooths paths via string-pulling.
 */

import { Building, BoundingBox, Point2D, calculateBounds } from './types';
import { hasLineOfSight, hasClearance, isPointStrictlyInside } from './LineOfSight';

const DEFAULT_PADDING = 1.5;
const MAX_VISIBILITY_DISTANCE = 150;
const FALLBACK_ENDPOINT_RADIUS = 350;
const CHUNK_SIZE = 2000;
// v2 invalidates older caches built before CW/CCW winding normalization
const GRAPH_CACHE_PREFIX = 'bitchat_visgraph_v2_';
const POLY_CELL_SIZE = 25;
const NODE_CELL_SIZE = 50;
const GRID_OFFSET = 32768;
const GRID_STRIDE = 65536;
const MAX_ENDPOINT_CONNECTORS = 32;

function packCell(gx: number, gy: number): number {
    return (gx + GRID_OFFSET) * GRID_STRIDE + (gy + GRID_OFFSET);
}

/** Signed polygon area (> 0 means CCW in Y-up coordinates, < 0 means CW). */
function signedPolygonArea(vertices: Point2D[]): number {
    let area2 = 0;
    const n = vertices.length;
    for (let i = 0; i < n; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % n];
        area2 += a.x * b.y - b.x * a.y;
    }
    return area2 * 0.5;
}

/** Normalize polygon winding to CCW and remove consecutive duplicate vertices. */
function normalizeCCW(vertices: Point2D[]): Point2D[] {
    const cleaned: Point2D[] = [];
    for (let i = 0; i < vertices.length; i++) {
        const curr = vertices[i];
        const prev = cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
        if (!prev || Math.abs(curr.x - prev.x) > 1e-4 || Math.abs(curr.y - prev.y) > 1e-4) {
            cleaned.push(curr);
        }
    }
    if (cleaned.length > 1) {
        const first = cleaned[0];
        const last = cleaned[cleaned.length - 1];
        if (Math.abs(first.x - last.x) <= 1e-4 && Math.abs(first.y - last.y) <= 1e-4) {
            cleaned.pop();
        }
    }
    if (cleaned.length < 3) return [];
    if (signedPolygonArea(cleaned) < 0) {
        cleaned.reverse();
    }
    return cleaned;
}

export interface PathResult {
    waypoints: Point2D[];
    totalDistance: number;
    found: boolean;
}

export type GraphBuildProgress = (progress: number, status: string) => void;

interface GraphNode {
    point: Point2D;
    neighbors: number[];
    distances: number[];
}

interface GraphCacheEntry {
    timestamp: number;
    padding: number;
    nodes: GraphNode[];
    inflatedPolygons: Point2D[][];
}

export class PathFinder {
    private nodes: GraphNode[] = [];
    private buildings: Building[] = [];
    private padding: number = DEFAULT_PADDING;
    private graphBuilt: boolean = false;
    private needsRebuild: boolean = false;
    private isBuilding: boolean = false;
    private buildPromise: Promise<void> | null = null;

    private inflatedPolygons: Point2D[][] = [];
    private inflatedBounds: BoundingBox[] = [];

    // 2D spatial grids for O(1) polygon & node queries
    private buildingGrid: Map<number, number[]> = new Map();
    private inflatedGrid: Map<number, number[]> = new Map();
    private nodeGrid: Map<number, number[]> = new Map();
    private buildingStamps: Uint32Array = new Uint32Array(0);
    private inflatedStamps: Uint32Array = new Uint32Array(0);
    private stampCounter: number = 0;

    onProgress?: GraphBuildProgress;

    buildVisibilityGraph(buildings: Building[], padding: number = DEFAULT_PADDING): boolean {
        if (buildings.length === 0) {
            this.buildings = buildings;
            this.padding = padding;
            this.nodes = [];
            this.inflatedPolygons = [];
            this.inflatedBounds = [];
            this.clearSpatialIndices();
            this.graphBuilt = true;
            this.needsRebuild = false;
            return true;
        }

        if (this.tryLoadFromCache(buildings, padding)) {
            return true;
        }

        this.buildings = buildings;
        this.padding = padding;
        this.nodes = [];
        this.inflatedPolygons = [];
        this.inflatedBounds = [];
        this.clearSpatialIndices();
        this.graphBuilt = false;
        this.needsRebuild = true;
        return false;
    }

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

    private clearSpatialIndices(): void {
        this.buildingGrid.clear();
        this.inflatedGrid.clear();
        this.nodeGrid.clear();
        this.buildingStamps = new Uint32Array(0);
        this.inflatedStamps = new Uint32Array(0);
        this.stampCounter = 0;
    }

    private rebuildPolygonIndices(): void {
        this.buildingGrid.clear();
        this.inflatedGrid.clear();
        this.inflatedBounds = this.inflatedPolygons.map(p => calculateBounds(p));
        this.buildingStamps = new Uint32Array(this.buildings.length);
        this.inflatedStamps = new Uint32Array(this.inflatedPolygons.length);
        this.stampCounter = 0;

        for (let i = 0; i < this.buildings.length; i++) {
            const bb = this.buildings[i].bounds;
            const minGX = Math.floor(bb.minX / POLY_CELL_SIZE);
            const maxGX = Math.floor(bb.maxX / POLY_CELL_SIZE);
            const minGY = Math.floor(bb.minY / POLY_CELL_SIZE);
            const maxGY = Math.floor(bb.maxY / POLY_CELL_SIZE);
            for (let gx = minGX; gx <= maxGX; gx++) {
                for (let gy = minGY; gy <= maxGY; gy++) {
                    const key = packCell(gx, gy);
                    let list = this.buildingGrid.get(key);
                    if (!list) {
                        list = [];
                        this.buildingGrid.set(key, list);
                    }
                    list.push(i);
                }
            }
        }

        for (let i = 0; i < this.inflatedBounds.length; i++) {
            const bb = this.inflatedBounds[i];
            const minGX = Math.floor(bb.minX / POLY_CELL_SIZE);
            const maxGX = Math.floor(bb.maxX / POLY_CELL_SIZE);
            const minGY = Math.floor(bb.minY / POLY_CELL_SIZE);
            const maxGY = Math.floor(bb.maxY / POLY_CELL_SIZE);
            for (let gx = minGX; gx <= maxGX; gx++) {
                for (let gy = minGY; gy <= maxGY; gy++) {
                    const key = packCell(gx, gy);
                    let list = this.inflatedGrid.get(key);
                    if (!list) {
                        list = [];
                        this.inflatedGrid.set(key, list);
                    }
                    list.push(i);
                }
            }
        }
    }

    private rebuildNodeIndex(): void {
        this.nodeGrid.clear();
        for (let i = 0; i < this.nodes.length; i++) {
            const p = this.nodes[i].point;
            const key = packCell(Math.floor(p.x / NODE_CELL_SIZE), Math.floor(p.y / NODE_CELL_SIZE));
            let list = this.nodeGrid.get(key);
            if (!list) {
                list = [];
                this.nodeGrid.set(key, list);
            }
            list.push(i);
        }
    }

    private nextStamp(): number {
        this.stampCounter++;
        if (this.stampCounter >= 0xfffffffe) {
            this.buildingStamps.fill(0);
            this.inflatedStamps.fill(0);
            this.stampCounter = 1;
        }
        return this.stampCounter;
    }

    private getNearbyBuildings(a: Point2D, b: Point2D): Building[] {
        const minX = a.x < b.x ? a.x : b.x;
        const maxX = a.x > b.x ? a.x : b.x;
        const minY = a.y < b.y ? a.y : b.y;
        const maxY = a.y > b.y ? a.y : b.y;

        const minGX = Math.floor(minX / POLY_CELL_SIZE);
        const maxGX = Math.floor(maxX / POLY_CELL_SIZE);
        const minGY = Math.floor(minY / POLY_CELL_SIZE);
        const maxGY = Math.floor(maxY / POLY_CELL_SIZE);

        const stamp = this.nextStamp();
        const stamps = this.buildingStamps;
        const out: Building[] = [];

        for (let gx = minGX; gx <= maxGX; gx++) {
            for (let gy = minGY; gy <= maxGY; gy++) {
                const cell = this.buildingGrid.get(packCell(gx, gy));
                if (!cell) continue;
                for (let i = 0; i < cell.length; i++) {
                    const idx = cell[i];
                    if (stamps[idx] === stamp) continue;
                    stamps[idx] = stamp;
                    const building = this.buildings[idx];
                    const bb = building.bounds;
                    if (bb.maxX >= minX && bb.minX <= maxX && bb.maxY >= minY && bb.minY <= maxY) {
                        out.push(building);
                    }
                }
            }
        }
        return out;
    }

    private getNearbyInflated(a: Point2D, b: Point2D): Point2D[][] {
        const minX = a.x < b.x ? a.x : b.x;
        const maxX = a.x > b.x ? a.x : b.x;
        const minY = a.y < b.y ? a.y : b.y;
        const maxY = a.y > b.y ? a.y : b.y;

        const minGX = Math.floor(minX / POLY_CELL_SIZE);
        const maxGX = Math.floor(maxX / POLY_CELL_SIZE);
        const minGY = Math.floor(minY / POLY_CELL_SIZE);
        const maxGY = Math.floor(maxY / POLY_CELL_SIZE);

        const stamp = this.nextStamp();
        const stamps = this.inflatedStamps;
        const out: Point2D[][] = [];

        for (let gx = minGX; gx <= maxGX; gx++) {
            for (let gy = minGY; gy <= maxGY; gy++) {
                const cell = this.inflatedGrid.get(packCell(gx, gy));
                if (!cell) continue;
                for (let i = 0; i < cell.length; i++) {
                    const idx = cell[i];
                    if (stamps[idx] === stamp) continue;
                    stamps[idx] = stamp;
                    const bb = this.inflatedBounds[idx];
                    if (bb.maxX >= minX && bb.minX <= maxX && bb.maxY >= minY && bb.minY <= maxY) {
                        out.push(this.inflatedPolygons[idx]);
                    }
                }
            }
        }
        return out;
    }

    private getNearbyNodeIndices(p: Point2D, radius: number): number[] {
        const cellRange = Math.max(1, Math.ceil(radius / NODE_CELL_SIZE));
        const cx = Math.floor(p.x / NODE_CELL_SIZE);
        const cy = Math.floor(p.y / NODE_CELL_SIZE);
        const rSq = radius * radius;
        const results: Array<{ idx: number; distSq: number }> = [];

        for (let gx = cx - cellRange; gx <= cx + cellRange; gx++) {
            for (let gy = cy - cellRange; gy <= cy + cellRange; gy++) {
                const cell = this.nodeGrid.get(packCell(gx, gy));
                if (!cell) continue;
                for (let i = 0; i < cell.length; i++) {
                    const idx = cell[i];
                    const np = this.nodes[idx].point;
                    const dx = np.x - p.x;
                    const dy = np.y - p.y;
                    const dSq = dx * dx + dy * dy;
                    if (dSq <= rSq) {
                        results.push({ idx, distSq: dSq });
                    }
                }
            }
        }

        results.sort((a, b) => a.distSq - b.distSq);
        return results.map(r => r.idx);
    }

    private prepareNodesAndPolygons(): void {
        this.nodes = [];
        this.inflatedPolygons = [];

        // Keep clearance polygon tighter than corner node offset so narrow 3-4 m alleys remain passable
        const clearancePadding = Math.min(this.padding * 0.45, 0.7);
        for (const building of this.buildings) {
            const inflated = this.getInflatedPolygon(building.vertices, clearancePadding);
            if (inflated.length >= 3) {
                this.inflatedPolygons.push(inflated);
            }
        }
        this.rebuildPolygonIndices();

        // Only place graph waypoints at convex outer corners (normalized CCW)
        const cornerPoints: Point2D[] = [];
        for (const building of this.buildings) {
            const corners = this.getConvexCornerNodes(building.vertices, this.padding);
            for (let i = 0; i < corners.length; i++) {
                const p = corners[i];
                if (this.isInsideAnyBuilding(p)) continue;

                const nearbyInf = this.getNearbyInflated(p, p);
                let blocked = false;
                for (let j = 0; j < nearbyInf.length; j++) {
                    if (isPointStrictlyInside(p, nearbyInf[j])) {
                        blocked = true;
                        break;
                    }
                }
                if (!blocked) {
                    cornerPoints.push(p);
                }
            }
        }

        for (let i = 0; i < cornerPoints.length; i++) {
            this.nodes.push({
                point: cornerPoints[i],
                neighbors: [],
                distances: [],
            });
        }
        this.rebuildNodeIndex();
    }

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

        this.prepareNodesAndPolygons();

        this.onProgress?.(0.1, `Building visibility graph (${this.nodes.length} nodes)...`);
        await this.yieldToUI();

        let checks = 0;
        const maxDistSq = MAX_VISIBILITY_DISTANCE * MAX_VISIBILITY_DISTANCE;

        for (let i = 0; i < this.nodes.length; i++) {
            const a = this.nodes[i].point;
            const nearby = this.getNearbyNodeIndices(a, MAX_VISIBILITY_DISTANCE);
            for (let ni = 0; ni < nearby.length; ni++) {
                const j = nearby[ni];
                if (j <= i) continue;
                const b = this.nodes[j].point;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const distSq = dx * dx + dy * dy;
                if (distSq <= maxDistSq && this.canSee(a, b)) {
                    const dist = Math.sqrt(distSq);
                    this.nodes[i].neighbors.push(j);
                    this.nodes[i].distances.push(dist);
                    this.nodes[j].neighbors.push(i);
                    this.nodes[j].distances.push(dist);
                }

                checks++;
                if (checks % CHUNK_SIZE === 0) {
                    const progress = 0.1 + (i / Math.max(1, this.nodes.length)) * 0.9;
                    this.onProgress?.(
                        progress,
                        `Building visibility graph (${Math.round(progress * 100)}%)...`
                    );
                    await this.yieldToUI();
                }
            }
        }

        this.graphBuilt = true;
        this.needsRebuild = false;
        this.saveToCache();
        this.onProgress?.(1, 'Ready');
    }

    private yieldToUI(): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    private ensureGraphBuilt(): void {
        if (this.graphBuilt && !this.needsRebuild) return;

        if (this.buildings.length === 0) {
            this.nodes = [];
            this.inflatedPolygons = [];
            this.graphBuilt = true;
            this.needsRebuild = false;
            return;
        }

        this.prepareNodesAndPolygons();

        const maxDistSq = MAX_VISIBILITY_DISTANCE * MAX_VISIBILITY_DISTANCE;
        for (let i = 0; i < this.nodes.length; i++) {
            const a = this.nodes[i].point;
            const nearby = this.getNearbyNodeIndices(a, MAX_VISIBILITY_DISTANCE);
            for (let ni = 0; ni < nearby.length; ni++) {
                const j = nearby[ni];
                if (j <= i) continue;
                const b = this.nodes[j].point;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const distSq = dx * dx + dy * dy;
                if (distSq <= maxDistSq && this.canSee(a, b)) {
                    const dist = Math.sqrt(distSq);
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

    isBuildingGraph(): boolean {
        return this.isBuilding;
    }

    private getContainingBuilding(p: Point2D): Building | null {
        const cell = this.buildingGrid.get(
            packCell(Math.floor(p.x / POLY_CELL_SIZE), Math.floor(p.y / POLY_CELL_SIZE))
        );
        if (!cell) return null;

        for (let i = 0; i < cell.length; i++) {
            const building = this.buildings[cell[i]];
            const bb = building.bounds;
            if (p.x < bb.minX || p.x > bb.maxX || p.y < bb.minY || p.y > bb.maxY) continue;
            if (this.pointInPolygon(p, building.vertices)) {
                return building;
            }
        }
        return null;
    }

    private isInsideAnyBuilding(p: Point2D): boolean {
        return this.getContainingBuilding(p) !== null;
    }

    findPath(start: Point2D, goal: Point2D): PathResult {
        this.ensureGraphBuilt();

        const dist = this.distance(start, goal);
        if (this.buildings.length === 0) {
            return { waypoints: [start, goal], totalDistance: dist, found: true };
        }

        const startBuilding = this.getContainingBuilding(start);
        const goalBuilding = this.getContainingBuilding(goal);
        if (startBuilding !== goalBuilding) {
            return { waypoints: [], totalDistance: 0, found: false };
        }

        // Indoor movement within the same building: allow only if the segment stays inside the building
        if (startBuilding !== null) {
            const mid = { x: (start.x + goal.x) * 0.5, y: (start.y + goal.y) * 0.5 };
            const staysInside =
                this.pointInPolygon(mid, startBuilding.vertices) &&
                !this.segmentCrossesPolygon(start, goal, startBuilding.vertices);
            return staysInside
                ? { waypoints: [start, goal], totalDistance: dist, found: true }
                : { waypoints: [], totalDistance: 0, found: false };
        }

        // Outdoor direct sightline check against real building polygons
        if (this.canEndpointSee(start, goal)) {
            return { waypoints: [start, goal], totalDistance: dist, found: true };
        }

        if (this.nodes.length === 0) {
            return { waypoints: [], totalDistance: 0, found: false };
        }

        const startIdx = this.nodes.length;
        const goalIdx = this.nodes.length + 1;

        const startNode: GraphNode = { point: start, neighbors: [], distances: [] };
        const goalNode: GraphNode = { point: goal, neighbors: [], distances: [] };
        const addedEdges: number[] = [];

        // Connect start & goal via real-building line-of-sight so agents standing near walls
        // (even 1 cm from a wall after wall-sliding) always connect cleanly to visible corners.
        this.connectEndpoint(start, startNode, MAX_VISIBILITY_DISTANCE);
        if (startNode.neighbors.length === 0) {
            this.connectEndpoint(start, startNode, FALLBACK_ENDPOINT_RADIUS);
        }

        let goalConnections = this.connectGoalEndpoint(
            goal,
            goalIdx,
            addedEdges,
            MAX_VISIBILITY_DISTANCE
        );
        if (goalConnections === 0) {
            goalConnections = this.connectGoalEndpoint(
                goal,
                goalIdx,
                addedEdges,
                FALLBACK_ENDPOINT_RADIUS
            );
        }

        if (startNode.neighbors.length === 0 || goalConnections === 0) {
            for (let i = 0; i < addedEdges.length; i++) {
                const node = this.nodes[addedEdges[i]];
                node.neighbors.pop();
                node.distances.pop();
            }
            return { waypoints: [], totalDistance: 0, found: false };
        }

        this.nodes.push(startNode);
        this.nodes.push(goalNode);

        const path = this.astar(startIdx, goalIdx);

        this.nodes.pop();
        this.nodes.pop();
        for (let i = 0; i < addedEdges.length; i++) {
            const node = this.nodes[addedEdges[i]];
            node.neighbors.pop();
            node.distances.pop();
        }

        if (!path) {
            return { waypoints: [], totalDistance: 0, found: false };
        }

        const rawWaypoints: Point2D[] = new Array(path.length);
        for (let i = 0; i < path.length; i++) {
            const idx = path[i];
            rawWaypoints[i] =
                idx === startIdx ? start : idx === goalIdx ? goal : this.nodes[idx].point;
        }

        const waypoints = this.smoothPath(rawWaypoints);
        let totalDistance = 0;
        for (let i = 1; i < waypoints.length; i++) {
            totalDistance += this.distance(waypoints[i - 1], waypoints[i]);
        }

        return { waypoints, totalDistance, found: true };
    }

    private connectEndpoint(point: Point2D, targetNode: GraphNode, radius: number): void {
        const candidates = this.getNearbyNodeIndices(point, radius);
        for (
            let i = 0;
            i < candidates.length && targetNode.neighbors.length < MAX_ENDPOINT_CONNECTORS;
            i++
        ) {
            const idx = candidates[i];
            const np = this.nodes[idx].point;
            if (this.canEndpointSee(point, np)) {
                targetNode.neighbors.push(idx);
                targetNode.distances.push(this.distance(point, np));
            }
        }
    }

    private connectGoalEndpoint(
        goal: Point2D,
        goalIdx: number,
        addedEdges: number[],
        radius: number
    ): number {
        const candidates = this.getNearbyNodeIndices(goal, radius);
        let count = 0;
        for (let i = 0; i < candidates.length && count < MAX_ENDPOINT_CONNECTORS; i++) {
            const idx = candidates[i];
            const node = this.nodes[idx];
            if (this.canEndpointSee(goal, node.point)) {
                node.neighbors.push(goalIdx);
                node.distances.push(this.distance(goal, node.point));
                addedEdges.push(idx);
                count++;
            }
        }
        return count;
    }

    /** Greedy string-pulling to remove redundant corner waypoints without clipping buildings. */
    private smoothPath(raw: Point2D[]): Point2D[] {
        if (raw.length <= 2) return raw;
        const smoothed: Point2D[] = [raw[0]];
        let anchor = 0;
        while (anchor < raw.length - 1) {
            let furthest = anchor + 1;
            for (let j = raw.length - 1; j > anchor + 1; j--) {
                const isEndpoint = anchor === 0 || j === raw.length - 1;
                const clear = isEndpoint
                    ? this.canEndpointSee(raw[anchor], raw[j])
                    : this.canSee(raw[anchor], raw[j]);
                if (clear) {
                    furthest = j;
                    break;
                }
            }
            smoothed.push(raw[furthest]);
            anchor = furthest;
        }
        return smoothed;
    }

    /**
     * Binary-heap typed-array A* (O(E log V), zero Map/Set GC overhead).
     */
    private astar(startIdx: number, goalIdx: number): number[] | null {
        const n = this.nodes.length;
        const goal = this.nodes[goalIdx].point;

        const gScore = new Float64Array(n);
        gScore.fill(Infinity);
        const cameFrom = new Int32Array(n);
        cameFrom.fill(-1);
        const closed = new Uint8Array(n);

        const heapNodes: number[] = [startIdx];
        const heapF: number[] = [this.distance(this.nodes[startIdx].point, goal)];
        gScore[startIdx] = 0;

        const pushHeap = (node: number, f: number): void => {
            let idx = heapNodes.length;
            heapNodes.push(node);
            heapF.push(f);
            while (idx > 0) {
                const parent = (idx - 1) >> 1;
                if (heapF[parent] <= heapF[idx]) break;
                const tn = heapNodes[parent];
                const tf = heapF[parent];
                heapNodes[parent] = heapNodes[idx];
                heapF[parent] = heapF[idx];
                heapNodes[idx] = tn;
                heapF[idx] = tf;
                idx = parent;
            }
        };

        const popHeap = (): number => {
            const top = heapNodes[0];
            const lastNode = heapNodes.pop()!;
            const lastF = heapF.pop()!;
            if (heapNodes.length > 0) {
                heapNodes[0] = lastNode;
                heapF[0] = lastF;
                let idx = 0;
                const len = heapNodes.length;
                while (true) {
                    const l = idx * 2 + 1;
                    const r = l + 1;
                    let smallest = idx;
                    if (l < len && heapF[l] < heapF[smallest]) smallest = l;
                    if (r < len && heapF[r] < heapF[smallest]) smallest = r;
                    if (smallest === idx) break;
                    const tn = heapNodes[idx];
                    const tf = heapF[idx];
                    heapNodes[idx] = heapNodes[smallest];
                    heapF[idx] = heapF[smallest];
                    heapNodes[smallest] = tn;
                    heapF[smallest] = tf;
                    idx = smallest;
                }
            }
            return top;
        };

        while (heapNodes.length > 0) {
            const current = popHeap();
            if (closed[current]) continue;
            if (current === goalIdx) {
                const rev: number[] = [];
                let cur = current;
                while (cur !== -1) {
                    rev.push(cur);
                    cur = cameFrom[cur];
                }
                rev.reverse();
                return rev;
            }
            closed[current] = 1;

            const currentNode = this.nodes[current];
            const curG = gScore[current];
            const neighbors = currentNode.neighbors;
            const distances = currentNode.distances;

            for (let i = 0; i < neighbors.length; i++) {
                const neighbor = neighbors[i];
                if (closed[neighbor]) continue;
                const tentativeG = curG + distances[i];
                if (tentativeG < gScore[neighbor]) {
                    cameFrom[neighbor] = current;
                    gScore[neighbor] = tentativeG;
                    const np = this.nodes[neighbor].point;
                    const dx = goal.x - np.x;
                    const dy = goal.y - np.y;
                    pushHeap(neighbor, tentativeG + Math.sqrt(dx * dx + dy * dy));
                }
            }
        }

        return null;
    }

    /**
     * Inflate a building polygon outward by `padding` meters, invariant to CW vs CCW winding.
     */
    private getInflatedPolygon(vertices: Point2D[], padding: number): Point2D[] {
        const ccw = normalizeCCW(vertices);
        const n = ccw.length;
        if (n < 3) return [];

        const inflated: Point2D[] = [];
        for (let i = 0; i < n; i++) {
            const prev = ccw[(i - 1 + n) % n];
            const curr = ccw[i];
            const next = ccw[(i + 1) % n];

            let e1x = curr.x - prev.x;
            let e1y = curr.y - prev.y;
            let e2x = next.x - curr.x;
            let e2y = next.y - curr.y;
            const len1 = Math.sqrt(e1x * e1x + e1y * e1y);
            const len2 = Math.sqrt(e2x * e2x + e2y * e2y);

            if (len1 < 0.001 || len2 < 0.001) {
                inflated.push(curr);
                continue;
            }

            e1x /= len1;
            e1y /= len1;
            e2x /= len2;
            e2y /= len2;

            // Outward right-hand normals for CCW polygon
            const n1x = e1y;
            const n1y = -e1x;
            const n2x = e2y;
            const n2y = -e2x;

            let bx = n1x + n2x;
            let by = n1y + n2y;
            const bLen = Math.sqrt(bx * bx + by * by);
            if (bLen < 0.001) {
                bx = n1x;
                by = n1y;
            } else {
                bx /= bLen;
                by /= bLen;
            }

            const dot = n1x * bx + n1y * by;
            const offsetDist = dot > 0.25 ? padding / dot : padding * 2;
            const clampedOffset = Math.min(offsetDist, padding * 2.5);

            inflated.push({
                x: curr.x + bx * clampedOffset,
                y: curr.y + by * clampedOffset,
            });
        }
        return inflated;
    }

    /**
     * Extract outward-padded visibility graph nodes ONLY at convex outer corners
     * of a building polygon (concave notches never lie on shortest obstacle-avoiding paths).
     */
    private getConvexCornerNodes(vertices: Point2D[], padding: number): Point2D[] {
        const ccw = normalizeCCW(vertices);
        const n = ccw.length;
        if (n < 3) return [];

        const corners: Point2D[] = [];
        for (let i = 0; i < n; i++) {
            const prev = ccw[(i - 1 + n) % n];
            const curr = ccw[i];
            const next = ccw[(i + 1) % n];

            let e1x = curr.x - prev.x;
            let e1y = curr.y - prev.y;
            let e2x = next.x - curr.x;
            let e2y = next.y - curr.y;
            const len1 = Math.sqrt(e1x * e1x + e1y * e1y);
            const len2 = Math.sqrt(e2x * e2x + e2y * e2y);
            if (len1 < 0.01 || len2 < 0.01) continue;

            e1x /= len1;
            e1y /= len1;
            e2x /= len2;
            e2y /= len2;

            // For a CCW polygon, left turn (cross > 0) = convex outer corner
            const cross = e1x * e2y - e1y * e2x;
            if (cross <= 0.05) continue;

            const n1x = e1y;
            const n1y = -e1x;
            const n2x = e2y;
            const n2y = -e2x;

            let bx = n1x + n2x;
            let by = n1y + n2y;
            const bLen = Math.sqrt(bx * bx + by * by);
            if (bLen < 0.001) continue;
            bx /= bLen;
            by /= bLen;

            const dot = n1x * bx + n1y * by;
            const offsetDist = dot > 0.25 ? padding / dot : padding * 2;
            const clampedOffset = Math.min(offsetDist, padding * 2.5);

            corners.push({
                x: curr.x + bx * clampedOffset,
                y: curr.y + by * clampedOffset,
            });
        }
        return corners;
    }

    /** Check line-of-sight against real building footprints only (used for start/goal endpoints). */
    private canEndpointSee(a: Point2D, b: Point2D): boolean {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.05) return true;

        const shrink = Math.min(0.01, len * 0.1);
        const aShrunk = { x: a.x + (dx / len) * shrink, y: a.y + (dy / len) * shrink };
        const bShrunk = { x: b.x - (dx / len) * shrink, y: b.y - (dy / len) * shrink };

        const nearbyBuildings = this.getNearbyBuildings(aShrunk, bShrunk);
        if (nearbyBuildings.length > 0 && !hasLineOfSight(aShrunk, bShrunk, nearbyBuildings)) {
            return false;
        }
        return true;
    }

    /** Check line-of-sight between graph nodes with wall-clearance margin. */
    private canSee(a: Point2D, b: Point2D): boolean {
        if (!this.canEndpointSee(a, b)) return false;

        const nearbyInflated = this.getNearbyInflated(a, b);
        if (nearbyInflated.length > 0 && !hasClearance(a, b, nearbyInflated)) {
            return false;
        }
        return true;
    }

    private segmentCrossesPolygon(a: Point2D, b: Point2D, poly: Point2D[]): boolean {
        const ax = a.x;
        const ay = a.y;
        const dx1 = b.x - ax;
        const dy1 = b.y - ay;
        const n = poly.length;
        for (let i = 0; i < n; i++) {
            const v1 = poly[i];
            const v2 = poly[(i + 1) % n];
            const dx2 = v2.x - v1.x;
            const dy2 = v2.y - v1.y;
            const denom = dx1 * dy2 - dy1 * dx2;
            if (Math.abs(denom) < 1e-10) continue;
            const dx3 = ax - v1.x;
            const dy3 = ay - v1.y;
            const t = (dx3 * dy2 - dy3 * dx2) / -denom;
            if (t <= 1e-4 || t >= 1 - 1e-4) continue;
            const u = (dx1 * dy3 - dy1 * dx3) / denom;
            if (u >= 0 && u <= 1) return true;
        }
        return false;
    }

    private pointInPolygon(p: Point2D, polygon: Point2D[]): boolean {
        const n = polygon.length;
        if (n < 3) return false;
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const pi = polygon[i];
            const pj = polygon[j];
            if (
                pi.y > p.y !== pj.y > p.y &&
                p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x
            ) {
                inside = !inside;
            }
        }
        return inside;
    }

    private distance(a: Point2D, b: Point2D): number {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    getNodeCount(): number {
        return this.nodes.length;
    }

    isReady(): boolean {
        return this.graphBuilt && !this.needsRebuild;
    }

    private generateCacheKey(buildings: Building[]): string {
        if (buildings.length === 0) return '';
        let hash = buildings.length.toString();
        for (let i = 0; i < Math.min(5, buildings.length); i++) {
            const b = buildings[i];
            if (b.vertices.length > 0) {
                hash += `_${b.vertices[0].x.toFixed(1)}_${b.vertices[0].y.toFixed(1)}`;
            }
        }
        const totalVertices = buildings.reduce((sum, b) => sum + b.vertices.length, 0);
        hash += `_v${totalVertices}`;
        return GRAPH_CACHE_PREFIX + hash;
    }

    tryLoadFromCache(buildings: Building[], padding: number): boolean {
        if (typeof localStorage === 'undefined') return false;
        if (buildings.length === 0) return false;

        const cacheKey = this.generateCacheKey(buildings);
        if (!cacheKey) return false;

        try {
            const cached = localStorage.getItem(cacheKey);
            if (!cached) return false;

            const entry: GraphCacheEntry = JSON.parse(cached);
            if (entry.padding !== padding) return false;

            this.buildings = buildings;
            this.padding = padding;
            this.nodes = entry.nodes;
            this.inflatedPolygons = entry.inflatedPolygons;
            this.rebuildPolygonIndices();
            this.rebuildNodeIndex();
            this.graphBuilt = true;
            this.needsRebuild = false;
            return true;
        } catch {
            return false;
        }
    }

    private saveToCache(): void {
        if (typeof localStorage === 'undefined') return;
        if (this.buildings.length === 0) return;
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
        } catch {
            // Quota exceeded or unavailable; ignore gracefully
        }
    }

    static clearCache(): void {
        if (typeof localStorage === 'undefined') return;
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith(GRAPH_CACHE_PREFIX) || key.startsWith('bitchat_visgraph_'))) {
                keysToRemove.push(key);
            }
        }
        for (const key of keysToRemove) {
            localStorage.removeItem(key);
        }
    }
}
