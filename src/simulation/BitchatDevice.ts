import { ConnectionManager } from './ConnectionManager';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { LogManager } from './LogManager';
import { Point } from './types';

export enum PowerMode {
    ECO = 'ECO',
    NORMAL = 'NORMAL',
    PERFORMANCE = 'PERFORMANCE'
}

export interface ConnectionSettings {
    maxClients: number;
    maxServers: number;
    maxTotal: number;
}

export const SCAN_INTERVALS: Record<PowerMode, number> = {
    [PowerMode.ECO]: 60000,
    [PowerMode.NORMAL]: 30000,
    [PowerMode.PERFORMANCE]: 10000
};

export interface DeviceTickable {
    tick(now: number): void;
    setLogger?(logger: LogManager): void;
}

export class BitchatDevice {
    readonly peerID: Uint8Array;
    nickname: string;
    connectionManager: ConnectionManager;
    appSimulator?: DeviceTickable;
    position?: Point; 
    logger?: LogManager;
    
    // Power & Scanning
    powerMode: PowerMode = PowerMode.PERFORMANCE;
    lastScanTime: number = -1;
    // The delay until the next scan, randomized each cycle to prevent synchronization
    currentScanDelay: number = -1;
    isScanning: boolean = false;
    alwaysScan: boolean = false; // For testing
    
    // Limits
    connectionSettings: ConnectionSettings = {
        maxClients: 8,
        maxServers: 8,
        maxTotal: 8
    };
    
    // Callbacks
    onPacketReceived?: (packet: BitchatPacket, from: BitchatDevice) => void;

    constructor(peerID: Uint8Array, nickname: string) {
        this.peerID = peerID;
        this.nickname = nickname;
        this.connectionManager = new ConnectionManager(this);
    }
    
    setPowerMode(mode: PowerMode) {
        this.powerMode = mode;
        this.logger?.log('INFO', 'DEVICE', `Power Mode set to ${mode}`, this.peerIDHex);
    }
    
    updateSettings(settings: Partial<ConnectionSettings>) {
        this.connectionSettings = { ...this.connectionSettings, ...settings };
        this.connectionManager.enforceLimits();
        this.logger?.log('INFO', 'DEVICE', `Connection Limits updated`, this.peerIDHex, this.connectionSettings);
    }
    
    setLogger(logger: LogManager) {
        this.logger = logger;
        this.connectionManager.setLogger(logger);
        if (this.appSimulator?.setLogger) {
            this.appSimulator.setLogger(logger);
        }
    }
    
    setAppSimulator(sim: DeviceTickable) {
        this.appSimulator = sim;
        if (this.logger && sim.setLogger) {
            sim.setLogger(this.logger);
        }
    }

    tick(now: number) {
        // App Logic
        if (this.appSimulator) {
            this.appSimulator.tick(now);
        }
        
        // Scanning Logic
        this.isScanning = this.alwaysScan;
        const baseInterval = SCAN_INTERVALS[this.powerMode];
        
        if (this.lastScanTime === -1) {
            // First tick initialization
            this.lastScanTime = now;
            // Initial random offset to desynchronize start times
            this.currentScanDelay = Math.random() * baseInterval;
        }

        if (now - this.lastScanTime > this.currentScanDelay) {
            this.isScanning = true;
            this.lastScanTime = now;
            
            // Calculate next delay: Base Interval ± 20% Jitter
            // This prevents "thundering herd" re-synchronization after CPU lags
            const jitter = (Math.random() - 0.5) * 0.4; // -0.2 to +0.2
            this.currentScanDelay = baseInterval * (1 + jitter);
        }
    }

    get peerIDHex(): string {
        return Array.from(this.peerID)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
    
    receivePacket(packet: BitchatPacket, from: BitchatDevice) {
        if (this.onPacketReceived) {
            this.onPacketReceived(packet, from);
        }
    }

    static createRandom(): BitchatDevice {
        const id = new Uint8Array(8);
        crypto.getRandomValues(id);
        const hex = Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('');
        return new BitchatDevice(id, `User-${hex.substring(0, 4)}`);
    }
}
