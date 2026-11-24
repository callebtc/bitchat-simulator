import { BitchatConnection } from '../../simulation/BitchatConnection';
import { BitchatPerson } from '../../simulation/BitchatPerson';
import { SimulationEngine } from '../../simulation/SimulationEngine';

/**
 * O(1) spatial-grid node hit test at world point (x, y).
 * Replaces Three.js InstancedMesh triangle raycasting so mouse moves & clicks
 * remain instant (< 0.01 ms) even with 5,000+ rendered nodes.
 */
export function findNearestPersonAt(
    engine: SimulationEngine,
    x: number,
    y: number,
    maxDist: number = 5.5
): BitchatPerson | null {
    const candidates = engine.spatial.getNeighborsAt(x, y, maxDist);
    let best: BitchatPerson | null = null;
    let bestDistSq = maxDist * maxDist;

    for (let i = 0; i < candidates.length; i++) {
        const p = candidates[i];
        const dx = p.position.x - x;
        const dy = p.position.y - y;
        const dSq = dx * dx + dy * dy;
        if (dSq < bestDistSq) {
            bestDistSq = dSq;
            best = p;
        }
    }

    return best;
}

/**
 * Find the closest active connection to world point (x, y) within `maxDist` meters.
 * Used for click-to-inspect connection selection without spawning per-edge hit meshes.
 */
export function findNearestConnectionAt(
    connections: BitchatConnection[],
    x: number,
    y: number,
    maxDist: number = 4.5
): BitchatConnection | null {
    let best: BitchatConnection | null = null;
    let bestDistSq = maxDist * maxDist;

    for (let i = 0; i < connections.length; i++) {
        const conn = connections[i];
        const a = conn.endpointA.position;
        const b = conn.endpointB.position;
        if (!a || !b) continue;

        const minX = (a.x < b.x ? a.x : b.x) - maxDist;
        const maxX = (a.x > b.x ? a.x : b.x) + maxDist;
        const minY = (a.y < b.y ? a.y : b.y) - maxDist;
        const maxY = (a.y > b.y ? a.y : b.y) + maxDist;
        if (x < minX || x > maxX || y < minY || y > maxY) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        let t = 0;
        if (lenSq > 0.0001) {
            t = ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
        }
        const px = a.x + t * dx;
        const py = a.y + t * dy;
        const dSq = (x - px) * (x - px) + (y - py) * (y - py);
        if (dSq < bestDistSq) {
            bestDistSq = dSq;
            best = conn;
        }
    }

    return best;
}
