/**
 * BuildingHeights
 * Derives a roof height (meters) for each OSM building footprint.
 *
 * Priority follows the OSM Simple 3D Buildings convention
 * (https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings):
 *   1. `height=*` tag (meters; also accepts "12 m", "40'" feet).
 *   2. `building:levels=*` × typical storey height (+ roof allowance).
 *   3. Deterministic estimate seeded by OSM id / footprint so reloads are stable.
 *
 * Pure and headless; no DOM / storage access.
 */

import { BuildingHeightSource, Point2D } from './types';

/** Typical floor-to-floor height in meters (OSM 3D convention uses ~3 m). */
export const STOREY_HEIGHT_M = 3.2;
/** Small allowance for parapets / roof slabs on level-derived heights. */
const ROOF_ALLOWANCE_M = 1.0;
const MIN_HEIGHT_M = 3;
const MAX_HEIGHT_M = 600;

/** Default heights for common `building=*` values when no tags are present. */
const TYPE_BASE_HEIGHT: Record<string, [number, number]> = {
    house: [6, 9],
    detached: [6, 9],
    residential: [12, 24],
    apartments: [15, 36],
    commercial: [12, 30],
    office: [18, 48],
    retail: [5, 10],
    industrial: [7, 14],
    warehouse: [7, 12],
    garage: [3, 4],
    garages: [3, 4],
    shed: [3, 4],
    roof: [4, 6],
    church: [14, 26],
    cathedral: [25, 45],
    school: [9, 14],
    university: [12, 24],
    hospital: [15, 30],
    hotel: [18, 50],
    train_station: [10, 18],
    kiosk: [3, 4],
};
const DEFAULT_RANGE: [number, number] = [9, 24];

export interface BuildingHeightResult {
    height: number;
    source: BuildingHeightSource;
}

/** Parse an OSM length value into meters (supports "12", "12.5 m", "40 ft", "40'"). */
export function parseOsmLength(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toLowerCase().replace(',', '.');
    const match = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?|ft|feet|')?$/);
    if (!match) return null;
    let value = parseFloat(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = match[2];
    if (unit === 'ft' || unit === 'feet' || unit === "'") value *= 0.3048;
    return value;
}

/** FNV-1a string hash → [0, 1). Deterministic across runs and platforms. */
export function hashUnit(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) / 4294967296;
}

/** Shoelace polygon area in m². */
export function polygonArea(vertices: Point2D[]): number {
    let a = 0;
    for (let i = 0, n = vertices.length; i < n; i++) {
        const p = vertices[i];
        const q = vertices[(i + 1) % n];
        a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) * 0.5;
}

const clampHeight = (h: number): number => Math.min(MAX_HEIGHT_M, Math.max(MIN_HEIGHT_M, h));

/**
 * Resolve a building's roof height from OSM properties, falling back to a
 * deterministic estimate based on building type and footprint area.
 */
export function resolveBuildingHeight(
    properties: Record<string, unknown> | undefined,
    vertices: Point2D[],
    stableKey: string
): BuildingHeightResult {
    const props = properties ?? {};

    const tagged = parseOsmLength(props.height);
    if (tagged !== null) {
        return { height: clampHeight(tagged), source: 'tag' };
    }

    const levels = parseOsmLength(props.levels ?? props['building:levels']);
    if (levels !== null) {
        return {
            height: clampHeight(levels * STOREY_HEIGHT_M + ROOF_ALLOWANCE_M),
            source: 'levels',
        };
    }

    const type = typeof props.building === 'string' ? props.building : 'yes';
    const [lo, hi] = TYPE_BASE_HEIGHT[type] ?? DEFAULT_RANGE;
    // Larger footprints in dense cores trend taller; tiny footprints are sheds / kiosks.
    const area = polygonArea(vertices);
    const areaFactor = area < 40 ? 0.45 : area < 120 ? 0.8 : area > 2500 ? 1.25 : 1.0;
    const t = hashUnit(stableKey);
    const raw = (lo + (hi - lo) * t) * areaFactor;
    // Snap to whole storeys so procedural window rows line up with the roof.
    const storeys = Math.max(1, Math.round(raw / STOREY_HEIGHT_M));
    return { height: clampHeight(storeys * STOREY_HEIGHT_M), source: 'estimate' };
}
