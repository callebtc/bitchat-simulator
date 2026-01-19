import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { addRandomNode, setupDemo } from '../../simulation/DemoSetup';
import { MovementMode } from '../../simulation/BitchatPerson';
import { usePersistedState } from '../../utils/usePersistedState';
import { EnvironmentSection } from './EnvironmentSection';
import { useLayout } from '../context/LayoutContext';
import { useVisualization } from '../context/VisualizationContext';
import { PerformanceStats } from './PerformanceStats';

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

const CollapsibleSection: React.FC<{
    title: string;
    isExpanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
    icon?: React.ReactNode;
}> = ({ title, isExpanded, onToggle, children, icon }) => {
    return (
        <div className="border-t border-gray-800 pt-2">
            <button 
                className="w-full flex justify-between items-center text-[10px] text-gray-500 hover:text-gray-300 transition-colors mb-1"
                onClick={onToggle}
            >
                <span className="uppercase tracking-wider font-bold flex items-center gap-2">
                    {icon}
                    {title}
                </span>
                <svg 
                    width="10" height="6" viewBox="0 0 10 6" fill="none" 
                    className={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                >
                    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
            </button>
            <div className={`overflow-hidden transition-all duration-300 ${isExpanded ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'}`}>
                <div className="pt-1">
                    {children}
                </div>
            </div>
        </div>
    );
};

export const MainControlPanel: React.FC = () => {
    const engine = useSimulation();
    const { viewCenter } = useSelection();
    const { bottomPanelHeight } = useLayout();
    const { showAnnouncePackets, setShowAnnouncePackets } = useVisualization();
    
    const [currentTime, setCurrentTime] = useState(Date.now());
    const [isCollapsed, setIsCollapsed] = usePersistedState('main_panel_collapsed', false);
    
    // Collapsible states
    const [isStatsExpanded, setIsStatsExpanded] = usePersistedState('stats_section_expanded', true);
    const [isVizExpanded, setIsVizExpanded] = usePersistedState('viz_section_expanded', true);
    const [isPopExpanded, setIsPopExpanded] = usePersistedState('pop_section_expanded', true);
    
    // Spawn busy toggle - NOT persisted, defaults to off
    const [spawnBusy, setSpawnBusy] = useState(false);
    
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
        
        const handleEnvironmentLoaded = (data: { buildingCount: number }) => {
            // Turn on spawn busy when map is loaded
            if (data.buildingCount > 0) {
                setSpawnBusy(true);
            }
        };

        engine.events.on('packet_transmitted', handlePacket);
        engine.events.on('reset', handleReset);
        engine.events.on('environment_loaded', handleEnvironmentLoaded);

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
            engine.events.off('environment_loaded', handleEnvironmentLoaded);
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
    
    const handleAddNode = () => {
        addRandomNode(engine, { 
            center: viewCenter,
            initialMode: spawnBusy ? MovementMode.BUSY : undefined
        });
    };
    
    // Long-press charging state for adding multiple nodes
    // Using refs to avoid stale closure issues in event handlers
    const [chargeCount, setChargeCount] = useState(0);
    const [isCharging, setIsCharging] = useState(false);
    const chargeCountRef = useRef(0);
    const isChargingRef = useRef(false);
    const chargeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const longPressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    
    const LONG_PRESS_THRESHOLD = 400; // ms before charging starts
    const CHARGE_INTERVAL = 60; // ms between count increments
    const MAX_CHARGE = 100;
    
    const startCharging = () => {
        isChargingRef.current = true;
        chargeCountRef.current = 1;
        setIsCharging(true);
        setChargeCount(1);
        
        chargeIntervalRef.current = setInterval(() => {
            chargeCountRef.current = Math.min(chargeCountRef.current + 1, MAX_CHARGE);
            setChargeCount(chargeCountRef.current);
        }, CHARGE_INTERVAL);
    };
    
    const handleAddNodePointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        // Start long-press timer
        longPressTimeoutRef.current = setTimeout(() => {
            startCharging();
        }, LONG_PRESS_THRESHOLD);
    };
    
    const handleAddNodePointerUp = () => {
        // Clear long-press timer
        if (longPressTimeoutRef.current) {
            clearTimeout(longPressTimeoutRef.current);
            longPressTimeoutRef.current = null;
        }
        
        // Clear charging interval
        if (chargeIntervalRef.current) {
            clearInterval(chargeIntervalRef.current);
            chargeIntervalRef.current = null;
        }
        
        // Use refs for current values (avoids stale closure)
        if (isChargingRef.current && chargeCountRef.current > 0) {
            // Add multiple nodes
            const countToAdd = chargeCountRef.current;
            for (let i = 0; i < countToAdd; i++) {
                addRandomNode(engine, { 
                    center: viewCenter,
                    initialMode: spawnBusy ? MovementMode.BUSY : undefined
                });
            }
        } else {
            // Single click - add one node
            handleAddNode();
        }
        
        // Reset state
        isChargingRef.current = false;
        chargeCountRef.current = 0;
        setIsCharging(false);
        setChargeCount(0);
    };
    
    const handleAddNodePointerLeave = () => {
        // Cancel charging if pointer leaves button
        if (longPressTimeoutRef.current) {
            clearTimeout(longPressTimeoutRef.current);
            longPressTimeoutRef.current = null;
        }
        if (chargeIntervalRef.current) {
            clearInterval(chargeIntervalRef.current);
            chargeIntervalRef.current = null;
        }
        isChargingRef.current = false;
        chargeCountRef.current = 0;
        setIsCharging(false);
        setChargeCount(0);
    };
    
    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (longPressTimeoutRef.current) clearTimeout(longPressTimeoutRef.current);
            if (chargeIntervalRef.current) clearInterval(chargeIntervalRef.current);
        };
    }, []);

    const handleTurnAllBusy = () => {
        engine.getAllPeople().forEach(person => {
            person.setMode(MovementMode.BUSY);
        });
    };

    return (
        <div 
            className="absolute top-4 left-4 w-72 bg-black/90 text-white p-3 rounded backdrop-blur-md border border-gray-800 shadow-2xl font-mono select-none pointer-events-auto transition-all duration-300 flex flex-col"
            style={{ maxHeight: `calc(100vh - ${bottomPanelHeight + 32}px)` }}
        >
            {/* Header */}
            <div className={`flex justify-between items-center shrink-0 ${isCollapsed ? '' : 'mb-3 border-b border-gray-800 pb-2'} transition-all`}>
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
            <div className={`space-y-3 transition-all duration-300 ease-in-out ${isCollapsed ? 'max-h-0 opacity-0 overflow-hidden' : 'max-h-[800px] opacity-100 overflow-y-auto custom-scrollbar'}`}>
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

                {/* Actions - moved below counters */}
                <div className="flex gap-1.5">
                    <button 
                        className={`flex-1 px-2 py-1.5 rounded text-[10px] font-bold border transition-all relative overflow-hidden select-none ${
                            isCharging 
                                ? 'bg-cyan-600/50 text-white border-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.4)]' 
                                : 'bg-cyan-900/30 hover:bg-cyan-800/50 text-cyan-200 border-cyan-800/50 hover:shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                        }`}
                        onPointerDown={handleAddNodePointerDown}
                        onPointerUp={handleAddNodePointerUp}
                        onPointerLeave={handleAddNodePointerLeave}
                        onContextMenu={(e) => e.preventDefault()}
                    >
                        {/* Charging progress bar */}
                        {isCharging && (
                            <div 
                                className="absolute inset-0 bg-cyan-400/30 transition-all"
                                style={{ width: `${(chargeCount / MAX_CHARGE) * 100}%` }}
                            />
                        )}
                        <span className="relative z-10">
                            {isCharging ? `ADD +${chargeCount} NODES` : '+ ADD NODE'}
                        </span>
                    </button>
                    <button 
                        className="flex-1 bg-red-900/20 hover:bg-red-900/40 text-red-300 px-2 py-1.5 rounded text-[10px] font-bold border border-red-900/50 transition-all"
                        onClick={() => setupDemo(engine, 5)}
                    >
                        RESET
                    </button>
                </div>
                
                {/* Population Section */}
                <CollapsibleSection 
                    title="Population" 
                    isExpanded={isPopExpanded} 
                    onToggle={() => setIsPopExpanded(!isPopExpanded)}
                    icon={
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                            <circle cx="9" cy="7" r="4"></circle>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                        </svg>
                    }
                >
                    <div className="space-y-2">
                         {/* Spawn Busy Toggle */}
                        <div className="flex items-center justify-between bg-gray-900/30 px-2 py-1.5 rounded border border-gray-800">
                            <label className="text-[10px] text-gray-400 flex items-center gap-1.5 cursor-pointer select-none">
                                <span className="uppercase tracking-wider">Spawn Busy</span>
                                {spawnBusy && (
                                    <span className="text-[8px] text-amber-400 bg-amber-900/30 px-1 py-0.5 rounded">
                                        BUSY
                                    </span>
                                )}
                            </label>
                            <button
                                onClick={() => setSpawnBusy(!spawnBusy)}
                                className={`relative w-8 h-4 rounded-full transition-colors ${
                                    spawnBusy ? 'bg-amber-600' : 'bg-gray-700'
                                }`}
                            >
                                <div
                                    className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                                        spawnBusy ? 'translate-x-4' : 'translate-x-0.5'
                                    }`}
                                />
                            </button>
                        </div>
                        
                        {/* Turn All Busy */}
                         <button 
                            className="w-full bg-amber-900/20 hover:bg-amber-900/40 text-amber-300 px-2 py-1.5 rounded text-[10px] font-bold border border-amber-900/50 transition-all"
                            onClick={handleTurnAllBusy}
                        >
                            TURN ALL BUSY
                        </button>
                    </div>
                </CollapsibleSection>

                {/* Visualization Section */}
                <CollapsibleSection
                    title="Visualization"
                    isExpanded={isVizExpanded}
                    onToggle={() => setIsVizExpanded(!isVizExpanded)}
                    icon={
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    }
                >
                     <div className="flex items-center justify-between bg-gray-900/30 px-2 py-1.5 rounded border border-gray-800">
                        <label className="text-[10px] text-gray-400 flex items-center gap-1.5 cursor-pointer select-none">
                            <span className="uppercase tracking-wider">Announce Pkts</span>
                        </label>
                        <button
                            onClick={() => setShowAnnouncePackets(!showAnnouncePackets)}
                            className={`relative w-8 h-4 rounded-full transition-colors ${
                                showAnnouncePackets ? 'bg-cyan-600' : 'bg-gray-700'
                            }`}
                        >
                            <div
                                className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                                    showAnnouncePackets ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                            />
                        </button>
                    </div>
                </CollapsibleSection>
                
                {/* Statistics Section (Expandable) */}
                <CollapsibleSection
                    title="Statistics"
                    isExpanded={isStatsExpanded}
                    onToggle={() => setIsStatsExpanded(!isStatsExpanded)}
                    icon={
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 20V10"/>
                            <path d="M12 20V4"/>
                            <path d="M6 20v-6"/>
                        </svg>
                    }
                >
                    <div className="space-y-2">
                        {/* Performance Stats */}
                        <PerformanceStats />
                        
                        {/* Packet Stats */}
                        <div className="space-y-1 border-t border-gray-800 pt-2">
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
                    </div>
                </CollapsibleSection>

                {/* Environment Section */}
                <EnvironmentSection />
            </div>
        </div>
    );
};
