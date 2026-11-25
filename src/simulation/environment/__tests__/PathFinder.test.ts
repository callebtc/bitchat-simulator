import { describe, it, expect } from 'vitest';
import { PathFinder } from '../PathFinder';
import { Building, Material, Point2D, calculateBounds } from '../types';
import { hasLineOfSight } from '../LineOfSight';
import { SimulationEngine } from '../../SimulationEngine';
import { BitchatPerson, MovementMode } from '../../BitchatPerson';
import { BitchatDevice } from '../../BitchatDevice';

function makeBuilding(id: string, vertices: Point2D[]): Building {
    return {
        id,
        material: Material.BUILDING,
        vertices,
        bounds: calculateBounds(vertices),
    };
}

describe('PathFinder & Pedestrian Navigation', () => {
    it('routes cleanly around both CCW and CW building polygons without intersecting any wall', () => {
        // One CCW rectangle and one CW rectangle (matching mixed OpenStreetMap winding)
        const ccwBuilding = makeBuilding('ccw', [
            { x: -20, y: -15 },
            { x: 20, y: -15 },
            { x: 20, y: 15 },
            { x: -20, y: 15 },
        ]);
        const cwBuilding = makeBuilding('cw', [
            { x: 35, y: -20 },
            { x: 35, y: 20 },
            { x: 75, y: 20 },
            { x: 75, y: -20 },
        ]);
        const buildings = [ccwBuilding, cwBuilding];

        const pf = new PathFinder();
        pf.buildVisibilityGraph(buildings, 1.5);

        const res = pf.findPath({ x: -35, y: 0 }, { x: 90, y: 0 });
        expect(res.found).toBe(true);
        expect(res.waypoints.length).toBeGreaterThanOrEqual(3);

        // Verify every segment of the returned path is completely obstacle-free
        for (let i = 1; i < res.waypoints.length; i++) {
            expect(hasLineOfSight(res.waypoints[i - 1], res.waypoints[i], buildings)).toBe(true);
        }
    });

    it('connects start and goal even when standing 0.1 m outside a building wall (inside padding radius)', () => {
        const block = makeBuilding('block', [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 30 },
            { x: 0, y: 30 },
        ]);
        const buildings = [block];

        const pf = new PathFinder();
        pf.buildVisibilityGraph(buildings, 1.5);

        // Both start and goal are only 0.1 m away from opposite walls (well inside 1.5 m padding!)
        const res = pf.findPath({ x: 20, y: -0.1 }, { x: 20, y: 30.1 });
        expect(res.found).toBe(true);
        expect(res.waypoints.length).toBeGreaterThanOrEqual(4);
        for (let i = 1; i < res.waypoints.length; i++) {
            expect(hasLineOfSight(res.waypoints[i - 1], res.waypoints[i], buildings)).toBe(true);
        }
    });

    it('navigates narrow 3.5 m alleys and concave L-shaped buildings cleanly', () => {
        // Concave L-shaped building (CW winding) + neighboring block forming a 3.5 m alley
        const lShapedCW = makeBuilding('l_cw', [
            { x: 0, y: 0 },
            { x: 0, y: 40 },
            { x: 15, y: 40 },
            { x: 15, y: 15 },
            { x: 40, y: 15 },
            { x: 40, y: 0 },
        ]);
        const neighbor = makeBuilding('neighbor', [
            { x: 43.5, y: 0 },
            { x: 70, y: 0 },
            { x: 70, y: 40 },
            { x: 43.5, y: 40 },
        ]);
        const buildings = [lShapedCW, neighbor];

        const pf = new PathFinder();
        pf.buildVisibilityGraph(buildings, 1.5);

        // Route from bottom-center through the 3.5 m alley to top-right
        const res = pf.findPath({ x: 41.75, y: -15 }, { x: 25, y: 30 });
        expect(res.found).toBe(true);
        for (let i = 1; i < res.waypoints.length; i++) {
            expect(hasLineOfSight(res.waypoints[i - 1], res.waypoints[i], buildings)).toBe(true);
        }
    });

    it('BUSY agents on a multi-building urban grid always obtain obstacle-free paths', () => {
        const engine = new SimulationEngine({ seed: 101 });
        const features = [];
        for (let gx = -2; gx <= 2; gx++) {
            for (let gy = -2; gy <= 2; gy++) {
                const x = gx * 45;
                const y = gy * 45;
                const lat0 = 40.758 + y / 111320;
                const lon0 = -73.9855 + x / (111320 * Math.cos((40.758 * Math.PI) / 180));
                const dLat = 28 / 111320;
                const dLon = 28 / (111320 * Math.cos((40.758 * Math.PI) / 180));
                // Alternate CW and CCW winding like real OpenStreetMap data
                const ring =
                    (gx + gy) % 2 === 0
                        ? [
                              [lon0, lat0],
                              [lon0 + dLon, lat0],
                              [lon0 + dLon, lat0 + dLat],
                              [lon0, lat0 + dLat],
                              [lon0, lat0],
                          ]
                        : [
                              [lon0, lat0],
                              [lon0, lat0 + dLat],
                              [lon0 + dLon, lat0 + dLat],
                              [lon0 + dLon, lat0],
                              [lon0, lat0],
                          ];
                features.push({
                    type: 'Feature' as const,
                    geometry: { type: 'Polygon' as const, coordinates: [ring] },
                    properties: {},
                });
            }
        }
        engine.environment.loadFromGeoJSON(
            { type: 'FeatureCollection', features },
            40.758,
            -73.9855
        );
        engine.rebuildPathfindingGraph();

        const buildings = engine.environment.getBuildings();
        const walkers: BitchatPerson[] = [];

        for (let i = 0; i < 20; i++) {
            // Place outdoors along streets (between blocks)
            const dev = BitchatDevice.createRandom(engine.rng);
            const p = new BitchatPerson(
                `walker_${i}`,
                { x: -10 + (i % 5) * 45 - 90, y: -10 + Math.floor(i / 5) * 45 - 90 },
                dev
            );
            engine.addPerson(p);
            p.setMode(MovementMode.BUSY);
            walkers.push(p);
        }

        // Step once so BUSY errands pick destinations and calculate visibility-graph paths
        engine.step(0.05, engine.simTimeMs + 50);

        let pathsChecked = 0;
        for (const p of walkers) {
            if (p.path && p.path.length >= 2) {
                pathsChecked++;
                for (let k = 1; k < p.path.length; k++) {
                    expect(hasLineOfSight(p.path[k - 1], p.path[k], buildings)).toBe(true);
                }
            } else {
                // Must NEVER leave an unresolved target with path === null when buildings exist
                expect(p.target).toBeNull();
            }
        }

        expect(pathsChecked).toBeGreaterThanOrEqual(15);
    });
});
