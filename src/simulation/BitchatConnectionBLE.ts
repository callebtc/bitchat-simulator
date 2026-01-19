import { BitchatConnection } from './BitchatConnection';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { BitchatDevice } from './BitchatDevice';
import { EnvironmentManager, calculateLineAttenuationStats } from './environment';

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
    gain: number;
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
        
        // Initialize RSSI based on actual positions/strengths immediately so we don't start at -40 if we are far away
        if (endpointA.position && endpointB.position) {
            const { targetRSSI } = BitchatConnectionBLE.calculateTargetRSSI(
                endpointA.position, 
                endpointB.position, 
                endpointA.bluetoothStrength,
                endpointB.bluetoothStrength,
                null // Environment will be set later via property, but this gives a decent baseline
            );
            this.rssi = targetRSSI;
        }
    }

    /**
     * Centralized RSSI calculation logic.
     * Calculates the theoretical target RSSI based on distance, environment, and device strengths.
     */
    static calculateTargetRSSI(
        posA: {x: number, y: number}, 
        posB: {x: number, y: number}, 
        strengthA: number,
        strengthB: number,
        environment: EnvironmentManager | null
    ): RSSIStats {
        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const effectiveDistance = Math.max(distance, 0.1);

        // 1. Path Loss
        const pathLoss = 10 * RSSI_CONFIG.PATH_LOSS_EXPONENT * Math.log10(effectiveDistance);
        let targetRSSI = RSSI_CONFIG.AT_1M - pathLoss;

        // 2. Environment Loss (Walls)
        let wallLoss = 0;
        let materialLoss = 0;
        let wallsCrossed = 0;

        if (environment) {
            const buildingsInPath = environment.getBuildingsInPath(posA, posB);
            const stats = calculateLineAttenuationStats(posA, posB, buildingsInPath);
            wallLoss = stats.wallLoss;
            materialLoss = stats.materialLoss;
            wallsCrossed = stats.wallsCrossed;
            targetRSSI -= stats.total;
        }

        // 3. Bluetooth Strength Gain
        // Baseline is 50. 100 is 2x power (+3dB). 25 is 0.5x power (-3dB).
        // Gain = 10 * log10(strength / 50)
        // We sum the gains from both sides (TX power boost + RX sensitivity boost equivalent)
        // Actually, typically TX power matters most. But let's assume 'strength' implies better antenna/chipset for both.
        // Let's treat it as: Connection Gain = Gain(A) + Gain(B)
        
        const gainA = 10 * Math.log10(Math.max(1, strengthA) / 50);
        const gainB = 10 * Math.log10(Math.max(1, strengthB) / 50);
        const totalGain = gainA + gainB;
        
        targetRSSI += totalGain;

        return {
            distance: effectiveDistance,
            pathLoss,
            wallLoss,
            materialLoss,
            wallsCrossed,
            gain: totalGain,
            totalLoss: pathLoss + wallLoss + materialLoss - totalGain, // Negative loss is gain? Or just net loss.
            targetRSSI
        };
    }

    /**
     * Calculate theoretical RSSI based on distance and environment (no noise/smoothing)
     */
    static estimateRSSI(
        posA: {x: number, y: number}, 
        posB: {x: number, y: number}, 
        strengthA: number,
        strengthB: number,
        environment: EnvironmentManager | null
    ): number {
        if (!posA || !posB) return RSSI_CONFIG.DISCONNECT_THRESHOLD - 10;
        return this.calculateTargetRSSI(posA, posB, strengthA, strengthB, environment).targetRSSI;
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

        // Use centralized calculation
        const stats = BitchatConnectionBLE.calculateTargetRSSI(
            posA, 
            posB, 
            this.endpointA.bluetoothStrength,
            this.endpointB.bluetoothStrength,
            this.environment
        );

        // Store detailed stats
        this.lastStats = stats;
        this.rssiTarget = stats.targetRSSI;

        // Add noise
        this.noisePhase += (now * 0.001) * (Math.PI * 2 / (RSSI_CONFIG.NOISE_PERIOD / 1000));
        const noise = Math.sin(this.noisePhase) * RSSI_CONFIG.NOISE_AMPLITUDE;

        // Smooth transition to target with noise
        const targetWithNoise = this.rssiTarget + noise;
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
