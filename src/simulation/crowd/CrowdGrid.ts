/**
 * CrowdGrid
 * Per-step snapshot of every pedestrian's position and velocity in a fine
 * (3 m) uniform hash grid. Steering reads neighbours from this snapshot, so
 * all agents react to the same world state each tick (Jacobi update): the
 * result is independent of update order and fully deterministic.
 */

export const CROWD_CELL_M = 3;
const OFFSET = 1 << 15;
const STRIDE = 1 << 16;

const cellKey = (gx: number, gy: number): number => (gx + OFFSET) * STRIDE + (gy + OFFSET);

export interface CrowdSnapshotAgent {
    id: string;
    position: { x: number; y: number };
    velocity: { x: number; y: number };
}

export class CrowdGrid {
    count = 0;
    px = new Float64Array(0);
    py = new Float64Array(0);
    vx = new Float64Array(0);
    vy = new Float64Array(0);
    ids: string[] = [];
    private indexById = new Map<string, number>();
    private cells = new Map<number, number[]>();
    private pool: number[][] = [];

    rebuild(agents: ReadonlyArray<CrowdSnapshotAgent>): void {
        const n = agents.length;
        if (this.px.length < n) {
            const cap = Math.max(64, n * 2);
            this.px = new Float64Array(cap);
            this.py = new Float64Array(cap);
            this.vx = new Float64Array(cap);
            this.vy = new Float64Array(cap);
        }
        for (const list of this.cells.values()) {
            list.length = 0;
            this.pool.push(list);
        }
        this.cells.clear();
        this.indexById.clear();
        this.ids.length = n;
        this.count = n;
        for (let i = 0; i < n; i++) {
            const a = agents[i];
            this.px[i] = a.position.x;
            this.py[i] = a.position.y;
            this.vx[i] = a.velocity.x;
            this.vy[i] = a.velocity.y;
            this.ids[i] = a.id;
            this.indexById.set(a.id, i);
            const key = cellKey(Math.floor(a.position.x / CROWD_CELL_M), Math.floor(a.position.y / CROWD_CELL_M));
            let list = this.cells.get(key);
            if (!list) {
                list = this.pool.pop() ?? [];
                this.cells.set(key, list);
            }
            list.push(i);
        }
    }

    indexOf(id: string): number {
        return this.indexById.get(id) ?? -1;
    }

    /**
     * Collect indices of agents within `radius` of (x, y), excluding `self`,
     * nearest first, at most `max`. Writes into `out` / `outDist2` and returns
     * the count.
     */
    query(x: number, y: number, radius: number, self: number, max: number, out: Int32Array, outDist2: Float64Array): number {
        const r2 = radius * radius;
        const g0x = Math.floor((x - radius) / CROWD_CELL_M);
        const g1x = Math.floor((x + radius) / CROWD_CELL_M);
        const g0y = Math.floor((y - radius) / CROWD_CELL_M);
        const g1y = Math.floor((y + radius) / CROWD_CELL_M);
        let n = 0;
        for (let gx = g0x; gx <= g1x; gx++) {
            for (let gy = g0y; gy <= g1y; gy++) {
                const list = this.cells.get(cellKey(gx, gy));
                if (!list) continue;
                for (let k = 0; k < list.length; k++) {
                    const j = list[k];
                    if (j === self) continue;
                    const dx = this.px[j] - x;
                    const dy = this.py[j] - y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 > r2) continue;
                    // Insertion into a small sorted buffer (max ≈ 16)
                    let pos = n < max ? n : max;
                    if (pos === max && d2 >= outDist2[max - 1]) continue;
                    while (pos > 0 && outDist2[pos - 1] > d2) {
                        if (pos < max) {
                            out[pos] = out[pos - 1];
                            outDist2[pos] = outDist2[pos - 1];
                        }
                        pos--;
                    }
                    out[pos] = j;
                    outDist2[pos] = d2;
                    if (n < max) n++;
                }
            }
        }
        return n;
    }
}
