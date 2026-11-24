import { describe, it, expect } from 'vitest';

import { parseOsmLength, resolveBuildingHeight, STOREY_HEIGHT_M } from '../BuildingHeights';
import { classifyOsmWay, estimateRoadWidth, parseOverpassResponse, OverpassElement } from '../OSMFetcher';
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
        expect(classifyOsmWay(undefined)).toBe('building');
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
});
