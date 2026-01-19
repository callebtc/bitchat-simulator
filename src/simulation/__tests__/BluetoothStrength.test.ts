import { describe, it, expect } from 'vitest';
import { BitchatDevice } from '../BitchatDevice';
import { BitchatConnectionBLE, RSSI_CONFIG } from '../BitchatConnectionBLE';

describe('Bluetooth Strength Impact on RSSI', () => {
    // Helper to calculate expected RSSI without environment
    const calculateExpectedRSSI = (dist: number, s1: number, s2: number) => {
        const pathLoss = 10 * RSSI_CONFIG.PATH_LOSS_EXPONENT * Math.log10(dist);
        const gain1 = 10 * Math.log10(s1 / 50);
        const gain2 = 10 * Math.log10(s2 / 50);
        return RSSI_CONFIG.AT_1M - pathLoss + gain1 + gain2;
    };

    it('standard devices (50) have baseline RSSI', () => {
        const d1 = BitchatDevice.createRandom();
        const d2 = BitchatDevice.createRandom();
        d1.bluetoothStrength = 50;
        d2.bluetoothStrength = 50;
        d1.position = { x: 0, y: 0 };
        d2.position = { x: 10, y: 0 };

        const rssi = BitchatConnectionBLE.estimateRSSI(
            d1.position, d2.position, 
            d1.bluetoothStrength, d2.bluetoothStrength, 
            null
        );

        const expected = calculateExpectedRSSI(10, 50, 50);
        expect(rssi).toBeCloseTo(expected, 1);
    });

    it('strong devices (100) boost RSSI by ~6dB total', () => {
        const d1 = BitchatDevice.createRandom();
        const d2 = BitchatDevice.createRandom();
        d1.bluetoothStrength = 100; // +3dB
        d2.bluetoothStrength = 100; // +3dB
        d1.position = { x: 0, y: 0 };
        d2.position = { x: 10, y: 0 };

        const rssi = BitchatConnectionBLE.estimateRSSI(
            d1.position, d2.position, 
            d1.bluetoothStrength, d2.bluetoothStrength, 
            null
        );

        const baseline = calculateExpectedRSSI(10, 50, 50);
        // 10 * log10(2) approx 3.01. So 2x gain is +6.02dB
        expect(rssi).toBeCloseTo(baseline + 6.02, 1);
    });

    it('weak devices (25) reduce RSSI by ~6dB total', () => {
        const d1 = BitchatDevice.createRandom();
        const d2 = BitchatDevice.createRandom();
        d1.bluetoothStrength = 25; // -3dB
        d2.bluetoothStrength = 25; // -3dB
        d1.position = { x: 0, y: 0 };
        d2.position = { x: 10, y: 0 };

        const rssi = BitchatConnectionBLE.estimateRSSI(
            d1.position, d2.position, 
            d1.bluetoothStrength, d2.bluetoothStrength, 
            null
        );

        const baseline = calculateExpectedRSSI(10, 50, 50);
        expect(rssi).toBeCloseTo(baseline - 6.02, 1);
    });

    it('mixed devices (100 + 25) cancel out to baseline', () => {
        const d1 = BitchatDevice.createRandom();
        const d2 = BitchatDevice.createRandom();
        d1.bluetoothStrength = 100; // +3dB
        d2.bluetoothStrength = 25; // -3dB
        d1.position = { x: 0, y: 0 };
        d2.position = { x: 10, y: 0 };

        const rssi = BitchatConnectionBLE.estimateRSSI(
            d1.position, d2.position, 
            d1.bluetoothStrength, d2.bluetoothStrength, 
            null
        );

        const baseline = calculateExpectedRSSI(10, 50, 50);
        expect(rssi).toBeCloseTo(baseline, 1);
    });
});
