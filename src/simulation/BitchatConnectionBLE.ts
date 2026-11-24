import { BitchatConnection } from './BitchatConnection';
import { BitchatPacket, toHex } from '../protocol/BitchatPacket';
import { BinaryProtocol } from '../protocol/BinaryProtocol';
import { BitchatDevice } from './BitchatDevice';
import { EnvironmentManager, calculateLineAttenuationStats } from './environment';
import { SeededRandom } from './SeededRandom';

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
    private lastRssiUpdateMs: number | null = null;

    // Detailed stats for UI
    lastStats: RSSIStats | null = null;

    // Environment reference (set by SimulationEngine)
    environment: EnvironmentManager | null = null;

    constructor(
        endpointA: BitchatDevice,
        endpointB: BitchatDevice,
        initiator?: BitchatDevice,
        rng?: SeededRandom,
        linkID?: string
    ) {
        super(endpointA, endpointB, initiator, 'BLE', linkID);
        this.rng = rng;
        // Initialize noise phase deterministically when rng is supplied
        this.noisePhase = (rng ? rng.next() : Math.random()) * Math.PI * 2;

        if (endpointA.position && endpointB.position) {
            const { targetRSSI } = BitchatConnectionBLE.calculateTargetRSSI(
                endpointA.position,
                endpointB.position,
                endpointA.bluetoothStrength,
                endpointB.bluetoothStrength,
                null
            );
            this.rssi = targetRSSI;
            this.rssiTarget = targetRSSI;
        }
    }

    static calculateTargetRSSI(
        posA: { x: number; y: number },
        posB: { x: number; y: number },
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

        // 3. Bluetooth Strength Gain (50 = 0 dB, 100 = +3 dB, 25 = -3 dB)
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
            totalLoss: pathLoss + wallLoss + materialLoss - totalGain,
            targetRSSI,
        };
    }

    static estimateRSSI(
        posA: { x: number; y: number },
        posB: { x: number; y: number },
        strengthA: number,
        strengthB: number,
        environment: EnvironmentManager | null
    ): number {
        if (!posA || !posB) return RSSI_CONFIG.DISCONNECT_THRESHOLD - 10;
        return this.calculateTargetRSSI(posA, posB, strengthA, strengthB, environment).targetRSSI;
    }

    send(packet: BitchatPacket, from: BitchatDevice, nowMs?: number): boolean {
        if (!this.isActive) return false;

        const now = nowMs ?? this.clock();
        const encoded = BinaryProtocol.encode(packet);
        const wireBytes = encoded ? encoded.length : packet.payload.length + 22;

        this.packetsSent++;
        this.bytesSent += wireBytes;
        this.lastActivityAtMs = now;

        const isRelay = from.peerIDHex !== toHex(packet.senderID);
        this.telemetry?.recordPacketTransmitted(now, wireBytes, isRelay);

        if (this.onPacketSent) {
            this.onPacketSent(packet, from);
        }

        this.packetQueue.push({
            packet,
            from,
            deliverAt: now + this.latencyMs,
        });
        return true;
    }

    /**
     * Update RSSI based on current positions and environment.
     * Advances noisePhase strictly by elapsed dt (fixing previous absolute-now bug).
     */
    updateRSSI(now: number): boolean {
        if (!this.isActive) return false;

        const posA = this.endpointA.position;
        const posB = this.endpointB.position;

        if (!posA || !posB) {
            return true;
        }

        const stats = BitchatConnectionBLE.calculateTargetRSSI(
            posA,
            posB,
            this.endpointA.bluetoothStrength,
            this.endpointB.bluetoothStrength,
            this.environment
        );

        this.lastStats = stats;
        this.rssiTarget = stats.targetRSSI;

        // Advance sinusoidal fading phase by elapsed dt in seconds
        const dtSec =
            this.lastRssiUpdateMs !== null ? Math.max(0, (now - this.lastRssiUpdateMs) * 0.001) : 0;
        this.lastRssiUpdateMs = now;
        this.noisePhase =
            (this.noisePhase + dtSec * ((Math.PI * 2) / (RSSI_CONFIG.NOISE_PERIOD / 1000))) %
            (Math.PI * 2);

        const noise = Math.sin(this.noisePhase) * RSSI_CONFIG.NOISE_AMPLITUDE;
        const targetWithNoise = this.rssiTarget + noise;
        this.rssi = this.rssi + (targetWithNoise - this.rssi) * RSSI_CONFIG.SMOOTHING_FACTOR;

        if (this.rssi < RSSI_CONFIG.DISCONNECT_THRESHOLD) {
            return false;
        }

        return true;
    }

    getRSSINormalized(): number {
        const range = RSSI_CONFIG.MAX_RSSI - RSSI_CONFIG.DISCONNECT_THRESHOLD;
        const value = (this.rssi - RSSI_CONFIG.DISCONNECT_THRESHOLD) / range;
        return Math.max(0, Math.min(1, value));
    }

    getTargetRSSI(): number {
        return this.rssiTarget;
    }
}
