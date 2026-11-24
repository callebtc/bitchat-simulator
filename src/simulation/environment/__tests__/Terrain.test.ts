import { describe, it, expect } from 'vitest';

import {
    buildHeightfieldFromTiles,
    decodeTerrarium,
    ElevationTile,
    Heightfield,
    lonLatToTile,
    TERRARIUM_TILE_SIZE,
    tilesCovering,
} from '../Terrain';

describe('Terrain', () => {
    it('decodes Terrarium RGB to meters', () => {
        // 0 m == (128, 0, 0); +1 m adds one to G; B is 1/256 m
        expect(decodeTerrarium(128, 0, 0)).toBe(0);
        expect(decodeTerrarium(128, 10, 128)).toBeCloseTo(10.5, 6);
        expect(decodeTerrarium(127, 255, 0)).toBe(-1);
    });

    it('computes slippy-map tile coordinates', () => {
        const t = lonLatToTile(0, 0, 1);
        expect(t.x).toBeCloseTo(1, 9);
        expect(t.y).toBeCloseTo(1, 9);
        const nw = lonLatToTile(85, -179.99, 2);
        expect(Math.floor(nw.x)).toBe(0);
        expect(Math.floor(nw.y)).toBe(0);
    });

    it('samples a heightfield bilinearly and clamps outside', () => {
        // 2×2 grid, 10 m cells: heights 0, 10 / 20, 30
        const hf = new Heightfield(0, 0, 10, 2, 2, new Float32Array([0, 10, 20, 30]));
        expect(hf.sample(0, 0)).toBe(0);
        expect(hf.sample(10, 10)).toBeCloseTo(30, 4);
        expect(hf.sample(5, 5)).toBeCloseTo(15, 4);
        expect(hf.sample(-100, -100)).toBe(0);
        expect(hf.minHeight).toBe(0);
        expect(hf.maxHeight).toBe(30);
        const square = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ];
        expect(hf.minUnder(square)).toBe(0);
    });

    it('resamples DEM tiles relative to the map origin elevation', () => {
        const lat = 37.79;
        const lon = -122.41;
        const keys = tilesCovering(lat, lon, -50, -50, 50, 50, 15);
        expect(keys.length).toBeGreaterThan(0);
        const S = TERRARIUM_TILE_SIZE;
        // Synthetic tiles: elevation rises 1 m per pixel row going south
        const tiles: ElevationTile[] = keys.map(k => {
            const heights = new Float32Array(S * S);
            for (let py = 0; py < S; py++) {
                for (let px = 0; px < S; px++) heights[py * S + px] = 100 + (k.y * S + py);
            }
            return { z: 15, x: k.x, y: k.y, heights };
        });
        const hf = buildHeightfieldFromTiles(tiles, lat, lon, -50, -50, 50, 50, 10);
        // Origin is the datum
        expect(hf.sample(0, 0)).toBeCloseTo(0, 1);
        // Southern samples (more negative y) sit higher in this synthetic DEM
        expect(hf.sample(0, -50)).toBeGreaterThan(hf.sample(0, 50));
    });

    it('falls back to flat ground without tiles', () => {
        const hf = buildHeightfieldFromTiles([], 0, 0, -10, -10, 10, 10);
        expect(hf.sample(3, 4)).toBe(0);
    });
});
