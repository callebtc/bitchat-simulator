import { BitchatPerson } from './BitchatPerson';
import { SpatialManager } from './SpatialManager';
import { EventBus } from '../events/EventBus';
import { BitchatConnection } from './BitchatConnection';
import { BitchatConnectionBLE, RSSI_CONFIG } from './BitchatConnectionBLE';
import { LogManager } from './LogManager';
import { EnvironmentManager, PathFinder } from './environment';
import { SeededRandom } from './SeededRandom';
import { EventScheduler } from './EventScheduler';
import { TelemetryCollector } from './TelemetryCollector';
import { DeviceRuntime } from './BitchatDevice';

const CONNECT_RADIUS = 100;
const DISCONNECT_RADIUS = 110;
/** Padding distance from building walls for pathfinding (meters) */
const PATHFINDING_PADDING = 2.5;

export interface SimulationEngineOptions {
    /** Deterministic PRNG seed (default: 0x5eed1234) */
    seed?: number;
}

export class SimulationEngine {
    spatial: SpatialManager;
    events: EventBus;
    logManager: LogManager;
    environment: EnvironmentManager;
    pathFinder: PathFinder;
    rng: SeededRandom;
    scheduler: EventScheduler;
    telemetry: TelemetryCollector;

    /** Monotonic simulation clock in milliseconds (decoupled from wall clock). */
    simTimeMs: number = 0;

    private isRunning: boolean = false;
    private lastWallTime: number = 0;
    private accumulatedTime: number = 0;
    readonly FIXED_TIME_STEP = 0.05; // 50ms physics/RSSI tick
    private people: Map<string, BitchatPerson> = new Map();

    // Active connections keyed by connection.id
    private globalConnections: Map<string, BitchatConnection> = new Map();
    // Pending connections waiting for handshake/stability check
    private pendingConnections: Map<string, { conn: BitchatConnectionBLE; finalizeAt: number }> =
        new Map();

    private readonly initialSeed: number;

    constructor(options: SimulationEngineOptions = {}) {
        this.initialSeed = options.seed ?? 0x5eed1234;
        this.rng = new SeededRandom(this.initialSeed);
        this.scheduler = new EventScheduler();
        this.telemetry = new TelemetryCollector();
        this.spatial = new SpatialManager();
        this.events = new EventBus();
        this.logManager = new LogManager();
        this.logManager.setClock(() => this.simTimeMs);
        this.environment = new EnvironmentManager();
        this.pathFinder = new PathFinder();
    }

    createDeviceRuntime(): DeviceRuntime {
        return {
            clock: () => this.simTimeMs,
            scheduler: this.scheduler,
            rng: this.rng,
            telemetry: this.telemetry,
            getPopulationCount: () => this.people.size,
        };
    }

    addPerson(person: BitchatPerson): void {
        person.setLogger(this.logManager);
        person.environment = this.environment;
        person.pathFinder = this.pathFinder;
        person.setRng(this.rng.fork(`person:${person.id}`));
        person.device.attachRuntime(this.createDeviceRuntime());
        this.people.set(person.id, person);
        this.spatial.addPerson(person);
        this.events.emit('person_added', person);
        this.logManager.log('INFO', 'GLOBAL', `Added person ${person.id}`);
    }

    rebuildPathfindingGraph(): boolean {
        const buildings = this.environment.getBuildings();
        const loadedFromCache = this.pathFinder.buildVisibilityGraph(
            buildings,
            PATHFINDING_PADDING
        );

        if (loadedFromCache) {
            this.logManager.log(
                'INFO',
                'GLOBAL',
                `Pathfinding loaded from cache (${buildings.length} buildings)`
            );
        } else if (buildings.length > 0) {
            this.logManager.log(
                'INFO',
                'GLOBAL',
                `Pathfinding graph will be built (${buildings.length} buildings)`
            );
        }

        return loadedFromCache;
    }

    removePerson(id: string): void {
        const person = this.people.get(id);
        if (person) {
            person.device.appSimulator?.onGracefulStop?.(this.simTimeMs);
            this.globalConnections.forEach((conn, key) => {
                if (conn.involves(person.device)) {
                    this.breakConnection(key, conn);
                }
            });
            this.pendingConnections.forEach((pending, key) => {
                if (pending.conn.involves(person.device)) {
                    this.pendingConnections.delete(key);
                }
            });
        }

        this.people.delete(id);
        this.spatial.removePerson(id);
        this.events.emit('person_removed', id);
        this.logManager.log('INFO', 'GLOBAL', `Removed person ${id}`);
    }

    reset(newSeed?: number): void {
        this.globalConnections.forEach(conn => {
            conn.close();
        });
        this.globalConnections.clear();
        this.pendingConnections.clear();

        const ids = Array.from(this.people.keys());
        ids.forEach(id => {
            this.spatial.removePerson(id);
        });
        this.people.clear();

        this.simTimeMs = 0;
        this.rng = new SeededRandom(newSeed ?? this.initialSeed);
        this.scheduler.clear(0);
        this.telemetry.reset();
        this.logManager.clear();

        this.events.emit('reset', undefined);
        this.logManager.log('INFO', 'GLOBAL', 'Simulation Reset');
    }

    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastWallTime = performance.now();
        this.loop();
    }

    stop(): void {
        this.isRunning = false;
    }

    /**
     * Advance the simulation deterministically by `durationMs` in fixed increments.
     * Ideal for headless benchmarks and reproducible unit tests.
     */
    runFor(durationMs: number, stepMs: number = 50): void {
        const targetEnd = this.simTimeMs + Math.max(0, durationMs);
        while (this.simTimeMs + stepMs <= targetEnd) {
            this.step(stepMs / 1000, this.simTimeMs + stepMs);
        }
        const remainder = targetEnd - this.simTimeMs;
        if (remainder > 0.001) {
            this.step(remainder / 1000, targetEnd);
        }
    }

    /**
     * Advance one simulation step.
     * Uses monotonic simTimeMs (never wall clock).
     */
    step(dt: number, nowOverride?: number): void {
        const targetNow =
            nowOverride !== undefined ? nowOverride : this.simTimeMs + dt * 1000;
        this.simTimeMs = targetNow;

        // 1. Drain any sub-tick scheduled protocol events up to targetNow
        this.scheduler.drainUntil(targetNow);
        this.simTimeMs = targetNow;

        // 2. Update positions & device ticks
        this.people.forEach(person => {
            person.update(dt);
            person.device.tick(targetNow);
        });

        // 3. Update Spatial Grid
        this.spatial.updateAll();

        // 4. Update Connections (Latency queue + RSSI)
        this.updateConnectionsRSSI(targetNow);
        this.updatePendingConnections(targetNow);
        this.updateConnectivity(targetNow);

        // 5. Drain any zero-delay events scheduled during this tick
        this.scheduler.drainUntil(targetNow);
        this.simTimeMs = targetNow;

        this.events.emit('tick', this.people);
    }

    private updatePendingConnections(now: number): void {
        const toFinalize: string[] = [];
        const toDrop: string[] = [];

        this.pendingConnections.forEach((pending, key) => {
            const { conn, finalizeAt } = pending;

            const stable = conn.updateRSSI(now);

            let distanceOk = true;
            if (conn.endpointA.position && conn.endpointB.position) {
                const dx = conn.endpointA.position.x - conn.endpointB.position.x;
                const dy = conn.endpointA.position.y - conn.endpointB.position.y;
                if (Math.sqrt(dx * dx + dy * dy) > DISCONNECT_RADIUS) {
                    distanceOk = false;
                }
            }

            if (!stable || !distanceOk) {
                toDrop.push(key);
                return;
            }

            if (now >= finalizeAt) {
                toFinalize.push(key);
            }
        });

        toDrop.forEach(key => {
            this.pendingConnections.delete(key);
            this.telemetry.recordConnectionFailed();
        });

        toFinalize.forEach(key => {
            const pending = this.pendingConnections.get(key);
            if (pending) {
                this.pendingConnections.delete(key);
                this.finalizeConnection(key, pending.conn, now);
            }
        });
    }

    private updateConnectivity(now: number): void {
        const peopleList = Array.from(this.people.values());
        const processedPairs = new Set<string>();

        for (const p1 of peopleList) {
            const neighbors = this.spatial.getNeighbors(p1, DISCONNECT_RADIUS);

            for (const p2 of neighbors) {
                const key = this.getConnectionKey(p1.device.peerIDHex, p2.device.peerIDHex);
                if (processedPairs.has(key)) continue;
                processedPairs.add(key);

                const existingConn = this.globalConnections.get(key);
                const pendingConn = this.pendingConnections.get(key);

                const dx = p1.position.x - p2.position.x;
                const dy = p1.position.y - p2.position.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (existingConn) {
                    if (dist > DISCONNECT_RADIUS || !existingConn.isActive) {
                        this.breakConnection(key, existingConn);
                    }
                } else if (pendingConn) {
                    // Handled in updatePendingConnections
                } else if (dist < CONNECT_RADIUS) {
                    const estimatedRSSI = BitchatConnectionBLE.estimateRSSI(
                        p1.position,
                        p2.position,
                        p1.device.bluetoothStrength,
                        p2.device.bluetoothStrength,
                        this.environment
                    );
                    if (estimatedRSSI <= RSSI_CONFIG.DISCONNECT_THRESHOLD) {
                        continue;
                    }

                    let initiator: BitchatPerson | null = null;

                    if (
                        p1.device.isScanning &&
                        p1.device.connectionManager.canAcceptConnection(true) &&
                        p2.device.connectionManager.canAcceptConnection(false)
                    ) {
                        initiator = p1;
                    } else if (
                        p2.device.isScanning &&
                        p2.device.connectionManager.canAcceptConnection(true) &&
                        p1.device.connectionManager.canAcceptConnection(false)
                    ) {
                        initiator = p2;
                    }

                    if (initiator) {
                        this.initiateConnection(key, p1, p2, initiator.device, now, estimatedRSSI);
                    }
                }
            }
        }

        this.globalConnections.forEach((conn, key) => {
            if (!processedPairs.has(key)) {
                if (!conn.endpointA.position || !conn.endpointB.position) return;
                const dx = conn.endpointA.position.x - conn.endpointB.position.x;
                const dy = conn.endpointA.position.y - conn.endpointB.position.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > DISCONNECT_RADIUS || !conn.isActive) {
                    this.breakConnection(key, conn);
                }
            }
        });
    }

    private loop = (): void => {
        if (!this.isRunning) return;

        const wallNow = performance.now();
        const dt = (wallNow - this.lastWallTime) / 1000;
        this.lastWallTime = wallNow;

        const safeDt = Math.min(dt, 0.25);
        this.accumulatedTime += safeDt;

        while (this.accumulatedTime >= this.FIXED_TIME_STEP) {
            this.step(this.FIXED_TIME_STEP);
            this.accumulatedTime -= this.FIXED_TIME_STEP;
        }

        requestAnimationFrame(this.loop);
    };

    getPerson(id: string): BitchatPerson | undefined {
        return this.people.get(id);
    }

    getAllPeople(): BitchatPerson[] {
        return Array.from(this.people.values());
    }

    getAllConnections(): BitchatConnection[] {
        return Array.from(this.globalConnections.values());
    }

    private updateConnectionsRSSI(now: number): void {
        const connectionsToBreak: string[] = [];

        this.globalConnections.forEach((conn, key) => {
            conn.update(now);

            if (conn instanceof BitchatConnectionBLE) {
                const shouldRemain = conn.updateRSSI(now);
                if (!shouldRemain) {
                    connectionsToBreak.push(key);
                    this.logManager.log(
                        'INFO',
                        'CONNECTION',
                        `Signal lost (RSSI: ${conn.rssi.toFixed(1)} dBm)`,
                        conn.id
                    );
                }
            }
        });

        for (const key of connectionsToBreak) {
            const conn = this.globalConnections.get(key);
            if (conn) {
                this.breakConnection(key, conn);
            }
        }
    }

    private getConnectionKey(id1: string, id2: string): string {
        return id1 < id2 ? `${id1}-${id2}` : `${id2}-${id1}`;
    }

    private initiateConnection(
        key: string,
        p1: BitchatPerson,
        p2: BitchatPerson,
        initiator: BitchatPerson['device'],
        now: number,
        initialRSSI: number
    ): void {
        const connRng = this.rng.fork(`conn:${key}:${now}`);
        const conn = new BitchatConnectionBLE(p1.device, p2.device, initiator, connRng);
        conn.setLogger(this.logManager);
        conn.environment = this.environment;
        conn.rssi = initialRSSI;
        conn.attachRuntime({
            clock: () => this.simTimeMs,
            scheduler: this.scheduler,
            rng: connRng,
            telemetry: this.telemetry,
            createdAtMs: now,
        });

        conn.onPacketSent = (packet, from) => {
            this.events.emit('packet_transmitted', {
                connectionId: conn.id,
                packet,
                fromId: from.peerIDHex,
            });
        };

        this.telemetry.recordConnectionInitiated();
        this.pendingConnections.set(key, {
            conn,
            finalizeAt: now + 100,
        });
    }

    private finalizeConnection(key: string, conn: BitchatConnectionBLE, now: number): void {
        const p1Dev = conn.endpointA;
        const p2Dev = conn.endpointB;
        const isP1Client = conn.initiator === p1Dev;

        if (
            !p1Dev.connectionManager.canAcceptConnection(isP1Client) ||
            !p2Dev.connectionManager.canAcceptConnection(!isP1Client)
        ) {
            this.telemetry.recordConnectionFailed();
            this.logManager.log(
                'INFO',
                'CONNECTION',
                'Connection Failed (Slots Full during pending)',
                conn.id
            );
            return;
        }

        this.globalConnections.set(key, conn);
        p1Dev.connectionManager.addConnection(conn);
        p2Dev.connectionManager.addConnection(conn);
        this.telemetry.recordConnectionFormed(false);

        p1Dev.appSimulator?.onConnectionEstablished?.(conn, now);
        p2Dev.appSimulator?.onConnectionEstablished?.(conn, now);

        this.events.emit('connection_formed', conn);
        this.logManager.log('INFO', 'CONNECTION', 'Connection Formed', conn.id, {
            between: [p1Dev.nickname, p2Dev.nickname],
        });
    }

    private breakConnection(key: string, conn: BitchatConnection): void {
        conn.close();
        conn.endpointA.connectionManager.removeConnection(conn.id);
        conn.endpointB.connectionManager.removeConnection(conn.id);

        this.globalConnections.delete(key);
        this.telemetry.recordConnectionBroken();

        conn.endpointA.appSimulator?.onConnectionBroken?.(conn, this.simTimeMs);
        conn.endpointB.appSimulator?.onConnectionBroken?.(conn, this.simTimeMs);

        this.events.emit('connection_broken', conn);
        this.logManager.log('INFO', 'CONNECTION', 'Connection Broken', conn.id);
    }
}
