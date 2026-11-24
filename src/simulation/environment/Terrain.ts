/**
 * Terrain
 * Headless heightfield utilities for ground elevation in local meters.
 *
 * Elevation source: Mapzen / AWS "Terrarium" DEM tiles (public, no key),
 * where height_m = R·256 + G + B/256 − 32768. Tiles use Web-Mercator
 * slippy-map addressing; max zoom 15 (~3–5 m per pixel at mid latitudes).
 *
 * Elevation is currently render-only (people, buildings and roads drape on
 * it); RF propagation remains a 2D model.
 */

import { localToLatLon, Point2D } from './types';

export const TERRARIUM_ZOOM = 15;
export const TERRARIUM_TILE_SIZE = 256;

/** Decode one Terrarium RGB pixel to meters above sea level. */
export function decodeTerrarium(r: number, g: number, b: number): number {
    return r * 256 + g + b / 256 - 32768;
}

/** Fractional slippy-map tile coordinates for a lat/lon at zoom `z`. */
export function lonLatToTile(lat: number, lon: number, z: number): { x: number; y: number } {
    const n = Math.pow(2, z);
    const latRad = (lat * Math.PI) / 180;
    const x = ((lon + 180) / 360) * n;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    return { x, y };
}

/** Decoded elevation tile (row-major, TERRARIUM_TILE_SIZE²). */
export interface ElevationTile {
    z: number;
    x: number;
    y: number;
    heights: Float32Array;
}

/** Regular grid of ground heights (meters) over a local-meter rectangle. */
export class Heightfield {
    readonly minX: number;
    readonly minY: number;
    readonly cellSize: number;
    readonly cols: number;
    readonly rows: number;
    readonly data: Float32Array;
    readonly minHeight: number;
    readonly maxHeight: number;

    constructor(minX: number, minY: number, cellSize: number, cols: number, rows: number, data: Float32Array) {
        this.minX = minX;
        this.minY = minY;
        this.cellSize = cellSize;
        this.cols = cols;
        this.rows = rows;
        this.data = data;
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < data.length; i++) {
            if (data[i] < lo) lo = data[i];
            if (data[i] > hi) hi = data[i];
        }
        this.minHeight = Number.isFinite(lo) ? lo : 0;
        this.maxHeight = Number.isFinite(hi) ? hi : 0;
    }

    get maxX(): number {
        return this.minX + (this.cols - 1) * this.cellSize;
    }

    get maxY(): number {
        return this.minY + (this.rows - 1) * this.cellSize;
    }

    /** Bilinear height at local (x, y); clamps to the grid edge outside it. */
    sample(x: number, y: number): number {
        let gx = (x - this.minX) / this.cellSize;
        let gy = (y - this.minY) / this.cellSize;
        gx = Math.max(0, Math.min(this.cols - 1.000001, gx));
        gy = Math.max(0, Math.min(this.rows - 1.000001, gy));
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = gx - ix;
        const fy = gy - iy;
        const i00 = iy * this.cols + ix;
        const h00 = this.data[i00];
        const h10 = this.data[i00 + 1];
        const h01 = this.data[i00 + this.cols];
        const h11 = this.data[i00 + this.cols + 1];
        return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
    }

    /** Lowest ground height under a polygon's vertices and centroid (for building plinths). */
    minUnder(vertices: Point2D[]): number {
        let lo = Infinity;
        let cx = 0;
        let cy = 0;
        for (const v of vertices) {
            lo = Math.min(lo, this.sample(v.x, v.y));
            cx += v.x;
            cy += v.y;
        }
        if (vertices.length > 0) lo = Math.min(lo, this.sample(cx / vertices.length, cy / vertices.length));
        return Number.isFinite(lo) ? lo : 0;
    }

    static flat(minX: number, minY: number, maxX: number, maxY: number, cellSize = 50): Heightfield {
        const cols = Math.max(2, Math.ceil((maxX - minX) / cellSize) + 1);
        const rows = Math.max(2, Math.ceil((maxY - minY) / cellSize) + 1);
        return new Heightfield(minX, minY, cellSize, cols, rows, new Float32Array(cols * rows));
    }
}

/** Tile keys (x, y at `zoom`) needed to cover a local rectangle around a geographic origin. */
export function tilesCovering(
    refLat: number,
    refLon: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    zoom: number = TERRARIUM_ZOOM
): Array<{ x: number; y: number }> {
    const sw = localToLatLon(minX, minY, refLat, refLon);
    const ne = localToLatLon(maxX, maxY, refLat, refLon);
    const a = lonLatToTile(sw.lat, sw.lng, zoom);
    const b = lonLatToTile(ne.lat, ne.lng, zoom);
    const tiles: Array<{ x: number; y: number }> = [];
    for (let x = Math.floor(Math.min(a.x, b.x)); x <= Math.floor(Math.max(a.x, b.x)); x++) {
        for (let y = Math.floor(Math.min(a.y, b.y)); y <= Math.floor(Math.max(a.y, b.y)); y++) {
            tiles.push({ x, y });
        }
    }
    return tiles;
}

/**
 * Resample decoded DEM tiles onto a local-meter grid. Heights are made
 * relative to the elevation at the geographic origin so the simulation
 * plane (z = 0) sits on the ground at the map center.
 */
export function buildHeightfieldFromTiles(
    tiles: ElevationTile[],
    refLat: number,
    refLon: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    cellSize: number = 4
): Heightfield {
    if (tiles.length === 0) return Heightfield.flat(minX, minY, maxX, maxY);
    const zoom = tiles[0].z;
    const byKey = new Map<string, ElevationTile>();
    for (const t of tiles) byKey.set(`${t.x}/${t.y}`, t);
    const S = TERRARIUM_TILE_SIZE;

    const pixel = (tx: number, ty: number, px: number, py: number): number | null => {
        // Allow sampling across tile seams
        if (px >= S) {
            tx += 1;
            px -= S;
        }
        if (py >= S) {
            ty += 1;
            py -= S;
        }
        const tile = byKey.get(`${tx}/${ty}`);
        return tile ? tile.heights[py * S + px] : null;
    };

    const elevationAt = (lat: number, lon: number): number | null => {
        const t = lonLatToTile(lat, lon, zoom);
        const fx = (t.x - Math.floor(t.x)) * S - 0.5;
        const fy = (t.y - Math.floor(t.y)) * S - 0.5;
        const tx = Math.floor(t.x);
        const ty = Math.floor(t.y);
        const x0 = Math.max(0, Math.floor(fx));
        const y0 = Math.max(0, Math.floor(fy));
        const ax = Math.max(0, fx - x0);
        const ay = Math.max(0, fy - y0);
        const h00 = pixel(tx, ty, x0, y0);
        const h10 = pixel(tx, ty, x0 + 1, y0) ?? h00;
        const h01 = pixel(tx, ty, x0, y0 + 1) ?? h00;
        const h11 = pixel(tx, ty, x0 + 1, y0 + 1) ?? h10;
        if (h00 === null || h10 === null || h01 === null || h11 === null) return null;
        return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    };

    const cols = Math.max(2, Math.ceil((maxX - minX) / cellSize) + 1);
    const rows = Math.max(2, Math.ceil((maxY - minY) / cellSize) + 1);
    const data = new Float32Array(cols * rows);
    const datum = elevationAt(refLat, refLon) ?? 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const p = localToLatLon(minX + c * cellSize, minY + r * cellSize, refLat, refLon);
            const h = elevationAt(p.lat, p.lng);
            data[r * cols + c] = h === null ? 0 : h - datum;
        }
    }
    return new Heightfield(minX, minY, cellSize, cols, rows, data);
}
