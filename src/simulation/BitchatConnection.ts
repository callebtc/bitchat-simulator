import { BitchatDevice } from './BitchatDevice';
import { BitchatPacket } from '../protocol/BitchatPacket';

export abstract class BitchatConnection {
    id: string;
    endpointA: BitchatDevice;
    endpointB: BitchatDevice;
    isActive: boolean = true;
    
    // Visualization callbacks
    onPacketSent?: (packet: BitchatPacket, from: BitchatDevice) => void;

    constructor(endpointA: BitchatDevice, endpointB: BitchatDevice) {
        this.id = `${endpointA.peerIDHex}-${endpointB.peerIDHex}`;
        this.endpointA = endpointA;
        this.endpointB = endpointB;
    }

    // Abstract method to send data
    abstract send(packet: BitchatPacket, from: BitchatDevice): void;
    
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
