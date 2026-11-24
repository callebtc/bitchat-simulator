/**
 * CrowdManager
 * Shared pedestrian context owned by SimulationEngine:
 *  - a per-step neighbour snapshot (CrowdGrid) for steering,
 *  - destination planning from map points of interest,
 *  - social groups (friends/families walking together).
 *
 * Group sizes follow field observations of urban pedestrians (Moussaïd et al.
 * 2010, PLoS ONE: most people walk in groups; pairs dominate). Groups walk
 * slower than individuals and in a side-by-side "abreast" line, bending into
 * a V/U shape when larger or when the street gets crowded.
 */

import { EnvironmentManager, Point2D } from '../environment';
import { SeededRandom } from '../SeededRandom';
import { CrowdGrid, CrowdSnapshotAgent } from './CrowdGrid';
import { DestinationPlanner, Poi } from './Destinations';
import {
    STEERING,
    Vec,
    anticipatoryForce,
    clampLength,
    densitySpeedFactor,
    personalSpaceForce,
    wallForce,
} from './Steering';

/** Probability of each group size for newly spawned strollers (1..5). */
export const GROUP_SIZE_DIST = [0.45, 0.33, 0.14, 0.06, 0.02];
/** Max distance (m) between strangers that may be grouped at spawn. */
const GROUP_FORMATION_RADIUS_M = 45;
/** Lateral spacing between group members walking abreast (m). */
const ABREAST_SPACING_M = 0.75;
/** Groups walk ~10 % slower than their slowest member alone. */
export const GROUP_SPEED_FACTOR = 0.9;

export interface CrowdAgent extends CrowdSnapshotAgent {
    /** True when the agent wants crowd/group behaviour (strolling). */
    readonly wantsGroup: boolean;
    /** Preferred free walking speed (m/s). */
    readonly prefSpeed: number;
    /** Heading used to orient a group's formation (radians). */
    readonly heading: number;
}

export interface Group {
    id: number;
    /** Member ids; index 0 is the leader (chooses destinations). */
    members: string[];
}

export interface SteeringInput {
    index: number;
    px: number;
    py: number;
    vx: number;
    vy: number;
    desiredVx: number;
    desiredVy: number;
    /** Scale for anticipatory avoidance (dwelling people mostly hold position). */
    avoidance: number;
    /** Ignore avoidance between members of this group (they walk close by choice). */
    groupId: number;
}

const _f: Vec = { x: 0, y: 0 };
const _wall: Point2D = { x: 0, y: 0 };

export class CrowdManager {
    readonly grid = new CrowdGrid();
    readonly planner: DestinationPlanner;
    private groups = new Map<number, Group>();
    private groupOfPerson = new Map<string, number>();
    private considered = new Set<string>();
    private nextGroupId = 1;
    private envVersion = 0;
    private nbrIdx = new Int32Array(STEERING.MAX_NEIGHBORS);
    private nbrD2 = new Float64Array(STEERING.MAX_NEIGHBORS);

    constructor(
        private readonly env: EnvironmentManager,
        private readonly rng: SeededRandom
    ) {
        this.planner = new DestinationPlanner(rng.fork('destinations'));
    }

    /** Call when buildings / map context change. */
    onEnvironmentChanged(): void {
        this.envVersion++;
    }

    reset(): void {
        this.groups.clear();
        this.groupOfPerson.clear();
        this.considered.clear();
        this.nextGroupId = 1;
        this.envVersion++;
    }

    /** Snapshot positions/velocities and form groups among new strollers. */
    beginStep(agents: ReadonlyArray<CrowdAgent>): void {
        this.grid.rebuild(agents);
        this.formPendingGroups(agents);
    }

    // ------------------------------------------------------------------ groups

    groupOf(personId: string): Group | undefined {
        const gid = this.groupOfPerson.get(personId);
        return gid === undefined ? undefined : this.groups.get(gid);
    }

    isLeader(personId: string): boolean {
        return this.groupOf(personId)?.members[0] === personId;
    }

    /** Leave any group (e.g. user gave this person an explicit command). */
    leaveGroup(personId: string): void {
        const g = this.groupOf(personId);
        this.groupOfPerson.delete(personId);
        if (!g) return;
        g.members = g.members.filter(m => m !== personId);
        if (g.members.length <= 1) {
            for (const m of g.members) this.groupOfPerson.delete(m);
            this.groups.delete(g.id);
        }
    }

    onPersonRemoved(personId: string): void {
        this.leaveGroup(personId);
        this.considered.delete(personId);
    }

    /** Allow a person to be (re)considered for grouping on the next step. */
    reconsider(personId: string): void {
        this.considered.delete(personId);
    }

    private formPendingGroups(agents: ReadonlyArray<CrowdAgent>): void {
        const fresh: CrowdAgent[] = [];
        for (const a of agents) {
            if (!a.wantsGroup || this.considered.has(a.id) || this.groupOfPerson.has(a.id)) continue;
            fresh.push(a);
        }
        if (fresh.length === 0) return;
        const taken = new Set<string>();
        for (const a of fresh) {
            if (taken.has(a.id)) continue;
            taken.add(a.id);
            this.considered.add(a.id);
            let size = 1;
            let r = this.rng.next();
            for (let k = 0; k < GROUP_SIZE_DIST.length; k++) {
                r -= GROUP_SIZE_DIST[k];
                if (r <= 0) {
                    size = k + 1;
                    break;
                }
            }
            if (size === 1) continue;
            // Nearest other fresh strollers become companions
            const mates = fresh
                .filter(b => !taken.has(b.id))
                .map(b => ({ b, d: Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y) }))
                .filter(e => e.d <= GROUP_FORMATION_RADIUS_M)
                .sort((p, q) => p.d - q.d || (p.b.id < q.b.id ? -1 : 1))
                .slice(0, size - 1);
            if (mates.length === 0) continue;
            const g: Group = { id: this.nextGroupId++, members: [a.id, ...mates.map(m => m.b.id)] };
            this.groups.set(g.id, g);
            for (const id of g.members) {
                this.groupOfPerson.set(id, g.id);
                taken.add(id);
                this.considered.add(id);
            }
        }
    }

    /**
     * Formation slot for a follower: abreast of the leader, alternating right
     * and left; members beyond three fall half a step back (U/V shape).
     */
    formationSlot(personId: string, out: Point2D): boolean {
        const g = this.groupOf(personId);
        if (!g) return false;
        const rank = g.members.indexOf(personId);
        if (rank <= 0) return false;
        const li = this.grid.indexOf(g.members[0]);
        if (li < 0) return false;
        const lx = this.grid.px[li];
        const ly = this.grid.py[li];
        const lvx = this.grid.vx[li];
        const lvy = this.grid.vy[li];
        const speed = Math.hypot(lvx, lvy);
        // Heading: leader's motion, or keep facing toward the group when stopped
        let hx = speed > 0.1 ? lvx / speed : 1;
        let hy = speed > 0.1 ? lvy / speed : 0;
        if (speed <= 0.1) {
            const fi = this.grid.indexOf(personId);
            if (fi >= 0) {
                const dx = this.grid.px[fi] - lx;
                const dy = this.grid.py[fi] - ly;
                const d = Math.hypot(dx, dy);
                if (d > 0.2) {
                    // Stand in a loose circle when the group stops to chat
                    out.x = lx + (dx / d) * 0.9;
                    out.y = ly + (dy / d) * 0.9;
                    return true;
                }
            }
            hx = 1;
            hy = 0;
        }
        const side = rank % 2 === 1 ? -1 : 1; // right first
        const slot = Math.ceil(rank / 2);
        const back = rank >= 3 ? 0.45 * (slot - 0) : 0;
        // Right-hand perpendicular of heading (hx, hy) is (hy, -hx)
        out.x = lx + hy * side * slot * ABREAST_SPACING_M - hx * back;
        out.y = ly - hx * side * slot * ABREAST_SPACING_M - hy * back;
        return true;
    }

    /** Distance from each follower to its slot (max), for leaders deciding to wait. */
    groupStraggle(leaderId: string): number {
        const g = this.groupOf(leaderId);
        if (!g || g.members[0] !== leaderId) return 0;
        let worst = 0;
        const slot = { x: 0, y: 0 };
        for (let k = 1; k < g.members.length; k++) {
            const i = this.grid.indexOf(g.members[k]);
            if (i < 0 || !this.formationSlot(g.members[k], slot)) continue;
            worst = Math.max(worst, Math.hypot(this.grid.px[i] - slot.x, this.grid.py[i] - slot.y));
        }
        return worst;
    }

    // ----------------------------------------------------------- destinations

    pickDestination(x: number, y: number, rng: SeededRandom): Poi {
        this.planner.ensure(this.env, this.envVersion);
        return this.planner.pick(x, y, rng, this.env);
    }

    // --------------------------------------------------------------- steering

    /** Local crowd density (persons / m²) within 2 m. */
    localDensity(index: number, x: number, y: number): number {
        const n = this.grid.query(x, y, 2, index, STEERING.MAX_NEIGHBORS, this.nbrIdx, this.nbrD2);
        return (n + 1) / (Math.PI * 4);
    }

    /**
     * Total steering acceleration for one agent: goal relaxation, anticipatory
     * avoidance of neighbours, personal space and wall clearance.
     */
    steer(input: SteeringInput, out: Vec): Vec {
        const { index, px, py, vx, vy } = input;
        out.x = (input.desiredVx - vx) / STEERING.TAU_RELAX;
        out.y = (input.desiredVy - vy) / STEERING.TAU_RELAX;

        const n = this.grid.query(px, py, STEERING.NEIGHBOR_RADIUS, index, STEERING.MAX_NEIGHBORS, this.nbrIdx, this.nbrD2);
        const g = this.grid;
        for (let k = 0; k < n; k++) {
            const j = this.nbrIdx[k];
            const sameGroup = input.groupId > 0 && this.groupOfPerson.get(g.ids[j]) === input.groupId;
            if (input.avoidance > 0) {
                anticipatoryForce(px, py, vx, vy, g.px[j], g.py[j], g.vx[j], g.vy[j], _f);
                const s = input.avoidance * (sameGroup ? 0.35 : 1);
                out.x += _f.x * s;
                out.y += _f.y * s;
            }
            const d = Math.sqrt(this.nbrD2[k]);
            personalSpaceForce(px - g.px[j], py - g.py[j], d, _f);
            const ps = sameGroup ? 0.45 : 1;
            out.x += _f.x * ps;
            out.y += _f.y * ps;
        }

        const wd = this.env.nearestWall(px, py, STEERING.WALL_RANGE, _wall);
        if (Number.isFinite(wd)) {
            wallForce(_wall.x, _wall.y, wd, _f);
            out.x += _f.x;
            out.y += _f.y;
        }
        return clampLength(out, STEERING.MAX_ACCEL);
    }

    /** Effective preferred speed after crowding slowdown (Weidmann). */
    crowdedSpeed(prefSpeed: number, index: number, x: number, y: number): number {
        return prefSpeed * densitySpeedFactor(this.localDensity(index, x, y));
    }
}
