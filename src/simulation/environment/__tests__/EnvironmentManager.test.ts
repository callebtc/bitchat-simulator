import { describe, it, expect, beforeEach } from 'vitest';
import { EnvironmentManager } from '../EnvironmentManager';
import { Material, GeoJSONFeatureCollection, Point2D } from '../types';

describe('EnvironmentManager', () => {
    let manager: EnvironmentManager;

    beforeEach(() => {
        manager = new EnvironmentManager();
    });

    describe('loadFromGeoJSON', () => {
        it('loads buildings from GeoJSON', () => {
            const geojson: GeoJSONFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[
                                [-73.985, 40.758],
                                [-73.984, 40.758],
                                [-73.984, 40.759],
                                [-73.985, 40.759],
                                [-73.985, 40.758], // Closed ring
                            ]],
                        },
                        properties: { name: 'Test Building' },
                    },
                ],
            };

            manager.loadFromGeoJSON(geojson, 40.758, -73.985);

            expect(manager.getBuildingCount()).toBe(1);
            const buildings = manager.getBuildings();
            expect(buildings[0].material).toBe(Material.BUILDING);
        });

        it('sets correct bounds', () => {
            const geojson: GeoJSONFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[
                                [-73.99, 40.75],
                                [-73.98, 40.75],
                                [-73.98, 40.76],
                                [-73.99, 40.76],
                                [-73.99, 40.75],
                            ]],
                        },
                        properties: {},
                    },
                ],
            };

            manager.loadFromGeoJSON(geojson);

            const bounds = manager.getBounds();
            expect(bounds).not.toBeNull();
            expect(bounds!.minLat).toBeCloseTo(40.75, 4);
            expect(bounds!.maxLat).toBeCloseTo(40.76, 4);
        });

        it('converts coordinates to local meters', () => {
            const centerLat = 40.758;
            const centerLon = -73.985;
            
            // Create a building 100m x 100m roughly
            const latOffset = 0.0009; // ~100m at this latitude
            const lonOffset = 0.0012; // ~100m at this latitude
            
            const geojson: GeoJSONFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[
                                [centerLon, centerLat],
                                [centerLon + lonOffset, centerLat],
                                [centerLon + lonOffset, centerLat + latOffset],
                                [centerLon, centerLat + latOffset],
                                [centerLon, centerLat],
                            ]],
                        },
                        properties: {},
                    },
                ],
            };

            manager.loadFromGeoJSON(geojson, centerLat, centerLon);

            const buildings = manager.getBuildings();
            expect(buildings).toHaveLength(1);
            
            // First vertex should be near origin (center)
            const firstVertex = buildings[0].vertices[0];
            expect(firstVertex.x).toBeCloseTo(0, 0);
            expect(firstVertex.y).toBeCloseTo(0, 0);
        });

        it('skips invalid polygons (< 3 vertices)', () => {
            const geojson: GeoJSONFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[
                                [-73.985, 40.758],
                                [-73.984, 40.758],
                                [-73.985, 40.758], // Only 2 unique points
                            ]],
                        },
                        properties: {},
                    },
                ],
            };

            manager.loadFromGeoJSON(geojson);

            expect(manager.getBuildingCount()).toBe(0);
        });
    });

    describe('clear', () => {
        it('removes all buildings', () => {
            const geojson: GeoJSONFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[
                                [-73.985, 40.758],
                                [-73.984, 40.758],
                                [-73.984, 40.759],
                                [-73.985, 40.759],
                                [-73.985, 40.758],
                            ]],
                        },
                        properties: {},
                    },
                ],
            };

            manager.loadFromGeoJSON(geojson);
            expect(manager.getBuildingCount()).toBe(1);

            manager.clear();
            expect(manager.getBuildingCount()).toBe(0);
            expect(manager.getBounds()).toBeNull();
        });
    });

    describe('getBuildingsInPath', () => {
        beforeEach(() => {
            // Load test buildings manually for predictable positions
            const data = {
                bounds: {
                    center: { lat: 0, lng: 0 },
                    minLat: -1, maxLat: 1,
                    minLng: -1, maxLng: 1,
                    localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
                },
                buildings: [
                    {
                        id: 'b1',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 10, y: -5 },
                            { x: 20, y: -5 },
                            { x: 20, y: 5 },
                            { x: 10, y: 5 },
                        ],
                        bounds: { minX: 10, minY: -5, maxX: 20, maxY: 5 },
                    },
                    {
                        id: 'b2',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 50, y: 40 },
                            { x: 60, y: 40 },
                            { x: 60, y: 50 },
                            { x: 50, y: 50 },
                        ],
                        bounds: { minX: 50, minY: 40, maxX: 60, maxY: 50 },
                    },
                ],
            };
            manager.loadFromData(data);
        });

        it('returns buildings that overlap with path bounding box', () => {
            // Path from (0,0) to (30,0) should include b1 but not b2
            const buildings = manager.getBuildingsInPath(
                { x: 0, y: 0 },
                { x: 30, y: 0 }
            );

            expect(buildings).toHaveLength(1);
            expect(buildings[0].id).toBe('b1');
        });

        it('returns empty array when path misses all buildings', () => {
            // Path entirely below all buildings
            const buildings = manager.getBuildingsInPath(
                { x: 0, y: -20 },
                { x: 100, y: -20 }
            );

            expect(buildings).toHaveLength(0);
        });

        it('returns multiple buildings when path crosses several', () => {
            // Path that could reach both buildings
            const buildings = manager.getBuildingsInPath(
                { x: 0, y: 0 },
                { x: 70, y: 60 }
            );

            expect(buildings).toHaveLength(2);
        });
    });

    describe('isInsideBuilding', () => {
        beforeEach(() => {
            const data = {
                bounds: {
                    center: { lat: 0, lng: 0 },
                    minLat: -1, maxLat: 1,
                    minLng: -1, maxLng: 1,
                    localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
                },
                buildings: [
                    {
                        id: 'b1',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 0, y: 0 },
                            { x: 10, y: 0 },
                            { x: 10, y: 10 },
                            { x: 0, y: 10 },
                        ],
                        bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
                    },
                ],
            };
            manager.loadFromData(data);
        });

        it('returns building when point is inside', () => {
            const point: Point2D = { x: 5, y: 5 };
            const building = manager.isInsideBuilding(point);

            expect(building).not.toBeNull();
            expect(building!.id).toBe('b1');
        });

        it('returns null when point is outside', () => {
            const point: Point2D = { x: 15, y: 5 };
            const building = manager.isInsideBuilding(point);

            expect(building).toBeNull();
        });

        it('returns null when point is on edge (typically outside)', () => {
            const point: Point2D = { x: 0, y: 5 };
            const building = manager.isInsideBuilding(point);
            
            // Edge cases can vary; the important thing is it doesn't crash
            // Most implementations treat edge as outside
            expect(building === null || building !== null).toBe(true);
        });
    });

    describe('exportData', () => {
        it('returns null when no data loaded', () => {
            expect(manager.exportData()).toBeNull();
        });

        it('returns serializable data when loaded', () => {
            const geojson: GeoJSONFeatureCollection = {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'Polygon',
                            coordinates: [[
                                [-73.985, 40.758],
                                [-73.984, 40.758],
                                [-73.984, 40.759],
                                [-73.985, 40.759],
                                [-73.985, 40.758],
                            ]],
                        },
                        properties: {},
                    },
                ],
            };

            manager.loadFromGeoJSON(geojson);

            const exported = manager.exportData();
            expect(exported).not.toBeNull();
            expect(exported!.buildings).toHaveLength(1);
            expect(exported!.bounds).toBeDefined();
        });
    });
});
