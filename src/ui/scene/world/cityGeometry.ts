import * as THREE from 'three';

import { Building, Point2D } from '../../../simulation/environment';
import { hashUnit } from '../../../simulation/environment/BuildingHeights';

/**
 * Builds merged GPU geometry for every building footprint, extruded to its
 * resolved roof height. Geometry is authored in simulation space (z-up) and
 * rendered under `SimRoot`.
 *
 * Attributes
 *  - position / normal : flat-shaded walls and roofs
 *  - color             : per-building facade (walls) or roof tint
 *  - aFacade (vec4)    : u = meters along the wall, v = meters above local
 *                        ground (negative for the plinth sunk into slopes,
 *                        ROOF_SENTINEL marks roofs), z = roof height above
 *                        ground, w = per-building seed in [0, 1)
 *
 * The facade attributes drive the procedural window shader in
 * `buildingMaterial.ts`, so a 2,000-building city is one draw call for
 * volumes plus one for crisp architectural edges.
 */

const FACADE_PALETTE = [
    0xb3b0aa, // concrete
    0xcdb89a, // sandstone
    0x9a614c, // brick
    0x7d8794, // slate
    0xdcd8d0, // white render
    0x95a1ad, // steel
    0xc09a7f, // terracotta wash
    0xa9a28f, // limestone
];
const GLASS_FACADE = 0x6d8fae;
const ROOF_PALETTE = [0x6c6f74, 0x7a7c80, 0x6f6660, 0x646d72, 0x8a8a86];

/** `aFacade.y` value flagging roof fragments (walls are always > this). */
export const ROOF_SENTINEL = -1000;
/** Walls extend this far below the lowest footprint ground point so slopes never show a gap. */
const PLINTH_DEPTH_M = 2.5;

/** Minimum corner turn (radians) that earns a vertical edge line. */
const CORNER_EDGE_MIN_TURN = 0.35;

export interface CityGeometry {
    volumes: THREE.BufferGeometry;
    edges: THREE.BufferGeometry;
    buildingCount: number;
    maxHeight: number;
}

function signedArea(v: Point2D[]): number {
    let a = 0;
    for (let i = 0, n = v.length; i < n; i++) {
        const p = v[i];
        const q = v[(i + 1) % n];
        a += p.x * q.y - q.x * p.y;
    }
    return a * 0.5;
}

class GeometryWriter {
    positions: number[] = [];
    normals: number[] = [];
    colors: number[] = [];
    facade: number[] = [];

    vertex(
        x: number,
        y: number,
        z: number,
        nx: number,
        ny: number,
        nz: number,
        c: THREE.Color,
        u: number,
        v: number,
        top: number,
        seed: number
    ): void {
        this.positions.push(x, y, z);
        this.normals.push(nx, ny, nz);
        this.colors.push(c.r, c.g, c.b);
        this.facade.push(u, v, top, seed);
    }
}

const _c = new THREE.Color();
const _roof = new THREE.Color();

export function buildCityGeometry(
    buildings: Building[],
    groundBase: (b: Building) => number = () => 0
): CityGeometry {
    const w = new GeometryWriter();
    const edges: number[] = [];
    let maxHeight = 0;
    let count = 0;

    for (let bi = 0; bi < buildings.length; bi++) {
        const b = buildings[bi];
        const src = b.vertices;
        const n = src.length;
        if (n < 3) continue;

        const height = b.height ?? 12;
        if (height > maxHeight) maxHeight = height;
        const base = groundBase(b);
        // Volumes starting above ground (overhangs, bridges, upper parts) get an
        // underside instead of a plinth sunk into the terrain.
        const minHeight = Math.min(b.minHeight ?? 0, height - 0.5);
        const floating = minHeight > 0.05;
        const bottom = floating ? base + minHeight : base - (base !== 0 ? PLINTH_DEPTH_M : 0);
        const top = base + height;
        const vBottom = bottom - base;
        count++;

        const seed = hashUnit(b.id + ':' + n);
        const isTower = height > 34 && seed < 0.65;
        _c.setHex(isTower ? GLASS_FACADE : FACADE_PALETTE[Math.floor(seed * FACADE_PALETTE.length)]);
        // Subtle per-building brightness variation keeps blocks from looking cloned
        _c.multiplyScalar(0.88 + hashUnit(b.id) * 0.24);
        _c.convertSRGBToLinear();
        _roof.setHex(ROOF_PALETTE[Math.floor(hashUnit(b.id + 'r') * ROOF_PALETTE.length)]);
        _roof.convertSRGBToLinear();

        // Outer ring counter-clockwise, courtyard rings clockwise: then the
        // building's outward wall normal is always (dy, -dx) for every ring.
        const verts = signedArea(src) >= 0 ? src : [...src].reverse();
        const holes = (b.holes ?? [])
            .filter(h => h.length >= 3)
            .map(h => (signedArea(h) <= 0 ? h : [...h].reverse()));
        const showUnderside = floating && !b.stacked;
        const edgeBase = floating ? bottom : base + 0.05;

        // --- Walls (outer facade + courtyard facades) ---
        for (const ring of [verts, ...holes]) {
            const rn = ring.length;
            let u = 0;
            for (let i = 0; i < rn; i++) {
                const a = ring[i];
                const c = ring[(i + 1) % rn];
                const dx = c.x - a.x;
                const dy = c.y - a.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len < 1e-3) continue;
                const nx = dy / len;
                const ny = -dx / len;
                const u0 = u;
                const u1 = u + len;
                // Two CCW triangles seen from outside: a0, c0, c1  and  a0, c1, a1
                w.vertex(a.x, a.y, bottom, nx, ny, 0, _c, u0, vBottom, height, seed);
                w.vertex(c.x, c.y, bottom, nx, ny, 0, _c, u1, vBottom, height, seed);
                w.vertex(c.x, c.y, top, nx, ny, 0, _c, u1, height, height, seed);
                w.vertex(a.x, a.y, bottom, nx, ny, 0, _c, u0, vBottom, height, seed);
                w.vertex(c.x, c.y, top, nx, ny, 0, _c, u1, height, height, seed);
                w.vertex(a.x, a.y, top, nx, ny, 0, _c, u0, height, height, seed);
                // Snap window bays so they restart on each wall at a consistent phase
                u = Math.ceil(u1 / 3.0) * 3.0;

                // Roof + base outline edges
                edges.push(a.x, a.y, top, c.x, c.y, top);
                edges.push(a.x, a.y, edgeBase, c.x, c.y, edgeBase);
            }

            // Vertical corner edges only where the outline actually turns
            for (let i = 0; i < rn; i++) {
                const prev = ring[(i - 1 + rn) % rn];
                const cur = ring[i];
                const next = ring[(i + 1) % rn];
                const a1 = Math.atan2(cur.y - prev.y, cur.x - prev.x);
                const a2 = Math.atan2(next.y - cur.y, next.x - cur.x);
                let turn = Math.abs(a2 - a1);
                if (turn > Math.PI) turn = 2 * Math.PI - turn;
                if (turn >= CORNER_EDGE_MIN_TURN) {
                    edges.push(cur.x, cur.y, edgeBase, cur.x, cur.y, top);
                }
            }
        }

        // --- Roof cap (courtyards cut out) ---
        const contour = verts.map(p => new THREE.Vector2(p.x, p.y));
        const holeContours = holes.map(h => h.map(p => new THREE.Vector2(p.x, p.y)));
        const all = holes.length ? verts.concat(...holes) : verts;
        const faces = THREE.ShapeUtils.triangulateShape(contour, holeContours);
        for (let fi = 0; fi < faces.length; fi++) {
            let [ia, ib, ic] = faces[fi];
            const pa = all[ia];
            const pb = all[ib];
            const pc = all[ic];
            const cross = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
            if (cross < 0) {
                const t = ib;
                ib = ic;
                ic = t;
            }
            for (const idx of [ia, ib, ic]) {
                const p = all[idx];
                w.vertex(p.x, p.y, top, 0, 0, 1, _roof, p.x, ROOF_SENTINEL, height, seed);
            }
            if (showUnderside) {
                // Underside (reversed winding, facing down) for overhangs / bridges
                for (const idx of [ia, ic, ib]) {
                    const p = all[idx];
                    w.vertex(p.x, p.y, bottom, 0, 0, -1, _roof, p.x, ROOF_SENTINEL, height, seed);
                }
            }
        }
    }

    const volumes = new THREE.BufferGeometry();
    volumes.setAttribute('position', new THREE.Float32BufferAttribute(w.positions, 3));
    volumes.setAttribute('normal', new THREE.Float32BufferAttribute(w.normals, 3));
    volumes.setAttribute('color', new THREE.Float32BufferAttribute(w.colors, 3));
    volumes.setAttribute('aFacade', new THREE.Float32BufferAttribute(w.facade, 4));
    volumes.computeBoundingSphere();

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
    edgeGeo.computeBoundingSphere();

    return { volumes, edges: edgeGeo, buildingCount: count, maxHeight };
}
