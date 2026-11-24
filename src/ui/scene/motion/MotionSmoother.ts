import { SimulationEngine } from '../../../simulation/SimulationEngine';

/**
 * Render-side motion interpolation.
 *
 * The simulation advances people in fixed 50 ms steps (20 Hz, slower when the
 * engine time-slices under load) while the display refreshes at 60–120 Hz.
 * Drawing raw positions therefore stair-steps. Every frame this smoother
 * detects new simulation positions and glides the displayed position from
 * where it currently is to the new one over the measured step interval.
 * Starting each glide from the *displayed* point (not the previous sim point)
 * keeps motion continuous even when step cadence is irregular.
 *
 * Costs one step of latency (~50 ms), invisible at walking speed. All 3D
 * layers and DOM overlays read the same positions so nothing drifts apart.
 */

/** Jumps larger than this (drag, respawn) snap instead of gliding. */
const SNAP_DISTANCE_M = 8;
const MIN_INTERVAL_MS = 16;
const MAX_INTERVAL_MS = 250;

export interface Motion {
    /** Displayed (interpolated) position. */
    x: number;
    y: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    startMs: number;
    seenFrame: number;
}

export class MotionSmoother {
    private motions = new Map<string, Motion>();
    private lastSimTimeMs = -1;
    private lastSimChangeWallMs = 0;
    /** EMA of wall-clock time between simulation position updates. */
    private intervalMs = 50;
    private frame = 0;

    update(engine: SimulationEngine, nowMs: number): void {
        this.frame++;
        if (engine.simTimeMs !== this.lastSimTimeMs) {
            if (this.lastSimTimeMs >= 0 && this.lastSimChangeWallMs > 0) {
                const measured = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, nowMs - this.lastSimChangeWallMs));
                this.intervalMs += (measured - this.intervalMs) * 0.2;
            }
            this.lastSimTimeMs = engine.simTimeMs;
            this.lastSimChangeWallMs = nowMs;
        }

        const people = engine.getAllPeople();
        const interval = this.intervalMs;
        for (let i = 0; i < people.length; i++) {
            const p = people[i];
            const px = p.position.x;
            const py = p.position.y;
            let m = this.motions.get(p.id);
            if (!m) {
                m = { x: px, y: py, fromX: px, fromY: py, toX: px, toY: py, startMs: nowMs, seenFrame: this.frame };
                this.motions.set(p.id, m);
                continue;
            }
            m.seenFrame = this.frame;
            if (px !== m.toX || py !== m.toY) {
                const jump = Math.hypot(px - m.x, py - m.y);
                if (jump > SNAP_DISTANCE_M) {
                    m.x = m.fromX = m.toX = px;
                    m.y = m.fromY = m.toY = py;
                    m.startMs = nowMs;
                    continue;
                }
                m.fromX = m.x;
                m.fromY = m.y;
                m.toX = px;
                m.toY = py;
                m.startMs = nowMs;
            }
            const t = Math.min(1, (nowMs - m.startMs) / interval);
            m.x = m.fromX + (m.toX - m.fromX) * t;
            m.y = m.fromY + (m.toY - m.fromY) * t;
        }

        // Drop people that left the simulation (checked every ~2 s)
        if (this.frame % 120 === 0 && this.motions.size > people.length) {
            for (const [id, m] of this.motions) {
                if (m.seenFrame !== this.frame) this.motions.delete(id);
            }
        }
    }

    /** Displayed position for a person id, or undefined if not tracked yet. */
    get(personId: string): Motion | undefined {
        return this.motions.get(personId);
    }

    /** Displayed x/y, falling back to the raw simulation position. */
    positionOf(personId: string, fallback: { x: number; y: number }): { x: number; y: number } {
        return this.motions.get(personId) ?? fallback;
    }

    clear(): void {
        this.motions.clear();
        this.lastSimTimeMs = -1;
        this.lastSimChangeWallMs = 0;
    }
}
