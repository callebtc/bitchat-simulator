/**
 * EnvironmentManager
 * Stores and queries building polygons for the simulation environment.
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

export class EnvironmentManager {
    private buildings: Building[] = [];
    private bounds: EnvironmentBounds | null = null;

    /**
     * Load environment from GeoJSON feature collection.
     * Converts lat/lon coordinates to local meters.
     */
    loadFromGeoJSON(
        geojson: GeoJSONFeatureCollection,
        centerLat?: number,
        centerLon?: number
    ): void {
        // Calculate center if not provided
        let minLat = Infinity, maxLat = -Infinity;
        let minLng = Infinity, maxLng = -Infinity;

        for (const feature of geojson.features) {
            if (feature.geometry.type !== 'Polygon') continue;
            
            const coords = feature.geometry.coordinates[0]; // Outer ring
            for (const [lng, lat] of coords) {
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
            }
        }

        const refLat = centerLat ?? (minLat + maxLat) / 2;
        const refLon = centerLon ?? (minLng + maxLng) / 2;

        // Convert all buildings
        this.buildings = [];
        let buildingId = 0;

        for (const feature of geojson.features) {
            if (feature.geometry.type !== 'Polygon') continue;

            const coords = feature.geometry.coordinates[0]; // Outer ring only for now
            const vertices: Point2D[] = [];

            for (const [lng, lat] of coords) {
                const local = latLonToLocal(lat, lng, refLat, refLon);
                vertices.push(local);
            }

            // Remove last vertex if it duplicates first (GeoJSON rings are closed)
            if (vertices.length > 1) {
                const first = vertices[0];
                const last = vertices[vertices.length - 1];
                if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.y - last.y) < 0.01) {
                    vertices.pop();
                }
            }

            if (vertices.length < 3) continue; // Invalid polygon

            const building: Building = {
                id: `building-${buildingId++}`,
                material: Material.BUILDING,
                vertices,
                bounds: calculateBounds(vertices),
                properties: feature.properties,
            };

            this.buildings.push(building);
        }

        // Calculate local bounds
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
    }

    /**
     * Clear all environment data.
     */
    clear(): void {
        this.buildings = [];
        this.bounds = null;
    }

    /**
     * Get all buildings.
     */
    getBuildings(): Building[] {
        return this.buildings;
    }

    /**
     * Get environment bounds.
     */
    getBounds(): EnvironmentBounds | null {
        return this.bounds;
    }

    /**
     * Get buildings that might intersect a line from A to B.
     * Uses bounding box pre-filtering for efficiency.
     */
    getBuildingsInPath(a: Point2D, b: Point2D): Building[] {
        // Calculate line bounding box
        const lineMinX = Math.min(a.x, b.x);
        const lineMaxX = Math.max(a.x, b.x);
        const lineMinY = Math.min(a.y, b.y);
        const lineMaxY = Math.max(a.y, b.y);

        // Filter buildings by bounding box overlap
        return this.buildings.filter(building => {
            const bb = building.bounds;
            return !(
                bb.maxX < lineMinX ||
                bb.minX > lineMaxX ||
                bb.maxY < lineMinY ||
                bb.minY > lineMaxY
            );
        });
    }

    /**
     * Check if a point is inside any building.
     */
    isInsideBuilding(point: Point2D): Building | null {
        for (const building of this.buildings) {
            // Quick bounding box check
            const bb = building.bounds;
            if (
                point.x < bb.minX || point.x > bb.maxX ||
                point.y < bb.minY || point.y > bb.maxY
            ) {
                continue;
            }

            // Point-in-polygon test
            if (this.pointInPolygon(point, building.vertices)) {
                return building;
            }
        }
        return null;
    }

    /**
     * Resolve movement from one point to another, handling building collisions.
     * If the path intersects a building, the movement slides along the wall.
     * 
     * @param from - Starting position
     * @param to - Desired ending position
     * @param maxIterations - Maximum slide iterations to prevent infinite loops
     * @returns The resolved position and whether movement was blocked
     */
    resolveMovement(from: Point2D, to: Point2D, maxIterations: number = 3): MovementResult {
        // No buildings = no collision
        if (this.buildings.length === 0) {
            return { position: to, blocked: false };
        }

        let currentPos = { ...from };
        let targetPos = { ...to };
        let blocked = false;
        
        // Small offset to prevent getting stuck on walls
        const EPSILON = 0.01;

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            // Get buildings that might be in the path
            const candidates = this.getBuildingsInPath(currentPos, targetPos);
            
            if (candidates.length === 0) {
                // No buildings in path, move freely
                return { position: targetPos, blocked };
            }

            // Find first intersection
            const collision = getFirstIntersection(currentPos, targetPos, candidates);

            if (!collision) {
                // No actual collision, move freely
                return { position: targetPos, blocked };
            }

            blocked = true;

            // Move to just before the collision point
            // Normal points outward from the building, so we add it to stay outside
            const collisionPoint: Point2D = {
                x: collision.point.x + collision.normal.x * EPSILON,
                y: collision.point.y + collision.normal.y * EPSILON,
            };

            // Calculate remaining movement vector
            const remainingVec: Point2D = {
                x: targetPos.x - collision.point.x,
                y: targetPos.y - collision.point.y,
            };

            // Project remaining movement onto the wall (slide)
            const slideVec = projectOntoSurface(remainingVec, collision.normal);

            // Calculate new target position after sliding
            const slideTarget: Point2D = {
                x: collisionPoint.x + slideVec.x,
                y: collisionPoint.y + slideVec.y,
            };

            // If slide movement is negligible, stop here
            const slideDist = Math.sqrt(slideVec.x * slideVec.x + slideVec.y * slideVec.y);
            if (slideDist < EPSILON) {
                return { 
                    position: collisionPoint, 
                    blocked: true,
                    velocity: { x: 0, y: 0 },
                };
            }

            // Update for next iteration (check if slide path also hits something)
            currentPos = collisionPoint;
            targetPos = slideTarget;
        }

        // Max iterations reached, return current position
        return { 
            position: currentPos, 
            blocked: true,
            velocity: { x: 0, y: 0 },
        };
    }

    /**
     * Ray casting point-in-polygon test.
     */
    private pointInPolygon(point: Point2D, vertices: Point2D[]): boolean {
        let inside = false;
        const n = vertices.length;

        for (let i = 0, j = n - 1; i < n; j = i++) {
            const vi = vertices[i];
            const vj = vertices[j];

            if (
                ((vi.y > point.y) !== (vj.y > point.y)) &&
                (point.x < (vj.x - vi.x) * (point.y - vi.y) / (vj.y - vi.y) + vi.x)
            ) {
                inside = !inside;
            }
        }

        return inside;
    }

    /**
     * Calculate total bounding box of all buildings.
     */
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

    /**
     * Get building count.
     */
    getBuildingCount(): number {
        return this.buildings.length;
    }

    /**
     * Export as serializable data.
     */
    exportData(): EnvironmentData | null {
        if (!this.bounds) return null;
        return {
            bounds: this.bounds,
            buildings: this.buildings,
        };
    }
}
