import { ConnectionManager } from './ConnectionManager';
import { BitchatPacket } from '../protocol/BitchatPacket';
// import { BitchatAppSimulator } from './AppLayer/BitchatAppSimulator'; // Circular, avoid explicit type if possible or use interface

import { Point } from './types';

export interface DeviceTickable {
    tick(now: number): void;
}

export class BitchatDevice {
    readonly peerID: Uint8Array;
    nickname: string;
    connectionManager: ConnectionManager;
    appSimulator?: DeviceTickable;
    position?: Point; // Simulation hack for visualization
    
    // Callbacks
    onPacketReceived?: (packet: BitchatPacket, from: BitchatDevice) => void;

    constructor(peerID: Uint8Array, nickname: string) {
        this.peerID = peerID;
        this.nickname = nickname;
        this.connectionManager = new ConnectionManager(this);
    }
    
    setAppSimulator(sim: DeviceTickable) {
        this.appSimulator = sim;
    }

    tick(now: number) {
        if (this.appSimulator) {
            this.appSimulator.tick(now);
        }
    }

    get peerIDHex(): string {
        return Array.from(this.peerID)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
    
    receivePacket(packet: BitchatPacket, from: BitchatDevice) {
        // Hand off to AppSimulator layer (via callback for now)
        if (this.onPacketReceived) {
            this.onPacketReceived(packet, from);
        }
    }

    // Helper to generate a random device
    static createRandom(): BitchatDevice {
        const id = new Uint8Array(8);
        crypto.getRandomValues(id);
        const hex = Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('');
        return new BitchatDevice(id, `User-${hex.substring(0, 4)}`);
    }
}
