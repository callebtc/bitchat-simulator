import { describe, it, expect } from 'vitest';

import { parseOsmLength, resolveBuildingHeight, STOREY_HEIGHT_M } from '../BuildingHeights';
import { assembleRings, classifyOsmWay, estimateRoadWidth, parseOverpassResponse, OverpassElement } from '../OSMFetcher';
import { EnvironmentManager } from '../EnvironmentManager';

const SQUARE = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
];

describe('BuildingHeights', () => {
    it('parses OSM length strings in meters and feet', () => {
        expect(parseOsmLength('12')).toBe(12);
        expect(parseOsmLength('12.5 m')).toBe(12.5);
        expect(parseOsmLength('100 ft')).toBeCloseTo(30.48, 2);
        expect(parseOsmLength("40'")).toBeCloseTo(12.192, 3);
        expect(parseOsmLength('tall')).toBeNull();
        expect(parseOsmLength(undefined)).toBeNull();
    });

    it('prefers explicit height over levels over estimate', () => {
        expect(resolveBuildingHeight({ height: '42', levels: '3' }, SQUARE, 'a')).toEqual({
            height: 42,
            source: 'tag',
        });
        const byLevels = resolveBuildingHeight({ levels: '5' }, SQUARE, 'a');
        expect(byLevels.source).toBe('levels');
        expect(byLevels.height).toBeCloseTo(5 * STOREY_HEIGHT_M + 1, 5);
    });

    it('produces deterministic whole-storey estimates', () => {
        const a = resolveBuildingHeight({ building: 'office' }, SQUARE, 'osm:123');
        const b = resolveBuildingHeight({ building: 'office' }, SQUARE, 'osm:123');
        expect(a).toEqual(b);
        expect(a.source).toBe('estimate');
        const storeys = a.height / STOREY_HEIGHT_M;
        expect(Math.abs(storeys - Math.round(storeys))).toBeLessThan(1e-9);
    });
});

describe('OSM map context parsing', () => {
    it('classifies ways by tag', () => {
        // Untagged ways are multipolygon members, assembled with their relation
        expect(classifyOsmWay(undefined)).toBeNull();
        expect(classifyOsmWay({ building: 'yes' })).toBe('building');
        expect(classifyOsmWay({ highway: 'primary' })).toBe('road');
        expect(classifyOsmWay({ highway: 'pedestrian', area: 'yes' })).toBe('plaza');
        expect(classifyOsmWay({ highway: 'construction' })).toBeNull();
        expect(classifyOsmWay({ leisure: 'park' })).toBe('park');
        expect(classifyOsmWay({ natural: 'water' })).toBe('water');
        expect(classifyOsmWay({ amenity: 'bench' })).toBeNull();
    });

    it('estimates road width from tags', () => {
        expect(estimateRoadWidth({ highway: 'residential', width: '9' })).toBe(9);
        expect(estimateRoadWidth({ highway: 'primary', lanes: '4' })).toBeCloseTo(13.2, 5);
        expect(estimateRoadWidth({ highway: 'footway' })).toBe(2.2);
        expect(estimateRoadWidth({ highway: 'primary_link' })).toBe(13);
    });

    it('splits buildings, roads, and areas and dedupes skeleton ways', () => {
        const ring = [1, 2, 3, 4, 1];
        const elements: OverpassElement[] = [
            { type: 'way' as const, id: 10, nodes: ring, tags: { building: 'yes', 'building:levels': '4' } },
            { type: 'way' as const, id: 11, nodes: [1, 3], tags: { highway: 'residential' } },
            { type: 'way' as const, id: 12, nodes: ring, tags: { leisure: 'park' } },
            // Skeleton re-output of way 10 without tags must not override the tagged copy
            { type: 'way' as const, id: 10, nodes: ring },
            { type: 'node' as const, id: 1, lat: 0, lon: 0 },
            { type: 'node' as const, id: 2, lat: 0, lon: 0.0002 },
            { type: 'node' as const, id: 3, lat: 0.0002, lon: 0.0002 },
            { type: 'node' as const, id: 4, lat: 0.0002, lon: 0 },
        ];
        const fc = parseOverpassResponse({ elements });
        const kinds = fc.features.map(f => f.properties.kind).sort();
        expect(kinds).toEqual(['building', 'park', 'road']);

        const env = new EnvironmentManager();
        env.loadFromGeoJSON(fc, 0.0001, 0.0001);
        expect(env.getBuildingCount()).toBe(1);
        expect(env.getBuildings()[0].heightSource).toBe('levels');
        const ctx = env.getMapContext();
        expect(ctx.roads).toHaveLength(1);
        expect(ctx.roads[0].roadClass).toBe('minor');
        expect(ctx.areas).toHaveLength(1);
        expect(ctx.areas[0].kind).toBe('park');

        env.clear();
        expect(env.getMapContext().roads).toHaveLength(0);
    });

    it('renders building:part volumes instead of their outline and drops duplicate ways', () => {
        // Outline 0..0.0004 deg square; a part covering its west half; a duplicate outline way
        const nodes: OverpassElement[] = [
            { type: 'node', id: 1, lat: 0, lon: 0 },
            { type: 'node', id: 2, lat: 0, lon: 0.0004 },
            { type: 'node', id: 3, lat: 0.0004, lon: 0.0004 },
            { type: 'node', id: 4, lat: 0.0004, lon: 0 },
            { type: 'node', id: 5, lat: 0, lon: 0.0002 },
            { type: 'node', id: 6, lat: 0.0004, lon: 0.0002 },
            // Detached building elsewhere (no parts)
            { type: 'node', id: 7, lat: 0.001, lon: 0.001 },
            { type: 'node', id: 8, lat: 0.001, lon: 0.0012 },
            { type: 'node', id: 9, lat: 0.0012, lon: 0.0012 },
        ];
        const elements: OverpassElement[] = [
            ...nodes,
            { type: 'way', id: 100, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes' } },
            { type: 'way', id: 101, nodes: [2, 3, 4, 1, 2], tags: { building: 'yes' } }, // same ring, rotated
            { type: 'way', id: 102, nodes: [1, 5, 6, 4, 1], tags: { 'building:part': 'yes', height: '40', min_height: '6' } },
            { type: 'way', id: 103, nodes: [7, 8, 9, 7], tags: { building: 'house' } },
        ];
        const env = new EnvironmentManager();
        env.loadFromGeoJSON(parseOverpassResponse({ elements }), 0.0005, 0.0005);

        // Physics / RF see outlines only, without the duplicate
        expect(env.getBuildingCount()).toBe(2);
        expect(env.getBuildings().every(b => !b.isPart)).toBe(true);
        const parts = env.getBuildingParts();
        expect(parts).toHaveLength(1);
        expect(parts[0].height).toBe(40);
        expect(parts[0].minHeight).toBe(6);

        // Rendering: the outline with a part is replaced by the part; the house stays
        const volumes = env.getRenderVolumes();
        expect(volumes).toHaveLength(2);
        expect(volumes.some(v => v.isPart)).toBe(true);
        expect(env.getBuildings().find(b => b.hasParts)).toBeDefined();
    });

    it('assembles multipolygon building relations with courtyards as holes', () => {
        expect(assembleRings([[1, 2, 3], [3, 4, 1]])).toEqual([[1, 2, 3, 4, 1]]);
        expect(assembleRings([[1, 2, 3], [1, 4, 3]])).toEqual([[1, 2, 3, 4, 1]]);

        const d = 0.0001;
        const nodes: OverpassElement[] = [
            // Outer 0..4d square split across two ways
            { type: 'node', id: 1, lat: 0, lon: 0 },
            { type: 'node', id: 2, lat: 0, lon: 4 * d },
            { type: 'node', id: 3, lat: 4 * d, lon: 4 * d },
            { type: 'node', id: 4, lat: 4 * d, lon: 0 },
            // Courtyard 1d..3d
            { type: 'node', id: 5, lat: d, lon: d },
            { type: 'node', id: 6, lat: d, lon: 3 * d },
            { type: 'node', id: 7, lat: 3 * d, lon: 3 * d },
            { type: 'node', id: 8, lat: 3 * d, lon: d },
        ];
        const elements: OverpassElement[] = [
            ...nodes,
            { type: 'way', id: 10, nodes: [1, 2, 3] },
            { type: 'way', id: 11, nodes: [3, 4, 1] },
            { type: 'way', id: 12, nodes: [5, 6, 7, 8, 5] },
            {
                type: 'relation',
                id: 99,
                tags: { type: 'multipolygon', building: 'apartments', 'building:levels': '5' },
                members: [
                    { type: 'way', ref: 10, role: 'outer' },
                    { type: 'way', ref: 11, role: 'outer' },
                    { type: 'way', ref: 12, role: 'inner' },
                ],
            },
        ];
        const fc = parseOverpassResponse({ elements });
        // One polygon with a hole; member ways are not emitted as separate buildings
        expect(fc.features).toHaveLength(1);
        expect((fc.features[0].geometry.coordinates as number[][][]).length).toBe(2);

        const env = new EnvironmentManager();
        env.loadFromGeoJSON(fc, 2 * d, 2 * d);
        expect(env.getBuildingCount()).toBe(1);
        const b = env.getBuildings()[0];
        expect(b.holes).toHaveLength(1);
        expect(b.heightSource).toBe('levels');
        expect(env.getRenderVolumes()).toHaveLength(1);
    });

    it('never draws coplanar nested volumes', () => {
        const ring = (x0: number, y0: number, x1: number, y1: number): number[][] => [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
            [x0, y0],
        ];
        const feature = (coords: number[][], height: string, osmId: number) => ({
            type: 'Feature' as const,
            geometry: { type: 'Polygon' as const, coordinates: [coords] },
            properties: { kind: 'building', osmId, height },
        });
        const env = new EnvironmentManager();
        env.loadFromGeoJSON(
            {
                type: 'FeatureCollection',
                features: [
                    feature(ring(0, 0, 0.001, 0.001), '20', 1), // container
                    feature(ring(0, 0, 0.0002, 0.0002), '20', 2), // same roof height → dropped
                    feature(ring(0.0005, 0.0005, 0.0006, 0.0006), '50', 3), // tower → drawn above roof only
                ],
            },
            0.0005,
            0.0005
        );
        const volumes = env.getRenderVolumes();
        expect(volumes).toHaveLength(2);
        const tower = volumes.find(v => v.height === 50);
        expect(tower?.minHeight).toBe(20);
        expect(tower?.stacked).toBe(true);
        // Physics still sees all three footprints
        expect(env.getBuildingCount()).toBe(3);
    });
});
