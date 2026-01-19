import React, { useEffect, useRef, useState } from 'react';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { LogEntry, LogCategory } from '../../simulation/LogManager';

function getCategoryColor(cat: LogCategory): string {
    switch (cat) {
        case 'GLOBAL': return 'text-white';
        case 'PACKET': return 'text-cyan-400';
        case 'CONNECTION': return 'text-green-400';
        case 'PERSON': return 'text-yellow-400';
        case 'DEVICE': return 'text-purple-400';
        default: return 'text-gray-400';
    }
}

export const LogView: React.FC = () => {
    const engine = useSimulation();
    const { selectedId } = useSelection();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const bottomRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);
    const [filterCategory, setFilterCategory] = useState<LogCategory | 'ALL'>('ALL');
    const [onlySelected, setOnlySelected] = useState(false);

    useEffect(() => {
        const updateLogs = (entry: LogEntry) => {
            setLogs(prev => {
                const next = [...prev, entry];
                if (next.length > 500) next.shift(); // Keep UI buffer smaller than engine buffer
                return next;
            });
        };
        
        // Initial load
        setLogs(engine.logManager.getLogs().slice(-100));

        const unsubscribe = engine.logManager.subscribe(updateLogs);
        return unsubscribe;
    }, [engine]);

    useEffect(() => {
        if (autoScroll && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, autoScroll]);

    const filteredLogs = logs.filter(log => {
        if (filterCategory !== 'ALL' && log.category !== filterCategory) return false;
        
        if (onlySelected && selectedId) {
             // If selected is a person/device
             const person = engine.getPerson(selectedId);
             if (person) {
                 if (log.entityId === person.id) return true;
                 if (log.entityId === person.device.peerIDHex) return true;
                 // Include connections?
                 return false;
             }
             // If selected is connection
             if (log.entityId === selectedId) return true;
             
             return false;
        }
        
        return true;
    });

    const handleCopy = () => {
        const text = filteredLogs.map(log => {
            const time = new Date(log.timestamp).toLocaleTimeString();
            const details = log.details ? JSON.stringify(log.details) : '';
            return `[${time}] [${log.category}] ${log.message} ${details}`;
        }).join('\n');
        
        navigator.clipboard.writeText(text);
    };

    return (
        <div className="flex flex-col h-full bg-black/90">
            <div className="flex justify-between items-center p-2 border-b border-gray-700 bg-gray-900/50 text-xs font-mono text-white">
                <div className="flex gap-2 items-center">
                    <span className="font-bold text-gray-400">LOGS</span>
                    <select 
                        value={filterCategory} 
                        onChange={e => setFilterCategory(e.target.value as any)}
                        className="bg-black border border-gray-600 rounded px-1 ml-2"
                    >
                        <option value="ALL">ALL</option>
                        <option value="GLOBAL">GLOBAL</option>
                        <option value="PACKET">PACKET</option>
                        <option value="CONNECTION">CONNECTION</option>
                    </select>
                    
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                        <input 
                            type="checkbox" 
                            checked={onlySelected} 
                            onChange={e => setOnlySelected(e.target.checked)}
                        />
                        <span className={selectedId ? "text-white" : "text-gray-500"}>
                            {selectedId ? "Filter Selected" : "Select Node"}
                        </span>
                    </label>
                </div>
                <div className="flex gap-2 items-center">
                     <label className="flex items-center gap-1">
                        <input 
                            type="checkbox" 
                            checked={autoScroll} 
                            onChange={e => setAutoScroll(e.target.checked)}
                        />
                        <span>Auto-scroll</span>
                    </label>
                    <button 
                        onClick={() => handleCopy()} 
                        className="text-blue-400 hover:text-blue-300 px-2"
                    >
                        Copy
                    </button>
                    <button 
                        onClick={() => engine.logManager.clear()} 
                        className="text-red-400 hover:text-red-300 px-2"
                    >
                        Clear
                    </button>
                </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs font-mono text-white">
                {filteredLogs.map(log => (
                    <div key={log.id} className="flex gap-2 hover:bg-white/5">
                        <span className="opacity-50 min-w-[60px]">
                            {new Date(log.timestamp).toLocaleTimeString().split(' ')[0]}
                        </span>
                        
                        {log.entityId && log.category === 'PACKET' && (
                            <span 
                                className="font-mono font-bold min-w-[70px]"
                                style={{ color: log.color }}
                            >
                                {log.entityId.substring(0, 6)}:
                            </span>
                        )}
                        
                        <span className={`min-w-[80px] font-bold ${getCategoryColor(log.category)}`}>
                            [{log.category}]
                        </span>
                        <span className="flex-1 break-all">
                            {log.message}
                            {log.details && (
                                <span className="text-gray-500 ml-2">
                                    {JSON.stringify(log.details)}
                                </span>
                            )}
                        </span>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
        </div>
    );
};
