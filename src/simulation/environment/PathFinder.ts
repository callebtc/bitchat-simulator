/**
 * PathFinder
 * High-performance visibility graph pathfinding around building obstacles.
 * Uses 2D spatial grids for buildings, inflated polygons, and graph nodes,
 * plus a binary-heap typed-array A* solver so thousands of BUSY agents can
 * continuously navigate dense cities like Times Square with negligible CPU.
 */

import { Building, BoundingBox, Point2D, calculateBounds } from './types';
import { hasLineOfSight, hasClearance, isPointStrictlyInside } from './LineOfSight';

const DEFAULT_PADDING = 3;
const MAX_VISIBILITY_DISTANCE = 150;
const CHUNK_SIZE = 2000;
const GRAPH_CACHE_PREFIX = 'bitchat_visgraph_';
const POLY_CELL_SIZE = 25;
const NODE_CELL_SIZE = 50;
const GRID_OFFSET = 32768;
const GRID_STRIDE = 65536;
const MAX_ENDPOINT_CONNECTORS = 20;

function packCell(gx: number, gy: number): number {
    return (gx + GRID_OFFSET) * GRID_STRIDE + (gy + GRID_OFFSET);
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

        for (const building of this.buildings) {
            const inflated = this.getInflatedPolygon(building.vertices, this.padding);
            if (inflated.length >= 3) {
                this.inflatedPolygons.push(inflated);
            }
        }
        this.rebuildPolygonIndices();

        let cornerPoints: Point2D[] = [];
        for (const building of this.buildings) {
            const padded = this.getPaddedVertices(building.vertices);
            cornerPoints.push(...padded);
        }

        cornerPoints = cornerPoints.filter(p => {
            const nearby = this.getNearbyInflated(p, p);
            for (let i = 0; i < nearby.length; i++) {
                if (isPointStrictlyInside(p, nearby[i])) {
                    return false;
                }
            }
            return true;
        });

        for (const point of cornerPoints) {
            this.nodes.push({
                point,
                neighbors: [],
                distances: [],
            });
        }
        this.rebuildNodeIndex();

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

        this.nodes = [];
        this.inflatedPolygons = [];

        if (this.buildings.length === 0) {
            this.graphBuilt = true;
            this.needsRebuild = false;
            return;
        }

        for (const building of this.buildings) {
            const inflated = this.getInflatedPolygon(building.vertices, this.padding);
            if (inflated.length >= 3) {
                this.inflatedPolygons.push(inflated);
            }
        }
        this.rebuildPolygonIndices();

        let cornerPoints: Point2D[] = [];
        for (const building of this.buildings) {
            cornerPoints.push(...this.getPaddedVertices(building.vertices));
        }

        cornerPoints = cornerPoints.filter(p => {
            const nearby = this.getNearbyInflated(p, p);
            for (let i = 0; i < nearby.length; i++) {
                if (isPointStrictlyInside(p, nearby[i])) return false;
            }
            return true;
        });

        for (const point of cornerPoints) {
            this.nodes.push({ point, neighbors: [], distances: [] });
        }
        this.rebuildNodeIndex();

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

    private isInsideAnyBuilding(p: Point2D): boolean {
        const cell = this.buildingGrid.get(
            packCell(Math.floor(p.x / POLY_CELL_SIZE), Math.floor(p.y / POLY_CELL_SIZE))
        );
        if (!cell) return false;

        for (let i = 0; i < cell.length; i++) {
            const building = this.buildings[cell[i]];
            const bb = building.bounds;
            if (p.x < bb.minX || p.x > bb.maxX || p.y < bb.minY || p.y > bb.maxY) continue;
            if (this.pointInPolygon(p, building.vertices)) {
                return true;
            }
        }
        return false;
    }

    findPath(start: Point2D, goal: Point2D): PathResult {
        this.ensureGraphBuilt();

        const dist = this.distance(start, goal);
        if (this.buildings.length === 0) {
            return { waypoints: [start, goal], totalDistance: dist, found: true };
        }

        const startInside = this.isInsideAnyBuilding(start);
        const goalInside = this.isInsideAnyBuilding(goal);
        if (startInside !== goalInside) {
            return { waypoints: [start, goal], totalDistance: dist, found: false };
        }

        if (this.canSee(start, goal)) {
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

        // Connect start to nearest visible graph nodes within visibility distance
        const startCandidates = this.getNearbyNodeIndices(start, MAX_VISIBILITY_DISTANCE);
        for (let i = 0; i < startCandidates.length && startNode.neighbors.length < MAX_ENDPOINT_CONNECTORS; i++) {
            const idx = startCandidates[i];
            const np = this.nodes[idx].point;
            if (this.canSee(start, np)) {
                startNode.neighbors.push(idx);
                startNode.distances.push(this.distance(start, np));
            }
        }

        // Connect goal to nearest visible graph nodes within visibility distance
        const goalCandidates = this.getNearbyNodeIndices(goal, MAX_VISIBILITY_DISTANCE);
        let goalConnections = 0;
        for (let i = 0; i < goalCandidates.length && goalConnections < MAX_ENDPOINT_CONNECTORS; i++) {
            const idx = goalCandidates[i];
            const node = this.nodes[idx];
            if (this.canSee(goal, node.point)) {
                node.neighbors.push(goalIdx);
                node.distances.push(this.distance(goal, node.point));
                addedEdges.push(idx);
                goalConnections++;
            }
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

        const waypoints: Point2D[] = new Array(path.length);
        let totalDistance = 0;
        for (let i = 0; i < path.length; i++) {
            const idx = path[i];
            const pt = idx === startIdx ? start : idx === goalIdx ? goal : this.nodes[idx].point;
            waypoints[i] = pt;
            if (i > 0) {
                totalDistance += this.distance(waypoints[i - 1], pt);
            }
        }

        return { waypoints, totalDistance, found: true };
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

        // Min-heap storing node indices & f-scores in parallel arrays
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

    private getInflatedPolygon(vertices: Point2D[], padding: number): Point2D[] {
        const n = vertices.length;
        if (n < 3) return [];

        const inflated: Point2D[] = [];
        for (let i = 0; i < n; i++) {
            const prev = vertices[(i - 1 + n) % n];
            const curr = vertices[i];
            const next = vertices[(i + 1) % n];

            const e1 = { x: curr.x - prev.x, y: curr.y - prev.y };
            const e2 = { x: next.x - curr.x, y: next.y - curr.y };
            const len1 = Math.sqrt(e1.x * e1.x + e1.y * e1.y);
            const len2 = Math.sqrt(e2.x * e2.x + e2.y * e2.y);

            if (len1 < 0.001 || len2 < 0.001) {
                inflated.push(curr);
                continue;
            }

            e1.x /= len1;
            e1.y /= len1;
            e2.x /= len2;
            e2.y /= len2;

            const n1 = { x: e1.y, y: -e1.x };
            const n2 = { x: e2.y, y: -e2.x };

            let bisector = { x: n1.x + n2.x, y: n1.y + n2.y };
            const bisectorLen = Math.sqrt(bisector.x * bisector.x + bisector.y * bisector.y);
            if (bisectorLen < 0.001) {
                bisector = n1;
            } else {
                bisector.x /= bisectorLen;
                bisector.y /= bisectorLen;
            }

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

    private getPaddedVertices(vertices: Point2D[]): Point2D[] {
        return this.getInflatedPolygon(vertices, this.padding);
    }

    private canSee(a: Point2D, b: Point2D): boolean {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.1) return true;

        const shrink = 0.01;
        const aShrunk = { x: a.x + (dx / len) * shrink, y: a.y + (dy / len) * shrink };
        const bShrunk = { x: b.x - (dx / len) * shrink, y: b.y - (dy / len) * shrink };

        const nearbyBuildings = this.getNearbyBuildings(aShrunk, bShrunk);
        if (nearbyBuildings.length > 0 && !hasLineOfSight(aShrunk, bShrunk, nearbyBuildings)) {
            return false;
        }

        const nearbyInflated = this.getNearbyInflated(a, b);
        if (nearbyInflated.length > 0 && !hasClearance(a, b, nearbyInflated)) {
            return false;
        }

        return true;
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
        } catch {
            // Ignore storage quota errors
        }
    }

    static clearCache(): void {
        if (typeof localStorage === 'undefined') return;
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
    }
}
