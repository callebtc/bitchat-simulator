export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR';
export type LogCategory = 'GLOBAL' | 'PERSON' | 'DEVICE' | 'CONNECTION' | 'PACKET';

export type LogDetails = object | string | number | boolean | null;

export interface LogEntry {
    id: number;
    timestamp: number;
    level: LogLevel;
    category: LogCategory;
    entityId?: string;
    message: string;
    details?: LogDetails;
    color?: string;
}

/**
 * O(1) circular ring-buffer log manager so high-density 1000+ node runs
 * never stall on O(N) array.shift() calls.
 */
export class LogManager {
    private buffer: Array<LogEntry | undefined>;
    private head: number = 0;
    private count: number = 0;
    private readonly maxLogs: number = 1000;
    private listeners: ((log: LogEntry) => void)[] = [];
    private nextId: number = 1;
    private clock: () => number = () => 0;
    /** When true, drops noisy DEBUG entries to keep 1000+ node simulations fast. */
    suppressDebug: boolean = false;

    constructor(maxLogs: number = 1000) {
        this.maxLogs = maxLogs;
        this.buffer = new Array<LogEntry | undefined>(maxLogs);
    }

    setClock(clock: () => number): void {
        this.clock = clock;
    }

    log(
        level: LogLevel,
        category: LogCategory,
        message: string,
        entityId?: string,
        details?: LogDetails,
        color?: string
    ): void {
        if (this.suppressDebug && level === 'DEBUG') return;

        const entry: LogEntry = {
            id: this.nextId++,
            timestamp: this.clock(),
            level,
            category,
            entityId,
            message,
            details,
            color,
        };

        const writeIdx = (this.head + this.count) % this.maxLogs;
        this.buffer[writeIdx] = entry;
        if (this.count < this.maxLogs) {
            this.count++;
        } else {
            this.head = (this.head + 1) % this.maxLogs;
        }

        for (let i = 0; i < this.listeners.length; i++) {
            this.listeners[i](entry);
        }
    }

    getLogs(filter?: { entityId?: string; category?: LogCategory }): LogEntry[] {
        const result: LogEntry[] = [];
        for (let i = 0; i < this.count; i++) {
            const log = this.buffer[(this.head + i) % this.maxLogs];
            if (!log) continue;
            if (filter) {
                if (filter.entityId && log.entityId !== filter.entityId) continue;
                if (filter.category && log.category !== filter.category) continue;
            }
            result.push(log);
        }
        return result;
    }

    clear(): void {
        this.buffer.fill(undefined);
        this.head = 0;
        this.count = 0;
    }

    subscribe(callback: (log: LogEntry) => void): () => void {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    }
}
