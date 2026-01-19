export interface PeerInfo {
    id: string; // Hex
    nickname: string;
    lastSeen: number;
    isDirect: boolean;
    hops: number; // Estimated hops
}

export class PeerManager {
    private peers: Map<string, PeerInfo> = new Map();

    updatePeer(id: string, nickname: string, isDirect: boolean, hops: number = 0) {
        const now = Date.now();
        const existing = this.peers.get(id);

        if (existing) {
            existing.lastSeen = now;
            existing.nickname = nickname; // Update nickname if changed
            // If it was routed and now direct, update.
            // If it was direct and now routed, update.
            existing.isDirect = isDirect;
            existing.hops = hops;
        } else {
            this.peers.set(id, {
                id,
                nickname,
                lastSeen: now,
                isDirect,
                hops
            });
        }
    }

    getPeer(id: string): PeerInfo | undefined {
        return this.peers.get(id);
    }

    getAllPeers(): PeerInfo[] {
        return Array.from(this.peers.values());
    }

    // Cleanup stale peers?
}
