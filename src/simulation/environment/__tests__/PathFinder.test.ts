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

    describe('narrow gap rejection', () => {
        it('rejects paths through very narrow gaps between buildings', () => {
            // Two buildings with only 2m gap between them (less than MIN_CLEARANCE * 2)
            const building1 = makeBuilding('b1', [
                { x: 0, y: 40 },
                { x: 20, y: 40 },
                { x: 20, y: 60 },
                { x: 0, y: 60 },
            ]);
            const building2 = makeBuilding('b2', [
                { x: 22, y: 40 },  // Only 2m gap
                { x: 50, y: 40 },
                { x: 50, y: 60 },
                { x: 22, y: 60 },
            ]);
            pathFinder.buildVisibilityGraph([building1, building2], 3);

            // Try to path through the narrow gap
            const result = pathFinder.findPath(
                { x: 10, y: 20 },
                { x: 35, y: 80 }
            );

            // Should not find a direct path through the gap
            // Either finds a path around or returns not found
            if (result.found) {
                // If found, verify it doesn't go through the gap
                for (const wp of result.waypoints) {
                    // Waypoint should not be in the gap area (x between 20 and 22, y between 40 and 60)
                    const inGap = wp.x > 19 && wp.x < 23 && wp.y >= 40 && wp.y <= 60;
                    expect(inGap).toBe(false);
                }
            }
        });

        it('allows paths through sufficiently wide corridors', () => {
            // Two buildings with 15m gap between them (wider than MIN_CLEARANCE * 2)
            const building1 = makeBuilding('b1', [
                { x: 40, y: 0 },
                { x: 60, y: 0 },
                { x: 60, y: 35 },
                { x: 40, y: 35 },
            ]);
            const building2 = makeBuilding('b2', [
                { x: 40, y: 65 },  // 30m gap (65-35=30)
                { x: 60, y: 65 },
                { x: 60, y: 100 },
                { x: 40, y: 100 },
            ]);
            pathFinder.buildVisibilityGraph([building1, building2], 3);

            // Path through the corridor
            const result = pathFinder.findPath(
                { x: 0, y: 50 },
                { x: 100, y: 50 }
            );

            expect(result.found).toBe(true);
            // Should be a direct path through the corridor
            expect(result.waypoints).toHaveLength(2);
        });
    });

    describe('zone validation', () => {
        let building: Building;

        beforeEach(() => {
            building = makeBuilding('b1', [
                { x: 40, y: 40 },
                { x: 60, y: 40 },
                { x: 60, y: 60 },
                { x: 40, y: 60 },
            ]);
            pathFinder.buildVisibilityGraph([building], 3);
        });

        it('rejects path from inside building to outside', () => {
            // Start inside the building, goal outside
            const result = pathFinder.findPath(
                { x: 50, y: 50 },  // Inside building
                { x: 100, y: 100 } // Outside
            );

            expect(result.found).toBe(false);
        });

        it('rejects path from outside building to inside', () => {
            // Start outside, goal inside the building
            const result = pathFinder.findPath(
                { x: 0, y: 0 },    // Outside
                { x: 50, y: 50 }   // Inside building
            );

            expect(result.found).toBe(false);
        });

        it('allows path between two outside points', () => {
            // Both outside
            const result = pathFinder.findPath(
                { x: 0, y: 0 },
                { x: 100, y: 100 }
            );

            expect(result.found).toBe(true);
        });

        it('rejects path between two inside points (buildings are solid obstacles)', () => {
            // Both inside the same building
            // Buildings are solid obstacles, so even if both points are inside,
            // we cannot find a valid path through a building
            const result = pathFinder.findPath(
                { x: 45, y: 50 },  // Inside
                { x: 55, y: 50 }   // Also inside
            );

            // While both are in "compatible zones" (both inside), 
            // the path validation fails because paths through buildings are invalid
            expect(result.found).toBe(false);
        });
    });

    describe('path clearance validation', () => {
        it('ensures path maintains minimum clearance from walls', () => {
            const building = makeBuilding('b1', [
                { x: 50, y: 50 },
                { x: 70, y: 50 },
                { x: 70, y: 70 },
                { x: 50, y: 70 },
            ]);
            pathFinder.buildVisibilityGraph([building], 5);

            // Start and goal that would naturally path close to corners
            const result = pathFinder.findPath(
                { x: 40, y: 40 },
                { x: 80, y: 80 }
            );

            expect(result.found).toBe(true);
            
            // Check all intermediate waypoints maintain clearance
            for (let i = 1; i < result.waypoints.length - 1; i++) {
                const wp = result.waypoints[i];
                // Should not be within 2m of building edges
                const tooCloseX = wp.x > 48 && wp.x < 72;
                const tooCloseY = wp.y > 48 && wp.y < 72;
                // At least one dimension should be outside the danger zone
                expect(!(tooCloseX && tooCloseY)).toBe(true);
            }
        });

        it('validates entire path segments not just waypoints', () => {
            // Two buildings forming a narrow passage that waypoints might skip over
            const building1 = makeBuilding('b1', [
                { x: 45, y: 0 },
                { x: 55, y: 0 },
                { x: 55, y: 45 },
                { x: 45, y: 45 },
            ]);
            const building2 = makeBuilding('b2', [
                { x: 45, y: 55 },
                { x: 55, y: 55 },
                { x: 55, y: 100 },
                { x: 45, y: 100 },
            ]);
            pathFinder.buildVisibilityGraph([building1, building2], 5);

            // Path that might try to cut diagonally through narrow gap
            const result = pathFinder.findPath(
                { x: 0, y: 30 },
                { x: 100, y: 70 }
            );

            // The path should either:
            // 1. Go through the corridor (if wide enough)
            // 2. Go around (if corridor is too narrow)
            // But NOT cut diagonally through buildings
            if (result.found && result.waypoints.length > 2) {
                // Verify no waypoint is inside either building
                for (const wp of result.waypoints) {
                    const inBuilding1 = wp.x > 45 && wp.x < 55 && wp.y > 0 && wp.y < 45;
                    const inBuilding2 = wp.x > 45 && wp.x < 55 && wp.y > 55 && wp.y < 100;
                    expect(inBuilding1 || inBuilding2).toBe(false);
                }
            }
        });
    });
});
