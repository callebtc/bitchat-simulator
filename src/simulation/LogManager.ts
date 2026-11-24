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

export class LogManager {
    private logs: LogEntry[] = [];
    private listeners: ((log: LogEntry) => void)[] = [];
    private maxLogs: number = 2000;
    private nextId: number = 1;
    private clock: () => number = () => 0;

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

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        this.listeners.forEach(l => l(entry));
    }

    getLogs(filter?: { entityId?: string; category?: LogCategory }): LogEntry[] {
        if (!filter) return this.logs;

        return this.logs.filter(log => {
            if (filter.entityId && log.entityId !== filter.entityId) return false;
            if (filter.category && log.category !== filter.category) return false;
            return true;
        });
    }

    clear(): void {
        this.logs = [];
    }

    subscribe(callback: (log: LogEntry) => void): () => void {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    }
}
