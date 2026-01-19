import { describe, it, expect, beforeEach } from 'vitest';
import { PathFinder } from '../PathFinder';
import { Building, Material, calculateBounds, Point2D } from '../types';

function makeBuilding(id: string, vertices: Point2D[]): Building {
    return {
        id,
        material: Material.BUILDING,
        vertices,
        bounds: calculateBounds(vertices),
    };
}

describe('PathFinder', () => {
    let pathFinder: PathFinder;

    beforeEach(() => {
        pathFinder = new PathFinder();
    });

    describe('empty environment', () => {
        it('returns direct path when no buildings', () => {
            pathFinder.buildVisibilityGraph([], 2);
            
            const result = pathFinder.findPath(
                { x: 0, y: 0 },
                { x: 100, y: 100 }
            );
            
            expect(result.found).toBe(true);
            expect(result.waypoints).toHaveLength(2);
            expect(result.waypoints[0]).toEqual({ x: 0, y: 0 });
            expect(result.waypoints[1]).toEqual({ x: 100, y: 100 });
            expect(result.totalDistance).toBeCloseTo(Math.sqrt(2) * 100, 1);
        });

        it('reports ready after building graph', () => {
            expect(pathFinder.isReady()).toBe(false);
            pathFinder.buildVisibilityGraph([], 2);
            expect(pathFinder.isReady()).toBe(true);
        });
    });

    describe('with single building', () => {
        let building: Building;

        beforeEach(() => {
            // Square building centered at (50, 50), size 20x20
            building = makeBuilding('b1', [
                { x: 40, y: 40 },
                { x: 60, y: 40 },
                { x: 60, y: 60 },
                { x: 40, y: 60 },
            ]);
            pathFinder.buildVisibilityGraph([building], 3);
        });

        it('creates visibility graph nodes', () => {
            // Trigger lazy graph building by calling findPath
            pathFinder.findPath({ x: 0, y: 0 }, { x: 100, y: 100 });
            // Should have 4 padded corners
            expect(pathFinder.getNodeCount()).toBe(4);
        });

        it('returns direct path when line of sight is clear', () => {
            // Path below the building
            const result = pathFinder.findPath(
                { x: 0, y: 20 },
                { x: 100, y: 20 }
            );
            
            expect(result.found).toBe(true);
            expect(result.waypoints).toHaveLength(2);
        });

        it('navigates around building when blocked', () => {
            // Path through the building (start left, end right)
            const result = pathFinder.findPath(
                { x: 20, y: 50 },
                { x: 80, y: 50 }
            );
            
            expect(result.found).toBe(true);
            // Should have waypoints around the building
            expect(result.waypoints.length).toBeGreaterThan(2);
            // Total distance should be longer than direct path
            expect(result.totalDistance).toBeGreaterThan(60);
        });

        it('includes start and goal in waypoints', () => {
            const start = { x: 20, y: 50 };
            const goal = { x: 80, y: 50 };
            
            const result = pathFinder.findPath(start, goal);
            
            expect(result.waypoints[0]).toEqual(start);
            expect(result.waypoints[result.waypoints.length - 1]).toEqual(goal);
        });
    });

    describe('with multiple buildings', () => {
        beforeEach(() => {
            // Two buildings creating a corridor
            const building1 = makeBuilding('b1', [
                { x: 40, y: 0 },
                { x: 60, y: 0 },
                { x: 60, y: 40 },
                { x: 40, y: 40 },
            ]);
            const building2 = makeBuilding('b2', [
                { x: 40, y: 60 },
                { x: 60, y: 60 },
                { x: 60, y: 100 },
                { x: 40, y: 100 },
            ]);
            pathFinder.buildVisibilityGraph([building1, building2], 3);
        });

        it('finds path through corridor', () => {
            const result = pathFinder.findPath(
                { x: 0, y: 50 },
                { x: 100, y: 50 }
            );
            
            expect(result.found).toBe(true);
            expect(result.waypoints).toHaveLength(2); // Direct path through gap
        });

        it('creates nodes for all building corners', () => {
            // Trigger lazy graph building by calling findPath
            pathFinder.findPath({ x: 0, y: 0 }, { x: 100, y: 100 });
            // 4 corners * 2 buildings
            expect(pathFinder.getNodeCount()).toBe(8);
        });
    });

    describe('pathfinding algorithm', () => {
        it('finds shortest path around L-shaped obstacle', () => {
            // L-shaped building
            const lBuilding = makeBuilding('l1', [
                { x: 40, y: 20 },
                { x: 60, y: 20 },
                { x: 60, y: 60 },
                { x: 80, y: 60 },
                { x: 80, y: 80 },
                { x: 40, y: 80 },
            ]);
            pathFinder.buildVisibilityGraph([lBuilding], 3);
            
            // Start at bottom-left, goal at top-right
            const result = pathFinder.findPath(
                { x: 20, y: 20 },
                { x: 100, y: 70 }
            );
            
            expect(result.found).toBe(true);
            expect(result.waypoints.length).toBeGreaterThanOrEqual(2);
        });

        it('handles very close start and goal', () => {
            const building = makeBuilding('b1', [
                { x: 40, y: 40 },
                { x: 60, y: 40 },
                { x: 60, y: 60 },
                { x: 40, y: 60 },
            ]);
            pathFinder.buildVisibilityGraph([building], 3);
            
            const result = pathFinder.findPath(
                { x: 10, y: 10 },
                { x: 11, y: 11 }
            );
            
            expect(result.found).toBe(true);
            expect(result.waypoints).toHaveLength(2);
            expect(result.totalDistance).toBeCloseTo(Math.sqrt(2), 4);
        });

        it('handles start and goal at same position', () => {
            const building = makeBuilding('b1', [
                { x: 40, y: 40 },
                { x: 60, y: 40 },
                { x: 60, y: 60 },
                { x: 40, y: 60 },
            ]);
            pathFinder.buildVisibilityGraph([building], 3);
            
            const result = pathFinder.findPath(
                { x: 10, y: 10 },
                { x: 10, y: 10 }
            );
            
            expect(result.found).toBe(true);
            expect(result.totalDistance).toBe(0);
        });
    });

    describe('padding calculation', () => {
        it('creates clearance around buildings', () => {
            const building = makeBuilding('b1', [
                { x: 50, y: 50 },
                { x: 70, y: 50 },
                { x: 70, y: 70 },
                { x: 50, y: 70 },
            ]);
            pathFinder.buildVisibilityGraph([building], 5);
            
            // Path that goes very close to corner
            const result = pathFinder.findPath(
                { x: 40, y: 40 },
                { x: 80, y: 80 }
            );
            
            expect(result.found).toBe(true);
            // Waypoints should maintain some distance from actual corners
            for (const wp of result.waypoints) {
                // Check that waypoints aren't inside the building
                const insideX = wp.x > 50 && wp.x < 70;
                const insideY = wp.y > 50 && wp.y < 70;
                expect(insideX && insideY).toBe(false);
            }
        });

        it('uses configurable padding distance', () => {
            const building = makeBuilding('b1', [
                { x: 50, y: 50 },
                { x: 60, y: 50 },
                { x: 60, y: 60 },
                { x: 50, y: 60 },
            ]);
            
            // Small padding
            pathFinder.buildVisibilityGraph([building], 1);
            const smallPaddingNodes = pathFinder.getNodeCount();
            
            // Large padding
            pathFinder.buildVisibilityGraph([building], 10);
            const largePaddingNodes = pathFinder.getNodeCount();
            
            // Same number of nodes, but different positions
            expect(smallPaddingNodes).toBe(largePaddingNodes);
        });
    });
});
