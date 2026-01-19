import { BitchatDevice } from '../BitchatDevice';
import { PeerManager } from './PeerManager';
import { BitchatPacket, MessageType, createPacket, SpecialRecipients, calculatePacketHash } from '../../protocol/BitchatPacket';
import { TLV, TLVType } from '../../protocol/TLV';
import { LogManager } from '../LogManager';
import { getPeerColor } from '../../utils/colorUtils';

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
    messages: ChatMessage[] = [];
    
    private lastAnnounceTime: number = 0;
    private seenPackets: Set<string> = new Set();
    private logger?: LogManager;
    
    // Config
    isAnnouncing: boolean = true;

    constructor(device: BitchatDevice) {
        this.device = device;
        this.peerManager = new PeerManager();
        this.device.onPacketReceived = (p, from) => this.handlePacket(p, from);
    }

    setLogger(logger: LogManager) {
        this.logger = logger;
    }

    tick(now: number) {
        if (!this.isAnnouncing) return;
        
        if (now - this.lastAnnounceTime > ANNOUNCE_INTERVAL) {
            this.sendAnnounce();
            this.lastAnnounceTime = now;
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
        if (recipientIdHex) {
            // Hex string to Uint8Array
            recipientID = new Uint8Array(recipientIdHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
        }
        
        const packet = createPacket(
            MessageType.MESSAGE,
            this.device.peerID,
            payload,
            MAX_TTL,
            recipientID || SpecialRecipients.BROADCAST
        );
        
        // Store locally
        this.messages.push({
            id: this.getPacketId(packet),
            timestamp: Date.now(),
            senderId: this.device.peerIDHex,
            recipientId: recipientIdHex,
            text: text,
            isOutgoing: true
        });
        
        // Mark seen and send
        this.markSeen(packet);
        this.device.connectionManager.broadcast(packet);
        
        this.log(recipientID ? `Sent DM` : `Sent Broadcast`, { text: text });
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
            recipient: packet.recipientID ? this.toHex(packet.recipientID).substring(0,6) : 'BROADCAST'
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
        if (!isForMe || packet.recipientID === undefined) {
             // Split Horizon: Don't send back to 'from'
             this.log(`Relaying ${typeStr}`, {
                 ttl: relayPacket.ttl,
                 receivedFrom: from.nickname
             });
             this.device.connectionManager.broadcast(relayPacket, from);
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
        const senderHex = this.toHex(packet.senderID);
        
        let nickname = "Unknown";
        if (nickBytes) {
            nickname = TLV.decodeNickname(nickBytes!);
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
}
