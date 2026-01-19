import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { addRandomNode, setupDemo } from '../../simulation/DemoSetup';
import { usePersistedState } from '../../utils/usePersistedState';
import { EnvironmentSection } from './EnvironmentSection';

// Types for history data
interface HistoryPoint {
    time: number;
    value: number;
}

const HISTORY_DURATION_MS = 30000; // 30 seconds
const UPDATE_INTERVAL_MS = 100; // Update UI every 100ms

const TinyGraph: React.FC<{ data: HistoryPoint[], color: string, label: string, maxValue?: number }> = ({ data, color, label, maxValue }) => {
    // Logical dimensions for viewBox
    const VIEW_WIDTH = 100;
    const VIEW_HEIGHT = 50;
    
    const points = useMemo(() => {
        if (data.length < 2) return "";
        
        const now = Date.now();
        const startTime = now - HISTORY_DURATION_MS;
        
        // Find max value for auto-scaling if not provided
        const max = maxValue ?? Math.max(...data.map(d => d.value), 1);
        
        return data.map(d => {
            const x = ((d.time - startTime) / HISTORY_DURATION_MS) * VIEW_WIDTH;
            const y = VIEW_HEIGHT - (d.value / max) * VIEW_HEIGHT;
            return `${x},${y}`;
        }).join(' ');
    }, [data, maxValue]);

    return (
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
            <div className="flex justify-between items-baseline text-[10px] text-gray-400 font-mono leading-none">
                <span>{label}</span>
                <span>{data.length > 0 ? data[data.length - 1].value.toFixed(0) : 0}</span>
            </div>
            <div className="border border-gray-800 bg-black/50 relative overflow-hidden w-full" style={{ height: 50 }}>
                <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} className="block w-full h-full" preserveAspectRatio="none">
                    <polyline
                        fill="none"
                        stroke={color}
                        strokeWidth="1.5"
                        points={points}
                        vectorEffect="non-scaling-stroke"
                    />
                </svg>
            </div>
        </div>
    );
};

export const MainControlPanel: React.FC = () => {
    const engine = useSimulation();
    const { viewCenter } = useSelection();
    const [currentTime, setCurrentTime] = useState(Date.now());
    const [isCollapsed, setIsCollapsed] = usePersistedState('main_panel_collapsed', false);
    
    // Stats Refs (to avoid re-renders on every packet)
    const statsRef = useRef({
        packetTimestamps: [] as number[], // timestamps of packets
        totalPackets: 0,
        connectionHistory: [] as HistoryPoint[],
        ppsHistory: [] as HistoryPoint[],
    });

    // Force re-render for UI updates
    const [, forceUpdate] = useState({});

    useEffect(() => {
        const handlePacket = () => {
            const now = Date.now();
            statsRef.current.packetTimestamps.push(now);
            statsRef.current.totalPackets++;
        };

        const handleReset = () => {
            statsRef.current = {
                packetTimestamps: [],
                totalPackets: 0,
                connectionHistory: [],
                ppsHistory: [],
            };
            forceUpdate({});
        };

        engine.events.on('packet_transmitted', handlePacket);
        engine.events.on('reset', handleReset);

        const interval = setInterval(() => {
            const now = Date.now();
            setCurrentTime(now);

            // Prune packet timestamps older than 1 minute
            const cutoff1m = now - 60000;
            const timestamps = statsRef.current.packetTimestamps;
            
            // Binary search or simple filter for pruning? Simple filter is fine for <10k items
            // Optimization: find index of first valid item
            let validIdx = 0;
            while(validIdx < timestamps.length && timestamps[validIdx] < cutoff1m) {
                validIdx++;
            }
            if (validIdx > 0) {
                statsRef.current.packetTimestamps = timestamps.slice(validIdx);
            }

            // Update Histories
            const connCount = engine.getAllConnections().length;
            
            // Calculate PPS (packets in last 1s)
            const cutoff1s = now - 1000;
            let pps = 0;
            for (let i = statsRef.current.packetTimestamps.length - 1; i >= 0; i--) {
                if (statsRef.current.packetTimestamps[i] >= cutoff1s) {
                    pps++;
                } else {
                    break;
                }
            }

            // Add history points
            statsRef.current.connectionHistory.push({ time: now, value: connCount });
            statsRef.current.ppsHistory.push({ time: now, value: pps });

            // Prune history
            const historyCutoff = now - HISTORY_DURATION_MS;
            statsRef.current.connectionHistory = statsRef.current.connectionHistory.filter(d => d.time > historyCutoff);
            statsRef.current.ppsHistory = statsRef.current.ppsHistory.filter(d => d.time > historyCutoff);
            
            forceUpdate({});

        }, UPDATE_INTERVAL_MS);

        return () => {
            engine.events.off('packet_transmitted', handlePacket);
            engine.events.off('reset', handleReset);
            clearInterval(interval);
        };
    }, [engine]);

    // Derived stats for render
    const now = currentTime;
    const timestamps = statsRef.current.packetTimestamps;
    
    const count1s = statsRef.current.ppsHistory.length > 0 ? statsRef.current.ppsHistory[statsRef.current.ppsHistory.length - 1].value : 0;
    
    // Efficiently count last 10s
    const cutoff10s = now - 10000;
    let count10s = 0;
    for (let i = timestamps.length - 1; i >= 0; i--) {
        if (timestamps[i] >= cutoff10s) count10s++;
        else break;
    }
    
    const count1m = timestamps.length; // We prune > 1m so length is correct
    
    const peerCount = engine.getAllPeople().length;
    const connCount = engine.getAllConnections().length;

    return (
        <div className="absolute top-4 left-4 w-72 bg-black/90 text-white p-3 rounded backdrop-blur-md border border-gray-800 shadow-2xl font-mono select-none pointer-events-auto transition-all duration-300">
            {/* Header */}
            <div className={`flex justify-between items-center ${isCollapsed ? '' : 'mb-3 border-b border-gray-800 pb-2'} transition-all`}>
                <div className="flex items-center gap-2">
                     <h1 className="text-sm font-bold tracking-widest text-gray-200">BITCHAT<span className="text-cyan-500">SIM</span></h1>
                     <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
                        <span className="text-[10px] text-gray-500">LIVE</span>
                    </div>
                </div>
                
                <button 
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="text-gray-500 hover:text-white transition-colors p-1"
                >
                    {isCollapsed ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
                    )}
                </button>
            </div>

            {/* Collapsible Content */}
            <div className={`space-y-3 overflow-hidden transition-all duration-300 ease-in-out ${isCollapsed ? 'max-h-0 opacity-0' : 'max-h-[700px] opacity-100'}`}>
                {/* Main Stats Grid */}
                <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-900/50 p-2 rounded border border-gray-800">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Peers</div>
                        <div className="text-xl text-cyan-400 font-bold leading-none mt-1">{peerCount}</div>
                    </div>
                    <div className="bg-gray-900/50 p-2 rounded border border-gray-800">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Conns</div>
                        <div className="text-xl text-green-400 font-bold leading-none mt-1">{connCount}</div>
                    </div>
                </div>

                {/* Packet Stats */}
                <div className="space-y-1">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-800 pb-1 mb-1">Packet Traffic</div>
                    <div className="grid grid-cols-4 gap-1 text-center">
                        <div>
                            <div className="text-[9px] text-gray-600">1s</div>
                            <div className="text-xs text-white">{count1s}</div>
                        </div>
                        <div>
                            <div className="text-[9px] text-gray-600">10s</div>
                            <div className="text-xs text-white">{count10s}</div>
                        </div>
                        <div>
                            <div className="text-[9px] text-gray-600">1m</div>
                            <div className="text-xs text-white">{count1m}</div>
                        </div>
                        <div>
                            <div className="text-[9px] text-gray-600">Total</div>
                            <div className="text-xs text-white">{statsRef.current.totalPackets}</div>
                        </div>
                    </div>
                </div>

                {/* Graphs */}
                <div className="flex gap-2 justify-between border-t border-gray-800 pt-2 w-full">
                    <TinyGraph 
                        data={statsRef.current.connectionHistory} 
                        color="#4ade80" 
                        label="CONNS" 
                    />
                    <TinyGraph 
                        data={statsRef.current.ppsHistory} 
                        color="#22d3ee" 
                        label="PKT/S" 
                    />
                </div>

                {/* Actions */}
                <div className="flex gap-1.5 pt-1">
                    <button 
                        className="flex-1 bg-cyan-900/30 hover:bg-cyan-800/50 text-cyan-200 px-2 py-1.5 rounded text-[10px] font-bold border border-cyan-800/50 transition-all hover:shadow-[0_0_10px_rgba(34,211,238,0.2)]"
                        onClick={() => addRandomNode(engine, viewCenter)}
                    >
                        + ADD NODE
                    </button>
                    <button 
                        className="flex-1 bg-red-900/20 hover:bg-red-900/40 text-red-300 px-2 py-1.5 rounded text-[10px] font-bold border border-red-900/50 transition-all"
                        onClick={() => setupDemo(engine, 5)}
                    >
                        RESET
                    </button>
                </div>

                {/* Environment Section */}
                <EnvironmentSection />
            </div>
        </div>
    );
};
