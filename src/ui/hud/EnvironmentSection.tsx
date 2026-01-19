import React, { useState, useEffect } from 'react';
import { useSimulation } from '../context/SimulationContext';
import { usePersistedState } from '../../utils/usePersistedState';
import { fetchBuildingsAround, clearAllMapCache, PathFinder } from '../../simulation/environment';

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

export const EnvironmentSection: React.FC = () => {
    const engine = useSimulation();
    const [isExpanded, setIsExpanded] = usePersistedState('env_section_expanded', false);
    const [selectedPreset, setSelectedPreset] = usePersistedState('env_preset', 0);
    const [customLat, setCustomLat] = usePersistedState('env_custom_lat', '40.758');
    const [customLon, setCustomLon] = usePersistedState('env_custom_lon', '-73.9855');
    const [customRadius, setCustomRadius] = usePersistedState('env_custom_radius', '200');
    const [isLoading, setIsLoading] = useState(false);
    const [loadingStatus, setLoadingStatus] = useState('');
    const [graphProgress, setGraphProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [, forceUpdate] = useState({});
    
    const buildingCount = engine.environment.getBuildingCount();
    const bounds = engine.environment.getBounds();
    const isGraphBuilding = engine.pathFinder.isBuildingGraph();
    const isGraphReady = engine.pathFinder.isReady();
    
    const isCustom = selectedPreset === PRESET_LOCATIONS.length - 1;
    const hasEnvironment = buildingCount > 0;

    // Set up progress callback on pathfinder
    useEffect(() => {
        engine.pathFinder.onProgress = (progress, status) => {
            setGraphProgress(progress);
            setLoadingStatus(status);
        };
        return () => {
            engine.pathFinder.onProgress = undefined;
        };
    }, [engine.pathFinder]);

    const handleLoad = async () => {
        setIsLoading(true);
        setError(null);
        setGraphProgress(0);
        setLoadingStatus('Fetching map data...');
        
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
                    engine.rebuildPathfindingGraph();
                    engine.events.emit('environment_loaded', { buildingCount: 0 });
                    forceUpdate({});
                    setIsLoading(false);
                    return;
                }
                lat = preset.lat;
                lon = preset.lon;
                radius = preset.radius;
            }
            
            console.log(`[Environment] Loading area: ${lat}, ${lon}, radius: ${radius}m`);
            
            const geojson = await fetchBuildingsAround(lat, lon, radius, {
                onProgress: (progress, status) => {
                    setGraphProgress(progress);
                    setLoadingStatus(status);
                }
            });
            engine.environment.loadFromGeoJSON(geojson, lat, lon);
            
            // Prepare pathfinding graph - this tries cache first
            const loadedFromCache = engine.rebuildPathfindingGraph();
            
            // Emit event so BuildingLayer renders immediately (don't wait for graph)
            engine.events.emit('environment_loaded', { 
                buildingCount: engine.environment.getBuildingCount() 
            });
            
            console.log(`[Environment] Loaded ${engine.environment.getBuildingCount()} buildings`);
            forceUpdate({});
            setIsLoading(false);
            
            // Build graph in background if not from cache
            if (!loadedFromCache) {
                setLoadingStatus('Building navigation graph...');
                // Don't await - let it run in background
                engine.pathFinder.buildGraphAsync().then(() => {
                    setLoadingStatus('');
                    setGraphProgress(0);
                    forceUpdate({});
                }).catch(e => {
                    console.error('[PathFinder] Async build error:', e);
                });
            } else {
                setLoadingStatus('');
                setGraphProgress(0);
            }
        } catch (e) {
            console.error('[Environment] Load error:', e);
            setError(e instanceof Error ? e.message : 'Failed to load');
            setIsLoading(false);
            setLoadingStatus('');
            setGraphProgress(0);
        }
    };

    const handleClear = () => {
        engine.environment.clear();
        engine.rebuildPathfindingGraph();
        engine.events.emit('environment_loaded', { buildingCount: 0 });
        forceUpdate({});
    };

    const handleClearCache = () => {
        clearAllMapCache();
        setError(null);
    };

    const handleClearNavCache = () => {
        PathFinder.clearCache();
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

                    {/* Loading Progress (map fetch or graph building) */}
                    {(isLoading || isGraphBuilding) && (
                        <div className="space-y-1">
                            <div className="flex items-center gap-2 text-[9px] text-blue-300">
                                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                                </svg>
                                <span>{loadingStatus || 'Loading...'}</span>
                            </div>
                            {graphProgress > 0 && graphProgress < 1 && (
                                <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
                                    <div 
                                        className="bg-blue-500 h-1.5 transition-all duration-150 ease-out"
                                        style={{ width: `${graphProgress * 100}%` }}
                                    />
                                </div>
                            )}
                            {!isLoading && isGraphBuilding && (
                                <div className="text-[8px] text-gray-500">
                                    Map visible • Pathfinding unavailable until complete
                                </div>
                            )}
                        </div>
                    )}

                    {/* Error Message */}
                    {error && (
                        <div className="text-[9px] text-red-400 bg-red-900/20 px-2 py-1 rounded border border-red-900/50">
                            {error}
                        </div>
                    )}

                    {/* Current Environment Status */}
                    {hasEnvironment && bounds && !isLoading && (
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
                            <div className="flex justify-between">
                                <span>Pathfinding:</span>
                                <span className={`font-mono ${isGraphReady ? 'text-green-400' : 'text-yellow-400'}`}>
                                    {isGraphReady ? 'Ready' : 'Building...'}
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
                            {isLoading ? 'LOADING...' : 'LOAD MAP'}
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
                    <div className="w-full text-[9px] text-gray-600 text-center py-0.5">
                        <button 
                            onClick={handleClearCache}
                            className="hover:text-gray-400 transition-colors"
                        >
                            Clear all cached map data
                        </button>
                        <span> or </span>
                        <button 
                            onClick={handleClearNavCache}
                            className="hover:text-gray-400 transition-colors underline"
                        >
                            only navigation data
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
