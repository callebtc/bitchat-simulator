import { describe, it, expect } from 'vitest';

import { SimulationEngine } from '../../SimulationEngine';
import { BitchatPerson, MovementMode } from '../../BitchatPerson';
import { BitchatDevice } from '../../BitchatDevice';
import { BitchatAppSimulator } from '../../AppLayer/BitchatAppSimulator';
import { anticipatoryForce, densitySpeedFactor, timeToCollision } from '../Steering';

function addPerson(engine: SimulationEngine, id: string, x: number, y: number): BitchatPerson {
    const d = BitchatDevice.createRandom(engine.rng);
    d.setAppSimulator(new BitchatAppSimulator(d, 'android'));
    const p = new BitchatPerson(id, { x, y }, d, engine.rng.fork(id));
    engine.addPerson(p);
    return p;
}

function minPairDistance(people: BitchatPerson[]): number {
    let min = Infinity;
    for (let i = 0; i < people.length; i++) {
        for (let j = i + 1; j < people.length; j++) {
            min = Math.min(min, Math.hypot(people[i].position.x - people[j].position.x, people[i].position.y - people[j].position.y));
        }
    }
    return min;
}

function squareBuilding(cx: number, cy: number, half: number): GeoJSON {
    // ~111 km per degree; tiny squares near (0,0)
    const k = 1 / 111_320;
    const ring = [
        [(cx - half) * k, (cy - half) * k],
        [(cx + half) * k, (cy - half) * k],
        [(cx + half) * k, (cy + half) * k],
        [(cx - half) * k, (cy + half) * k],
        [(cx - half) * k, (cy - half) * k],
    ];
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { kind: 'building', osmId: cx * 1000 + cy, height: '12' } };
}
type GeoJSON = { type: 'Feature'; geometry: { type: 'Polygon'; coordinates: number[][][] }; properties: Record<string, unknown> };

describe('Steering primitives', () => {
    it('computes time to collision for approaching discs', () => {
        // Two agents 10 m apart closing at 2 m/s with combined radius 0.5 → 4.75 s
        expect(timeToCollision(10, 0, -2, 0, 0.5)).toBeCloseTo(4.75, 5);
        expect(timeToCollision(10, 0, 2, 0, 0.5)).toBe(Infinity); // moving apart
        expect(timeToCollision(0.2, 0, -1, 0, 0.5)).toBe(0); // already touching
    });

    it('sidesteps a head-on walker laterally, not by braking', () => {
        const f = { x: 0, y: 0 };
        anticipatoryForce(0, 0, 1.3, 0, 4, 0.05, -1.3, 0, f);
        expect(Math.abs(f.y)).toBeGreaterThan(Math.abs(f.x) * 0.5);
        expect(f.y).toBeLessThan(0); // the other is slightly to the left → dodge right
    });

    it('slows walkers in dense crowds (Weidmann)', () => {
        expect(densitySpeedFactor(0.1)).toBeGreaterThan(0.95);
        expect(densitySpeedFactor(2)).toBeLessThan(0.75);
        expect(densitySpeedFactor(5)).toBeLessThan(0.2);
    });
});

describe('Crowd behaviour', () => {
    it('two people walking head-on pass each other without contact', () => {
        const engine = new SimulationEngine({ seed: 501 });
        const a = addPerson(engine, 'A', -15, 0);
        const b = addPerson(engine, 'B', 15, 0.01);
        a.setTarget({ x: 15, y: 0 });
        b.setTarget({ x: -15, y: 0 });
        let closest = Infinity;
        // Free walking speeds are ~0.8–1.8 m/s, so 30 m takes up to ~40 s
        for (let t = 0; t < 45_000; t += 50) {
            engine.step(0.05, engine.simTimeMs + 50);
            closest = Math.min(closest, Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y));
        }
        expect(closest).toBeGreaterThan(0.5); // never bodies touching (2 × 0.25 m radius)
        expect(a.position.x).toBeGreaterThan(13);
        expect(b.position.x).toBeLessThan(-13);
    });

    it('a dense strolling crowd keeps personal space, walks at human speeds, and forms groups', () => {
        const engine = new SimulationEngine({ seed: 502 });
        const people: BitchatPerson[] = [];
        for (let i = 0; i < 60; i++) {
            const p = addPerson(engine, `p${i}`, (engine.rng.next() - 0.5) * 40, (engine.rng.next() - 0.5) * 40);
            p.setMode(MovementMode.RANDOM_WALK);
            people.push(p);
        }
        let overlapsSamples = 0;
        let samples = 0;
        let speedSum = 0;
        let speedN = 0;
        for (let t = 0; t < 60_000; t += 50) {
            engine.step(0.05, engine.simTimeMs + 50);
            if (t % 1000 === 0 && t > 2000) {
                samples++;
                if (minPairDistance(people) < 0.3) overlapsSamples++;
                for (const p of people) {
                    const s = Math.hypot(p.velocity.x, p.velocity.y);
                    if (s > 0.3) {
                        speedSum += s;
                        speedN++;
                    }
                }
            }
        }
        // Bodies (0.5 m wide) essentially never interpenetrate
        expect(overlapsSamples / samples).toBeLessThan(0.1);
        const meanSpeed = speedSum / speedN;
        expect(meanSpeed).toBeGreaterThan(0.8);
        expect(meanSpeed).toBeLessThan(1.6);
        // Social groups formed, and followers stay close to their leader
        const groups = new Set(people.map(p => engine.crowd.groupOf(p.id)?.id).filter((g): g is number => g !== undefined));
        expect(groups.size).toBeGreaterThan(5);
        let followerDist = 0;
        let followers = 0;
        for (const p of people) {
            const g = engine.crowd.groupOf(p.id);
            if (!g || g.members[0] === p.id) continue;
            const leader = engine.getPerson(g.members[0]);
            if (!leader) continue;
            followerDist += Math.hypot(p.position.x - leader.position.x, p.position.y - leader.position.y);
            followers++;
        }
        expect(followers).toBeGreaterThan(0);
        expect(followerDist / followers).toBeLessThan(4);
        // People actually go places (not jitter in place)
        expect(people.filter(p => Math.hypot(p.position.x, p.position.y) > 25).length).toBeGreaterThan(10);
    });

    it('walks around buildings and keeps clear of walls', () => {
        const engine = new SimulationEngine({ seed: 503 });
        engine.environment.loadFromGeoJSON(
            { type: 'FeatureCollection', features: [squareBuilding(0, 0, 10), squareBuilding(40, 0, 8), squareBuilding(-30, 25, 9)] },
            0,
            0
        );
        engine.rebuildPathfindingGraph();
        engine.pathFinder.buildVisibilityGraph(engine.environment.getBuildings(), 2.5);
        const people: BitchatPerson[] = [];
        for (let i = 0; i < 25; i++) {
            let x = 0;
            let y = 0;
            do {
                x = (engine.rng.next() - 0.5) * 120;
                y = (engine.rng.next() - 0.5) * 120;
            } while (engine.environment.isInsideBuilding({ x, y }));
            const p = addPerson(engine, `w${i}`, x, y);
            p.setMode(MovementMode.RANDOM_WALK);
            people.push(p);
        }
        let inside = 0;
        let hugging = 0;
        let samples = 0;
        const v = { x: 0, y: 0 };
        for (let t = 0; t < 45_000; t += 50) {
            engine.step(0.05, engine.simTimeMs + 50);
            if (t % 500 === 0) {
                for (const p of people) {
                    samples++;
                    if (engine.environment.isInsideBuilding(p.position)) inside++;
                    if (engine.environment.nearestWall(p.position.x, p.position.y, 0.15, v) < 0.15) hugging++;
                }
            }
        }
        expect(inside).toBe(0);
        expect(hugging / samples).toBeLessThan(0.02);
    });

    it('is deterministic for a given seed', () => {
        const run = (): string => {
            const engine = new SimulationEngine({ seed: 504 });
            const people: BitchatPerson[] = [];
            for (let i = 0; i < 20; i++) {
                const p = addPerson(engine, `d${i}`, (engine.rng.next() - 0.5) * 30, (engine.rng.next() - 0.5) * 30);
                p.setMode(MovementMode.RANDOM_WALK);
                people.push(p);
            }
            engine.runFor(20_000, 50);
            return people.map(p => `${p.position.x.toFixed(6)},${p.position.y.toFixed(6)}`).join(';');
        };
        expect(run()).toBe(run());
    });
});
