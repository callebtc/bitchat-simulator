import { BitchatDevice } from '../BitchatDevice';
import { PeerManager } from './PeerManager';
import { BitchatPacket, MessageType, createPacket, SpecialRecipients, calculatePacketHash } from '../../protocol/BitchatPacket';
import { TLV, TLVType } from '../../protocol/TLV';
import { LogManager } from '../LogManager';
import { getPeerColor } from '../../utils/colorUtils';
import { MeshGraph } from './MeshGraph';

const ANNOUNCE_INTERVAL = 5000; // 5 seconds
const MAX_TTL = 7;

export interface ChatMessage {
    id: string;
    timestamp: number;
    senderId: string;
    recipientId?: string; // undefined = Broadcast
    text: string;
    isOutgoing: boolean;
}

export class BitchatAppSimulator {
    device: BitchatDevice;
    peerManager: PeerManager;
    meshGraph: MeshGraph;
    messages: ChatMessage[] = [];
    
    private lastAnnounceTime: number = -1;
    private currentAnnounceDelay: number = ANNOUNCE_INTERVAL;
    private seenPackets: Set<string> = new Set();
    private logger?: LogManager;
    
    // Config
    isAnnouncing: boolean = true;

    constructor(device: BitchatDevice) {
        this.device = device;
        this.peerManager = new PeerManager();
        this.meshGraph = new MeshGraph();
        this.device.onPacketReceived = (p, from) => this.handlePacket(p, from);
    }

    setLogger(logger: LogManager) {
        this.logger = logger;
    }

    tick(now: number) {
        if (!this.isAnnouncing) return;
        
        if (this.lastAnnounceTime === -1) {
            // First tick initialization
            this.lastAnnounceTime = now;
            // Initial random offset
            this.currentAnnounceDelay = Math.random() * ANNOUNCE_INTERVAL;
        }
        
        if (now - this.lastAnnounceTime > this.currentAnnounceDelay) {
            this.sendAnnounce();
            this.lastAnnounceTime = now;
            
            // Calculate next delay: Base Interval ± 20% Jitter
            const jitter = (Math.random() - 0.5) * 0.4;
            this.currentAnnounceDelay = ANNOUNCE_INTERVAL * (1 + jitter);
        }
    }

    private log(message: string, details?: any, level: 'INFO'|'DEBUG' = 'INFO') {
        if (this.logger) {
            const hexId = this.device.peerIDHex;
            this.logger.log(level, 'PACKET', message, hexId, details, getPeerColor(hexId));
        }
    }

    private sendAnnounce() {
        // Construct TLV Payload
        // 1. Nickname
        const tlvNick = TLV.encodeNickname(this.device.nickname);
        
        // 2. Neighbors (Gossip)
        const connectedPeers = this.device.connectionManager.getConnectedPeers();
        const peerIDs = connectedPeers.map(p => p.peerID);
        const tlvNeighbors = TLV.encodeNeighbors(peerIDs);
        
        const payload = new Uint8Array(tlvNick.length + tlvNeighbors.length);
        payload.set(tlvNick, 0);
        payload.set(tlvNeighbors, tlvNick.length);
        
        const packet = createPacket(
            MessageType.ANNOUNCE, 
            this.device.peerID, 
            payload, 
            MAX_TTL, 
            SpecialRecipients.BROADCAST
        );

        // Update my own graph with my direct neighbors so I can calculate paths correctly
        // (Wait, MeshGraph needs other peers' announcements. I know my own connections.)
        this.meshGraph.updateFromAnnouncement(this.device.peerIDHex, connectedPeers.map(p => p.peerIDHex));

        // Mark as seen so we don't echo it back if it loops
        this.markSeen(packet);
        this.device.connectionManager.broadcast(packet);
        
        this.log(`Broadcasting ANNOUNCE`, { 
            ttl: MAX_TTL, 
            neighbors: connectedPeers.length 
        }, 'DEBUG');
    }

    sendMessage(text: string, recipientIdHex?: string) {
        // Encode Text
        const encoder = new TextEncoder();
        const payload = encoder.encode(text);
        
        // Resolve Recipient
        let recipientID: Uint8Array | undefined = undefined;
        let route: Uint8Array[] | undefined = undefined;
        let nextHopHex: string | undefined = undefined;

        if (recipientIdHex) {
            // Hex string to Uint8Array
            recipientID = this.hexToBytes(recipientIdHex);
            
            // Source Routing: Calculate path
            const path = this.meshGraph.getShortestPath(this.device.peerIDHex, recipientIdHex);
            
            if (path && path.length > 1) {
                // Path includes [Start, Hop1, Hop2, ..., End]
                // Route field excludes Start and End
                const intermediateHops = path.slice(1, path.length - 1);
                
                // If there are intermediate hops, populate route
                if (intermediateHops.length > 0) {
                    route = intermediateHops.map(hex => this.hexToBytes(hex));
                }
                
                // First hop is the immediate next node in the path (index 1)
                nextHopHex = path[1];
                
                this.log(`Computed Source Route`, { 
                    to: recipientIdHex.substring(0, 6),
                    path: path.map(h => h.substring(0,6)).join('->'),
                    hops: intermediateHops.length
                });
            } else {
                this.log(`No route found`, { to: recipientIdHex.substring(0, 6) }, 'DEBUG');
            }
        }
        
        const packet = createPacket(
            MessageType.MESSAGE,
            this.device.peerID,
            payload,
            MAX_TTL,
            recipientID || SpecialRecipients.BROADCAST
        );
        
        if (route) {
            packet.version = 2; // Must upgrade to V2 for routing
            packet.route = route;
        }
        
        // Store locally
        this.messages.push({
            id: this.getPacketId(packet),
            timestamp: Date.now(),
            senderId: this.device.peerIDHex,
            recipientId: recipientIdHex,
            text: text,
            isOutgoing: true
        });
        
        // Mark seen
        this.markSeen(packet);

        // Send Logic
        let sent = false;
        if (nextHopHex) {
             // Unicast to first hop
             sent = this.device.connectionManager.sendTo(nextHopHex, packet);
             if (sent) {
                 this.log(`Unicast Message (Source Routed)`, { nextHop: nextHopHex.substring(0,6) });
             } else {
                 this.log(`Failed to unicast to next hop, falling back to broadcast`, { nextHop: nextHopHex.substring(0,6) }, 'DEBUG');
             }
        }

        if (!sent) {
            this.device.connectionManager.broadcast(packet);
            this.log(recipientID ? `Sent DM (Broadcast)` : `Sent Broadcast`, { text: text });
        }
    }

    private handlePacket(packet: BitchatPacket, from: BitchatDevice) {
        const packetId = this.getPacketId(packet);
        const typeStr = packet.type === MessageType.ANNOUNCE ? 'ANNOUNCE' : 'MESSAGE';
        
        // 0. Duplicate Check
        if (this.seenPackets.has(packetId)) {
            // this.log(`Dropped duplicate packet ${typeStr}`, { packetId }, 'DEBUG');
            return;
        }
        this.markSeen(packet);

        // 1. Loop Check: Did I send this?
        const senderHex = this.toHex(packet.senderID);
        if (senderHex === this.device.peerIDHex) return;

        this.log(`Received ${typeStr}`, {
            from: from.nickname,
            sender: senderHex.substring(0,6),
            ttl: packet.ttl,
            recipient: packet.recipientID ? this.toHex(packet.recipientID).substring(0,6) : 'BROADCAST',
            routed: !!packet.route
        });

        // 2. Process Packet
        if (packet.type === MessageType.ANNOUNCE) {
            this.handleAnnounce(packet, from);
        } else if (packet.type === MessageType.MESSAGE) {
            this.handleMessage(packet, senderHex);
        }

        // 3. Relay Logic
        if (packet.ttl <= 1) {
            this.log(`Dropped packet ${typeStr} (TTL Expired)`, { packetId }, 'DEBUG');
            return; 
        }
        
        const relayPacket = { ...packet, ttl: packet.ttl - 1 };
        
        const isForMe = this.isForMe(packet);
        
        // If it's for me, we don't relay unless it's a broadcast (which is already handled by !recipientID check below)
        // But spec says "If I am not in the route, I am not a designated relay."
        
        if (isForMe && packet.recipientID) {
            // Consumed, do not relay
            return;
        }

        // Source Routing Logic
        let routed = false;
        if (packet.route && packet.version >= 2) {
             const myHex = this.device.peerIDHex;
             const routeHexes = packet.route.map(r => this.toHex(r));
             const myIndex = routeHexes.indexOf(myHex);
             
             if (myIndex !== -1) {
                 // I am in the route. Find next hop.
                 // Route list contains intermediate hops.
                 // [Hop1, Hop2, Hop3]
                 // If I am Hop1 (index 0), next is Hop2 (index 1).
                 // If I am Hop3 (index 2), next is Recipient.
                 
                 let nextHopHex: string;
                 if (myIndex + 1 < routeHexes.length) {
                     nextHopHex = routeHexes[myIndex + 1];
                 } else {
                     // Last hop in route, next is Recipient
                     nextHopHex = this.toHex(packet.recipientID!);
                 }
                 
                 // Try Unicast
                 const success = this.device.connectionManager.sendTo(nextHopHex, relayPacket);
                 if (success) {
                     this.log(`Relaying Source Routed Packet`, { nextHop: nextHopHex.substring(0,6) });
                     routed = true;
                 } else {
                     this.log(`Route Broken: Failed to send to ${nextHopHex.substring(0,6)}, flooding`, {}, 'DEBUG');
                     // Fallback to flood
                 }
             } else {
                 // I am not in the route.
                 // If I received this via unicast (mistake?) or flood fallback, I should probably flood it to ensure delivery.
                 // Spec says: "If NO (Standard): Flood". Implicitly if not in route, treat as standard?
                 this.log(`Not in route, flooding`, {}, 'DEBUG');
             }
        }

        if (!routed) {
            // Default Flood / Fallback
            if (packet.recipientID === undefined || !isForMe) { // Don't relay if it was for me (already checked above but safe to double check)
                 // Split Horizon: Don't send back to 'from'
                 this.device.connectionManager.broadcast(relayPacket, from);
                 // Only log generic relay if not too verbose
                 // this.log(`Relaying Flood`, { ttl: relayPacket.ttl });
            }
        }
    }
    
    private handleMessage(packet: BitchatPacket, senderHex: string) {
        // Decode
        const decoder = new TextDecoder();
        const text = decoder.decode(packet.payload);
        
        let recipientHex: string | undefined = undefined;
        if (packet.recipientID && !this.isBroadcast(packet.recipientID)) {
            recipientHex = this.toHex(packet.recipientID);
        }
        
        // Store if Broadcast or For Me
        const isForMe = this.isForMe(packet);
        if (!recipientHex || isForMe) {
            this.messages.push({
                id: this.getPacketId(packet),
                timestamp: Number(packet.timestamp), // Convert BigInt
                senderId: senderHex,
                recipientId: recipientHex,
                text: text,
                isOutgoing: false
            });
        }
    }
    
    private isBroadcast(arr: Uint8Array): boolean {
        for(let i=0; i<8; i++) {
            if (arr[i] !== 0xFF) return false;
        }
        return true;
    }

    private getPacketId(packet: BitchatPacket): string {
        return calculatePacketHash(packet);
    }
    
    private markSeen(packet: BitchatPacket) {
        const id = this.getPacketId(packet);
        this.seenPackets.add(id);
        // Limit size
        if (this.seenPackets.size > 1000) {
            const first = this.seenPackets.keys().next().value;
            if (first) {
                this.seenPackets.delete(first);
            }
        }
    }

    private handleAnnounce(packet: BitchatPacket, from: BitchatDevice) {
        // Decode payload
        const tlvs = TLV.decode(packet.payload);
        const nickBytes = tlvs.get(TLVType.NICKNAME);
        const neighborsBytes = tlvs.get(TLVType.DIRECT_NEIGHBORS);
        const senderHex = this.toHex(packet.senderID);
        
        let nickname = "Unknown";
        if (nickBytes) {
            nickname = TLV.decodeNickname(nickBytes!);
        }
        
        // Update Mesh Graph with Neighbors
        if (neighborsBytes) {
            const neighborIDs = TLV.decodeNeighbors(neighborsBytes);
            const neighborHexes = neighborIDs.map(id => this.toHex(id));
            this.meshGraph.updateFromAnnouncement(senderHex, neighborHexes);
        } else {
            // If no neighbors TLV, assume empty list (isolated) or just update nickname
            this.meshGraph.updateFromAnnouncement(senderHex, []);
        }

        // Is this a direct neighbor?
        // 'from' is the device that physically sent it to us.
        // If 'from.peerID' == 'packet.senderID', it's direct.
        // But in Sim, 'from' is reliable.
        const isDirect = from.peerIDHex === senderHex;

        this.peerManager.updatePeer(senderHex, nickname, isDirect, MAX_TTL - packet.ttl);
    }
    
    private isForMe(packet: BitchatPacket): boolean {
        if (!packet.recipientID) return false; // Broadcast
        // Check exact match
        for(let i=0; i<8; i++) {
            if (packet.recipientID[i] !== this.device.peerID[i]) return false;
        }
        return true;
    }

    private toHex(arr: Uint8Array): string {
         return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    private hexToBytes(hex: string): Uint8Array {
        return new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    }
}
