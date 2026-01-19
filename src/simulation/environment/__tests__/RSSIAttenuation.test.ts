import { describe, it, expect, beforeEach } from 'vitest';
import { BitchatConnectionBLE, RSSI_CONFIG } from '../../BitchatConnectionBLE';
import { BitchatDevice } from '../../BitchatDevice';
import { EnvironmentManager } from '../EnvironmentManager';
import { Material, MATERIAL_ATTENUATION } from '../types';

describe('RSSI Attenuation with Environment', () => {
    let deviceA: BitchatDevice;
    let deviceB: BitchatDevice;
    let environment: EnvironmentManager;

    beforeEach(() => {
        // Create two devices using factory method
        deviceA = BitchatDevice.createRandom();
        deviceB = BitchatDevice.createRandom();
        
        // Position them 10 meters apart
        deviceA.position = { x: 0, y: 0 };
        deviceB.position = { x: 10, y: 0 };
        
        environment = new EnvironmentManager();
    });

    describe('BitchatConnectionBLE RSSI calculation', () => {
        it('calculates RSSI based on distance without environment', () => {
            const conn = new BitchatConnectionBLE(deviceA, deviceB);
            conn.environment = environment; // Empty environment
            
            const now = performance.now();
            
            // Update multiple times to let smoothing settle
            for (let i = 0; i < 20; i++) {
                conn.updateRSSI(now + i * 100);
            }
            
            // RSSI at 10m should be less than at 1m
            // Formula: RSSI = AT_1M - 10 * n * log10(d)
            const expectedRSSI = RSSI_CONFIG.AT_1M - 
                10 * RSSI_CONFIG.PATH_LOSS_EXPONENT * Math.log10(10);
            
            // Allow for noise variation (±5 dB)
            expect(conn.rssi).toBeGreaterThan(expectedRSSI - 5);
            expect(conn.rssi).toBeLessThan(expectedRSSI + 5);
        });

        it('calculates lower RSSI when building is between devices', () => {
            // Add a building between the devices
            environment.loadFromData({
                bounds: {
                    center: { lat: 0, lng: 0 },
                    minLat: -1, maxLat: 1,
                    minLng: -1, maxLng: 1,
                    localBounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
                },
                buildings: [
                    {
                        id: 'wall',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 4, y: -5 },  // 2m thick wall from x=4 to x=6
                            { x: 6, y: -5 },
                            { x: 6, y: 5 },
                            { x: 4, y: 5 },
                        ],
                        bounds: { minX: 4, minY: -5, maxX: 6, maxY: 5 },
                    },
                ],
            });

            const connWithBuilding = new BitchatConnectionBLE(deviceA, deviceB);
            connWithBuilding.environment = environment;

            const connWithoutBuilding = new BitchatConnectionBLE(deviceA, deviceB);
            connWithoutBuilding.environment = new EnvironmentManager(); // Empty

            const now = performance.now();
            connWithBuilding.updateRSSI(now);
            connWithoutBuilding.updateRSSI(now);

            // Connection through building should have worse (lower) RSSI
            expect(connWithBuilding.rssi).toBeLessThan(connWithoutBuilding.rssi);
            
            // The difference should be approximately the building attenuation
            // 2m through building * 12 dB/m = 24 dB attenuation
            const expectedAttenuation = 2 * MATERIAL_ATTENUATION[Material.BUILDING];
            const actualDifference = connWithoutBuilding.rssi - connWithBuilding.rssi;
            
            // Allow some tolerance for smoothing
            expect(actualDifference).toBeGreaterThan(expectedAttenuation * 0.2);
        });

        it('accumulates attenuation through multiple buildings', () => {
            // Add two buildings between the devices
            environment.loadFromData({
                bounds: {
                    center: { lat: 0, lng: 0 },
                    minLat: -1, maxLat: 1,
                    minLng: -1, maxLng: 1,
                    localBounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
                },
                buildings: [
                    {
                        id: 'wall1',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 3, y: -5 },
                            { x: 4, y: -5 },
                            { x: 4, y: 5 },
                            { x: 3, y: 5 },
                        ],
                        bounds: { minX: 3, minY: -5, maxX: 4, maxY: 5 },
                    },
                    {
                        id: 'wall2',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 6, y: -5 },
                            { x: 7, y: -5 },
                            { x: 7, y: 5 },
                            { x: 6, y: 5 },
                        ],
                        bounds: { minX: 6, minY: -5, maxX: 7, maxY: 5 },
                    },
                ],
            });

            // Connection through one building
            const envOneBuilding = new EnvironmentManager();
            envOneBuilding.loadFromData({
                bounds: {
                    center: { lat: 0, lng: 0 },
                    minLat: -1, maxLat: 1,
                    minLng: -1, maxLng: 1,
                    localBounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
                },
                buildings: [
                    {
                        id: 'wall1',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 3, y: -5 },
                            { x: 4, y: -5 },
                            { x: 4, y: 5 },
                            { x: 3, y: 5 },
                        ],
                        bounds: { minX: 3, minY: -5, maxX: 4, maxY: 5 },
                    },
                ],
            });

            const connTwoBuildings = new BitchatConnectionBLE(deviceA, deviceB);
            connTwoBuildings.environment = environment;

            const connOneBuilding = new BitchatConnectionBLE(deviceA, deviceB);
            connOneBuilding.environment = envOneBuilding;

            const now = performance.now();
            connTwoBuildings.updateRSSI(now);
            connOneBuilding.updateRSSI(now);

            // Two buildings should attenuate more than one
            expect(connTwoBuildings.rssi).toBeLessThan(connOneBuilding.rssi);
        });

        it('returns false (disconnect) when RSSI falls below threshold', () => {
            // Position devices far apart AND add thick walls
            deviceB.position = { x: 50, y: 0 };
            
            // Add a very thick building to push RSSI below threshold
            environment.loadFromData({
                bounds: {
                    center: { lat: 0, lng: 0 },
                    minLat: -1, maxLat: 1,
                    minLng: -1, maxLng: 1,
                    localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
                },
                buildings: [
                    {
                        id: 'thick_wall',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 10, y: -20 },
                            { x: 40, y: -20 }, // 30m thick!
                            { x: 40, y: 20 },
                            { x: 10, y: 20 },
                        ],
                        bounds: { minX: 10, minY: -20, maxX: 40, maxY: 20 },
                    },
                ],
            });

            const conn = new BitchatConnectionBLE(deviceA, deviceB);
            conn.environment = environment;

            const now = performance.now();
            
            // Update multiple times to let smoothing settle
            for (let i = 0; i < 10; i++) {
                conn.updateRSSI(now + i * 100);
            }

            // RSSI should be very low
            expect(conn.rssi).toBeLessThan(RSSI_CONFIG.DISCONNECT_THRESHOLD);
            
            // updateRSSI should return false (signal to disconnect)
            const shouldRemain = conn.updateRSSI(now + 1000);
            expect(shouldRemain).toBe(false);
        });

        it('getRSSINormalized returns value between 0 and 1', () => {
            const conn = new BitchatConnectionBLE(deviceA, deviceB);
            conn.environment = environment;

            const now = performance.now();
            conn.updateRSSI(now);

            const normalized = conn.getRSSINormalized();
            expect(normalized).toBeGreaterThanOrEqual(0);
            expect(normalized).toBeLessThanOrEqual(1);
        });
    });

    describe('Integration with EnvironmentManager.getBuildingsInPath', () => {
        it('correctly filters buildings by bounding box', () => {
            environment.loadFromData({
                bounds: {
                    center: { lat: 0, lng: 0 },
                    minLat: -1, maxLat: 1,
                    minLng: -1, maxLng: 1,
                    localBounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
                },
                buildings: [
                    {
                        id: 'in_path',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 4, y: -2 },
                            { x: 6, y: -2 },
                            { x: 6, y: 2 },
                            { x: 4, y: 2 },
                        ],
                        bounds: { minX: 4, minY: -2, maxX: 6, maxY: 2 },
                    },
                    {
                        id: 'out_of_path',
                        material: Material.BUILDING,
                        vertices: [
                            { x: 50, y: 50 },
                            { x: 60, y: 50 },
                            { x: 60, y: 60 },
                            { x: 50, y: 60 },
                        ],
                        bounds: { minX: 50, minY: 50, maxX: 60, maxY: 60 },
                    },
                ],
            });

            // Line from deviceA to deviceB (0,0) to (10,0)
            const buildingsInPath = environment.getBuildingsInPath(
                { x: 0, y: 0 },
                { x: 10, y: 0 }
            );

            expect(buildingsInPath).toHaveLength(1);
            expect(buildingsInPath[0].id).toBe('in_path');
        });
    });
});
