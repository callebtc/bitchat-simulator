/**
 * Destination planning for strolling pedestrians.
 *
 * Real pedestrians don't walk to uniformly random points: they go to shop
 * doors, linger on plazas and in parks, and use sidewalks. With an OSM map
 * loaded we derive points of interest (POIs) from the actual geometry;
 * without one we scatter a few deterministic "hotspots" (cafés, a fountain…)
 * that crowds gather around.
 *
 * Choice model: sample a handful of POIs, weight each by attractiveness ×
 * a distance-decay term (people prefer trips of ~50–300 m), roulette-select.
 */

import { EnvironmentManager, MapContext, Point2D, Building } from '../environment';
import { SeededRandom } from '../SeededRandom';

export type PoiKind = 'entrance' | 'plaza' | 'park' | 'sidewalk' | 'hotspot';

export interface Poi {
    x: number;
    y: number;
    kind: PoiKind;
    /** Relative attractiveness. */
    weight: number;
}

/** Dwell time ranges by destination kind (seconds). */
export const DWELL_S: Record<PoiKind, [number, number]> = {
    entrance: [6, 40], // window shopping, waiting at a door
    plaza: [15, 75],
    park: [20, 90],
    sidewalk: [0, 5], // mostly pass-through
    hotspot: [12, 60],
};

const POI_WEIGHT: Record<PoiKind, number> = {
    entrance: 2.5,
    plaza: 2,
    park: 1.6,
    // Many more sidewalk samples exist than shops / plazas, so keep each light
    sidewalk: 0.3,
    hotspot: 2.2,
};

/** Preferred trip length scale (m) for the distance-decay term. */
const TRIP_SCALE_M = 170;
const MIN_TRIP_M = 18;
const CANDIDATES_PER_PICK = 28;
const SIDEWALK_SPACING_M = 22;
const ENTRANCE_MAX_ROAD_DIST_M = 30;

function closestOnSegment(px: number, py: number, a: Point2D, b: Point2D): { x: number; y: number; d2: number } {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 1e-9 ? ((px - a.x) * ex + (py - a.y) * ey) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = a.x + ex * t;
    const y = a.y + ey * t;
    return { x, y, d2: (px - x) ** 2 + (py - y) ** 2 };
}

function signedArea(v: Point2D[]): number {
    let a = 0;
    for (let i = 0; i < v.length; i++) {
        const p = v[i];
        const q = v[(i + 1) % v.length];
        a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
}

/** Door: the facade edge nearest a road, offset 1.2 m outward from its midpoint. */
function entranceFor(b: Building, ctx: MapContext): Point2D | null {
    const v = signedArea(b.vertices) >= 0 ? b.vertices : [...b.vertices].reverse();
    let best: Point2D | null = null;
    let bestD2 = ENTRANCE_MAX_ROAD_DIST_M ** 2;
    for (let i = 0; i < v.length; i++) {
        const a = v[i];
        const c = v[(i + 1) % v.length];
        const len = Math.hypot(c.x - a.x, c.y - a.y);
        if (len < 3) continue;
        const mx = (a.x + c.x) / 2;
        const my = (a.y + c.y) / 2;
        for (const road of ctx.roads) {
            for (let k = 0; k < road.points.length - 1; k++) {
                const q = closestOnSegment(mx, my, road.points[k], road.points[k + 1]);
                if (q.d2 < bestD2) {
                    bestD2 = q.d2;
                    // Outward normal of a CCW ring is (dy, -dx)
                    best = { x: mx + ((c.y - a.y) / len) * 1.2, y: my + (-(c.x - a.x) / len) * 1.2 };
                }
            }
        }
    }
    return best;
}

export class DestinationPlanner {
    private pois: Poi[] = [];
    private version = -1;

    constructor(private readonly rng: SeededRandom) {}

    /** Rebuild POIs when the environment changed (`version` bumps on load/clear). */
    ensure(env: EnvironmentManager, version: number): void {
        if (version === this.version) return;
        this.version = version;
        this.pois = this.extract(env);
    }

    getPois(): ReadonlyArray<Poi> {
        return this.pois;
    }

    private extract(env: EnvironmentManager): Poi[] {
        const pois: Poi[] = [];
        const ctx = env.getMapContext();
        const outside = (p: Point2D) => !env.isInsideBuilding(p);

        if (env.getBuildingCount() === 0 && ctx.roads.length === 0) {
            // Open field: a few gathering spots around the origin
            const r = this.rng.fork('hotspots');
            for (let i = 0; i < 8; i++) {
                const ang = r.next() * Math.PI * 2;
                const dist = 30 + r.next() * 220;
                pois.push({ x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, kind: 'hotspot', weight: POI_WEIGHT.hotspot });
            }
            return pois;
        }

        // Sidewalks: both curbs of drivable roads, plus footways themselves
        for (const road of ctx.roads) {
            const off = road.roadClass === 'footway' ? 0 : road.width / 2 + 1.6;
            let carry = 0;
            for (let k = 0; k < road.points.length - 1; k++) {
                const a = road.points[k];
                const b = road.points[k + 1];
                const len = Math.hypot(b.x - a.x, b.y - a.y);
                if (len < 1e-3) continue;
                const ux = (b.x - a.x) / len;
                const uy = (b.y - a.y) / len;
                for (let d = SIDEWALK_SPACING_M - carry; d < len; d += SIDEWALK_SPACING_M) {
                    for (const side of off > 0 ? [1, -1] : [0]) {
                        const p = { x: a.x + ux * d - uy * off * side, y: a.y + uy * d + ux * off * side };
                        if (outside(p)) pois.push({ ...p, kind: 'sidewalk', weight: POI_WEIGHT.sidewalk });
                    }
                }
                carry = (carry + len) % SIDEWALK_SPACING_M;
            }
        }

        // Plazas and parks: a few interior samples each
        for (const area of ctx.areas) {
            if (area.kind === 'water') continue;
            const kind: PoiKind = area.kind === 'park' ? 'park' : 'plaza';
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const v of area.vertices) {
                minX = Math.min(minX, v.x);
                minY = Math.min(minY, v.y);
                maxX = Math.max(maxX, v.x);
                maxY = Math.max(maxY, v.y);
            }
            const samples = Math.min(6, 1 + Math.floor(((maxX - minX) * (maxY - minY)) / 1500));
            let placed = 0;
            for (let attempt = 0; attempt < samples * 6 && placed < samples; attempt++) {
                const p = { x: minX + this.rng.next() * (maxX - minX), y: minY + this.rng.next() * (maxY - minY) };
                if (pointInRing(p, area.vertices) && outside(p)) {
                    pois.push({ ...p, kind, weight: POI_WEIGHT[kind] });
                    placed++;
                }
            }
        }

        // Building entrances facing a nearby road
        if (ctx.roads.length > 0) {
            for (const b of env.getBuildings()) {
                const door = entranceFor(b, ctx);
                if (door && outside(door)) pois.push({ ...door, kind: 'entrance', weight: POI_WEIGHT.entrance });
            }
        }
        return pois;
    }

    /**
     * Pick a destination for an agent at (x, y). Falls back to a nearby random
     * outdoor point when no POIs exist.
     */
    pick(x: number, y: number, rng: SeededRandom, env: EnvironmentManager): Poi {
        const pois = this.pois;
        if (pois.length > 0) {
            let total = 0;
            const picks: Poi[] = [];
            const weights: number[] = [];
            for (let i = 0; i < CANDIDATES_PER_PICK; i++) {
                const p = pois[Math.floor(rng.next() * pois.length)];
                const d = Math.hypot(p.x - x, p.y - y);
                const w = p.weight * Math.exp(-d / TRIP_SCALE_M) * (d < MIN_TRIP_M ? 0.08 : 1);
                picks.push(p);
                weights.push(w);
                total += w;
            }
            let r = rng.next() * total;
            for (let i = 0; i < picks.length; i++) {
                r -= weights[i];
                if (r <= 0) return jitter(picks[i], rng);
            }
            return jitter(picks[picks.length - 1], rng);
        }
        for (let attempt = 0; attempt < 20; attempt++) {
            const ang = rng.next() * Math.PI * 2;
            const d = 40 + rng.next() * 160;
            const p = { x: x + Math.cos(ang) * d, y: y + Math.sin(ang) * d };
            if (!env.isInsideBuilding(p)) return { ...p, kind: 'sidewalk', weight: 1 };
        }
        return { x, y, kind: 'sidewalk', weight: 1 };
    }
}

/** Spread arrivals around a POI so crowds don't stack on one pixel. */
function jitter(p: Poi, rng: SeededRandom): Poi {
    const spread = p.kind === 'plaza' || p.kind === 'park' || p.kind === 'hotspot' ? 6 : 1.2;
    const ang = rng.next() * Math.PI * 2;
    const r = Math.sqrt(rng.next()) * spread;
    return { ...p, x: p.x + Math.cos(ang) * r, y: p.y + Math.sin(ang) * r };
}

function pointInRing(p: Point2D, ring: Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}
