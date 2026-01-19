import { BitchatConnection } from './BitchatConnection';
import { BitchatDevice } from './BitchatDevice';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { LogManager } from './LogManager';

export class ConnectionManager {
    private owner: BitchatDevice;
    private connections: Map<string, BitchatConnection> = new Map(); // Keyed by ConnectionID
    private logger?: LogManager;

    constructor(owner: BitchatDevice) {
        this.owner = owner;
    }

    setLogger(logger: LogManager) {
        this.logger = logger;
    }

    addConnection(connection: BitchatConnection) {
        this.connections.set(connection.id, connection);
        this.logger?.log('DEBUG', 'DEVICE', 'Connection Added', this.owner.peerIDHex, { connId: connection.id });
        this.enforceLimits(); // Check limits whenever adding
    }

    removeConnection(connectionId: string) {
        this.connections.delete(connectionId);
        this.logger?.log('DEBUG', 'DEVICE', 'Connection Removed', this.owner.peerIDHex, { connId: connectionId });
    }
    
    getRoleCounts() {
        let clients = 0;
        let servers = 0;
        this.connections.forEach(conn => {
            if (!conn.isActive) return;
            if (conn.initiator === this.owner) {
                clients++;
            } else {
                servers++;
            }
        });
        return { clients, servers, total: clients + servers };
    }
    
    canAcceptConnection(asClient: boolean): boolean {
        const counts = this.getRoleCounts();
        const limits = this.owner.connectionSettings;
        
        if (counts.total >= limits.maxTotal) return false;
        if (asClient) {
            return counts.clients < limits.maxClients;
        } else {
            // As server
            return counts.servers < limits.maxServers;
        }
    }
    
    enforceLimits() {
        const limits = this.owner.connectionSettings;
        let counts = this.getRoleCounts();
        
        // Strategy: Drop oldest connections if over limit
        // Since Map iterates insertion order, the first ones are oldest
        
        if (counts.total > limits.maxTotal) {
            this.evictConnections(counts.total - limits.maxTotal, 'total');
            counts = this.getRoleCounts(); // Update
        }
        
        if (counts.clients > limits.maxClients) {
            this.evictConnections(counts.clients - limits.maxClients, 'client');
            counts = this.getRoleCounts();
        }
        
        if (counts.servers > limits.maxServers) {
            this.evictConnections(counts.servers - limits.maxServers, 'server');
        }
    }
    
    private evictConnections(count: number, reason: 'total'|'client'|'server') {
        let evicted = 0;
        
        // We need to iterate carefully.
        // We can't delete while iterating if we break the loop? Map.forEach is safe.
        // But we want to stop after 'count'.
        
        for (const conn of this.connections.values()) {
            if (evicted >= count) break;
            if (!conn.isActive) continue;
            
            let shouldDrop = false;
            
            if (reason === 'total') shouldDrop = true;
            else if (reason === 'client' && conn.initiator === this.owner) shouldDrop = true;
            else if (reason === 'server' && conn.initiator !== this.owner) shouldDrop = true;
            
            if (shouldDrop) {
                this.logger?.log('INFO', 'DEVICE', `Evicting connection (Limit: ${reason})`, this.owner.peerIDHex, { connId: conn.id });
                conn.close(); // Mark inactive. SimulationEngine cleanup loop will handle physical removal.
                evicted++;
            }
        }
    }

    broadcast(packet: BitchatPacket, exclude?: BitchatDevice) {
        this.connections.forEach(conn => {
            if (conn.isActive) {
                const other = conn.getOtherParty(this.owner);
                if (other !== exclude) {
                    conn.send(packet, this.owner);
                }
            }
        });
    }

    sendTo(peerIDHex: string, packet: BitchatPacket) {
        // Find connection to peerID
        // This is inefficient O(N), but fine for small N.
        for (const conn of this.connections.values()) {
            const other = conn.getOtherParty(this.owner);
            if (other.peerIDHex === peerIDHex) {
                conn.send(packet, this.owner);
                return true;
            }
        }
        return false;
    }
    
    getConnectedPeers(): BitchatDevice[] {
        const peers: BitchatDevice[] = [];
        this.connections.forEach(conn => {
            if (conn.isActive) {
                peers.push(conn.getOtherParty(this.owner));
            }
        });
        return peers;
    }
}
