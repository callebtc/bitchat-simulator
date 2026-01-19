import React, { useEffect, useState, useRef } from 'react';
import { useSimulation } from '../context/SimulationContext';

interface LogEntry {
    id: string;
    timestamp: number;
    type: 'connection' | 'packet' | 'system';
    message: string;
}

export const Terminal: React.FC = () => {
    const engine = useSimulation();
    const [isOpen, setIsOpen] = useState(false); // Collapsed by default
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);

    const addLog = (type: LogEntry['type'], message: string) => {
        setLogs(prev => {
            const next = [...prev, {
                id: Math.random().toString(),
                timestamp: Date.now(),
                type,
                message
            }];
            if (next.length > 50) next.shift(); // Keep last 50
            return next;
        });
    };

    useEffect(() => {
        const onConnFormed = (c: any) => addLog('connection', `Connected: ${c.endpointA.nickname} <-> ${c.endpointB.nickname}`);
        const onConnBroken = (c: any) => addLog('connection', `Disconnected: ${c.endpointA.nickname} <-> ${c.endpointB.nickname}`);
        const onReset = () => { setLogs([]); addLog('system', 'Simulation Reset'); };
        
        // Listen for all packets? That's too noisy. 
        // Maybe just summary or rely on Inspector for details.
        // Let's hook into engine tick to scan for packets? No.
        // We can listen to 'tick' but that doesn't give packets.
        // For now, track topology changes which are most interesting globally.
        
        engine.events.on('connection_formed', onConnFormed);
        engine.events.on('connection_broken', onConnBroken);
        engine.events.on('reset', onReset);

        return () => {
            engine.events.off('connection_formed', onConnFormed);
            engine.events.off('connection_broken', onConnBroken);
            engine.events.off('reset', onReset);
        };
    }, [engine]);

    // Auto scroll
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs, isOpen]);

    return (
        <div className={`absolute bottom-0 left-0 right-0 bg-black/95 text-white border-t border-gray-800 transition-all duration-300 flex flex-col ${isOpen ? 'h-64' : 'h-8'}`}>
            {/* Header / Toggle */}
            <div 
                className="flex items-center justify-between px-4 h-8 bg-gray-900 cursor-pointer hover:bg-gray-800 select-none"
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-green-500">➜</span>
                    <span className="font-bold">TERMINAL</span>
                    <span className="opacity-50">| {logs.length} events</span>
                </div>
                <div className="text-xs opacity-50">
                    {isOpen ? '▼' : '▲'}
                </div>
            </div>

            {/* Content */}
            {isOpen && (
                <div 
                    ref={scrollRef}
                    className="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-1"
                >
                    {logs.map(log => (
                        <div key={log.id} className="flex gap-2">
                            <span className="opacity-30">
                                {new Date(log.timestamp).toLocaleTimeString().split(' ')[0]}
                            </span>
                            <span className={`
                                ${log.type === 'connection' ? 'text-yellow-400' : ''}
                                ${log.type === 'system' ? 'text-cyan-400' : ''}
                            `}>
                                {log.message}
                            </span>
                        </div>
                    ))}
                    <div className="h-2" />
                </div>
            )}
        </div>
    );
};
