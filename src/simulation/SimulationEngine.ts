import { BitchatPerson } from './BitchatPerson';
import { BitchatDevice, DeviceRuntime } from './BitchatDevice';
import { SpatialManager } from './SpatialManager';
import { EventBus } from '../events/EventBus';
import { BitchatConnection, TransportKind } from './BitchatConnection';
import { BitchatPacket, MessageType } from '../protocol/BitchatPacket';
import { BitchatConnectionBLE, RSSI_CONFIG } from './BitchatConnectionBLE';
import { BitchatConnectionWifiAware, WIFI_AWARE_CONFIG } from './BitchatConnectionWifiAware';
import { LogManager } from './LogManager';
import { EnvironmentManager, PathFinder } from './environment';
import { SeededRandom } from './SeededRandom';
import { EventScheduler } from './EventScheduler';
import { TelemetryCollector } from './TelemetryCollector';
import { RadioMedium, RadioMediumConfig } from './RadioMedium';

const CONNECT_RADIUS = 100;
const DISCONNECT_RADIUS = 110;
const PATHFINDING_PADDING = 2.5;

// Android MeshConnectionTracker retry & GATT setup constants
const CONNECTION_RETRY_DELAY_MS = 5_000;
const MAX_CONNECTION_ATTEMPTS = 3;
const CONNECTION_ATTEMPT_EXPIRY_MS = CONNECTION_RETRY_DELAY_MS * 2;
const DEFAULT_GATT_HANDSHAKE_MS = 500; // 200ms MTU(517) + 100ms discover/CCCD + 200ms ready

// Scaling thresholds: <= 100 nodes run full 20 Hz; > 100 nodes stagger discovery & RSSI across 5 buckets (4 Hz)
const STAGGER_POPULATION_THRESHOLD = 100;
const STAGGER_BUCKETS = 5;
const LARGE_CROWD_MAX_NEIGHBOR_SAMPLE = 24;

export interface SimulationEngineOptions {
    seed?: number;
    gattHandshakeMs?: number;
    wifiAwareHandshakeMs?: number;
    allowDualRoleLinks?: boolean;
    radioMediumConfig?: Partial<RadioMediumConfig>;
}

interface PendingHandshake {
    conn: BitchatConnectionBLE | BitchatConnectionWifiAware;
    finalizeAt: number;
}

interface ConnectionAttemptRecord {
    attempts: number;
    lastAttemptMs: number;
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
    radioMedium: RadioMedium;

    /** Monotonic simulation clock in milliseconds (decoupled from wall clock). */
    simTimeMs: number = 0;

    private isRunning: boolean = false;
    private lastWallTime: number = 0;
    private accumulatedTime: number = 0;
    private tickCounter: number = 0;
    private visualPktsEmittedThisTick: number = 0;
    readonly FIXED_TIME_STEP = 0.05; // 50ms physics/RSSI tick

    private people: Map<string, BitchatPerson> = new Map();
    private personByPeerId: Map<string, BitchatPerson> = new Map();

    // Active connections keyed by linkID + cached dense list for zero-alloc rendering
    private globalConnections: Map<string, BitchatConnection> = new Map();
    private connectionsListCache: BitchatConnection[] = [];
    private connectionsDirty: boolean = false;

    // Pending BLE GATT / Wi-Fi Aware handshakes keyed by linkID
    private pendingConnections: Map<string, PendingHandshake> = new Map();
    // O(1) pending slot counters per device & transport (eliminates O(P) inner-loop scans)
    private pendingBleClients: Map<string, number> = new Map();
    private pendingBleServers: Map<string, number> = new Map();
    private pendingWifiClients: Map<string, number> = new Map();
    private pendingWifiServers: Map<string, number> = new Map();

    // MeshConnectionTracker retry/backoff state keyed by linkID
    private attemptTracker: Map<string, ConnectionAttemptRecord> = new Map();

    private readonly initialSeed: number;
    readonly gattHandshakeMs: number;
    readonly wifiAwareHandshakeMs: number;
    readonly allowDualRoleLinks: boolean;

    constructor(options: SimulationEngineOptions = {}) {
        this.initialSeed = options.seed ?? 0x5eed1234;
        this.gattHandshakeMs = options.gattHandshakeMs ?? DEFAULT_GATT_HANDSHAKE_MS;
        this.wifiAwareHandshakeMs = options.wifiAwareHandshakeMs ?? WIFI_AWARE_CONFIG.HANDSHAKE_MS;
        this.allowDualRoleLinks = options.allowDualRoleLinks ?? true;
        this.rng = new SeededRandom(this.initialSeed);
        this.scheduler = new EventScheduler();
        this.telemetry = new TelemetryCollector();
        this.radioMedium = new RadioMedium(options.radioMediumConfig);
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
        this.personByPeerId.set(person.device.peerIDHex, person);
        this.spatial.addPerson(person);
        this.logManager.suppressDebug = this.people.size > STAGGER_POPULATION_THRESHOLD;
        this.events.emit('person_added', person);
        if (this.people.size <= STAGGER_POPULATION_THRESHOLD) {
            this.logManager.log('INFO', 'GLOBAL', `Added person ${person.id}`);
        }
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
            const pendingToRemove: string[] = [];
            this.pendingConnections.forEach((pending, key) => {
                if (pending.conn.involves(person.device)) {
                    pendingToRemove.push(key);
                }
            });
            for (const key of pendingToRemove) {
                this.deletePending(key);
            }
            this.personByPeerId.delete(person.device.peerIDHex);
        }

        this.people.delete(id);
        this.spatial.removePerson(id);
        this.logManager.suppressDebug = this.people.size > STAGGER_POPULATION_THRESHOLD;
        this.events.emit('person_removed', id);
        this.logManager.log('INFO', 'GLOBAL', `Removed person ${id}`);
    }

    reset(newSeed?: number): void {
        this.globalConnections.forEach(conn => {
            conn.close();
        });
        this.globalConnections.clear();
        this.connectionsListCache = [];
        this.connectionsDirty = false;
        this.pendingConnections.clear();
        this.pendingBleClients.clear();
        this.pendingBleServers.clear();
        this.pendingWifiClients.clear();
        this.pendingWifiServers.clear();
        this.attemptTracker.clear();

        const ids = Array.from(this.people.keys());
        for (let i = 0; i < ids.length; i++) {
            this.spatial.removePerson(ids[i]);
        }
        this.people.clear();
        this.personByPeerId.clear();

        this.simTimeMs = 0;
        this.tickCounter = 0;
        this.rng = new SeededRandom(newSeed ?? this.initialSeed);
        this.scheduler.clear(0);
        this.telemetry.reset();
        this.radioMedium.reset();
        this.logManager.suppressDebug = false;
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

    step(dt: number, nowOverride?: number): void {
        const targetNow =
            nowOverride !== undefined ? nowOverride : this.simTimeMs + dt * 1000;
        this.simTimeMs = targetNow;
        this.tickCounter++;
        this.visualPktsEmittedThisTick = 0;

        // 1. Drain sub-tick scheduled protocol/GATT events up to targetNow
        this.scheduler.drainUntil(targetNow);
        this.simTimeMs = targetNow;

        // 2. Update positions & device ticks (dense array iteration, zero Map iterator overhead)
        const peopleList = this.spatial.getAll();
        for (let i = 0; i < peopleList.length; i++) {
            const person = peopleList[i];
            person.update(dt);
            person.device.tick(targetNow);
        }

        // 3. Update Spatial Grid
        this.spatial.updateAll();

        // 4. Update Connections (RSSI + staged handshakes + discovery)
        this.updateConnectionsRSSI(targetNow);
        this.updatePendingConnections(targetNow);
        this.updateConnectivity(targetNow);

        // 5. Drain any zero-delay events scheduled during this tick
        this.scheduler.drainUntil(targetNow);
        this.simTimeMs = targetNow;

        this.events.emit('tick', this.people);
    }

    private adjustPendingCounts(
        conn: BitchatConnectionBLE | BitchatConnectionWifiAware,
        delta: 1 | -1
    ): void {
        const clientId = conn.getClient().peerIDHex;
        const serverId = conn.getServer().peerIDHex;
        const clientMap =
            conn.transportType === 'WIFI_AWARE' ? this.pendingWifiClients : this.pendingBleClients;
        const serverMap =
            conn.transportType === 'WIFI_AWARE' ? this.pendingWifiServers : this.pendingBleServers;

        const nextClient = (clientMap.get(clientId) ?? 0) + delta;
        if (nextClient <= 0) clientMap.delete(clientId);
        else clientMap.set(clientId, nextClient);

        const nextServer = (serverMap.get(serverId) ?? 0) + delta;
        if (nextServer <= 0) serverMap.delete(serverId);
        else serverMap.set(serverId, nextServer);
    }

    private setPending(
        key: string,
        conn: BitchatConnectionBLE | BitchatConnectionWifiAware,
        finalizeAt: number
    ): void {
        this.pendingConnections.set(key, { conn, finalizeAt });
        this.adjustPendingCounts(conn, 1);
    }

    private deletePending(key: string): PendingHandshake | undefined {
        const existing = this.pendingConnections.get(key);
        if (!existing) return undefined;
        this.pendingConnections.delete(key);
        this.adjustPendingCounts(existing.conn, -1);
        return existing;
    }

    private isAttemptAllowed(directedKey: string, now: number): boolean {
        const rec = this.attemptTracker.get(directedKey);
        if (!rec) return true;
        const elapsed = now - rec.lastAttemptMs;
        if (elapsed > CONNECTION_ATTEMPT_EXPIRY_MS) {
            this.attemptTracker.delete(directedKey);
            return true;
        }
        return rec.attempts < MAX_CONNECTION_ATTEMPTS && elapsed > CONNECTION_RETRY_DELAY_MS;
    }

    private recordAttempt(directedKey: string, now: number): void {
        const rec = this.attemptTracker.get(directedKey);
        const expired = rec ? now - rec.lastAttemptMs > CONNECTION_ATTEMPT_EXPIRY_MS : true;
        const nextAttempts = expired ? 1 : (rec?.attempts ?? 0) + 1;
        this.attemptTracker.set(directedKey, { attempts: nextAttempts, lastAttemptMs: now });
    }

    private updatePendingConnections(now: number): void {
        if (this.pendingConnections.size === 0) return;

        const toFinalize: string[] = [];
        const toDrop: string[] = [];

        this.pendingConnections.forEach((pending, key) => {
            const { conn, finalizeAt } = pending;

            const stable =
                conn instanceof BitchatConnectionWifiAware
                    ? conn.updateRSSI()
                    : conn.updateRSSI(now);

            const maxDist =
                conn.transportType === 'WIFI_AWARE'
                    ? WIFI_AWARE_CONFIG.DISCONNECT_RADIUS_M
                    : DISCONNECT_RADIUS;

            let distanceOk = true;
            if (conn.endpointA.position && conn.endpointB.position) {
                const dx = conn.endpointA.position.x - conn.endpointB.position.x;
                const dy = conn.endpointA.position.y - conn.endpointB.position.y;
                if (dx * dx + dy * dy > maxDist * maxDist) {
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

        for (let i = 0; i < toDrop.length; i++) {
            this.deletePending(toDrop[i]);
            this.telemetry.recordConnectionFailed();
        }

        for (let i = 0; i < toFinalize.length; i++) {
            const key = toFinalize[i];
            const pending = this.deletePending(key);
            if (pending) {
                this.finalizeConnection(key, pending.conn, now);
            }
        }
    }

    private updateConnectivity(now: number): void {
        const peopleList = this.spatial.getAll();
        const isLargeCrowd = peopleList.length > STAGGER_POPULATION_THRESHOLD;
        const bucket = this.tickCounter % STAGGER_BUCKETS;

        // 1. Evaluate active links for distance/closed disconnect (staggered at 4 Hz for large crowds)
        const toBreak: Array<{ key: string; conn: BitchatConnection }> = [];
        let connIdx = 0;
        this.globalConnections.forEach((conn, key) => {
            const idx = connIdx++;
            if (!conn.isActive) {
                toBreak.push({ key, conn });
                return;
            }
            if (isLargeCrowd && idx % STAGGER_BUCKETS !== bucket) return;
            if (!conn.endpointA.position || !conn.endpointB.position) return;
            const maxDist =
                conn.transportType === 'WIFI_AWARE'
                    ? WIFI_AWARE_CONFIG.DISCONNECT_RADIUS_M
                    : DISCONNECT_RADIUS;
            const dx = conn.endpointA.position.x - conn.endpointB.position.x;
            const dy = conn.endpointA.position.y - conn.endpointB.position.y;
            if (dx * dx + dy * dy > maxDist * maxDist) {
                toBreak.push({ key, conn });
            }
        });
        for (let i = 0; i < toBreak.length; i++) {
            this.breakConnection(toBreak[i].key, toBreak[i].conn);
        }

        // 2. BLE scanning discovery (full 20 Hz for <= 100 nodes; staggered 4 Hz round-robin for > 100 nodes)
        const connectRadiusSq = CONNECT_RADIUS * CONNECT_RADIUS;
        const maxNeighborSample = isLargeCrowd ? LARGE_CROWD_MAX_NEIGHBOR_SAMPLE : undefined;

        for (let pi = 0; pi < peopleList.length; pi++) {
            if (isLargeCrowd && pi % STAGGER_BUCKETS !== bucket) continue;
            const scanner = peopleList[pi];
            if (!scanner.device.isScanning) continue;
            if (!this.canInitiateOrAccept(scanner.device, true, 'BLE')) continue;

            const scanRssiThreshold = scanner.device.getScanRssiThreshold();
            const minRssi =
                scanRssiThreshold > RSSI_CONFIG.DISCONNECT_THRESHOLD
                    ? scanRssiThreshold
                    : RSSI_CONFIG.DISCONNECT_THRESHOLD;
            const neighbors = this.spatial.getNeighbors(scanner, CONNECT_RADIUS, maxNeighborSample);
            if (neighbors.length === 0) continue;

            this.rng.shuffle(neighbors);

            for (let ni = 0; ni < neighbors.length; ni++) {
                if (!this.canInitiateOrAccept(scanner.device, true, 'BLE')) break;
                const target = neighbors[ni];
                const directedKey = this.getDirectedBleKey(
                    scanner.device.peerIDHex,
                    target.device.peerIDHex
                );

                if (
                    this.globalConnections.has(directedKey) ||
                    this.pendingConnections.has(directedKey)
                ) {
                    continue;
                }

                if (
                    scanner.device.connectionManager.hasActiveConnectionToPeer(
                        target.device.peerIDHex,
                        'BLE'
                    )
                ) {
                    continue;
                }
                if (this.shouldCollapseDualLinks(scanner.device, target.device)) {
                    const reverseKey = this.getDirectedBleKey(
                        target.device.peerIDHex,
                        scanner.device.peerIDHex
                    );
                    if (
                        this.globalConnections.has(reverseKey) ||
                        this.pendingConnections.has(reverseKey)
                    ) {
                        continue;
                    }
                }

                if (!this.canInitiateOrAccept(target.device, false, 'BLE')) {
                    continue;
                }

                if (!this.isAttemptAllowed(directedKey, now)) {
                    continue;
                }

                const dx = scanner.position.x - target.position.x;
                const dy = scanner.position.y - target.position.y;
                if (dx * dx + dy * dy >= connectRadiusSq) continue;

                const estimatedRSSI = BitchatConnectionBLE.estimateRSSI(
                    scanner.position,
                    target.position,
                    scanner.device.bluetoothStrength,
                    target.device.bluetoothStrength,
                    this.environment
                );
                if (estimatedRSSI <= minRssi) continue;

                this.initiateConnection(directedKey, scanner, target, now, estimatedRSSI);
            }
        }

        // 3. Wi-Fi Aware NAN discovery (5 GHz, undirected peer TCP sockets)
        const wifiRadiusSq =
            WIFI_AWARE_CONFIG.CONNECT_RADIUS_M * WIFI_AWARE_CONFIG.CONNECT_RADIUS_M;
        for (let pi = 0; pi < peopleList.length; pi++) {
            if (isLargeCrowd && pi % STAGGER_BUCKETS !== bucket) continue;
            const peerA = peopleList[pi];
            if (!peerA.device.wifiAwareEnabled) continue;
            if (!this.canInitiateOrAccept(peerA.device, true, 'WIFI_AWARE')) continue;

            const neighbors = this.spatial.getNeighbors(
                peerA,
                WIFI_AWARE_CONFIG.CONNECT_RADIUS_M,
                maxNeighborSample
            );
            if (neighbors.length === 0) continue;
            this.rng.shuffle(neighbors);

            for (let ni = 0; ni < neighbors.length; ni++) {
                if (!this.canInitiateOrAccept(peerA.device, true, 'WIFI_AWARE')) break;
                const peerB = neighbors[ni];
                if (!peerB.device.wifiAwareEnabled) continue;
                if (peerA.device.peerIDHex >= peerB.device.peerIDHex) continue;

                const wifiKey = `WIFI_AWARE:${peerA.device.peerIDHex}-${peerB.device.peerIDHex}`;
                if (this.globalConnections.has(wifiKey) || this.pendingConnections.has(wifiKey)) {
                    continue;
                }
                if (!this.canInitiateOrAccept(peerB.device, false, 'WIFI_AWARE')) {
                    continue;
                }
                if (!this.isAttemptAllowed(wifiKey, now)) {
                    continue;
                }

                const dx = peerA.position.x - peerB.position.x;
                const dy = peerA.position.y - peerB.position.y;
                if (dx * dx + dy * dy >= wifiRadiusSq) continue;

                const estimatedRssi = BitchatConnectionWifiAware.estimateRSSI(
                    peerA.position,
                    peerB.position,
                    this.environment
                );
                if (estimatedRssi <= WIFI_AWARE_CONFIG.CONNECT_THRESHOLD) continue;

                this.initiateWifiAwareConnection(wifiKey, peerA, peerB, now, estimatedRssi);
            }
        }
    }

    private loop = (): void => {
        if (!this.isRunning) return;

        const wallNow = performance.now();
        const dt = (wallNow - this.lastWallTime) / 1000;
        this.lastWallTime = wallNow;

        const safeDt = Math.min(dt, 0.25);
        this.accumulatedTime += safeDt;

        // Cap catch-up substeps & wall-time budget per animation frame so massive crowds keep UI responsive
        let substeps = 0;
        const maxSubsteps = 2;
        const frameBudgetMs = 14;
        const frameStart = performance.now();
        while (
            this.accumulatedTime >= this.FIXED_TIME_STEP &&
            substeps < maxSubsteps &&
            performance.now() - frameStart < frameBudgetMs
        ) {
            this.step(this.FIXED_TIME_STEP);
            this.accumulatedTime -= this.FIXED_TIME_STEP;
            substeps++;
        }
        if (this.accumulatedTime > this.FIXED_TIME_STEP * 2) {
            this.accumulatedTime = this.FIXED_TIME_STEP;
        }

        requestAnimationFrame(this.loop);
    };

    getPerson(id: string): BitchatPerson | undefined {
        return this.people.get(id);
    }

    getPersonByPeerId(peerIdHex: string): BitchatPerson | undefined {
        return this.personByPeerId.get(peerIdHex);
    }

    getAllPeople(): BitchatPerson[] {
        return this.spatial.getAll();
    }

    getAllConnections(): BitchatConnection[] {
        if (this.connectionsDirty) {
            this.connectionsListCache = Array.from(this.globalConnections.values());
            this.connectionsDirty = false;
        }
        return this.connectionsListCache;
    }

    getConnectionById(id: string): BitchatConnection | undefined {
        return this.globalConnections.get(id);
    }

    registerExternalConnection(conn: BitchatConnection): void {
        this.globalConnections.set(conn.id, conn);
        this.connectionsDirty = true;
    }

    removeExternalConnection(key: string): void {
        this.globalConnections.delete(key);
        this.connectionsDirty = true;
    }

    private updateConnectionsRSSI(now: number): void {
        if (this.globalConnections.size === 0) return;
        const isLargeCrowd = this.people.size > STAGGER_POPULATION_THRESHOLD;
        const bucket = this.tickCounter % STAGGER_BUCKETS;
        const connectionsToBreak: string[] = [];

        let idx = 0;
        this.globalConnections.forEach((conn, key) => {
            const myIdx = idx++;
            conn.update(now);

            if (isLargeCrowd && myIdx % STAGGER_BUCKETS !== bucket) return;

            if (conn instanceof BitchatConnectionBLE) {
                const shouldRemain = conn.updateRSSI(now);
                if (!shouldRemain) {
                    connectionsToBreak.push(key);
                    if (!isLargeCrowd) {
                        this.logManager.log(
                            'INFO',
                            'CONNECTION',
                            `Signal lost (RSSI: ${conn.rssi.toFixed(1)} dBm)`,
                            conn.id
                        );
                    }
                }
            } else if (conn instanceof BitchatConnectionWifiAware) {
                const shouldRemain = conn.updateRSSI();
                if (!shouldRemain) {
                    connectionsToBreak.push(key);
                    if (!isLargeCrowd) {
                        this.logManager.log(
                            'INFO',
                            'CONNECTION',
                            `Wi-Fi Aware signal lost (RSSI: ${conn.rssi.toFixed(1)} dBm)`,
                            conn.id
                        );
                    }
                }
            }
        });

        for (let i = 0; i < connectionsToBreak.length; i++) {
            const key = connectionsToBreak[i];
            const conn = this.globalConnections.get(key);
            if (conn) {
                this.breakConnection(key, conn);
            }
        }
    }

    private canInitiateOrAccept(
        device: BitchatDevice,
        asClient: boolean,
        transport: TransportKind
    ): boolean {
        const active = device.connectionManager.getRoleCounts(transport);
        const peerId = device.peerIDHex;
        const pendingClients =
            (transport === 'WIFI_AWARE'
                ? this.pendingWifiClients.get(peerId)
                : this.pendingBleClients.get(peerId)) ?? 0;
        const pendingServers =
            (transport === 'WIFI_AWARE'
                ? this.pendingWifiServers.get(peerId)
                : this.pendingBleServers.get(peerId)) ?? 0;

        const limits = device.connectionSettings;
        const total = active.total + pendingClients + pendingServers;
        if (total >= limits.maxTotal) return false;
        if (asClient) {
            return active.clients + pendingClients < limits.maxClients;
        }
        return active.servers + pendingServers < limits.maxServers;
    }

    private shouldCollapseDualLinks(a: BitchatDevice, b: BitchatDevice): boolean {
        if (!this.allowDualRoleLinks) return true;
        return Boolean(
            a.appSimulator?.shouldCollapseDuplicateLinks?.() ||
                b.appSimulator?.shouldCollapseDuplicateLinks?.()
        );
    }

    private emitPacketTransmitted(
        connectionId: string,
        packet: BitchatPacket,
        fromId: string
    ): void {
        // Always emit all events for <= 100 nodes, routed packets, and user data packets;
        // throttle background ANNOUNCE/REQUEST_SYNC visual dot emissions in 1000+ node crowds
        // (telemetry still records 100% of transmissions accurately).
        if (this.people.size > STAGGER_POPULATION_THRESHOLD) {
            const isBackground =
                packet.type === MessageType.ANNOUNCE ||
                packet.type === MessageType.REQUEST_SYNC;
            if (isBackground && !packet.route) {
                if (this.visualPktsEmittedThisTick >= 120) return;
                this.visualPktsEmittedThisTick++;
            }
        }
        this.events.emit('packet_transmitted', {
            connectionId,
            packet,
            fromId,
        });
    }

    private getDirectedBleKey(clientPeerHex: string, serverPeerHex: string): string {
        return `BLE:${clientPeerHex}->${serverPeerHex}`;
    }

    private initiateConnection(
        directedKey: string,
        clientPerson: BitchatPerson,
        serverPerson: BitchatPerson,
        now: number,
        initialRSSI: number
    ): void {
        this.recordAttempt(directedKey, now);

        const connRng = this.rng.fork(`conn:${directedKey}:${now}`);
        const conn = new BitchatConnectionBLE(
            clientPerson.device,
            serverPerson.device,
            clientPerson.device,
            connRng,
            directedKey
        );
        conn.setLogger(this.logManager);
        conn.environment = this.environment;
        conn.radioMedium = this.radioMedium;
        conn.rssi = initialRSSI;
        conn.isReady = false;
        conn.attachRuntime({
            clock: () => this.simTimeMs,
            scheduler: this.scheduler,
            rng: connRng,
            telemetry: this.telemetry,
            createdAtMs: now,
        });

        conn.onPacketSent = (packet, from) => {
            this.emitPacketTransmitted(conn.id, packet, from.peerIDHex);
        };

        this.telemetry.recordConnectionInitiated();
        this.setPending(directedKey, conn, now + this.gattHandshakeMs);
    }

    private initiateWifiAwareConnection(
        wifiKey: string,
        peerA: BitchatPerson,
        peerB: BitchatPerson,
        now: number,
        initialRssi: number
    ): void {
        this.recordAttempt(wifiKey, now);

        const connRng = this.rng.fork(`conn:${wifiKey}:${now}`);
        const conn = new BitchatConnectionWifiAware(
            peerA.device,
            peerB.device,
            peerA.device,
            connRng,
            wifiKey
        );
        conn.setLogger(this.logManager);
        conn.environment = this.environment;
        conn.radioMedium = this.radioMedium;
        conn.rssi = initialRssi;
        conn.isReady = false;
        conn.attachRuntime({
            clock: () => this.simTimeMs,
            scheduler: this.scheduler,
            rng: connRng,
            telemetry: this.telemetry,
            createdAtMs: now,
        });

        conn.onPacketSent = (packet, from) => {
            this.emitPacketTransmitted(conn.id, packet, from.peerIDHex);
        };

        this.telemetry.recordConnectionInitiated();
        this.setPending(wifiKey, conn, now + this.wifiAwareHandshakeMs);
    }

    private finalizeConnection(
        key: string,
        conn: BitchatConnectionBLE | BitchatConnectionWifiAware,
        now: number
    ): void {
        const clientDev = conn.getClient();
        const serverDev = conn.getServer();
        const transport = conn.transportType;

        if (
            !clientDev.connectionManager.canAcceptConnection(true, transport) ||
            !serverDev.connectionManager.canAcceptConnection(false, transport)
        ) {
            this.telemetry.recordConnectionFailed();
            if (this.people.size <= STAGGER_POPULATION_THRESHOLD) {
                this.logManager.log(
                    'INFO',
                    'CONNECTION',
                    `Connection Failed (Slots Full during ${transport} setup)`,
                    conn.id
                );
            }
            return;
        }

        let isDualLink = false;
        if (transport === 'BLE') {
            const reverseKey = this.getDirectedBleKey(serverDev.peerIDHex, clientDev.peerIDHex);
            isDualLink = this.globalConnections.has(reverseKey);
            if (isDualLink && this.shouldCollapseDualLinks(clientDev, serverDev)) {
                this.attemptTracker.delete(key);
                return;
            }
        }

        this.attemptTracker.delete(key);
        conn.isReady = true;
        conn.createdAtMs = now;
        conn.lastActivityAtMs = now;
        this.globalConnections.set(key, conn);
        this.connectionsDirty = true;

        clientDev.connectionManager.addConnection(conn);
        serverDev.connectionManager.addConnection(conn);
        this.telemetry.recordConnectionFormed(isDualLink);

        clientDev.appSimulator?.onConnectionEstablished?.(conn, now);
        serverDev.appSimulator?.onConnectionEstablished?.(conn, now);

        this.events.emit('connection_formed', conn);
        if (this.people.size <= STAGGER_POPULATION_THRESHOLD) {
            this.logManager.log('INFO', 'CONNECTION', 'Connection Formed', conn.id, {
                between: [clientDev.nickname, serverDev.nickname],
                dualLink: isDualLink,
            });
        }
    }

    private breakConnection(key: string, conn: BitchatConnection): void {
        conn.close();
        conn.endpointA.connectionManager.removeConnection(conn.id);
        conn.endpointB.connectionManager.removeConnection(conn.id);

        this.globalConnections.delete(key);
        this.connectionsDirty = true;
        this.telemetry.recordConnectionBroken();

        conn.endpointA.appSimulator?.onConnectionBroken?.(conn, this.simTimeMs);
        conn.endpointB.appSimulator?.onConnectionBroken?.(conn, this.simTimeMs);

        this.events.emit('connection_broken', conn);
        if (this.people.size <= STAGGER_POPULATION_THRESHOLD) {
            this.logManager.log('INFO', 'CONNECTION', 'Connection Broken', conn.id);
        }
    }
}
