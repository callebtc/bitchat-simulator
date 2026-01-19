import { BitchatPerson } from './BitchatPerson';
import { SpatialManager } from './SpatialManager';
import { EventBus } from '../events/EventBus';
import { BitchatConnection } from './BitchatConnection';
import { BitchatConnectionBLE } from './BitchatConnectionBLE';

const CONNECT_RADIUS = 100;
const DISCONNECT_RADIUS = 110;

export class SimulationEngine {
    spatial: SpatialManager;
    events: EventBus;
    
    private isRunning: boolean = false;
    private lastTime: number = 0;
    private people: Map<string, BitchatPerson> = new Map();
    
    // Track global connections to manage lifecycle: key is "idA-idB" (sorted)
    private globalConnections: Map<string, BitchatConnection> = new Map();

    constructor() {
        this.spatial = new SpatialManager();
        this.events = new EventBus();
    }

    addPerson(person: BitchatPerson) {
        this.people.set(person.id, person);
        this.spatial.addPerson(person);
        this.events.emit('person_added', person);
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
        
        this.events.emit('reset', undefined);
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
                    // Check break
                    if (dist > DISCONNECT_RADIUS) {
                        this.breakConnection(key, existingConn);
                    }
                } else {
                    // Check form
                    if (dist < CONNECT_RADIUS) {
                        this.formConnection(key, p1, p2);
                    }
                }
            }
        }
    }
    
    private getConnectionKey(id1: string, id2: string): string {
        return id1 < id2 ? `${id1}-${id2}` : `${id2}-${id1}`;
    }
    
    private formConnection(key: string, p1: BitchatPerson, p2: BitchatPerson) {
        const conn = new BitchatConnectionBLE(p1.device, p2.device);
        this.globalConnections.set(key, conn);
        
        p1.device.connectionManager.addConnection(conn);
        p2.device.connectionManager.addConnection(conn);
        
        this.events.emit('connection_formed', conn);
    }
    
    private breakConnection(key: string, conn: BitchatConnection) {
        conn.close();
        conn.endpointA.connectionManager.removeConnection(conn.id);
        conn.endpointB.connectionManager.removeConnection(conn.id);
        
        this.globalConnections.delete(key);
        this.events.emit('connection_broken', conn);
    }
}
