/**
 * Deterministic millisecond-precision min-heap discrete event scheduler.
 *
 * Used alongside the fixed 50 ms physics tick so sub-tick protocol timers
 * (15 ms GATT retries, 20 ms fragment pacing, 8-25 ms voice jitter,
 * 10-220 ms iOS relay jitter, staged GATT handshakes) execute in exact
 * chronological and insertion order without wall-clock timers.
 */

export interface ScheduledEventHandle {
    readonly id: number;
    readonly fireAtMs: number;
    readonly tag?: string;
}

interface ScheduledNode {
    id: number;
    seq: number;
    fireAtMs: number;
    callback: (nowMs: number) => void;
    cancelled: boolean;
    tag?: string;
}

export class EventScheduler {
    private heap: ScheduledNode[] = [];
    private byId: Map<number, ScheduledNode> = new Map();
    private nextId: number = 1;
    private nextSeq: number = 1;
    private currentTimeMs: number = 0;

    now(): number {
        return this.currentTimeMs;
    }

    setTime(timeMs: number): void {
        if (timeMs > this.currentTimeMs) {
            this.currentTimeMs = timeMs;
        }
    }

    scheduleAt(
        fireAtMs: number,
        callback: (nowMs: number) => void,
        tag?: string
    ): ScheduledEventHandle {
        const clampedFireAt = Math.max(this.currentTimeMs, fireAtMs);
        const node: ScheduledNode = {
            id: this.nextId++,
            seq: this.nextSeq++,
            fireAtMs: clampedFireAt,
            callback,
            cancelled: false,
            tag,
        };
        this.byId.set(node.id, node);
        this.push(node);
        return { id: node.id, fireAtMs: clampedFireAt, tag };
    }

    scheduleIn(
        delayMs: number,
        callback: (nowMs: number) => void,
        tag?: string
    ): ScheduledEventHandle {
        return this.scheduleAt(this.currentTimeMs + Math.max(0, delayMs), callback, tag);
    }

    cancel(handle: ScheduledEventHandle | null | undefined): boolean {
        if (!handle) return false;
        const node = this.byId.get(handle.id);
        if (!node || node.cancelled) return false;
        node.cancelled = true;
        this.byId.delete(handle.id);
        return true;
    }

    /**
     * Drains all scheduled events with fireAtMs <= targetTimeMs in strict
     * (fireAtMs, insertionSeq) order, updating currentTimeMs to each event's
     * fire time before invoking its callback.
     */
    drainUntil(targetTimeMs: number): number {
        let fired = 0;
        while (this.heap.length > 0) {
            const top = this.heap[0];
            if (top.cancelled) {
                this.pop();
                continue;
            }
            if (top.fireAtMs > targetTimeMs) {
                break;
            }
            this.pop();
            this.byId.delete(top.id);
            if (top.fireAtMs > this.currentTimeMs) {
                this.currentTimeMs = top.fireAtMs;
            }
            top.callback(this.currentTimeMs);
            fired++;
        }
        if (targetTimeMs > this.currentTimeMs) {
            this.currentTimeMs = targetTimeMs;
        }
        return fired;
    }

    pendingCount(): number {
        return this.byId.size;
    }

    clear(resetTimeMs: number = 0): void {
        this.heap = [];
        this.byId.clear();
        this.currentTimeMs = resetTimeMs;
    }

    private isBefore(a: ScheduledNode, b: ScheduledNode): boolean {
        if (a.fireAtMs !== b.fireAtMs) {
            return a.fireAtMs < b.fireAtMs;
        }
        return a.seq < b.seq;
    }

    private push(node: ScheduledNode): void {
        this.heap.push(node);
        let idx = this.heap.length - 1;
        while (idx > 0) {
            const parent = (idx - 1) >> 1;
            if (!this.isBefore(this.heap[idx], this.heap[parent])) break;
            const tmp = this.heap[parent];
            this.heap[parent] = this.heap[idx];
            this.heap[idx] = tmp;
            idx = parent;
        }
    }

    private pop(): ScheduledNode | undefined {
        if (this.heap.length === 0) return undefined;
        const root = this.heap[0];
        const last = this.heap.pop()!;
        if (this.heap.length > 0) {
            this.heap[0] = last;
            let idx = 0;
            const len = this.heap.length;
            while (true) {
                const left = (idx << 1) + 1;
                const right = left + 1;
                let smallest = idx;
                if (left < len && this.isBefore(this.heap[left], this.heap[smallest])) {
                    smallest = left;
                }
                if (right < len && this.isBefore(this.heap[right], this.heap[smallest])) {
                    smallest = right;
                }
                if (smallest === idx) break;
                const tmp = this.heap[idx];
                this.heap[idx] = this.heap[smallest];
                this.heap[smallest] = tmp;
                idx = smallest;
            }
        }
        return root;
    }
}
