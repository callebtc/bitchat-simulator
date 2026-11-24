/**
 * EnvironmentManager
 * Stores and queries building polygons for the simulation environment.
 * Uses a 2D uniform spatial grid (25 m cells) with stamp-based deduplication
 * for O(1) point-in-building and line-of-sight candidate queries at 1000+ users.
 */

import {
    Building,
    EnvironmentData,
    EnvironmentBounds,
    Point2D,
    BoundingBox,
    Material,
    GeoJSONFeatureCollection,
    latLonToLocal,
    calculateBounds,
} from './types';

import { getFirstIntersection, projectOntoSurface } from './LineOfSight';

/** Result of movement resolution with collision detection */
export interface MovementResult {
    /** Final position after collision resolution */
    position: Point2D;
    /** Whether movement was blocked by a building */
    blocked: boolean;
    /** Remaining velocity after sliding (if applicable) */
    velocity?: Point2D;
}

const BUILDING_CELL_SIZE = 25;
const GRID_OFFSET = 32768;
const GRID_STRIDE = 65536;

function packCell(gx: number, gy: number): number {
    return (gx + GRID_OFFSET) * GRID_STRIDE + (gy + GRID_OFFSET);
}

export class EnvironmentManager {
    private buildings: Building[] = [];
    private buildingById: Map<string, Building> = new Map();
    private bounds: EnvironmentBounds | null = null;

    // 2D spatial grid indexing building indices for O(1) spatial queries
    private grid: Map<number, number[]> = new Map();
    private queryStamps: Uint32Array = new Uint32Array(0);
    private currentStamp: number = 0;

    /**
     * Load environment from GeoJSON feature collection.
     * Converts lat/lon coordinates to local meters.
     */
    loadFromGeoJSON(
        geojson: GeoJSONFeatureCollection,
        centerLat?: number,
        centerLon?: number
    ): void {
        let minLat = Infinity, maxLat = -Infinity;
        let minLng = Infinity, maxLng = -Infinity;

        for (const feature of geojson.features) {
            if (feature.geometry.type !== 'Polygon') continue;

            const coords = feature.geometry.coordinates[0];
            for (const [lng, lat] of coords) {
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
            }
        }

        const refLat = centerLat ?? (minLat + maxLat) / 2;
        const refLon = centerLon ?? (minLng + maxLng) / 2;

        this.buildings = [];
        let buildingId = 0;

        for (const feature of geojson.features) {
            if (feature.geometry.type !== 'Polygon') continue;

            const coords = feature.geometry.coordinates[0];
            const vertices: Point2D[] = [];

            for (const [lng, lat] of coords) {
                const local = latLonToLocal(lat, lng, refLat, refLon);
                vertices.push(local);
            }

            if (vertices.length > 1) {
                const first = vertices[0];
                const last = vertices[vertices.length - 1];
                if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) {
                    vertices.pop();
                }
            }

            if (vertices.length < 3) continue;

            const building: Building = {
                id: `building-${buildingId++}`,
                material: Material.BUILDING,
                vertices,
                bounds: calculateBounds(vertices),
                properties: feature.properties,
            };

            this.buildings.push(building);
        }

        this.rebuildSpatialIndex();

        const localBounds = this.calculateTotalBounds();

        this.bounds = {
            center: { lat: refLat, lng: refLon },
            minLat,
            maxLat,
            minLng,
            maxLng,
            localBounds,
        };
    }

    /**
     * Load environment from pre-processed EnvironmentData.
     */
    loadFromData(data: EnvironmentData): void {
        this.buildings = data.buildings;
        this.bounds = data.bounds;
        this.rebuildSpatialIndex();
    }

    /**
     * Clear all environment data.
     */
    clear(): void {
        this.buildings = [];
        this.buildingById.clear();
        this.grid.clear();
        this.queryStamps = new Uint32Array(0);
        this.currentStamp = 0;
        this.bounds = null;
    }

    private rebuildSpatialIndex(): void {
        this.buildingById.clear();
        this.grid.clear();
        this.queryStamps = new Uint32Array(this.buildings.length);
        this.currentStamp = 0;

        for (let idx = 0; idx < this.buildings.length; idx++) {
            const b = this.buildings[idx];
            this.buildingById.set(b.id, b);

            const bb = b.bounds;
            const minGX = Math.floor(bb.minX / BUILDING_CELL_SIZE);
            const maxGX = Math.floor(bb.maxX / BUILDING_CELL_SIZE);
            const minGY = Math.floor(bb.minY / BUILDING_CELL_SIZE);
            const maxGY = Math.floor(bb.maxY / BUILDING_CELL_SIZE);

            for (let gx = minGX; gx <= maxGX; gx++) {
                for (let gy = minGY; gy <= maxGY; gy++) {
                    const key = packCell(gx, gy);
                    let list = this.grid.get(key);
                    if (!list) {
                        list = [];
                        this.grid.set(key, list);
                    }
                    list.push(idx);
                }
            }
        }
    }

    private nextStamp(): number {
        this.currentStamp++;
        if (this.currentStamp >= 0xfffffffe) {
            this.queryStamps.fill(0);
            this.currentStamp = 1;
        }
        return this.currentStamp;
    }

    getBuildings(): Building[] {
        return this.buildings;
    }

    getBuildingById(id: string): Building | undefined {
        return this.buildingById.get(id);
    }

    getBounds(): EnvironmentBounds | null {
        return this.bounds;
    }

    /**
     * Get buildings whose bounding boxes overlap the segment A -> B.
     * Uses O(cells) 2D grid traversal with zero Set allocations.
     */
    getBuildingsInPath(a: Point2D, b: Point2D): Building[] {
        if (this.buildings.length === 0) return [];

        const lineMinX = a.x < b.x ? a.x : b.x;
        const lineMaxX = a.x > b.x ? a.x : b.x;
        const lineMinY = a.y < b.y ? a.y : b.y;
        const lineMaxY = a.y > b.y ? a.y : b.y;

        const minGX = Math.floor(lineMinX / BUILDING_CELL_SIZE);
        const maxGX = Math.floor(lineMaxX / BUILDING_CELL_SIZE);
        const minGY = Math.floor(lineMinY / BUILDING_CELL_SIZE);
        const maxGY = Math.floor(lineMaxY / BUILDING_CELL_SIZE);

        const stamp = this.nextStamp();
        const stamps = this.queryStamps;
        const buildings = this.buildings;
        const result: Building[] = [];

        for (let gx = minGX; gx <= maxGX; gx++) {
            for (let gy = minGY; gy <= maxGY; gy++) {
                const cell = this.grid.get(packCell(gx, gy));
                if (!cell) continue;

                for (let i = 0; i < cell.length; i++) {
                    const idx = cell[i];
                    if (stamps[idx] === stamp) continue;
                    stamps[idx] = stamp;

                    const building = buildings[idx];
                    const bb = building.bounds;
                    if (
                        bb.maxX >= lineMinX &&
                        bb.minX <= lineMaxX &&
                        bb.maxY >= lineMinY &&
                        bb.minY <= lineMaxY
                    ) {
                        result.push(building);
                    }
                }
            }
        }

        return result;
    }

    /**
     * Check if a point is inside any building (O(1) grid cell lookup).
     */
    isInsideBuilding(point: Point2D): Building | null {
        if (this.buildings.length === 0) return null;

        const gx = Math.floor(point.x / BUILDING_CELL_SIZE);
        const gy = Math.floor(point.y / BUILDING_CELL_SIZE);
        const cell = this.grid.get(packCell(gx, gy));
        if (!cell) return null;

        for (let i = 0; i < cell.length; i++) {
            const building = this.buildings[cell[i]];
            const bb = building.bounds;
            if (
                point.x < bb.minX ||
                point.x > bb.maxX ||
                point.y < bb.minY ||
                point.y > bb.maxY
            ) {
                continue;
            }
            if (this.pointInPolygon(point, building.vertices)) {
                return building;
            }
        }
        return null;
    }

    /**
     * Resolve movement from one point to another, handling building collisions.
     * If the path intersects a building, the movement slides along the wall.
     */
    resolveMovement(from: Point2D, to: Point2D, maxIterations: number = 3): MovementResult {
        if (this.buildings.length === 0) {
            return { position: to, blocked: false };
        }

        let curX = from.x;
        let curY = from.y;
        let tgtX = to.x;
        let tgtY = to.y;
        let blocked = false;
        const EPSILON = 0.01;

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            const currentPos: Point2D = { x: curX, y: curY };
            const targetPos: Point2D = { x: tgtX, y: tgtY };
            const candidates = this.getBuildingsInPath(currentPos, targetPos);

            if (candidates.length === 0) {
                return { position: targetPos, blocked };
            }

            const collision = getFirstIntersection(currentPos, targetPos, candidates);
            if (!collision) {
                return { position: targetPos, blocked };
            }

            blocked = true;

            const colX = collision.point.x + collision.normal.x * EPSILON;
            const colY = collision.point.y + collision.normal.y * EPSILON;
            const remainingVec: Point2D = {
                x: tgtX - collision.point.x,
                y: tgtY - collision.point.y,
            };

            const slideVec = projectOntoSurface(remainingVec, collision.normal);
            const slideDistSq = slideVec.x * slideVec.x + slideVec.y * slideVec.y;
            if (slideDistSq < EPSILON * EPSILON) {
                return {
                    position: { x: colX, y: colY },
                    blocked: true,
                    velocity: { x: 0, y: 0 },
                };
            }

            curX = colX;
            curY = colY;
            tgtX = colX + slideVec.x;
            tgtY = colY + slideVec.y;
        }

        return {
            position: { x: curX, y: curY },
            blocked: true,
            velocity: { x: 0, y: 0 },
        };
    }

    private pointInPolygon(point: Point2D, vertices: Point2D[]): boolean {
        let inside = false;
        const n = vertices.length;
        const px = point.x;
        const py = point.y;

        for (let i = 0, j = n - 1; i < n; j = i++) {
            const vi = vertices[i];
            const vj = vertices[j];

            if (
                vi.y > py !== vj.y > py &&
                px < ((vj.x - vi.x) * (py - vi.y)) / (vj.y - vi.y) + vi.x
            ) {
                inside = !inside;
            }
        }

        return inside;
    }

    private calculateTotalBounds(): BoundingBox {
        if (this.buildings.length === 0) {
            return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
        }

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const building of this.buildings) {
            if (building.bounds.minX < minX) minX = building.bounds.minX;
            if (building.bounds.minY < minY) minY = building.bounds.minY;
            if (building.bounds.maxX > maxX) maxX = building.bounds.maxX;
            if (building.bounds.maxY > maxY) maxY = building.bounds.maxY;
        }

        return { minX, minY, maxX, maxY };
    }

    getBuildingCount(): number {
        return this.buildings.length;
    }

    exportData(): EnvironmentData | null {
        if (!this.bounds) return null;
        return {
            bounds: this.bounds,
            buildings: this.buildings,
        };
    }
}
