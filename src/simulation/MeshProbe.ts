import { SimulationEngine } from './SimulationEngine';
import { TransportKind } from './BitchatConnection';
import { BitchatConnectionBLE } from './BitchatConnectionBLE';
import { BitchatConnectionWifiAware } from './BitchatConnectionWifiAware';
import { BitchatAppSimulator } from './AppLayer/BitchatAppSimulator';
import { BitchatDevice } from './BitchatDevice';

export type ProbeReachabilityStatus =
    | 'direct_wifi'
    | 'direct_ble'
    | 'source_route'
    | 'flood_reachable'
    | 'exceeds_ttl'
    | 'unreachable';

export interface DirectLinkProbeInfo {
    transport: TransportKind;
    rssiDbm: number;
    linkId: string;
}

export interface PeerRouteProbe {
    fromPeerHex: string;
    toPeerHex: string;
    status: ProbeReachabilityStatus;
    /** Whether a DM is expected to reach the recipient right now */
    canDeliver: boolean;
    /** Active 1-hop direct link if connected (prefers Wi-Fi Aware if both exist) */
    directLink?: DirectLinkProbeInfo;
    /** Protocol-level bidirectional confirmed MeshGraph route (peerIDHex[] including endpoints) */
    sourceRoutePath: string[] | null;
    /** Shortest physical active-link path across the mesh (peerIDHex[] including endpoints) */
    physicalPath: string[] | null;
    /** Best path to display on map (direct -> sourceRoute -> physical) */
    displayPath: string[] | null;
    /** Number of hops in displayPath (0 if none, 1 if direct) */
    hops: number;
    /** Sender's configured maxTtl */
    maxTtl: number;
    /** Sender's Noise XX session state with recipient */
    noiseState: 'none' | 'handshaking' | 'established';
    /** Queued DM count in sender's outbox for this recipient */
    outboxQueued: number;
    /** Whether sender has verified recipient's announce signing key */
    hasVerifiedKey: boolean;
}

const MAX_PHYSICAL_PROBE_DEPTH = 16;

/**
 * Pure, read-only reachability and route probe between two peers in the mesh.
 * Runs in O(visited) using per-device active link lists so it remains instant
 * (< 0.1 ms) even in 5,000-node simulations.
 */
export function probePeerRoute(
    engine: SimulationEngine,
    fromPeerHex: string,
    toPeerHex: string
): PeerRouteProbe {
    const fromPerson = engine.getPersonByPeerId(fromPeerHex);
    const toPerson = engine.getPersonByPeerId(toPeerHex);
    const sim = fromPerson?.device.appSimulator as BitchatAppSimulator | undefined;
    const maxTtl = sim?.policy.maxTtl ?? 7;

    const rawNoiseState = sim?.noiseManager.getSession(toPeerHex)?.state;
    const noiseState: 'none' | 'handshaking' | 'established' =
        rawNoiseState === 'established'
            ? 'established'
            : rawNoiseState === 'initiator_sent_msg1' || rawNoiseState === 'responder_sent_msg2'
              ? 'handshaking'
              : 'none';
    const outboxQueued = sim?.messageRouter.getOutboxCount(toPeerHex) ?? 0;
    const hasVerifiedKey = Boolean(sim?.peerManager.getPeer(toPeerHex)?.signingPublicKey);

    if (!fromPerson || !toPerson || fromPeerHex === toPeerHex) {
        return {
            fromPeerHex,
            toPeerHex,
            status: 'unreachable',
            canDeliver: false,
            sourceRoutePath: null,
            physicalPath: null,
            displayPath: null,
            hops: 0,
            maxTtl,
            noiseState,
            outboxQueued,
            hasVerifiedKey,
        };
    }

    // 1. Check for an active 1-hop direct physical connection (prefer Wi-Fi Aware over BLE)
    const fromActive = fromPerson.device.connectionManager.getActiveConnections();
    let directLink: DirectLinkProbeInfo | undefined;
    for (let i = 0; i < fromActive.length; i++) {
        const conn = fromActive[i];
        if (!conn.isActive || !conn.isReady) continue;
        const other = conn.getOtherParty(fromPerson.device);
        if (other.peerIDHex !== toPeerHex) continue;

        const rssiDbm =
            conn instanceof BitchatConnectionBLE || conn instanceof BitchatConnectionWifiAware
                ? conn.rssi
                : -50;
        const candidate: DirectLinkProbeInfo = {
            transport: conn.transportType,
            rssiDbm,
            linkId: conn.linkID,
        };
        if (!directLink || (candidate.transport === 'WIFI_AWARE' && directLink.transport !== 'WIFI_AWARE')) {
            directLink = candidate;
        }
    }

    if (directLink) {
        const path = [fromPeerHex, toPeerHex];
        return {
            fromPeerHex,
            toPeerHex,
            status: directLink.transport === 'WIFI_AWARE' ? 'direct_wifi' : 'direct_ble',
            canDeliver: true,
            directLink,
            sourceRoutePath: null,
            physicalPath: path,
            displayPath: path,
            hops: 1,
            maxTtl,
            noiseState,
            outboxQueued,
            hasVerifiedKey,
        };
    }

    // 2. Check protocol-level bidirectional MeshGraph source route
    const sourceRoutePath = sim
        ? sim.meshGraph.getShortestPath(fromPeerHex, toPeerHex, sim.policy.maxSourceRouteHops)
        : null;

    // 3. Local-adjacency BFS over active ready links to find shortest physical multi-hop path
    const physicalPath = findShortestPhysicalPath(
        fromPerson.device,
        toPeerHex,
        MAX_PHYSICAL_PROBE_DEPTH
    );

    if (sourceRoutePath && sourceRoutePath.length >= 2) {
        const hops = sourceRoutePath.length - 1;
        return {
            fromPeerHex,
            toPeerHex,
            status: 'source_route',
            canDeliver: hops <= maxTtl,
            sourceRoutePath,
            physicalPath,
            displayPath: sourceRoutePath,
            hops,
            maxTtl,
            noiseState,
            outboxQueued,
            hasVerifiedKey,
        };
    }

    if (physicalPath && physicalPath.length >= 2) {
        const hops = physicalPath.length - 1;
        const withinTtl = hops <= maxTtl;
        return {
            fromPeerHex,
            toPeerHex,
            status: withinTtl ? 'flood_reachable' : 'exceeds_ttl',
            canDeliver: withinTtl,
            sourceRoutePath: null,
            physicalPath,
            displayPath: physicalPath,
            hops,
            maxTtl,
            noiseState,
            outboxQueued,
            hasVerifiedKey,
        };
    }

    return {
        fromPeerHex,
        toPeerHex,
        status: 'unreachable',
        canDeliver: false,
        sourceRoutePath: null,
        physicalPath: null,
        displayPath: null,
        hops: 0,
        maxTtl,
        noiseState,
        outboxQueued,
        hasVerifiedKey,
    };
}

function findShortestPhysicalPath(
    startDevice: BitchatDevice,
    targetPeerHex: string,
    maxDepth: number
): string[] | null {
    const startHex = startDevice.peerIDHex;
    const queue: BitchatDevice[] = [startDevice];
    const depths: number[] = [0];
    let head = 0;

    const visited = new Set<string>([startHex]);
    const parent = new Map<string, string>();

    while (head < queue.length) {
        const curr = queue[head];
        const depth = depths[head];
        head++;

        if (depth >= maxDepth) continue;

        const conns = curr.connectionManager.getActiveConnections();
        for (let i = 0; i < conns.length; i++) {
            const conn = conns[i];
            if (!conn.isActive || !conn.isReady) continue;
            const neighbor = conn.getOtherParty(curr);
            const nHex = neighbor.peerIDHex;
            if (visited.has(nHex)) continue;

            visited.add(nHex);
            parent.set(nHex, curr.peerIDHex);

            if (nHex === targetPeerHex) {
                const path: string[] = [targetPeerHex];
                let node = targetPeerHex;
                while (node !== startHex) {
                    const prev = parent.get(node);
                    if (!prev) break;
                    path.push(prev);
                    node = prev;
                }
                path.reverse();
                return path;
            }

            queue.push(neighbor);
            depths.push(depth + 1);
        }
    }

    return null;
}
