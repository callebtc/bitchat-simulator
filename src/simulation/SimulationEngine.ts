import { BitchatPerson } from './BitchatPerson';
import { SpatialManager } from './SpatialManager';
import { EventBus } from '../events/EventBus';
import { BitchatConnection } from './BitchatConnection';
import { BitchatConnectionBLE } from './BitchatConnectionBLE';
import { LogManager } from './LogManager';
import { EnvironmentManager, PathFinder } from './environment';

const CONNECT_RADIUS = 100;
const DISCONNECT_RADIUS = 110;
/** Padding distance from building walls for pathfinding (meters) */
const PATHFINDING_PADDING = 5;

export class SimulationEngine {
    spatial: SpatialManager;
    events: EventBus;
    logManager: LogManager;
    environment: EnvironmentManager;
    pathFinder: PathFinder;
    
    private isRunning: boolean = false;
    private lastTime: number = 0;
    private people: Map<string, BitchatPerson> = new Map();
    
    // Track global connections to manage lifecycle: key is "idA-idB" (sorted)
    private globalConnections: Map<string, BitchatConnection> = new Map();

    constructor() {
        this.spatial = new SpatialManager();
        this.events = new EventBus();
        this.logManager = new LogManager();
        this.environment = new EnvironmentManager();
        this.pathFinder = new PathFinder();
    }

    addPerson(person: BitchatPerson) {
        person.setLogger(this.logManager);
        // Set environment reference for collision detection
        person.environment = this.environment;
        // Set pathfinder reference for navigation
        person.pathFinder = this.pathFinder;
        this.people.set(person.id, person);
        this.spatial.addPerson(person);
        this.events.emit('person_added', person);
        this.logManager.log('INFO', 'GLOBAL', `Added person ${person.id}`);
    }
    
    /**
     * Rebuild the pathfinding graph.
     * Should be called when environment changes.
     * Returns true if loaded from cache, false if needs building.
     */
    rebuildPathfindingGraph(): boolean {
        const buildings = this.environment.getBuildings();
        const loadedFromCache = this.pathFinder.buildVisibilityGraph(buildings, PATHFINDING_PADDING);
        
        if (loadedFromCache) {
            this.logManager.log('INFO', 'GLOBAL', `Pathfinding loaded from cache (${buildings.length} buildings)`);
        } else if (buildings.length > 0) {
            this.logManager.log('INFO', 'GLOBAL', `Pathfinding graph will be built (${buildings.length} buildings)`);
        }
        
        return loadedFromCache;
    }

    removePerson(id: string) {
        const person = this.people.get(id);
        if (person) {
            // Cleanup connections involving this person
            this.globalConnections.forEach((conn, key) => {
                if (conn.involves(person.device)) {
                    this.breakConnection(key, conn);
                }
            });
        }
        
        this.people.delete(id);
        this.spatial.removePerson(id);
        this.events.emit('person_removed', id);
        this.logManager.log('INFO', 'GLOBAL', `Removed person ${id}`);
    }
    
    reset() {
        // Clear all connections first
        this.globalConnections.forEach((conn) => {
            // Don't emit individual breaks, just wipe
            conn.close();
        });
        this.globalConnections.clear();
        
        // Clear people
        const ids = Array.from(this.people.keys());
        ids.forEach(id => {
            this.spatial.removePerson(id);
        });
        this.people.clear();
        this.logManager.clear();
        
        this.events.emit('reset', undefined);
        this.logManager.log('INFO', 'GLOBAL', 'Simulation Reset');
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastTime = performance.now();
        this.loop();
    }

    stop() {
        this.isRunning = false;
    }

    // Step method for manual stepping (testing)
    step(dt: number) {
        const now = performance.now();
        
        // Update positions
        this.people.forEach(person => {
            person.update(dt);
            person.device.tick(now);
        });

        // Update Connections (Latency + RSSI)
        this.updateConnectionsRSSI(now);

        this.updateConnectivity();
        
        this.events.emit('tick', this.people);
    }

    private loop = () => {
        if (!this.isRunning) return;
        
        const now = performance.now();
        const dt = (now - this.lastTime) / 1000; // seconds
        this.lastTime = now;

        this.step(dt);

        requestAnimationFrame(this.loop);
    }
    
    getPerson(id: string): BitchatPerson | undefined {
        return this.people.get(id);
    }
    
    getAllPeople(): BitchatPerson[] {
        return Array.from(this.people.values());
    }
    
    getAllConnections(): BitchatConnection[] {
        return Array.from(this.globalConnections.values());
    }

    /**
     * Update RSSI for all connections and handle disconnects.
     */
    private updateConnectionsRSSI(now: number) {
        const connectionsToBreak: string[] = [];

        this.globalConnections.forEach((conn, key) => {
            // Update latency queue
            conn.update(now);

            // Update RSSI for BLE connections
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

        // Break connections that lost signal
        for (const key of connectionsToBreak) {
            const conn = this.globalConnections.get(key);
            if (conn) {
                this.breakConnection(key, conn);
            }
        }
    }

    private updateConnectivity() {
        const peopleList = Array.from(this.people.values());
        
        for (let i = 0; i < peopleList.length; i++) {
            for (let j = i + 1; j < peopleList.length; j++) {
                const p1 = peopleList[i];
                const p2 = peopleList[j];
                
                const dx = p1.position.x - p2.position.x;
                const dy = p1.position.y - p2.position.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                
                const key = this.getConnectionKey(p1.device.peerIDHex, p2.device.peerIDHex);
                const existingConn = this.globalConnections.get(key);
                
                if (existingConn) {
                    // Check break conditions (distance-based as fallback)
                    if (dist > DISCONNECT_RADIUS) {
                        this.breakConnection(key, existingConn);
                    } else if (!existingConn.isActive) {
                        // It was closed logically (e.g. eviction), now remove physically
                        this.breakConnection(key, existingConn);
                    }
                } else {
                    // Check form conditions
                    if (dist < CONNECT_RADIUS) {
                        // Check Scanning & Role Availability
                        // Logic: One must be scanning (Client) and find the other (Server)
                        
                        let initiator: BitchatPerson | null = null;
                        
                        // Try p1 as Client, p2 as Server
                        if (p1.device.isScanning && 
                            p1.device.connectionManager.canAcceptConnection(true) && 
                            p2.device.connectionManager.canAcceptConnection(false)) {
                            initiator = p1;
                        }
                        // Try p2 as Client, p1 as Server (only if not already connected)
                        else if (p2.device.isScanning && 
                                 p2.device.connectionManager.canAcceptConnection(true) && 
                                 p1.device.connectionManager.canAcceptConnection(false)) {
                            initiator = p2;
                        }
                        
                        if (initiator) {
                            this.formConnection(key, p1, p2, initiator.device);
                        }
                    }
                }
            }
        }
    }
    
    private getConnectionKey(id1: string, id2: string): string {
        return id1 < id2 ? `${id1}-${id2}` : `${id2}-${id1}`;
    }
    
    private formConnection(key: string, p1: BitchatPerson, p2: BitchatPerson, initiator: any) {
        const conn = new BitchatConnectionBLE(p1.device, p2.device, initiator);
        conn.setLogger(this.logManager);
        
        // Attach environment reference for RSSI calculations
        conn.environment = this.environment;
        
        // Hook up visualization events
        conn.onPacketSent = (packet, from) => {
            this.events.emit('packet_transmitted', {
                connectionId: conn.id,
                packet: packet,
                fromId: from.peerIDHex
            });
        };
        
        this.globalConnections.set(key, conn);
        
        p1.device.connectionManager.addConnection(conn);
        p2.device.connectionManager.addConnection(conn);
        
        this.events.emit('connection_formed', conn);
        this.logManager.log('INFO', 'CONNECTION', 'Connection Formed', conn.id, {
             between: [p1.device.nickname, p2.device.nickname]
        });
    }
    
    private breakConnection(key: string, conn: BitchatConnection) {
        conn.close();
        conn.endpointA.connectionManager.removeConnection(conn.id);
        conn.endpointB.connectionManager.removeConnection(conn.id);
        
        this.globalConnections.delete(key);
        this.events.emit('connection_broken', conn);
        this.logManager.log('INFO', 'CONNECTION', 'Connection Broken', conn.id);
    }
}
