import { BitchatDevice } from './BitchatDevice';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { LogManager } from './LogManager';
import { EventScheduler } from './EventScheduler';
import { SeededRandom } from './SeededRandom';
import { TelemetryCollector } from './TelemetryCollector';

export type TransportKind = 'BLE' | 'WIFI_AWARE';

export abstract class BitchatConnection {
    id: string;
    readonly linkID: string;
    readonly transportType: TransportKind;
    endpointA: BitchatDevice;
    endpointB: BitchatDevice;
    initiator: BitchatDevice; // Client role (initiator)
    isActive: boolean = true;
    isReady: boolean = true;
    createdAtMs: number = 0;
    lastActivityAtMs: number = 0;
    logger?: LogManager;

    protected clock: () => number = () => 0;
    protected scheduler?: EventScheduler;
    protected rng?: SeededRandom;
    protected telemetry?: TelemetryCollector;

    // Stats
    packetsSent: number = 0;
    packetsReceived: number = 0;
    bytesSent: number = 0;
    packetsDropped: number = 0;

    // Visualization callbacks
    onPacketSent?: (packet: BitchatPacket, from: BitchatDevice) => void;

    // Latency simulation queue (used by subclasses that don't override with scheduler)
    protected packetQueue: Array<{
        packet: BitchatPacket;
        from: BitchatDevice;
        deliverAt: number;
    }> = [];
    protected latencyMs: number = 400;

    constructor(
        endpointA: BitchatDevice,
        endpointB: BitchatDevice,
        initiator?: BitchatDevice,
        transportType: TransportKind = 'BLE',
        linkID?: string
    ) {
        this.endpointA = endpointA;
        this.endpointB = endpointB;
        this.initiator = initiator || endpointA;
        this.transportType = transportType;
        this.linkID = linkID || `${transportType}:${this.initiator.peerIDHex}->${this.getOtherParty(this.initiator).peerIDHex}`;
        this.id = linkID || `${endpointA.peerIDHex}-${endpointB.peerIDHex}`;
    }

    attachRuntime(runtime: {
        clock: () => number;
        scheduler?: EventScheduler;
        rng?: SeededRandom;
        telemetry?: TelemetryCollector;
        createdAtMs?: number;
    }): void {
        this.clock = runtime.clock;
        this.scheduler = runtime.scheduler;
        this.rng = runtime.rng;
        this.telemetry = runtime.telemetry;
        if (runtime.createdAtMs !== undefined) {
            this.createdAtMs = runtime.createdAtMs;
            this.lastActivityAtMs = runtime.createdAtMs;
        }
    }

    setLogger(logger: LogManager): void {
        this.logger = logger;
    }

    /** Send a packet from one endpoint across this link. Returns true if accepted/queued. */
    abstract send(packet: BitchatPacket, from: BitchatDevice, nowMs?: number): boolean;

    /** Update loop for queued latency processing. */
    update(now: number): void {
        if (!this.isActive) return;

        for (let i = this.packetQueue.length - 1; i >= 0; i--) {
            const item = this.packetQueue[i];
            if (now >= item.deliverAt) {
                const target = this.getOtherParty(item.from);
                this.packetQueue.splice(i, 1);
                this.packetsReceived++;
                this.lastActivityAtMs = now;
                this.telemetry?.recordPacketDeliveredOnLink();
                target.receivePacket(item.packet, item.from, this);
            }
        }
    }

    involves(device: BitchatDevice): boolean {
        return this.endpointA === device || this.endpointB === device;
    }

    getOtherParty(me: BitchatDevice): BitchatDevice {
        return me === this.endpointA ? this.endpointB : this.endpointA;
    }

    getClient(): BitchatDevice {
        return this.initiator;
    }

    getServer(): BitchatDevice {
        return this.getOtherParty(this.initiator);
    }

    close(): void {
        this.isActive = false;
        this.isReady = false;
        this.packetQueue.length = 0;
    }
}
