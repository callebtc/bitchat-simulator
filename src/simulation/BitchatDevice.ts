import { ConnectionManager } from './ConnectionManager';
import { BitchatPacket, toHex } from '../protocol/BitchatPacket';
import { LogManager } from './LogManager';
import { Point } from './types';
import { SeededRandom } from './SeededRandom';
import { EventScheduler } from './EventScheduler';
import { TelemetryCollector } from './TelemetryCollector';
import { BitchatConnection } from './BitchatConnection';
import { BlePowerProfile, resolveBlePowerProfile } from './PowerProfile';

export enum PowerMode {
    ECO = 'ECO',
    NORMAL = 'NORMAL',
    PERFORMANCE = 'PERFORMANCE',
    ULTRA_LOW_POWER = 'ULTRA_LOW_POWER',
}

export interface ConnectionSettings {
    maxClients: number;
    maxServers: number;
    maxTotal: number;
}

export const SCAN_INTERVALS: Record<PowerMode, number> = {
    [PowerMode.ECO]: 30_000,
    [PowerMode.NORMAL]: 10_000,
    [PowerMode.PERFORMANCE]: 10_000,
    [PowerMode.ULTRA_LOW_POWER]: 30_000,
};

export interface DeviceRuntime {
    clock: () => number;
    scheduler: EventScheduler;
    rng: SeededRandom;
    telemetry: TelemetryCollector;
    getPopulationCount?: () => number;
}

export interface DeviceTickable {
    tick(now: number): void;
    setLogger?(logger: LogManager): void;
    attachRuntime?(runtime: DeviceRuntime): void;
    onConnectionEstablished?(connection: BitchatConnection, nowMs: number): void;
    onConnectionBroken?(connection: BitchatConnection, nowMs: number): void;
    onGracefulStop?(nowMs: number): void;
    shouldCollapseDuplicateLinks?(): boolean;
}

export class BitchatDevice {
    readonly peerID: Uint8Array;
    readonly peerIDHex: string;
    /** Symbolic 32-byte Curve25519 static public key for realistic wire sizing */
    readonly noisePublicKey: Uint8Array;
    /** Symbolic 32-byte Ed25519 signing public key for realistic wire sizing */
    readonly signingPublicKey: Uint8Array;
    nickname: string;
    connectionManager: ConnectionManager;
    appSimulator?: DeviceTickable;
    position?: Point;
    logger?: LogManager;
    runtime?: DeviceRuntime;
    rng: SeededRandom;

    // Power & Scanning (Android PowerManager duty-cycle model)
    powerMode: PowerMode = PowerMode.NORMAL;
    isBackground: boolean = false;
    bluetoothStrength: number = 50; // 0-100, 50 is baseline
    /** Optional Wi-Fi Aware hardware capability (Phase 5) */
    wifiAwareEnabled: boolean = false;
    isScanning: boolean = false;
    alwaysScan: boolean = false; // Override for deterministic unit tests

    private scanPhaseOffsetMs: number = -1;

    // Limits
    connectionSettings: ConnectionSettings = {
        maxClients: 8,
        maxServers: 8,
        maxTotal: 8,
    };

    // Callbacks
    onPacketReceived?: (
        packet: BitchatPacket,
        from: BitchatDevice,
        connection?: BitchatConnection
    ) => void;

    constructor(peerID: Uint8Array, nickname: string, rng?: SeededRandom) {
        this.peerID = peerID;
        this.peerIDHex = toHex(peerID);
        this.nickname = nickname;
        this.rng =
            rng ??
            new SeededRandom(
                0x13370001 ^
                    (peerID[0] << 24) ^
                    (peerID[1] << 16) ^
                    (peerID[2] << 8) ^
                    peerID[3]
            );
        this.noisePublicKey = this.rng.fork('noise-pk').nextBytes(32);
        this.signingPublicKey = this.rng.fork('sign-pk').nextBytes(32);
        this.connectionManager = new ConnectionManager(this);
    }

    attachRuntime(runtime: DeviceRuntime): void {
        this.runtime = runtime;
        this.rng = runtime.rng.fork(`device:${this.peerIDHex}`);
        this.appSimulator?.attachRuntime?.(runtime);
    }

    now(): number {
        return this.runtime ? this.runtime.clock() : 0;
    }

    getBlePowerProfile(): BlePowerProfile {
        const hasDirectPeers = this.connectionManager.getActiveConnections().length > 0;
        return resolveBlePowerProfile(this.powerMode, this.isBackground, hasDirectPeers);
    }

    getScanRssiThreshold(): number {
        return this.getBlePowerProfile().rssiThresholdDbm;
    }

    setPowerMode(mode: PowerMode): void {
        this.powerMode = mode;
        this.logger?.log('INFO', 'DEVICE', `Power Mode set to ${mode}`, this.peerIDHex);
    }

    updateSettings(settings: Partial<ConnectionSettings>): void {
        this.connectionSettings = { ...this.connectionSettings, ...settings };
        this.connectionManager.enforceLimits();
        this.logger?.log(
            'INFO',
            'DEVICE',
            'Connection Limits updated',
            this.peerIDHex,
            this.connectionSettings
        );
    }

    setLogger(logger: LogManager): void {
        this.logger = logger;
        this.connectionManager.setLogger(logger);
        if (this.appSimulator?.setLogger) {
            this.appSimulator.setLogger(logger);
        }
    }

    setAppSimulator(sim: DeviceTickable): void {
        this.appSimulator = sim;
        if (this.logger && sim.setLogger) {
            sim.setLogger(this.logger);
        }
        if (this.runtime && sim.attachRuntime) {
            sim.attachRuntime(this.runtime);
        }
    }

    tick(now: number): void {
        if (this.appSimulator) {
            this.appSimulator.tick(now);
        }

        // Android PowerManager BLE scan ON/OFF duty cycling
        if (this.alwaysScan) {
            this.isScanning = true;
            return;
        }

        const profile = this.getBlePowerProfile();
        if (profile.continuousScan) {
            this.isScanning = true;
            return;
        }

        const cycleMs = profile.scanOnMs + profile.scanOffMs;
        if (this.scanPhaseOffsetMs < 0) {
            // Desynchronize devices across the scan duty cycle
            this.scanPhaseOffsetMs = this.rng.next() * cycleMs;
        }
        const phase = (now + this.scanPhaseOffsetMs) % cycleMs;
        this.isScanning = phase < profile.scanOnMs;
    }

    receivePacket(
        packet: BitchatPacket,
        from: BitchatDevice,
        connection?: BitchatConnection
    ): void {
        if (this.onPacketReceived) {
            this.onPacketReceived(packet, from, connection);
        }
    }

    static createRandom(rng?: SeededRandom): BitchatDevice {
        let id: Uint8Array;
        if (rng) {
            id = rng.nextBytes(8);
        } else {
            id = new Uint8Array(8);
            crypto.getRandomValues(id);
        }
        const hex = toHex(id);
        const device = new BitchatDevice(id, `User-${hex.substring(0, 4)}`, rng?.fork(`dev:${hex}`));
        device.bluetoothStrength = 25 + (rng ? rng.next() : Math.random()) * 75;
        return device;
    }
}
