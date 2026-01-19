import { BitchatConnection } from './BitchatConnection';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { BitchatDevice } from './BitchatDevice';

export class BitchatConnectionBLE extends BitchatConnection {
    // BLE specific properties (RSSI, etc.) can go here later

    send(packet: BitchatPacket, from: BitchatDevice): void {
        if (!this.isActive) return;

        // const target = this.getOtherParty(from);
        
        this.packetsSent++;
        
        // Visualize immediately (so we see it leave the sender)
        if (this.onPacketSent) {
            this.onPacketSent(packet, from);
        }

        // Simulate network latency
        // Use performance.now() which is what the engine uses
        const now = performance.now();
        this.packetQueue.push({
            packet,
            from,
            deliverAt: now + this.latencyMs
        });
        
        // Removed immediate delivery:
        // target.receivePacket(packet, from);
        // this.packetsReceived++; // Will be incremented in update() on delivery
    }
}
