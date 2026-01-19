import { BitchatConnection } from './BitchatConnection';
import { BitchatDevice } from './BitchatDevice';
import { BitchatPacket } from '../protocol/BitchatPacket';
import { LogManager } from './LogManager';

export class ConnectionManager {
    private owner: BitchatDevice;
    private connections: Map<string, BitchatConnection> = new Map(); // Keyed by ConnectionID or PeerID?
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
    }

    removeConnection(connectionId: string) {
        this.connections.delete(connectionId);
        this.logger?.log('DEBUG', 'DEVICE', 'Connection Removed', this.owner.peerIDHex, { connId: connectionId });
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
