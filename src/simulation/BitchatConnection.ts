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
