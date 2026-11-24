/**
 * Pedestrian steering model (pure, headless).
 *
 * Combines three well-established pedestrian-dynamics terms into one
 * acceleration:
 *  1. Goal relaxation (Helbing & Molnár 1995): accelerate toward the desired
 *     velocity with relaxation time τ ≈ 0.5 s.
 *  2. Anticipatory avoidance via time-to-collision (Karamouzas, Skinner & Guy
 *     2014, "Universal power law governing pedestrian interactions"):
 *     interaction energy ∝ e^(−τ/τ₀)/τ², so people sidestep early and gently
 *     instead of bumping.
 *  3. Short-range personal-space and wall repulsion (social-force
 *     exponentials) that only matter in contact / dense situations.
 *
 * Walking speed follows Weidmann's (1993) fundamental diagram: free speed
 * ~1.34 m/s, slowing as local density rises.
 */

export const STEERING = {
    /** Body radius (m); shoulder width ≈ 0.5 m. */
    RADIUS: 0.25,
    /** Relaxation time toward desired velocity (s). */
    TAU_RELAX: 0.5,
    /** Anticipation horizon for time-to-collision avoidance (s). */
    TTC_HORIZON: 4,
    /** Power-law strength k and exponential cutoff τ₀ (Karamouzas et al. 2014). */
    TTC_K: 1.5,
    TTC_TAU0: 3,
    /** Max avoidance acceleration from a single neighbour (m/s²). */
    TTC_MAX: 5,
    /** Fraction of the avoidance force allowed to act as braking (rest is swerve). */
    TTC_BRAKE_SHARE: 0.45,
    /** Personal-space repulsion: A·exp((R − d)/B). */
    PERSONAL_A: 2.5,
    PERSONAL_B: 0.22,
    PERSONAL_R: 0.75,
    /** Wall repulsion: Aw·exp((Rw − d)/Bw). */
    WALL_A: 4,
    WALL_B: 0.18,
    WALL_R: 0.4,
    WALL_RANGE: 1.4,
    /** Hard cap on total steering acceleration (m/s²). */
    MAX_ACCEL: 6,
    /** Neighbour search radius (m) and max neighbours considered. */
    NEIGHBOR_RADIUS: 5,
    MAX_NEIGHBORS: 12,
} as const;

export interface Vec {
    x: number;
    y: number;
}

/** Weidmann (1993) speed–density relation; ρ in persons/m². */
export function densitySpeedFactor(density: number): number {
    if (density <= 0.05) return 1;
    const f = 1 - Math.exp(-1.913 * (1 / density - 1 / 5.4));
    return Math.max(0.12, Math.min(1, f));
}

/**
 * Time until two discs (combined radius R) touch, given relative position
 * x = pj − pi and relative velocity v = vj − vi. Infinity when they never
 * meet; 0 when already overlapping.
 */
export function timeToCollision(xx: number, xy: number, vx: number, vy: number, R: number): number {
    const c = xx * xx + xy * xy - R * R;
    if (c < 0) return 0;
    const a = vx * vx + vy * vy;
    if (a < 1e-9) return Infinity;
    const b = xx * vx + xy * vy;
    if (b >= 0) return Infinity; // moving apart
    const disc = b * b - a * c;
    if (disc <= 0) return Infinity;
    const tau = (-b - Math.sqrt(disc)) / a;
    return tau > 0 ? tau : Infinity;
}

/**
 * Avoidance acceleration on agent i from neighbour j (anticipatory power
 * law). Pushes i away from where the two would touch.
 */
export function anticipatoryForce(
    pix: number,
    piy: number,
    vix: number,
    viy: number,
    pjx: number,
    pjy: number,
    vjx: number,
    vjy: number,
    out: Vec
): Vec {
    out.x = 0;
    out.y = 0;
    const R = STEERING.RADIUS * 2;
    const xx = pjx - pix;
    const xy = pjy - piy;
    const rvx = vjx - vix;
    const rvy = vjy - viy;
    const tau = timeToCollision(xx, xy, rvx, rvy, R);
    if (!Number.isFinite(tau) || tau <= 0 || tau > STEERING.TTC_HORIZON) return out;
    // Relative position at the moment of contact (from i toward j)
    let dx = xx + rvx * tau;
    let dy = xy + rvy * tau;
    let len = Math.hypot(dx, dy);
    if (len < 1e-6) {
        // Perfectly head-on: deterministic sidestep to the right of i's motion
        dx = viy;
        dy = -vix;
        len = Math.hypot(dx, dy) || 1;
    }
    let mag = (STEERING.TTC_K * Math.exp(-tau / STEERING.TTC_TAU0)) / (tau * tau);
    if (mag > STEERING.TTC_MAX) mag = STEERING.TTC_MAX;
    let fx = (-dx / len) * mag;
    let fy = (-dy / len) * mag;

    // Pedestrians resolve conflicts by swerving rather than stopping
    // (Moussaïd et al. 2011): damp the braking component along the walking
    // direction and, for near head-on conflicts, add a keep-right sidestep.
    const speed = Math.hypot(vix, viy);
    if (speed > 0.1) {
        const ux = vix / speed;
        const uy = viy / speed;
        const along = fx * ux + fy * uy;
        let latX = fx - along * ux;
        let latY = fy - along * uy;
        const latMag = Math.hypot(latX, latY);
        if (latMag < mag * 0.5) {
            // Right-hand side of the heading (ux, uy) is (uy, −ux)
            const extra = mag * 0.5 - latMag;
            const sx = latMag > 1e-6 ? latX / latMag : uy;
            const sy = latMag > 1e-6 ? latY / latMag : -ux;
            latX += sx * extra;
            latY += sy * extra;
        }
        const brake = along < 0 ? along * STEERING.TTC_BRAKE_SHARE : along;
        fx = ux * brake + latX;
        fy = uy * brake + latY;
    }
    out.x = fx;
    out.y = fy;
    return out;
}

/** Short-range personal-space repulsion from a neighbour at distance d. */
export function personalSpaceForce(dx: number, dy: number, d: number, out: Vec): Vec {
    // dx, dy: vector from neighbour to self
    out.x = 0;
    out.y = 0;
    if (d > STEERING.PERSONAL_R * 2 || d < 1e-6) return out;
    const mag = STEERING.PERSONAL_A * Math.exp((STEERING.PERSONAL_R - d) / STEERING.PERSONAL_B);
    out.x = (dx / d) * Math.min(mag, 8);
    out.y = (dy / d) * Math.min(mag, 8);
    return out;
}

/** Wall repulsion given the vector from the closest wall point to the agent. */
export function wallForce(dx: number, dy: number, d: number, out: Vec): Vec {
    out.x = 0;
    out.y = 0;
    if (d > STEERING.WALL_RANGE || d < 1e-6) return out;
    const mag = Math.min(10, STEERING.WALL_A * Math.exp((STEERING.WALL_R - d) / STEERING.WALL_B));
    out.x = (dx / d) * mag;
    out.y = (dy / d) * mag;
    return out;
}

/** Clamp a vector's length in place. */
export function clampLength(v: Vec, max: number): Vec {
    const l = Math.hypot(v.x, v.y);
    if (l > max) {
        v.x = (v.x / l) * max;
        v.y = (v.y / l) * max;
    }
    return v;
}

/** Normal-distributed sample (Box–Muller) from a uniform source. */
export function gaussian(next: () => number, mean: number, sd: number): number {
    const u = Math.max(1e-9, next());
    const v = next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
