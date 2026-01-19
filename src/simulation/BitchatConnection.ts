import { BitchatDevice } from './BitchatDevice';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { LogManager } from './LogManager';

export abstract class BitchatConnection {
    id: string;
    endpointA: BitchatDevice;
    endpointB: BitchatDevice;
    isActive: boolean = true;
    logger?: LogManager;
    
    // Stats
    packetsSent: number = 0;
    packetsReceived: number = 0;

    // Visualization callbacks
    onPacketSent?: (packet: BitchatPacket, from: BitchatDevice) => void;
    
    // Latency simulation
    protected packetQueue: Array<{
        packet: BitchatPacket;
        from: BitchatDevice;
        deliverAt: number;
    }> = [];
    protected latencyMs: number = 400; // Default 400ms

    constructor(endpointA: BitchatDevice, endpointB: BitchatDevice) {
        this.id = `${endpointA.peerIDHex}-${endpointB.peerIDHex}`;
        this.endpointA = endpointA;
        this.endpointB = endpointB;
    }
    
    setLogger(logger: LogManager) {
        this.logger = logger;
    }

    // Abstract method to send data
    abstract send(packet: BitchatPacket, from: BitchatDevice): void;
    
    // Update loop for latency processing
    update(now: number) {
        if (!this.isActive) return;
        
        // Process queue - iterate backwards to safely splice
        for (let i = this.packetQueue.length - 1; i >= 0; i--) {
            const item = this.packetQueue[i];
            if (now >= item.deliverAt) {
                // Deliver
                const target = this.getOtherParty(item.from);
                target.receivePacket(item.packet, item.from);
                this.packetsReceived++;
                
                // Remove
                this.packetQueue.splice(i, 1);
            }
        }
    }
    
    // Check if device is part of this connection

    involves(device: BitchatDevice): boolean {
        return this.endpointA === device || this.endpointB === device;
    }

    getOtherParty(me: BitchatDevice): BitchatDevice {
        return me === this.endpointA ? this.endpointB : this.endpointA;
    }

    close() {
        this.isActive = false;
    }
}
