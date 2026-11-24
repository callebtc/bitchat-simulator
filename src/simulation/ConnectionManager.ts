import { BitchatConnection, TransportKind } from './BitchatConnection';
import { BitchatDevice } from './BitchatDevice';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { LogManager } from './LogManager';

/**
 * Per-device link table aligned with Android BluetoothConnectionTracker.kt:
 * - Enforces maxClients, maxServers, and maxTotal per transport.
 * - Role-aware eviction: evicts oldest excess clients/servers first, then for
 *   overall cap explicitly evicts oldest clients before servers.
 */
export class ConnectionManager {
    private owner: BitchatDevice;
    private connections: Map<string, BitchatConnection> = new Map();
    private logger?: LogManager;

    constructor(owner: BitchatDevice) {
        this.owner = owner;
    }

    setLogger(logger: LogManager): void {
        this.logger = logger;
    }

    addConnection(connection: BitchatConnection): void {
        this.connections.set(connection.id, connection);
        this.logger?.log('DEBUG', 'DEVICE', 'Connection Added', this.owner.peerIDHex, {
            connId: connection.id,
        });
        this.enforceLimits(connection.transportType);
    }

    removeConnection(connectionId: string): void {
        this.connections.delete(connectionId);
        this.logger?.log('DEBUG', 'DEVICE', 'Connection Removed', this.owner.peerIDHex, {
            connId: connectionId,
        });
    }

    getRoleCounts(transport?: TransportKind): { clients: number; servers: number; total: number } {
        let clients = 0;
        let servers = 0;
        this.connections.forEach(conn => {
            if (!conn.isActive) return;
            if (transport && conn.transportType !== transport) return;
            if (conn.initiator === this.owner) {
                clients++;
            } else {
                servers++;
            }
        });
        return { clients, servers, total: clients + servers };
    }

    canAcceptConnection(asClient: boolean, transport: TransportKind = 'BLE'): boolean {
        const counts = this.getRoleCounts(transport);
        const limits = this.owner.connectionSettings;

        if (counts.total >= limits.maxTotal) return false;
        if (asClient) {
            return counts.clients < limits.maxClients;
        }
        return counts.servers < limits.maxServers;
    }

    /**
     * Exact port of Android BluetoothConnectionTracker.getConnectionsToEvict:
     * 1. Enforce role caps (maxClients, maxServers) oldest-first.
     * 2. Enforce overall cap (maxTotal) preferring evicting oldest clients before servers.
     */
    enforceLimits(transport: TransportKind = 'BLE'): void {
        const limits = this.owner.connectionSettings;
        const active = Array.from(this.connections.values()).filter(
            c => c.isActive && c.transportType === transport
        );

        const toEvict = new Set<BitchatConnection>();

        const clients = active
            .filter(c => c.initiator === this.owner)
            .sort((a, b) => a.createdAtMs - b.createdAtMs);
        if (clients.length > limits.maxClients) {
            for (const c of clients.slice(0, clients.length - limits.maxClients)) {
                toEvict.add(c);
            }
        }

        const servers = active
            .filter(c => c.initiator !== this.owner)
            .sort((a, b) => a.createdAtMs - b.createdAtMs);
        if (servers.length > limits.maxServers) {
            for (const c of servers.slice(0, servers.length - limits.maxServers)) {
                toEvict.add(c);
            }
        }

        const remaining = active.filter(c => !toEvict.has(c));
        if (remaining.length > limits.maxTotal) {
            let needed = remaining.length - limits.maxTotal;
            const remClients = remaining
                .filter(c => c.initiator === this.owner)
                .sort((a, b) => a.createdAtMs - b.createdAtMs);
            const remServers = remaining
                .filter(c => c.initiator !== this.owner)
                .sort((a, b) => a.createdAtMs - b.createdAtMs);

            for (const c of remClients.slice(0, needed)) {
                toEvict.add(c);
                needed--;
            }
            if (needed > 0) {
                for (const c of remServers.slice(0, needed)) {
                    toEvict.add(c);
                }
            }
        }

        for (const conn of toEvict) {
            this.logger?.log('INFO', 'DEVICE', 'Evicting connection (Limit)', this.owner.peerIDHex, {
                connId: conn.id,
            });
            conn.close();
        }
    }

    hasActiveConnectionToPeer(peerIDHex: string, transport?: TransportKind): boolean {
        for (const conn of this.connections.values()) {
            if (!conn.isActive) continue;
            if (transport && conn.transportType !== transport) continue;
            if (conn.getOtherParty(this.owner).peerIDHex === peerIDHex) {
                return true;
            }
        }
        return false;
    }

    broadcast(packet: BitchatPacket, exclude?: BitchatDevice, nowMs?: number): boolean {
        let accepted = false;
        this.connections.forEach(conn => {
            if (conn.isActive) {
                const other = conn.getOtherParty(this.owner);
                if (other !== exclude) {
                    if (conn.send(packet, this.owner, nowMs)) {
                        accepted = true;
                    }
                }
            }
        });
        return accepted;
    }

    sendTo(peerIDHex: string, packet: BitchatPacket, nowMs?: number): boolean {
        for (const conn of this.connections.values()) {
            if (!conn.isActive) continue;
            const other = conn.getOtherParty(this.owner);
            if (other.peerIDHex === peerIDHex) {
                return conn.send(packet, this.owner, nowMs);
            }
        }
        return false;
    }

    getActiveConnections(transport?: TransportKind): BitchatConnection[] {
        const active: BitchatConnection[] = [];
        this.connections.forEach(conn => {
            if (conn.isActive && (!transport || conn.transportType === transport)) {
                active.push(conn);
            }
        });
        return active;
    }

    getConnectedPeers(transport?: TransportKind): BitchatDevice[] {
        const seen = new Set<string>();
        const peers: BitchatDevice[] = [];
        this.connections.forEach(conn => {
            if (conn.isActive && (!transport || conn.transportType === transport)) {
                const other = conn.getOtherParty(this.owner);
                if (!seen.has(other.peerIDHex)) {
                    seen.add(other.peerIDHex);
                    peers.push(other);
                }
            }
        });
        return peers;
    }
}
