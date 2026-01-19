import { describe, it, expect, beforeEach } from 'vitest';
import { EnvironmentManager } from '../EnvironmentManager';
import {
    getFirstIntersection,
    getEdgeNormal,
    projectOntoSurface,
} from '../LineOfSight';
import { Material, Point2D, Building } from '../types';

// Helper to create a square building
function createSquareBuilding(
    id: string,
    centerX: number,
    centerY: number,
    size: number
): Building {
    const halfSize = size / 2;
    const vertices: Point2D[] = [
        { x: centerX - halfSize, y: centerY - halfSize },
        { x: centerX + halfSize, y: centerY - halfSize },
        { x: centerX + halfSize, y: centerY + halfSize },
        { x: centerX - halfSize, y: centerY + halfSize },
    ];
    return {
        id,
        material: Material.BUILDING,
        vertices,
        bounds: {
            minX: centerX - halfSize,
            minY: centerY - halfSize,
            maxX: centerX + halfSize,
            maxY: centerY + halfSize,
        },
    };
}

describe('Collision Detection', () => {
    describe('getFirstIntersection', () => {
        it('returns null when path misses all buildings', () => {
            const buildings: Building[] = [
                createSquareBuilding('b1', 50, 50, 10),
            ];

            const result = getFirstIntersection(
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                buildings
            );

            expect(result).toBeNull();
        });

        it('returns intersection when path hits a building', () => {
            const buildings: Building[] = [
                createSquareBuilding('b1', 10, 0, 4), // Building from x=8 to x=12
            ];

            const result = getFirstIntersection(
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                buildings
            );

            expect(result).not.toBeNull();
            expect(result!.point.x).toBeCloseTo(8, 1); // Entry point
            expect(result!.point.y).toBeCloseTo(0, 1);
            expect(result!.building.id).toBe('b1');
        });

        it('returns the closest intersection when multiple buildings are hit', () => {
            const buildings: Building[] = [
                createSquareBuilding('b1', 5, 0, 2),  // x=4 to x=6
                createSquareBuilding('b2', 15, 0, 2), // x=14 to x=16
            ];

            const result = getFirstIntersection(
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                buildings
            );

            expect(result).not.toBeNull();
            expect(result!.building.id).toBe('b1'); // First building hit
            expect(result!.point.x).toBeCloseTo(4, 1);
        });

        it('ignores intersections at the starting point (t ≈ 0)', () => {
            const buildings: Building[] = [
                createSquareBuilding('b1', 0, 0, 4), // Building from x=-2 to x=2
            ];

            // Start exactly at the edge of the building
            const result = getFirstIntersection(
                { x: -2, y: 0 },
                { x: -10, y: 0 },
                buildings
            );

            // Should not detect intersection since we're moving away
            expect(result).toBeNull();
        });
    });

    describe('getEdgeNormal', () => {
        it('returns normal pointing toward outside point', () => {
            const v1: Point2D = { x: 0, y: 0 };
            const v2: Point2D = { x: 10, y: 0 };
            const outsidePoint: Point2D = { x: 5, y: -5 }; // Below the edge

            const normal = getEdgeNormal(v1, v2, outsidePoint);

            // Normal should point down (negative y)
            expect(normal.y).toBeLessThan(0);
            // Should be unit length
            const len = Math.sqrt(normal.x * normal.x + normal.y * normal.y);
            expect(len).toBeCloseTo(1, 5);
        });

        it('returns opposite normal for opposite outside point', () => {
            const v1: Point2D = { x: 0, y: 0 };
            const v2: Point2D = { x: 10, y: 0 };
            const outsideAbove: Point2D = { x: 5, y: 5 }; // Above the edge

            const normal = getEdgeNormal(v1, v2, outsideAbove);

            // Normal should point up (positive y)
            expect(normal.y).toBeGreaterThan(0);
        });
    });

    describe('projectOntoSurface', () => {
        it('removes normal component from velocity', () => {
            const velocity: Point2D = { x: 10, y: -5 };
            const normal: Point2D = { x: 0, y: -1 }; // Pointing down

            const result = projectOntoSurface(velocity, normal);

            // Y component should be removed, X should remain
            expect(result.x).toBeCloseTo(10, 5);
            expect(result.y).toBeCloseTo(0, 5);
        });

        it('handles diagonal normals', () => {
            const velocity: Point2D = { x: 10, y: 10 };
            // Normal pointing at 45 degrees
            const normal: Point2D = { 
                x: Math.SQRT1_2, 
                y: Math.SQRT1_2 
            };

            const result = projectOntoSurface(velocity, normal);

            // Component along normal removed
            // Original: (10, 10), Normal: (√2/2, √2/2)
            // Dot product: 10*√2/2 + 10*√2/2 = 10√2
            // Result: (10, 10) - 10√2 * (√2/2, √2/2) = (10, 10) - (10, 10) = (0, 0)
            expect(result.x).toBeCloseTo(0, 5);
            expect(result.y).toBeCloseTo(0, 5);
        });

        it('preserves tangent component', () => {
            const velocity: Point2D = { x: 5, y: 0 };
            const normal: Point2D = { x: 0, y: 1 }; // Pointing up

            const result = projectOntoSurface(velocity, normal);

            // Velocity is already parallel to surface, should be unchanged
            expect(result.x).toBeCloseTo(5, 5);
            expect(result.y).toBeCloseTo(0, 5);
        });
    });
});

describe('EnvironmentManager.resolveMovement', () => {
    let manager: EnvironmentManager;

    beforeEach(() => {
        manager = new EnvironmentManager();
    });

    it('allows free movement when no buildings exist', () => {
        const result = manager.resolveMovement(
            { x: 0, y: 0 },
            { x: 10, y: 10 }
        );

        expect(result.blocked).toBe(false);
        expect(result.position.x).toBeCloseTo(10, 5);
        expect(result.position.y).toBeCloseTo(10, 5);
    });

    it('allows free movement when path misses buildings', () => {
        manager.loadFromData({
            bounds: {
                center: { lat: 0, lng: 0 },
                minLat: -1, maxLat: 1, minLng: -1, maxLng: 1,
                localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
            },
            buildings: [createSquareBuilding('b1', 50, 50, 10)],
        });

        const result = manager.resolveMovement(
            { x: 0, y: 0 },
            { x: 10, y: 0 }
        );

        expect(result.blocked).toBe(false);
        expect(result.position.x).toBeCloseTo(10, 5);
    });

    it('stops movement at building edge', () => {
        manager.loadFromData({
            bounds: {
                center: { lat: 0, lng: 0 },
                minLat: -1, maxLat: 1, minLng: -1, maxLng: 1,
                localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
            },
            buildings: [createSquareBuilding('b1', 10, 0, 4)], // x=8 to x=12
        });

        const result = manager.resolveMovement(
            { x: 0, y: 0 },
            { x: 20, y: 0 } // Trying to move through building
        );

        expect(result.blocked).toBe(true);
        // Should stop just before building (x ≈ 8 - epsilon)
        expect(result.position.x).toBeLessThan(8);
        expect(result.position.x).toBeGreaterThan(7);
    });

    it('slides along walls when hitting at an angle', () => {
        // Building at y=5 so diagonal line from (0,0) to (20,10) intersects it
        // Line at x=8: y=4, at x=12: y=6 - both inside building y=[3,7]
        manager.loadFromData({
            bounds: {
                center: { lat: 0, lng: 0 },
                minLat: -1, maxLat: 1, minLng: -1, maxLng: 1,
                localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
            },
            buildings: [createSquareBuilding('b1', 10, 5, 4)], // x=8 to x=12, y=3 to y=7
        });

        // Moving diagonally toward the building
        const result = manager.resolveMovement(
            { x: 0, y: 0 },
            { x: 20, y: 10 } // Diagonal movement
        );

        expect(result.blocked).toBe(true);
        // Should slide along the wall
        expect(result.position.x).toBeLessThan(20);
    });

    it('handles movement inside existing buildings gracefully', () => {
        manager.loadFromData({
            bounds: {
                center: { lat: 0, lng: 0 },
                minLat: -1, maxLat: 1, minLng: -1, maxLng: 1,
                localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
            },
            buildings: [createSquareBuilding('b1', 0, 0, 20)], // Large building centered at origin
        });

        // Both points inside building - should allow movement
        // (Once inside, person can move inside)
        const result = manager.resolveMovement(
            { x: 1, y: 1 },
            { x: 5, y: 5 }
        );

        // When both endpoints are inside, the line may not intersect any edges
        // So movement is allowed
        expect(result.position.x).toBeCloseTo(5, 1);
        expect(result.position.y).toBeCloseTo(5, 1);
    });

    it('handles corner collisions', () => {
        // Place building so diagonal path hits the side, not exactly at corner
        // Line from (0,0) to (20,20) passes through (10, 10)
        // Building centered at (12, 10) with size 6: x=[9,15], y=[7,13]
        // At x=9, y=9 (inside building y range [7,13]) - will hit left edge
        manager.loadFromData({
            bounds: {
                center: { lat: 0, lng: 0 },
                minLat: -1, maxLat: 1, minLng: -1, maxLng: 1,
                localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
            },
            buildings: [
                createSquareBuilding('b1', 12, 10, 6), // x=9 to x=15, y=7 to y=13
            ],
        });

        // Moving diagonally - will hit left edge of building
        const result = manager.resolveMovement(
            { x: 0, y: 0 },
            { x: 20, y: 20 }
        );

        expect(result.blocked).toBe(true);
        // Should stop at or before x=9
        expect(result.position.x).toBeLessThan(10);
    });
});

describe('Integration: Person movement with collision', () => {
    it('single step collision is detected', () => {
        const manager = new EnvironmentManager();
        manager.loadFromData({
            bounds: {
                center: { lat: 0, lng: 0 },
                minLat: -1, maxLat: 1, minLng: -1, maxLng: 1,
                localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
            },
            buildings: [createSquareBuilding('b1', 50, 0, 20)], // x=40 to x=60, y=-10 to y=10
        });

        // Single step that crosses the building
        const result = manager.resolveMovement(
            { x: 30, y: 0 },
            { x: 70, y: 0 } // Would cross the building from x=40 to x=60
        );

        expect(result.blocked).toBe(true);
        expect(result.position.x).toBeLessThan(41);
    });

    it('person stops at building boundary with multiple steps', () => {
        const manager = new EnvironmentManager();
        manager.loadFromData({
            bounds: {
                center: { lat: 0, lng: 0 },
                minLat: -1, maxLat: 1, minLng: -1, maxLng: 1,
                localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
            },
            buildings: [createSquareBuilding('b1', 50, 0, 20)], // x=40 to x=60, y=-10 to y=10
        });

        // Simulate walking - each step is 10m
        let position: Point2D = { x: 0, y: 0 };

        for (let i = 0; i < 10; i++) {
            const newPos: Point2D = {
                x: position.x + 10,
                y: position.y,
            };
            const result = manager.resolveMovement(position, newPos);
            position = { ...result.position }; // Make a copy to avoid reference issues
        }

        // Should stop at building (x ≈ 40)
        expect(position.x).toBeLessThan(41);
        expect(position.x).toBeGreaterThan(35);
    });
});
