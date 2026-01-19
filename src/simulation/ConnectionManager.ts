import { BitchatConnection } from './BitchatConnection';
import { BitchatDevice } from './BitchatDevice';
import { BitchatPacket } from '../protocol/BitchatPacket';

export class ConnectionManager {
    private owner: BitchatDevice;
    private connections: Map<string, BitchatConnection> = new Map(); // Keyed by ConnectionID or PeerID?

    constructor(owner: BitchatDevice) {
        this.owner = owner;
    }

    addConnection(connection: BitchatConnection) {
        this.connections.set(connection.id, connection);
    }

    removeConnection(connectionId: string) {
        this.connections.delete(connectionId);
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
