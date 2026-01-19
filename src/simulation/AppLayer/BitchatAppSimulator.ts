import { BitchatDevice } from '../BitchatDevice';
import { PeerManager } from './PeerManager';
import { BitchatPacket, MessageType, createPacket, SpecialRecipients } from '../../protocol/BitchatPacket';
import { TLV, TLVType } from '../../protocol/TLV';

const ANNOUNCE_INTERVAL = 5000; // 5 seconds
const MAX_TTL = 7;

export class BitchatAppSimulator {
    device: BitchatDevice;
    peerManager: PeerManager;
    private lastAnnounceTime: number = 0;
    private seenPackets: Set<string> = new Set();

    constructor(device: BitchatDevice) {
        this.device = device;
        this.peerManager = new PeerManager();
        this.device.onPacketReceived = (p, from) => this.handlePacket(p, from);
    }

    tick(now: number) {
        if (now - this.lastAnnounceTime > ANNOUNCE_INTERVAL) {
            this.sendAnnounce();
            this.lastAnnounceTime = now;
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
    }

    private handlePacket(packet: BitchatPacket, from: BitchatDevice) {
        // 0. Duplicate Check
        const packetId = this.getPacketId(packet);
        if (this.seenPackets.has(packetId)) return;
        this.markSeen(packet);

        // 1. Loop Check: Did I send this?
        const senderHex = this.toHex(packet.senderID);
        if (senderHex === this.device.peerIDHex) return;

        // 2. Process Packet
        if (packet.type === MessageType.ANNOUNCE) {
            this.handleAnnounce(packet, from);
        }

        // 3. Relay Logic
        if (packet.ttl <= 1) return; // Drop if TTL will become 0
        
        const relayPacket = { ...packet, ttl: packet.ttl - 1 };
        
        const isForMe = this.isForMe(packet);
        if (!isForMe || packet.recipientID === undefined) {
             // Split Horizon: Don't send back to 'from'
             this.device.connectionManager.broadcast(relayPacket, from);
        }
    }
    
    private getPacketId(packet: BitchatPacket): string {
        // Sender + Timestamp is decent unique ID for sim
        return `${this.toHex(packet.senderID)}_${packet.timestamp}`;
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
