import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { addRandomNode, setupDemo } from '../../simulation/DemoSetup';
import { usePersistedState } from '../../utils/usePersistedState';
import { fetchBuildingsAround, clearOSMCache } from '../../simulation/environment';

// Types for history data
interface HistoryPoint {
    time: number;
    value: number;
}

// Preset locations for easy selection
const PRESET_LOCATIONS = [
    { name: 'None', lat: 0, lon: 0, radius: 0 },
    { name: 'NYC - Times Square', lat: 40.758, lon: -73.9855, radius: 200 },
    { name: 'London - Trafalgar', lat: 51.508, lon: -0.1276, radius: 200 },
    { name: 'Paris - Eiffel', lat: 48.8584, lon: 2.2945, radius: 200 },
    { name: 'Tokyo - Shibuya', lat: 35.6595, lon: 139.7004, radius: 200 },
    { name: 'Berlin - Brandenburg', lat: 52.5163, lon: 13.3777, radius: 200 },
    { name: 'San Francisco - Union', lat: 37.788, lon: -122.4075, radius: 200 },
    { name: 'Custom...', lat: 0, lon: 0, radius: 200 },
];

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

// Environment Section Component
const EnvironmentSection: React.FC<{ engine: ReturnType<typeof useSimulation> }> = ({ engine }) => {
    const [isExpanded, setIsExpanded] = usePersistedState('env_section_expanded', false);
    const [selectedPreset, setSelectedPreset] = usePersistedState('env_preset', 0);
    const [customLat, setCustomLat] = usePersistedState('env_custom_lat', '40.758');
    const [customLon, setCustomLon] = usePersistedState('env_custom_lon', '-73.9855');
    const [customRadius, setCustomRadius] = usePersistedState('env_custom_radius', '200');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [, forceUpdate] = useState({});
    
    const buildingCount = engine.environment.getBuildingCount();
    const bounds = engine.environment.getBounds();
    
    const isCustom = selectedPreset === PRESET_LOCATIONS.length - 1;
    const hasEnvironment = buildingCount > 0;

    const handleLoad = async () => {
        setIsLoading(true);
        setError(null);
        
        try {
            let lat: number, lon: number, radius: number;
            
            if (isCustom) {
                lat = parseFloat(customLat);
                lon = parseFloat(customLon);
                radius = parseFloat(customRadius);
                
                if (isNaN(lat) || isNaN(lon) || isNaN(radius)) {
                    throw new Error('Invalid coordinates');
                }
            } else {
                const preset = PRESET_LOCATIONS[selectedPreset];
                if (preset.radius === 0) {
                    // "None" selected
                    engine.environment.clear();
                    forceUpdate({});
                    setIsLoading(false);
                    return;
                }
                lat = preset.lat;
                lon = preset.lon;
                radius = preset.radius;
            }
            
            console.log(`[Environment] Loading area: ${lat}, ${lon}, radius: ${radius}m`);
            
            const geojson = await fetchBuildingsAround(lat, lon, radius);
            engine.environment.loadFromGeoJSON(geojson, lat, lon);
            
            console.log(`[Environment] Loaded ${engine.environment.getBuildingCount()} buildings`);
            forceUpdate({});
        } catch (e) {
            console.error('[Environment] Load error:', e);
            setError(e instanceof Error ? e.message : 'Failed to load');
        } finally {
            setIsLoading(false);
        }
    };

    const handleClear = () => {
        engine.environment.clear();
        forceUpdate({});
    };

    const handleClearCache = () => {
        clearOSMCache();
        setError(null);
    };

    return (
        <div className="border-t border-gray-800 pt-2">
            {/* Header */}
            <button 
                className="w-full flex justify-between items-center text-[10px] text-gray-500 hover:text-gray-300 transition-colors mb-1"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <span className="uppercase tracking-wider font-bold flex items-center gap-2">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                        <polyline points="9,22 9,12 15,12 15,22"/>
                    </svg>
                    Environment
                    {hasEnvironment && (
                        <span className="text-blue-400 font-mono">({buildingCount})</span>
                    )}
                </span>
                <svg 
                    width="10" height="6" viewBox="0 0 10 6" fill="none" 
                    className={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                >
                    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
            </button>

            {/* Expandable Content */}
            <div className={`overflow-hidden transition-all duration-300 ${isExpanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
                <div className="space-y-2 pt-1">
                    {/* Location Selector */}
                    <div className="flex flex-col gap-1">
                        <label className="text-[9px] text-gray-600 uppercase tracking-wider">Location</label>
                        <select
                            value={selectedPreset}
                            onChange={(e) => setSelectedPreset(parseInt(e.target.value))}
                            className="bg-gray-900/70 border border-gray-700 rounded px-2 py-1 text-[10px] text-white focus:outline-none focus:border-blue-500 cursor-pointer"
                            disabled={isLoading}
                        >
                            {PRESET_LOCATIONS.map((loc, i) => (
                                <option key={i} value={i}>{loc.name}</option>
                            ))}
                        </select>
                    </div>

                    {/* Custom Coordinates */}
                    {isCustom && (
                        <div className="grid grid-cols-3 gap-1">
                            <div>
                                <label className="text-[9px] text-gray-600 block mb-0.5">Lat</label>
                                <input
                                    type="text"
                                    value={customLat}
                                    onChange={(e) => setCustomLat(e.target.value)}
                                    className="w-full bg-gray-900/70 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-white focus:outline-none focus:border-blue-500 font-mono"
                                    placeholder="40.758"
                                    disabled={isLoading}
                                />
                            </div>
                            <div>
                                <label className="text-[9px] text-gray-600 block mb-0.5">Lon</label>
                                <input
                                    type="text"
                                    value={customLon}
                                    onChange={(e) => setCustomLon(e.target.value)}
                                    className="w-full bg-gray-900/70 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-white focus:outline-none focus:border-blue-500 font-mono"
                                    placeholder="-73.985"
                                    disabled={isLoading}
                                />
                            </div>
                            <div>
                                <label className="text-[9px] text-gray-600 block mb-0.5">Radius</label>
                                <input
                                    type="text"
                                    value={customRadius}
                                    onChange={(e) => setCustomRadius(e.target.value)}
                                    className="w-full bg-gray-900/70 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-white focus:outline-none focus:border-blue-500 font-mono"
                                    placeholder="200"
                                    disabled={isLoading}
                                />
                            </div>
                        </div>
                    )}

                    {/* Error Message */}
                    {error && (
                        <div className="text-[9px] text-red-400 bg-red-900/20 px-2 py-1 rounded border border-red-900/50">
                            {error}
                        </div>
                    )}

                    {/* Current Environment Status */}
                    {hasEnvironment && bounds && (
                        <div className="text-[9px] text-gray-500 bg-blue-900/10 px-2 py-1.5 rounded border border-blue-900/30">
                            <div className="flex justify-between">
                                <span>Buildings:</span>
                                <span className="text-blue-400 font-mono">{buildingCount}</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Center:</span>
                                <span className="text-gray-400 font-mono">
                                    {bounds.center.lat.toFixed(4)}, {bounds.center.lng.toFixed(4)}
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="flex gap-1">
                        <button
                            onClick={handleLoad}
                            disabled={isLoading || selectedPreset === 0}
                            className={`flex-1 px-2 py-1 rounded text-[10px] font-bold border transition-all ${
                                isLoading 
                                    ? 'bg-gray-800 text-gray-500 border-gray-700 cursor-wait'
                                    : selectedPreset === 0
                                        ? 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed'
                                        : 'bg-blue-900/30 hover:bg-blue-800/50 text-blue-200 border-blue-800/50 hover:shadow-[0_0_10px_rgba(59,130,246,0.2)]'
                            }`}
                        >
                            {isLoading ? (
                                <span className="flex items-center justify-center gap-1">
                                    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                                    </svg>
                                    Loading...
                                </span>
                            ) : 'LOAD MAP'}
                        </button>
                        <button
                            onClick={handleClear}
                            disabled={!hasEnvironment || isLoading}
                            className={`px-2 py-1 rounded text-[10px] font-bold border transition-all ${
                                !hasEnvironment || isLoading
                                    ? 'bg-gray-800 text-gray-600 border-gray-700 cursor-not-allowed'
                                    : 'bg-orange-900/20 hover:bg-orange-900/40 text-orange-300 border-orange-900/50'
                            }`}
                        >
                            CLEAR
                        </button>
                    </div>

                    {/* Cache Clear */}
                    <button
                        onClick={handleClearCache}
                        className="w-full text-[9px] text-gray-600 hover:text-gray-400 transition-colors py-0.5"
                    >
                        Clear cached map data
                    </button>
                </div>
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
                <EnvironmentSection engine={engine} />
            </div>
        </div>
    );
};
