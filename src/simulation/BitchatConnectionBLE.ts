import { BitchatConnection } from './BitchatConnection';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { BitchatDevice } from './BitchatDevice';
import { EnvironmentManager, calculateLineAttenuationStats, Point2D } from './environment';

// RSSI Configuration - mutable so UI can modify
export const RSSI_CONFIG = {
    /** RSSI at 1 meter distance (typical BLE) in dBm */
    AT_1M: -40,
    /** Path loss exponent (2.0 = free space, 2.5-3.0 = indoor) */
    PATH_LOSS_EXPONENT: 2.5,
    /** Disconnect threshold in dBm */
    DISCONNECT_THRESHOLD: -85,
    /** Maximum good RSSI (for color scaling) */
    MAX_RSSI: -30,
    /** Noise amplitude in dB (can be modified at runtime) */
    NOISE_AMPLITUDE: 3,
    /** Noise period in milliseconds (slower = more stable signal) */
    NOISE_PERIOD: 15000,
    /** Smoothing factor for RSSI updates (0-1, higher = faster) */
    SMOOTHING_FACTOR: 0.3,
};

export interface RSSIStats {
    distance: number;
    pathLoss: number;
    wallLoss: number;
    materialLoss: number;
    wallsCrossed: number;
    totalLoss: number;
    targetRSSI: number;
}

/** Update RSSI config at runtime */
export function setRssiNoiseAmplitude(amplitude: number): void {
    RSSI_CONFIG.NOISE_AMPLITUDE = Math.max(0, Math.min(10, amplitude));
}

export class BitchatConnectionBLE extends BitchatConnection {
    // RSSI Properties
    rssi: number = RSSI_CONFIG.AT_1M;
    private rssiTarget: number = RSSI_CONFIG.AT_1M;
    private noisePhase: number = 0;
    
    // Detailed stats for UI
    lastStats: RSSIStats | null = null;
    
    // Environment reference (set by SimulationEngine)
    environment: EnvironmentManager | null = null;

    constructor(endpointA: BitchatDevice, endpointB: BitchatDevice, initiator?: BitchatDevice) {
        super(endpointA, endpointB, initiator);
        // Initialize noise phase randomly so connections don't all fluctuate in sync
        this.noisePhase = Math.random() * Math.PI * 2;
    }

    send(packet: BitchatPacket, from: BitchatDevice): void {
        if (!this.isActive) return;

        this.packetsSent++;
        
        // Visualize immediately (so we see it leave the sender)
        if (this.onPacketSent) {
            this.onPacketSent(packet, from);
        }

        // Simulate network latency
        const now = performance.now();
        this.packetQueue.push({
            packet,
            from,
            deliverAt: now + this.latencyMs
        });
    }

    /**
     * Update RSSI based on current positions and environment.
     * Should be called each simulation tick.
     * 
     * @param now - Current timestamp in milliseconds
     * @returns true if connection should remain active, false if should disconnect
     */
    updateRSSI(now: number): boolean {
        if (!this.isActive) return false;

        const posA = this.endpointA.position;
        const posB = this.endpointB.position;

        if (!posA || !posB) {
            return true; // Can't calculate, keep connection
        }

        // Calculate distance
        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Avoid log(0) for very close devices
        const effectiveDistance = Math.max(distance, 0.1);

        // Free-space path loss: RSSI = RSSI_1m - 10 * n * log10(d)
        // Path Loss (dB) = 10 * n * log10(d)
        // We calculate this relative to 1m
        const pathLoss = 10 * RSSI_CONFIG.PATH_LOSS_EXPONENT * Math.log10(effectiveDistance);
        
        let targetRSSI = RSSI_CONFIG.AT_1M - pathLoss;
        let wallLoss = 0;
        let materialLoss = 0;
        let wallsCrossed = 0;

        // Material attenuation
        if (this.environment) {
            const pointA: Point2D = { x: posA.x, y: posA.y };
            const pointB: Point2D = { x: posB.x, y: posB.y };
            
            const buildingsInPath = this.environment.getBuildingsInPath(pointA, pointB);
            const stats = calculateLineAttenuationStats(pointA, pointB, buildingsInPath);
            
            wallLoss = stats.wallLoss;
            materialLoss = stats.materialLoss;
            wallsCrossed = stats.wallsCrossed;
            
            targetRSSI -= stats.total;
        }

        // Store target RSSI
        this.rssiTarget = targetRSSI;
        
        // Store detailed stats
        this.lastStats = {
            distance: effectiveDistance,
            pathLoss,
            wallLoss,
            materialLoss,
            wallsCrossed,
            totalLoss: pathLoss + wallLoss + materialLoss,
            targetRSSI
        };

        // Add noise
        this.noisePhase += (now * 0.001) * (Math.PI * 2 / (RSSI_CONFIG.NOISE_PERIOD / 1000));
        const noise = Math.sin(this.noisePhase) * RSSI_CONFIG.NOISE_AMPLITUDE;

        // Smooth transition to target with noise
        const targetWithNoise = targetRSSI + noise;
        this.rssi = this.rssi + (targetWithNoise - this.rssi) * RSSI_CONFIG.SMOOTHING_FACTOR;

        // Check disconnect threshold
        if (this.rssi < RSSI_CONFIG.DISCONNECT_THRESHOLD) {
            return false; // Signal to disconnect
        }

        return true;
    }

    /**
     * Get RSSI as a normalized value (0-1) for visualization.
     * 0 = at disconnect threshold, 1 = maximum good signal
     */
    getRSSINormalized(): number {
        const range = RSSI_CONFIG.MAX_RSSI - RSSI_CONFIG.DISCONNECT_THRESHOLD;
        const value = (this.rssi - RSSI_CONFIG.DISCONNECT_THRESHOLD) / range;
        return Math.max(0, Math.min(1, value));
    }

    /**
     * Get current target RSSI without noise.
     */
    getTargetRSSI(): number {
        return this.rssiTarget;
    }
}
