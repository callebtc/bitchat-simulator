import { BitchatDevice } from './BitchatDevice';
import { Point, Vector2 } from './types';
import { LogManager } from './LogManager';
import { EnvironmentManager, PathFinder, PathResult } from './environment';
import { SeededRandom } from './SeededRandom';
import { CrowdManager, GROUP_SPEED_FACTOR } from './crowd/CrowdManager';
import { DWELL_S, PoiKind } from './crowd/Destinations';
import { STEERING, Vec, gaussian } from './crowd/Steering';

export enum MovementMode {
    STILL = 'STILL',
    /** Destination-driven strolling: picks shops, plazas, sidewalks; lingers; walks in groups. */
    RANDOM_WALK = 'RANDOM_WALK',
    TARGET = 'TARGET',
    /** Errands: indoors roams within its building, outdoors visits destinations alone. */
    BUSY = 'BUSY',
    MANUAL = 'MANUAL',
}

/** Callback for when a path is calculated */
export type PathCalculatedCallback = (path: Point[], target: Point) => void;

/** What a pedestrian is currently doing (for UI / inspection). */
export type Activity = 'idle' | 'walking' | 'dwelling' | 'following';

const WAYPOINT_REACHED_M = 1.6;
const ARRIVAL_M = 0.8;
const PROGRESS_WINDOW_S = 3;
const PROGRESS_MIN_M = 0.6;
/** Followers further than this from their slot navigate (pathfind) to the leader. */
const FOLLOW_REJOIN_M = 14;
/** Leaders slow to a stroll when a follower lags further than this. */
const GROUP_WAIT_M = 3;

const _acc: Vec = { x: 0, y: 0 };
const _slot: Point = { x: 0, y: 0 };

/**
 * A pedestrian carrying a BitChat device.
 *
 * Movement pipeline per tick: decide a desired velocity (navigation along a
 * visibility-graph path, group formation, or dwelling) → crowd steering
 * (anticipatory avoidance of nearby people, personal space, wall clearance;
 * see `crowd/Steering.ts`) → integrate with hard wall collision.
 * Free walking speed is drawn per person from N(1.34, 0.26) m/s (Weidmann).
 */
export class BitchatPerson {
    id: string;
    position: Point;
    velocity: Vector2;
    device: BitchatDevice;
    logger?: LogManager;

    /** Environment reference for collision detection (set by SimulationEngine) */
    environment?: EnvironmentManager;
    /** PathFinder reference (set by SimulationEngine) */
    pathFinder?: PathFinder;
    /** Shared crowd context: neighbours, destinations, groups (set by SimulationEngine) */
    crowd?: CrowdManager;

    mode: MovementMode = MovementMode.STILL;
    target: Point | null = null;
    /** Current path waypoints */
    path: Point[] | null = null;
    /** Index of current waypoint being navigated to */
    currentWaypointIndex: number = 0;
    /** Callback when path is calculated (for UI animation) */
    onPathCalculated?: PathCalculatedCallback;

    /** Preferred free walking speed (m/s). */
    prefSpeed: number;
    /** Facing direction (radians, math convention), smoothed from motion. */
    heading: number = 0;
    activity: Activity = 'idle';
    /** Kind of place currently heading to / lingering at. */
    destinationKind: PoiKind | null = null;

    private dwellTimer = 0;
    private pendingDwell = 0;
    private progressTimer = 0;
    private progressAnchor: Point = { x: 0, y: 0 };
    private stuckCount = 0;
    private followReplanTimer = 0;
    /** Building the agent is busy inside (null if outdoors). */
    private busyBuildingId: string | null = null;
    private desired: Vec = { x: 0, y: 0 };
    private rng: SeededRandom;

    constructor(id: string, position: Point, device: BitchatDevice, rng?: SeededRandom) {
        this.id = id;
        this.position = position;
        this.velocity = { x: 0, y: 0 };
        this.device = device;
        this.device.position = this.position; // Link position
        this.rng = rng ?? device.rng.fork(`person:${id}`);
        this.prefSpeed = this.samplePrefSpeed();
    }

    setRng(rng: SeededRandom): void {
        this.rng = rng;
        this.prefSpeed = this.samplePrefSpeed();
    }

    private samplePrefSpeed(): number {
        return Math.min(1.8, Math.max(0.8, gaussian(() => this.rng.next(), 1.34, 0.26)));
    }

    /** Crowd snapshot hooks (see CrowdAgent). */
    get wantsGroup(): boolean {
        return this.mode === MovementMode.RANDOM_WALK;
    }

    setLogger(logger: LogManager) {
        this.logger = logger;
        this.device.setLogger(logger);
    }

    setMode(mode: MovementMode) {
        const previous = this.mode;
        this.mode = mode;
        this.dwellTimer = 0;
        this.stuckCount = 0;
        this.resetProgress();
        if (mode !== MovementMode.RANDOM_WALK) this.crowd?.leaveGroup(this.id);
        else if (previous !== MovementMode.RANDOM_WALK) this.crowd?.reconsider(this.id);

        if (mode === MovementMode.STILL) {
            this.velocity = { x: 0, y: 0 };
            this.activity = 'idle';
        } else if (mode === MovementMode.RANDOM_WALK) {
            this.clearNavigation();
            this.activity = 'walking';
        } else if (mode === MovementMode.BUSY) {
            this.clearNavigation();
            this.busyBuildingId = this.environment?.isInsideBuilding(this.position)?.id ?? null;
            this.activity = 'walking';
        }
    }

    setTarget(p: Point) {
        if (!this.planPath(p, false, true)) return;
        this.crowd?.leaveGroup(this.id);
        this.mode = MovementMode.TARGET;
        this.destinationKind = null;
        this.dwellTimer = 0;
        this.stuckCount = 0;
        this.activity = 'walking';
        if (this.path && this.onPathCalculated) {
            this.onPathCalculated(this.path, p);
        }
    }

    setVelocity(v: Vector2) {
        this.velocity = v;
        this.mode = MovementMode.MANUAL;
        this.crowd?.leaveGroup(this.id);
    }

    /** Remaining path including the current position (for visualization). */
    getRemainingPath(): Point[] | null {
        if (!this.path || this.currentWaypointIndex >= this.path.length) return null;
        return [{ x: this.position.x, y: this.position.y }, ...this.path.slice(this.currentWaypointIndex)];
    }

    // ------------------------------------------------------------------ update

    update(dt: number) {
        if (this.mode === MovementMode.STILL) {
            this.velocity = { x: 0, y: 0 };
            return;
        }
        if (this.mode === MovementMode.MANUAL) {
            this.integrate(dt);
            return;
        }

        let avoidance = 1;
        if (this.mode === MovementMode.TARGET) {
            if (this.navigate(this.prefSpeed)) {
                this.velocity = { x: 0, y: 0 };
                this.mode = MovementMode.STILL;
                this.activity = 'idle';
                this.clearNavigation();
                return;
            }
        } else if (this.mode === MovementMode.RANDOM_WALK) {
            avoidance = this.updateStroll(dt);
        } else if (this.mode === MovementMode.BUSY) {
            avoidance = this.updateErrands(dt);
        }

        this.applySteering(dt, avoidance);
        this.integrate(dt);
        this.trackProgress(dt);
    }

    /** Strolling: choose destination → walk → linger; followers keep formation. */
    private updateStroll(dt: number): number {
        const crowd = this.crowd;
        const group = crowd?.groupOf(this.id);
        if (crowd && group && group.members[0] !== this.id) return this.updateFollower(dt, crowd);

        if (this.activity === 'dwelling') {
            this.dwellTimer -= dt;
            this.setDesired(0, 0);
            if (this.dwellTimer > 0) return 0.25;
            this.clearNavigation();
            this.activity = 'walking';
        }
        if (!this.target) this.chooseDestination();
        if (!this.target) {
            this.setDesired(0, 0);
            return 0.5;
        }

        let speed = this.prefSpeed * (group ? GROUP_SPEED_FACTOR : 1);
        if (crowd) {
            const idx = crowd.grid.indexOf(this.id);
            speed = idx >= 0 ? crowd.crowdedSpeed(speed, idx, this.position.x, this.position.y) : speed;
            // Leaders wait for companions who fell behind
            if (group && crowd.groupStraggle(this.id) > GROUP_WAIT_M) speed *= 0.35;
        }
        if (this.navigate(speed)) this.startDwell();
        return 1;
    }

    /** Group member: hold a slot abreast of the leader; rejoin via pathfinding when far. */
    private updateFollower(dt: number, crowd: CrowdManager): number {
        this.activity = 'following';
        if (!crowd.formationSlot(this.id, _slot)) {
            this.setDesired(0, 0);
            return 1;
        }
        const dx = _slot.x - this.position.x;
        const dy = _slot.y - this.position.y;
        const dist = Math.hypot(dx, dy);
        const g = crowd.groupOf(this.id);
        const li = g ? crowd.grid.indexOf(g.members[0]) : -1;
        const lvx = li >= 0 ? crowd.grid.vx[li] : 0;
        const lvy = li >= 0 ? crowd.grid.vy[li] : 0;
        const leaderSpeed = Math.hypot(lvx, lvy);

        if (dist > FOLLOW_REJOIN_M) {
            // Too far to just drift over: walk there properly around buildings
            this.followReplanTimer -= dt;
            if (!this.target || this.followReplanTimer <= 0) {
                this.planPath({ x: _slot.x, y: _slot.y }, false);
                this.followReplanTimer = 3;
            }
            if (this.target) {
                this.navigate(this.prefSpeed * 1.25);
            } else {
                this.setDesired(0, 0);
            }
            return 1;
        }
        this.clearNavigation();
        if (leaderSpeed < 0.1 && dist < 0.6) {
            // Group has stopped: stand and chat
            this.setDesired(0, 0);
            return 0.25;
        }
        // Match the leader's velocity and close the gap to the slot
        const gain = 0.9;
        this.setDesired(lvx + dx * gain, lvy + dy * gain);
        const max = this.prefSpeed * 1.5;
        const s = Math.hypot(this.desired.x, this.desired.y);
        if (s > max) this.setDesired((this.desired.x / s) * max, (this.desired.y / s) * max);
        return 1;
    }

    /** Errands: indoors roam the same building with pauses; outdoors visit destinations alone. */
    private updateErrands(dt: number): number {
        if (this.activity === 'dwelling') {
            this.dwellTimer -= dt;
            this.setDesired(0, 0);
            if (this.dwellTimer > 0) return 0.25;
            this.clearNavigation();
            this.activity = 'walking';
        }
        if (!this.target) {
            if (this.busyBuildingId) {
                for (let attempt = 0; attempt < 4; attempt++) {
                    const p = this.randomPointInBuilding(this.busyBuildingId);
                    if (!p) {
                        this.busyBuildingId = null;
                        break;
                    }
                    if (this.planPath(p)) {
                        this.destinationKind = null;
                        this.pendingDwell = 3 + this.rng.next() * 22;
                        break;
                    }
                }
            }
            if (!this.target) this.chooseDestination();
        }
        if (!this.target) {
            this.setDesired(0, 0);
            return 0.5;
        }
        let speed = this.prefSpeed;
        const crowd = this.crowd;
        if (crowd) {
            const idx = crowd.grid.indexOf(this.id);
            if (idx >= 0) speed = crowd.crowdedSpeed(speed, idx, this.position.x, this.position.y);
        }
        if (this.navigate(speed)) this.startDwell();
        return 1;
    }

    // -------------------------------------------------------------- navigation

    private chooseDestination(): void {
        const maxAttempts = 8;
        if (this.crowd) {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const poi = this.crowd.pickDestination(this.position.x, this.position.y, this.rng);
                if (this.planPath({ x: poi.x, y: poi.y })) {
                    this.destinationKind = poi.kind;
                    const [lo, hi] = DWELL_S[poi.kind];
                    this.pendingDwell = lo + this.rng.next() * (hi - lo);
                    return;
                }
            }
            return;
        }
        // Standalone (no engine): wander to a nearby point
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const ang = this.rng.next() * Math.PI * 2;
            const d = 20 + this.rng.next() * 60;
            const dest = { x: this.position.x + Math.cos(ang) * d, y: this.position.y + Math.sin(ang) * d };
            if (this.planPath(dest)) {
                this.destinationKind = 'sidewalk';
                this.pendingDwell = this.rng.next() * 8;
                return;
            }
        }
    }

    private startDwell(): void {
        this.clearNavigation();
        this.dwellTimer = this.pendingDwell;
        this.activity = this.dwellTimer > 0.5 ? 'dwelling' : 'walking';
        this.setDesired(0, 0);
    }

    /**
     * Compute a visibility-graph path to `p` (straight line only when no buildings exist).
     * Never falls back to an unrouted straight line across buildings when pathfinding fails.
     */
    private planPath(p: Point, notify = true, keepExistingOnFailure = false): boolean {
        const env = this.environment;
        const pf = this.pathFinder;
        if (pf && env && env.getBuildingCount() > 0) {
            if (pf.isBuildingGraph()) {
                if (!keepExistingOnFailure) this.clearNavigation();
                return false;
            }
            const result: PathResult = pf.findPath(
                { x: this.position.x, y: this.position.y },
                { x: p.x, y: p.y }
            );
            if (!result.found || result.waypoints.length < 2) {
                if (!keepExistingOnFailure) this.clearNavigation();
                return false;
            }
            this.target = { x: p.x, y: p.y };
            this.path = result.waypoints.map(wp => ({ x: wp.x, y: wp.y }));
            this.currentWaypointIndex = 1;
            this.resetProgress();
            if (notify && this.onPathCalculated) this.onPathCalculated(this.path, p);
            return true;
        }

        this.target = { x: p.x, y: p.y };
        this.path = null;
        this.currentWaypointIndex = 0;
        this.resetProgress();
        return true;
    }

    private clearNavigation(): void {
        this.target = null;
        this.path = null;
        this.currentWaypointIndex = 0;
    }

    /**
     * Set the desired velocity toward the next waypoint (gently cutting
     * corners toward the one after it). Returns true on arrival.
     */
    private navigate(speed: number): boolean {
        if (!this.target) {
            this.setDesired(0, 0);
            return true;
        }
        const final = this.target;
        let nav = this.path && this.currentWaypointIndex < this.path.length ? this.path[this.currentWaypointIndex] : final;
        let dx = nav.x - this.position.x;
        let dy = nav.y - this.position.y;
        let dist = Math.hypot(dx, dy);
        const isLast = !this.path || this.currentWaypointIndex >= this.path.length - 1;

        if (!isLast && this.path && dist < WAYPOINT_REACHED_M) {
            this.currentWaypointIndex++;
            nav = this.path[this.currentWaypointIndex];
            dx = nav.x - this.position.x;
            dy = nav.y - this.position.y;
            dist = Math.hypot(dx, dy);
        }
        const distFinal = Math.hypot(final.x - this.position.x, final.y - this.position.y);
        if (distFinal < ARRIVAL_M) {
            this.setDesired(0, 0);
            return true;
        }
        if (dist < 1e-6) {
            this.setDesired(0, 0);
            return false;
        }
        let ux = dx / dist;
        let uy = dy / dist;
        // Anticipate the turn: blend toward the following waypoint when close
        if (this.path && this.currentWaypointIndex < this.path.length - 1 && dist < 4) {
            const next = this.path[this.currentWaypointIndex + 1];
            const nx = next.x - this.position.x;
            const ny = next.y - this.position.y;
            const nd = Math.hypot(nx, ny) || 1;
            const w = (1 - dist / 4) * 0.5;
            ux = ux * (1 - w) + (nx / nd) * w;
            uy = uy * (1 - w) + (ny / nd) * w;
            const l = Math.hypot(ux, uy) || 1;
            ux /= l;
            uy /= l;
        }
        // Ease in to the destination
        const s = Math.min(speed, 0.3 + distFinal * 0.8);
        this.setDesired(ux * s, uy * s);
        return false;
    }

    private setDesired(x: number, y: number): void {
        this.desired.x = x;
        this.desired.y = y;
    }

    // ---------------------------------------------------------------- physics

    private applySteering(dt: number, avoidance: number): void {
        const crowd = this.crowd;
        const idx = crowd ? crowd.grid.indexOf(this.id) : -1;
        if (crowd && idx >= 0) {
            crowd.steer(
                {
                    index: idx,
                    px: this.position.x,
                    py: this.position.y,
                    vx: this.velocity.x,
                    vy: this.velocity.y,
                    desiredVx: this.desired.x,
                    desiredVy: this.desired.y,
                    avoidance,
                    groupId: crowd.groupOf(this.id)?.id ?? 0,
                },
                _acc
            );
        } else {
            _acc.x = (this.desired.x - this.velocity.x) / STEERING.TAU_RELAX;
            _acc.y = (this.desired.y - this.velocity.y) / STEERING.TAU_RELAX;
        }
        let vx = this.velocity.x + _acc.x * dt;
        let vy = this.velocity.y + _acc.y * dt;
        const max = Math.min(2.5, this.prefSpeed * 1.6);
        const sp = Math.hypot(vx, vy);
        if (sp > max) {
            vx = (vx / sp) * max;
            vy = (vy / sp) * max;
        }
        // Settle fully when standing (no micro-jitter while lingering)
        if (this.desired.x === 0 && this.desired.y === 0 && sp < 0.05) {
            vx = 0;
            vy = 0;
        }
        this.velocity = { x: vx, y: vy };
        if (sp > 0.15) {
            const h = Math.atan2(vy, vx);
            let d = h - this.heading;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            this.heading += d * Math.min(1, dt * 6);
        }
    }

    /** Move by velocity with hard building collision (slides along walls). */
    private integrate(dt: number): void {
        const newX = this.position.x + this.velocity.x * dt;
        const newY = this.position.y + this.velocity.y * dt;
        if (this.environment && this.environment.getBuildingCount() > 0) {
            const result = this.environment.resolveMovement(
                { x: this.position.x, y: this.position.y },
                { x: newX, y: newY }
            );
            this.position.x = result.position.x;
            this.position.y = result.position.y;
        } else {
            this.position.x = newX;
            this.position.y = newY;
        }
    }

    private resetProgress(): void {
        this.progressTimer = 0;
        this.progressAnchor = { x: this.position.x, y: this.position.y };
    }

    /** Replan when not making headway; give up on a destination after repeats. */
    private trackProgress(dt: number): void {
        const wantsToMove = Math.hypot(this.desired.x, this.desired.y) > 0.3;
        if (!wantsToMove || !this.target) {
            this.resetProgress();
            return;
        }
        this.progressTimer += dt;
        if (this.progressTimer < PROGRESS_WINDOW_S) return;
        const moved = Math.hypot(this.position.x - this.progressAnchor.x, this.position.y - this.progressAnchor.y);
        this.resetProgress();
        if (moved >= PROGRESS_MIN_M) {
            this.stuckCount = 0;
            return;
        }
        this.stuckCount++;
        const target = this.target;
        if (this.stuckCount >= 3) {
            this.stuckCount = 0;
            if (this.mode === MovementMode.TARGET) {
                this.mode = MovementMode.STILL;
                this.activity = 'idle';
                this.velocity = { x: 0, y: 0 };
                this.clearNavigation();
            } else {
                this.clearNavigation(); // pick something else next tick
            }
            return;
        }
        if (!this.planPath(target, false) && this.mode === MovementMode.TARGET) {
            this.mode = MovementMode.STILL;
            this.activity = 'idle';
            this.velocity = { x: 0, y: 0 };
        }
    }

    private randomPointInBuilding(buildingId: string): Point | null {
        const env = this.environment;
        const b = env?.getBuildingById(buildingId);
        if (!env || !b) return null;
        const { minX, maxX, minY, maxY } = b.bounds;
        for (let attempt = 0; attempt < 40; attempt++) {
            const p = { x: minX + this.rng.next() * (maxX - minX), y: minY + this.rng.next() * (maxY - minY) };
            if (env.isInsideBuilding(p)?.id === buildingId) return p;
        }
        return null;
    }
}
