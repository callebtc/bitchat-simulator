import { PowerMode } from './BitchatDevice';

/**
 * Android PowerManager.kt / PowerProfileResolver equivalent.
 * Maps device power mode & background state to BLE scan duty cycles,
 * RSSI connect thresholds, announce cadence, and max connections.
 */

export interface BlePowerProfile {
    scanOnMs: number;
    scanOffMs: number;
    continuousScan: boolean;
    rssiThresholdDbm: number;
    announceIntervalMs: number;
    maxConnections: number;
}

export function resolveBlePowerProfile(
    mode: PowerMode,
    isBackground: boolean = false,
    hasDirectPeers: boolean = false
): BlePowerProfile {
    if (isBackground) {
        return {
            scanOnMs: 1_000,
            scanOffMs: hasDirectPeers ? 29_000 : 59_000,
            continuousScan: false,
            rssiThresholdDbm: mode === PowerMode.ULTRA_LOW_POWER ? -65 : -75,
            announceIntervalMs: mode === PowerMode.ULTRA_LOW_POWER ? 300_000 : 60_000,
            maxConnections: 8,
        };
    }

    switch (mode) {
        case PowerMode.PERFORMANCE:
            return {
                scanOnMs: Number.POSITIVE_INFINITY,
                scanOffMs: 0,
                continuousScan: true,
                rssiThresholdDbm: -95,
                announceIntervalMs: 30_000,
                maxConnections: 8,
            };
        case PowerMode.NORMAL:
            // Maps to Android BALANCED
            return {
                scanOnMs: 8_000,
                scanOffMs: 2_000,
                continuousScan: false,
                rssiThresholdDbm: -85,
                announceIntervalMs: 30_000,
                maxConnections: 8,
            };
        case PowerMode.ECO:
            // Maps to Android POWER_SAVER
            return {
                scanOnMs: 2_000,
                scanOffMs: 28_000,
                continuousScan: false,
                rssiThresholdDbm: -75,
                announceIntervalMs: 60_000,
                maxConnections: 8,
            };
        case PowerMode.ULTRA_LOW_POWER:
            return {
                scanOnMs: 1_000,
                scanOffMs: 29_000,
                continuousScan: false,
                rssiThresholdDbm: -65,
                announceIntervalMs: 120_000,
                maxConnections: 8,
            };
    }
}
