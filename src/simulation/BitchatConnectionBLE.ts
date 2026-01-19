import { BitchatConnection } from './BitchatConnection';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { BitchatDevice } from './BitchatDevice';

export class BitchatConnectionBLE extends BitchatConnection {
    // BLE specific properties (RSSI, etc.) can go here later

    send(packet: BitchatPacket, from: BitchatDevice): void {
        if (!this.isActive) return;

        const target = this.getOtherParty(from);
        
        // Simulate immediate delivery for now
        // In real sim, we might add a delay or drop chance
        target.receivePacket(packet, from);
    }
}
