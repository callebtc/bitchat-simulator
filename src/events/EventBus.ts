export type EventCallback<T = any> = (data: T) => void;

export class EventBus {
    private listeners: Map<string, EventCallback[]> = new Map();

    on<T>(event: string, callback: EventCallback<T>): void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(callback);
    }

    off<T>(event: string, callback: EventCallback<T>): void {
        if (!this.listeners.has(event)) return;
        const callbacks = this.listeners.get(event)!;
        const index = callbacks.indexOf(callback);
        if (index > -1) {
            callbacks.splice(index, 1);
        }
    }

    emit<T>(event: string, data: T): void {
        if (!this.listeners.has(event)) return;
        this.listeners.get(event)!.forEach(cb => cb(data));
    }
    
    clear(): void {
        this.listeners.clear();
    }
}
