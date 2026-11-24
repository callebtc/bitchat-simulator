/**
 * Peer lifecycle manager modeled on Android PeerManager.kt:
 * - Tracks verified identity keys, capabilities, dynamic direct status, and lastSeen.
 * - Supports explicit removal (LEAVE or disconnect grace expiry) and periodic
 *   stale-peer sweeps with cascade cleanup callback (`onPeerRemoved`).
 */

export interface PeerInfo {
    id: string; // Hex (16 chars)
    nickname: string;
    lastSeen: number;
    isDirect: boolean;
    hops: number;
    isVerified: boolean;
    noisePublicKey?: Uint8Array;
    signingPublicKey?: Uint8Array;
    capabilities?: number;
}

export class PeerManager {
    private peers: Map<string, PeerInfo> = new Map();

    /** Dynamic callback to query whether a peer currently has an active direct link. */
    isPeerDirectlyConnected?: (peerID: string) => boolean;

    /** Cascade cleanup hook (invoked on peer eviction / LEAVE). */
    onPeerRemoved?: (peerID: string) => void;

    updatePeer(
        id: string,
        nickname: string,
        isDirect: boolean,
        hops: number = 0,
        nowMs: number = 0,
        identity?: {
            noisePublicKey?: Uint8Array;
            signingPublicKey?: Uint8Array;
            isVerified?: boolean;
            capabilities?: number;
        }
    ): boolean {
        const existing = this.peers.get(id);
        const isNew = !existing;
        const dynamicDirect = this.isPeerDirectlyConnected
            ? this.isPeerDirectlyConnected(id) || isDirect
            : isDirect;

        if (existing) {
            existing.lastSeen = nowMs;
            existing.nickname = nickname;
            existing.isDirect = dynamicDirect;
            existing.hops = hops;
            if (identity?.noisePublicKey) existing.noisePublicKey = identity.noisePublicKey;
            if (identity?.signingPublicKey) existing.signingPublicKey = identity.signingPublicKey;
            if (identity?.isVerified !== undefined) existing.isVerified = identity.isVerified;
            if (identity?.capabilities !== undefined) existing.capabilities = identity.capabilities;
        } else {
            this.peers.set(id, {
                id,
                nickname,
                lastSeen: nowMs,
                isDirect: dynamicDirect,
                hops,
                isVerified: identity?.isVerified ?? true,
                noisePublicKey: identity?.noisePublicKey,
                signingPublicKey: identity?.signingPublicKey,
                capabilities: identity?.capabilities,
            });
        }
        return isNew;
    }

    updateLastSeen(id: string, nowMs: number): void {
        const existing = this.peers.get(id);
        if (existing) {
            existing.lastSeen = nowMs;
        }
    }

    getPeer(id: string): PeerInfo | undefined {
        const info = this.peers.get(id);
        if (!info) return undefined;
        if (this.isPeerDirectlyConnected) {
            info.isDirect = this.isPeerDirectlyConnected(id);
        }
        return info;
    }

    getAllPeers(): PeerInfo[] {
        const result: PeerInfo[] = [];
        for (const info of this.peers.values()) {
            if (this.isPeerDirectlyConnected) {
                info.isDirect = this.isPeerDirectlyConnected(info.id);
            }
            result.push(info);
        }
        return result;
    }

    getActivePeerCount(): number {
        return this.peers.size;
    }

    isVerifiedDirectPeer(peerID: string): boolean {
        const peer = this.peers.get(peerID);
        if (!peer || !peer.isVerified) return false;
        return this.isPeerDirectlyConnected ? this.isPeerDirectlyConnected(peerID) : peer.isDirect;
    }

    getVerifiedDirectPeerIDs(): string[] {
        const direct: string[] = [];
        for (const info of this.peers.values()) {
            const isDir = this.isPeerDirectlyConnected
                ? this.isPeerDirectlyConnected(info.id)
                : info.isDirect;
            if (info.isVerified && isDir) {
                direct.push(info.id);
            }
        }
        return direct;
    }

    removePeer(id: string): boolean {
        const removed = this.peers.delete(id);
        if (removed) {
            this.onPeerRemoved?.(id);
        }
        return removed;
    }

    /**
     * Evict peers whose lastSeen exceeds staleTimeoutMs (Android: 180s; iOS: 60s).
     */
    cleanupStalePeers(nowMs: number, staleTimeoutMs: number): string[] {
        const toRemove: string[] = [];
        for (const [id, info] of this.peers) {
            if (nowMs - info.lastSeen > staleTimeoutMs) {
                toRemove.push(id);
            }
        }
        for (const id of toRemove) {
            this.removePeer(id);
        }
        return toRemove;
    }

    clear(): void {
        this.peers.clear();
    }
}
