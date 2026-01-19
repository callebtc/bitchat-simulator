export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR';
export type LogCategory = 'GLOBAL' | 'PERSON' | 'DEVICE' | 'CONNECTION' | 'PACKET';

export interface LogEntry {
    id: number;
    timestamp: number;
    level: LogLevel;
    category: LogCategory;
    entityId?: string; // ID of person/device/connection
    message: string;
    details?: any; // Structured data
    color?: string; // Hex color for the entity
}

export class LogManager {
    private logs: LogEntry[] = [];
    private listeners: ((log: LogEntry) => void)[] = [];
    private maxLogs: number = 2000;
    private nextId: number = 1;

    log(level: LogLevel, category: LogCategory, message: string, entityId?: string, details?: any, color?: string) {
        const entry: LogEntry = {
            id: this.nextId++,
            timestamp: Date.now(),
            level,
            category,
            entityId,
            message,
            details,
            color
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        this.listeners.forEach(l => l(entry));
        
        // Console fallback for now, maybe remove later if too noisy
        // console.log(`[${category}] ${message}`, details || '');
    }

    getLogs(filter?: { entityId?: string, category?: LogCategory }): LogEntry[] {
        if (!filter) return this.logs;
        
        return this.logs.filter(log => {
            if (filter.entityId && log.entityId !== filter.entityId) return false;
            if (filter.category && log.category !== filter.category) return false;
            return true;
        });
    }

    clear() {
        this.logs = [];
        this.notifyClear();
    }

    subscribe(callback: (log: LogEntry) => void): () => void {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    }
    
    private notifyClear() {
        // Implement if needed for UI to clear
    }
}
