import { describe, it, expect } from 'vitest';

import { MotionSmoother } from './MotionSmoother';
import { SimulationEngine } from '../../../simulation/SimulationEngine';

interface FakePerson {
    id: string;
    position: { x: number; y: number };
}

function fakeEngine(people: FakePerson[]): { engine: SimulationEngine; state: { simTimeMs: number } } {
    const state = { simTimeMs: 0 };
    const engine = {
        get simTimeMs() {
            return state.simTimeMs;
        },
        getAllPeople: () => people,
    } as unknown as SimulationEngine;
    return { engine, state };
}

describe('MotionSmoother', () => {
    it('glides between 20 Hz simulation steps instead of stair-stepping', () => {
        const person = { id: 'p', position: { x: 0, y: 0 } };
        const { engine, state } = fakeEngine([person]);
        const m = new MotionSmoother();

        // Establish a 50 ms step cadence
        for (let t = 0; t <= 200; t += 50) {
            state.simTimeMs = t;
            m.update(engine, t);
        }
        // Sim step: person moves 1 m
        state.simTimeMs = 250;
        person.position.x = 1;
        m.update(engine, 250);
        expect(m.get('p')?.x).toBeCloseTo(0, 5);

        // Halfway through the step interval → halfway there
        m.update(engine, 275);
        expect(m.get('p')?.x).toBeCloseTo(0.5, 1);

        m.update(engine, 300);
        expect(m.get('p')?.x).toBeCloseTo(1, 5);
    });

    it('snaps on teleports and falls back to raw positions for unknown ids', () => {
        const person = { id: 'p', position: { x: 0, y: 0 } };
        const { engine, state } = fakeEngine([person]);
        const m = new MotionSmoother();
        m.update(engine, 0);
        person.position.x = 50;
        state.simTimeMs = 50;
        m.update(engine, 50);
        expect(m.get('p')?.x).toBe(50);
        expect(m.positionOf('missing', { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
    });
});
