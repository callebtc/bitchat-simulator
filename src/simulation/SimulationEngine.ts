import { BitchatPerson } from './BitchatPerson';
import { BitchatDevice } from './BitchatDevice';
import { SpatialManager } from './SpatialManager';
import { EventBus } from '../events/EventBus';
import { BitchatConnection } from './BitchatConnection';
import { BitchatConnectionBLE, RSSI_CONFIG } from './BitchatConnectionBLE';
import { BitchatConnectionWifiAware, WIFI_AWARE_CONFIG } from './BitchatConnectionWifiAware';
import { LogManager } from './LogManager';
import { EnvironmentManager, PathFinder } from './environment';
import { SeededRandom } from './SeededRandom';
import { EventScheduler } from './EventScheduler';
import { TelemetryCollector } from './TelemetryCollector';
import { DeviceRuntime } from './BitchatDevice';
import { RadioMedium, RadioMediumConfig } from './RadioMedium';

const CONNECT_RADIUS = 100;
const DISCONNECT_RADIUS = 110;
/** Padding distance from building walls for pathfinding (meters) */
const PATHFINDING_PADDING = 2.5;

// Android MeshConnectionTracker retry & GATT setup constants
const CONNECTION_RETRY_DELAY_MS = 5_000;
const MAX_CONNECTION_ATTEMPTS = 3;
const CONNECTION_ATTEMPT_EXPIRY_MS = CONNECTION_RETRY_DELAY_MS * 2;
const DEFAULT_GATT_HANDSHAKE_MS = 500; // 200ms MTU(517) + 100ms discover/CCCD + 200ms ready

export interface SimulationEngineOptions {
    /** Deterministic PRNG seed (default: 0x5eed1234) */
    seed?: number;
    /** Staged BLE GATT handshake duration in ms (default: 500 ms matching Android) */
    gattHandshakeMs?: number;
    /** Wi-Fi Aware NAN + NDP + TCP handshake duration in ms (default: 1200 ms) */
    wifiAwareHandshakeMs?: number;
    /** Allow concurrent dual-role BLE links during scan races (default: true) */
    allowDualRoleLinks?: boolean;
    /** Optional RadioMedium overrides (e.g. disable RF interference in isolated tests) */
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
    readonly FIXED_TIME_STEP = 0.05; // 50ms physics/RSSI tick
    private people: Map<string, BitchatPerson> = new Map();

    // Active connections keyed by linkID ("BLE:<client>-><server>" or "WIFI_AWARE:<a>-<b>")
    private globalConnections: Map<string, BitchatConnection> = new Map();
    // Pending BLE GATT / Wi-Fi Aware handshakes keyed by linkID
    private pendingConnections: Map<string, PendingHandshake> = new Map();
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
        this.attemptTracker.clear();

        const ids = Array.from(this.people.keys());
        ids.forEach(id => {
            this.spatial.removePerson(id);
        });
        this.people.clear();

        this.simTimeMs = 0;
        this.rng = new SeededRandom(newSeed ?? this.initialSeed);
        this.scheduler.clear(0);
        this.telemetry.reset();
        this.radioMedium.reset();
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
     * Advance one simulation step using monotonic simTimeMs (never wall clock).
     */
    step(dt: number, nowOverride?: number): void {
        const targetNow =
            nowOverride !== undefined ? nowOverride : this.simTimeMs + dt * 1000;
        this.simTimeMs = targetNow;

        // 1. Drain sub-tick scheduled protocol/GATT events up to targetNow
        this.scheduler.drainUntil(targetNow);
        this.simTimeMs = targetNow;

        // 2. Update positions & device ticks
        this.people.forEach(person => {
            person.update(dt);
            person.device.tick(targetNow);
        });

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
                if (Math.sqrt(dx * dx + dy * dy) > maxDist) {
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

        // 1. Evaluate active links for distance/closed disconnect
        const toBreak: Array<{ key: string; conn: BitchatConnection }> = [];
        this.globalConnections.forEach((conn, key) => {
            if (!conn.isActive) {
                toBreak.push({ key, conn });
                return;
            }
            if (!conn.endpointA.position || !conn.endpointB.position) return;
            const maxDist =
                conn.transportType === 'WIFI_AWARE'
                    ? WIFI_AWARE_CONFIG.DISCONNECT_RADIUS_M
                    : DISCONNECT_RADIUS;
            const dx = conn.endpointA.position.x - conn.endpointB.position.x;
            const dy = conn.endpointA.position.y - conn.endpointB.position.y;
            if (Math.sqrt(dx * dx + dy * dy) > maxDist) {
                toBreak.push({ key, conn });
            }
        });
        for (const item of toBreak) {
            this.breakConnection(item.key, item.conn);
        }

        // 2. Scanning discovery (directed client -> server evaluation, allowing realistic dual-role races)
        for (const scanner of peopleList) {
            if (!scanner.device.isScanning) continue;
            if (!this.canInitiateOrAccept(scanner.device, true, 'BLE')) continue;

            const scanRssiThreshold = scanner.device.getScanRssiThreshold();
            const neighbors = this.spatial.getNeighbors(scanner, CONNECT_RADIUS);
            // Randomize BLE advertising arrival order (Bluetooth Core Spec random advDelay)
            this.rng.shuffle(neighbors);

            for (const target of neighbors) {
                if (!this.canInitiateOrAccept(scanner.device, true, 'BLE')) break;
                const directedKey = this.getDirectedBleKey(
                    scanner.device.peerIDHex,
                    target.device.peerIDHex
                );

                // Already have this exact directed link active or pending
                if (
                    this.globalConnections.has(directedKey) ||
                    this.pendingConnections.has(directedKey)
                ) {
                    continue;
                }

                // Android BluetoothGattClientManager checks service-data peerID against ALREADY established links.
                // Note: if the reverse link is only *pending* (both devices scanning concurrently), a realistic
                // dual-role scan race occurs when allowDualRoleLinks is enabled!
                if (scanner.device.connectionManager.hasActiveConnectionToPeer(target.device.peerIDHex, 'BLE')) {
                    continue;
                }
                const collapseDual = this.shouldCollapseDualLinks(scanner.device, target.device);
                if (collapseDual) {
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
                if (Math.sqrt(dx * dx + dy * dy) >= CONNECT_RADIUS) continue;

                const estimatedRSSI = BitchatConnectionBLE.estimateRSSI(
                    scanner.position,
                    target.position,
                    scanner.device.bluetoothStrength,
                    target.device.bluetoothStrength,
                    this.environment
                );
                // Must pass both scanner's power-mode RSSI threshold AND minimum link floor
                const minRssi = Math.max(scanRssiThreshold, RSSI_CONFIG.DISCONNECT_THRESHOLD);
                if (estimatedRSSI <= minRssi) continue;

                this.initiateConnection(directedKey, scanner, target, now, estimatedRSSI);
            }
        }

        // 3. Wi-Fi Aware NAN discovery (5 GHz, undirected peer TCP sockets)
        for (const peerA of peopleList) {
            if (!peerA.device.wifiAwareEnabled) continue;
            if (!this.canInitiateOrAccept(peerA.device, true, 'WIFI_AWARE')) continue;

            const neighbors = this.spatial.getNeighbors(peerA, WIFI_AWARE_CONFIG.CONNECT_RADIUS_M);
            this.rng.shuffle(neighbors);
            for (const peerB of neighbors) {
                if (!this.canInitiateOrAccept(peerA.device, true, 'WIFI_AWARE')) break;
                if (!peerB.device.wifiAwareEnabled) continue;
                // Lexicographic tie-breaker prevents duplicate NAN TCP connection races
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
                if (Math.sqrt(dx * dx + dy * dy) >= WIFI_AWARE_CONFIG.CONNECT_RADIUS_M) continue;

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

    registerExternalConnection(conn: BitchatConnection): void {
        this.globalConnections.set(conn.id, conn);
    }

    removeExternalConnection(key: string): void {
        this.globalConnections.delete(key);
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
            } else if (conn instanceof BitchatConnectionWifiAware) {
                const shouldRemain = conn.updateRSSI();
                if (!shouldRemain) {
                    connectionsToBreak.push(key);
                    this.logManager.log(
                        'INFO',
                        'CONNECTION',
                        `Wi-Fi Aware signal lost (RSSI: ${conn.rssi.toFixed(1)} dBm)`,
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

    private canInitiateOrAccept(
        device: BitchatDevice,
        asClient: boolean,
        transport: 'BLE' | 'WIFI_AWARE'
    ): boolean {
        const active = device.connectionManager.getRoleCounts(transport);
        let pendingClients = 0;
        let pendingServers = 0;
        this.pendingConnections.forEach(({ conn }) => {
            if (conn.transportType !== transport) return;
            if (conn.getClient() === device) pendingClients++;
            else if (conn.getServer() === device) pendingServers++;
        });
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
            this.events.emit('packet_transmitted', {
                connectionId: conn.id,
                packet,
                fromId: from.peerIDHex,
            });
        };

        this.telemetry.recordConnectionInitiated();
        this.pendingConnections.set(directedKey, {
            conn,
            finalizeAt: now + this.gattHandshakeMs,
        });
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
            this.events.emit('packet_transmitted', {
                connectionId: conn.id,
                packet,
                fromId: from.peerIDHex,
            });
        };

        this.telemetry.recordConnectionInitiated();
        this.pendingConnections.set(wifiKey, {
            conn,
            finalizeAt: now + this.wifiAwareHandshakeMs,
        });
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
            this.logManager.log(
                'INFO',
                'CONNECTION',
                `Connection Failed (Slots Full during ${transport} setup)`,
                conn.id
            );
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

        clientDev.connectionManager.addConnection(conn);
        serverDev.connectionManager.addConnection(conn);
        this.telemetry.recordConnectionFormed(isDualLink);

        clientDev.appSimulator?.onConnectionEstablished?.(conn, now);
        serverDev.appSimulator?.onConnectionEstablished?.(conn, now);

        this.events.emit('connection_formed', conn);
        this.logManager.log('INFO', 'CONNECTION', 'Connection Formed', conn.id, {
            between: [clientDev.nickname, serverDev.nickname],
            dualLink: isDualLink,
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
