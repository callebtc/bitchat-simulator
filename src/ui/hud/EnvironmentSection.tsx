import React, { useEffect, useMemo, useState } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useCamera } from '../context/CameraContext';
import { useTerrain } from '../context/TerrainContext';
import { usePersistedState } from '../../utils/usePersistedState';
import { fetchBuildingsAround, clearAllMapCache, PathFinder, polygonArea } from '../../simulation/environment';

/**
 * Location picker for the physical environment: search any place on Earth
 * (OSM Nominatim geocoder), pick a curated hotspot, choose a capture radius,
 * then load real OSM buildings (extruded to tagged / estimated heights),
 * roads, parks and water.
 */

interface Place {
    name: string;
    detail: string;
    lat: number;
    lon: number;
}

const PRESETS: Place[] = [
    { name: 'Times Square', detail: 'New York', lat: 40.758, lon: -73.9855 },
    { name: 'Shibuya Crossing', detail: 'Tokyo', lat: 35.6595, lon: 139.7004 },
    { name: 'Trafalgar Square', detail: 'London', lat: 51.508, lon: -0.1276 },
    { name: 'Champ de Mars', detail: 'Paris', lat: 48.8558, lon: 2.2986 },
    { name: 'Brandenburg Gate', detail: 'Berlin', lat: 52.5163, lon: 13.3777 },
    { name: 'Lombard Street', detail: 'San Francisco · hills', lat: 37.8021, lon: -122.4187 },
    { name: 'Marina Bay', detail: 'Singapore', lat: 1.2834, lon: 103.8607 },
    { name: 'Montmartre', detail: 'Paris · hilltop', lat: 48.8867, lon: 2.3431 },
];

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

interface NominatimResult {
    display_name: string;
    lat: string;
    lon: string;
}

/** Body of the left rail's Location section (header lives in MainControlPanel). */
export const EnvironmentSection: React.FC = () => {
    const engine = useSimulation();
    const { requestReset } = useCamera();
    const terrain = useTerrain();
    const [place, setPlace] = usePersistedState<Place>('env_place', PRESETS[0]);
    const [radius, setRadius] = usePersistedState('env_radius_m', 250);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<Place[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [status, setStatus] = useState('');
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [version, setVersion] = useState(0);

    useEffect(() => {
        engine.pathFinder.onProgress = (p, s) => {
            setProgress(p);
            setStatus(s);
        };
        const bump = () => setVersion(v => v + 1);
        engine.events.on('environment_loaded', bump);
        return () => {
            engine.pathFinder.onProgress = undefined;
            engine.events.off('environment_loaded', bump);
        };
    }, [engine]);

    const buildings = engine.environment.getBuildings();
    const bounds = engine.environment.getBounds();
    const isGraphBuilding = engine.pathFinder.isBuildingGraph();
    const isGraphReady = engine.pathFinder.isReady();

    const stats = useMemo(() => {
        if (buildings.length === 0) return null;
        let tallest = 0;
        let sumH = 0;
        let tagged = 0;
        let footprint = 0;
        for (const b of buildings) {
            const h = b.height ?? 0;
            tallest = Math.max(tallest, h);
            sumH += h;
            if (b.heightSource !== 'estimate') tagged++;
            footprint += polygonArea(b.vertices);
        }
        const ctx = engine.environment.getMapContext();
        let roadM = 0;
        for (const r of ctx.roads) {
            for (let i = 1; i < r.points.length; i++) {
                roadM += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
            }
        }
        return {
            count: buildings.length,
            tallest,
            avg: sumH / buildings.length,
            taggedPct: (tagged / buildings.length) * 100,
            footprintHa: footprint / 10000,
            roadKm: roadM / 1000,
            parks: ctx.areas.filter(a => a.kind === 'park').length,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buildings, version]);

    const search = async (e: React.FormEvent) => {
        e.preventDefault();
        const q = query.trim();
        if (!q) return;
        // Direct "lat, lon" entry skips the geocoder
        const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (m) {
            const p = { name: `${parseFloat(m[1]).toFixed(4)}, ${parseFloat(m[2]).toFixed(4)}`, detail: 'Coordinates', lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
            setPlace(p);
            setResults([]);
            return;
        }
        setIsSearching(true);
        setError(null);
        try {
            const url = `${NOMINATIM_URL}?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
            const res = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(`Geocoder error ${res.status}`);
            const data = (await res.json()) as NominatimResult[];
            const mapped = data.map(r => {
                const parts = r.display_name.split(',').map(s => s.trim());
                return {
                    name: parts[0],
                    detail: parts.slice(1, 3).join(', '),
                    lat: parseFloat(r.lat),
                    lon: parseFloat(r.lon),
                };
            });
            setResults(mapped);
            if (mapped.length === 0) setError('No places found');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Search failed');
        } finally {
            setIsSearching(false);
        }
    };

    const load = async (target: Place = place) => {
        setIsLoading(true);
        setError(null);
        setProgress(0);
        setStatus('Fetching OpenStreetMap data…');
        try {
            const geojson = await fetchBuildingsAround(target.lat, target.lon, radius, {
                onProgress: (p, s) => {
                    setProgress(p);
                    setStatus(s);
                },
            });
            engine.environment.loadFromGeoJSON(geojson, target.lat, target.lon);
            const fromCache = engine.rebuildPathfindingGraph();
            engine.events.emit('environment_loaded', { buildingCount: engine.environment.getBuildingCount() });
            requestReset();
            setIsLoading(false);
            if (!fromCache) {
                setStatus('Building navigation graph…');
                engine.pathFinder
                    .buildGraphAsync()
                    .then(() => {
                        setStatus('');
                        setProgress(0);
                        setVersion(v => v + 1);
                    })
                    .catch(err => console.error('[PathFinder] Async build error:', err));
            } else {
                setStatus('');
                setProgress(0);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load map');
            setIsLoading(false);
            setStatus('');
            setProgress(0);
        }
    };

    const clear = () => {
        engine.environment.clear();
        engine.rebuildPathfindingGraph();
        engine.events.emit('environment_loaded', { buildingCount: 0 });
    };

    const pick = (p: Place) => {
        setPlace(p);
        setResults([]);
        setQuery('');
    };

    return (
        <div className="space-y-2.5">
                    {/* Search */}
                    <form onSubmit={search} className="relative">
                        <input
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Search a place or paste lat, lon"
                            className="w-full rounded-lg border border-white/10 bg-black/40 py-1.5 pl-7 pr-2 text-[11px] text-slate-100 placeholder:text-slate-600 focus:border-sky-500/60 focus:outline-none"
                            disabled={isLoading}
                        />
                        <svg className="absolute left-2 top-2 text-slate-500" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                            <circle cx="11" cy="11" r="7" />
                            <path d="M20 20l-3.5-3.5" />
                        </svg>
                        {isSearching && <span className="absolute right-2 top-1.5 text-[10px] text-sky-300">…</span>}
                        {results.length > 0 && (
                            <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-md">
                                {results.map((r, i) => (
                                    <button
                                        key={i}
                                        type="button"
                                        onClick={() => pick(r)}
                                        className="block w-full px-2.5 py-1.5 text-left hover:bg-sky-500/10"
                                    >
                                        <div className="truncate text-[11px] text-slate-100">{r.name}</div>
                                        <div className="truncate text-[9px] text-slate-500">{r.detail}</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </form>

                    {/* Presets */}
                    <div className="grid grid-cols-2 gap-1">
                        {PRESETS.map(p => {
                            const on = Math.abs(p.lat - place.lat) < 1e-4 && Math.abs(p.lon - place.lon) < 1e-4;
                            return (
                                <button
                                    key={p.name}
                                    onClick={() => pick(p)}
                                    disabled={isLoading}
                                    className={`rounded-md border px-2 py-1 text-left transition ${
                                        on
                                            ? 'border-sky-400/50 bg-sky-500/10 text-sky-100'
                                            : 'border-white/5 bg-white/[0.02] text-slate-400 hover:border-white/15 hover:text-slate-200'
                                    }`}
                                >
                                    <div className="truncate text-[10px] font-medium">{p.name}</div>
                                    <div className="truncate text-[8.5px] opacity-60">{p.detail}</div>
                                </button>
                            );
                        })}
                    </div>

                    {/* Selected place + radius */}
                    <div className="rounded-lg border border-white/10 bg-black/30 p-2">
                        <div className="flex items-baseline justify-between gap-2">
                            <div className="min-w-0">
                                <div className="truncate text-[11px] font-semibold text-slate-100">{place.name}</div>
                                <div className="font-mono text-[9px] text-slate-500">
                                    {place.lat.toFixed(5)}, {place.lon.toFixed(5)}
                                </div>
                            </div>
                            <span className="shrink-0 font-mono text-[10px] text-sky-300">r = {radius} m</span>
                        </div>
                        <input
                            type="range"
                            min={100}
                            max={600}
                            step={25}
                            value={radius}
                            onChange={e => setRadius(parseInt(e.target.value, 10))}
                            className="mt-1.5 w-full accent-sky-400"
                            disabled={isLoading}
                        />
                        <div className="flex justify-between text-[8.5px] text-slate-600">
                            <span>100 m · block</span>
                            <span>600 m · district</span>
                        </div>
                    </div>

                    {/* Terrain elevation */}
                    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-2 py-1.5">
                        <div className="min-w-0">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-300">Terrain elevation</div>
                            <div className="truncate font-mono text-[9px] text-slate-500">
                                {terrain.status === 'ready' && terrain.field
                                    ? `DEM ±${(terrain.field.maxHeight - terrain.field.minHeight).toFixed(1)} m relief`
                                    : terrain.status === 'loading'
                                      ? 'Fetching elevation tiles…'
                                      : terrain.status === 'error'
                                        ? 'Elevation unavailable · flat'
                                        : terrain.status === 'flat'
                                          ? 'Flat ground'
                                          : 'AWS Terrarium DEM'}
                            </div>
                        </div>
                        <button
                            onClick={() => terrain.setEnabled(!terrain.enabled)}
                            className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${terrain.enabled ? 'bg-sky-600' : 'bg-gray-700'}`}
                        >
                            <div
                                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                                    terrain.enabled ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                            />
                        </button>
                    </div>

                    {(isLoading || isGraphBuilding) && (
                        <div className="space-y-1">
                            <div className="flex items-center gap-2 text-[9.5px] text-sky-300">
                                <span className="h-2 w-2 animate-ping rounded-full bg-sky-400" />
                                <span className="truncate">{status || 'Loading…'}</span>
                            </div>
                            {progress > 0 && progress < 1 && (
                                <div className="h-1 w-full overflow-hidden rounded-full bg-white/5">
                                    <div className="h-1 bg-gradient-to-r from-sky-500 to-cyan-300 transition-all" style={{ width: `${progress * 100}%` }} />
                                </div>
                            )}
                            {!isLoading && isGraphBuilding && (
                                <div className="text-[8.5px] text-slate-500">City visible · pedestrian routing available when graph completes</div>
                            )}
                        </div>
                    )}

                    {error && (
                        <div className="rounded border border-red-900/50 bg-red-900/20 px-2 py-1 text-[9.5px] text-red-300">{error}</div>
                    )}

                    {stats && bounds && !isLoading && (
                        <div className="grid grid-cols-3 gap-1 rounded-lg border border-sky-900/30 bg-sky-950/20 p-1.5 text-center">
                            {[
                                ['Buildings', stats.count.toString()],
                                ['Tallest', `${stats.tallest.toFixed(0)} m`],
                                ['Avg height', `${stats.avg.toFixed(1)} m`],
                                ['OSM heights', `${stats.taggedPct.toFixed(0)}%`],
                                ['Roads', `${stats.roadKm.toFixed(1)} km`],
                                ['Routing', isGraphReady ? 'Ready' : '…'],
                            ].map(([k, v]) => (
                                <div key={k}>
                                    <div className="font-mono text-[11px] text-sky-200">{v}</div>
                                    <div className="text-[8px] uppercase tracking-wider text-slate-500">{k}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="flex gap-1">
                        <button
                            onClick={() => load()}
                            disabled={isLoading}
                            className={`flex-1 rounded-md border px-2 py-1.5 text-[10px] font-bold tracking-wide transition ${
                                isLoading
                                    ? 'cursor-wait border-gray-700 bg-gray-800 text-gray-500'
                                    : 'border-sky-500/40 bg-gradient-to-b from-sky-500/25 to-sky-700/10 text-sky-100 hover:shadow-[0_0_14px_rgba(56,189,248,0.3)]'
                            }`}
                        >
                            {isLoading ? 'LOADING…' : stats ? 'RELOAD AREA' : 'LOAD 3D CITY'}
                        </button>
                        <button
                            onClick={clear}
                            disabled={!stats || isLoading}
                            className={`rounded-md border px-2 py-1.5 text-[10px] font-bold transition ${
                                !stats || isLoading
                                    ? 'cursor-not-allowed border-gray-700 bg-gray-800 text-gray-600'
                                    : 'border-orange-900/50 bg-orange-900/20 text-orange-300 hover:bg-orange-900/40'
                            }`}
                        >
                            CLEAR
                        </button>
                    </div>

                    <div className="text-center text-[8.5px] text-slate-600">
                        Map data © OpenStreetMap contributors · Elevation: Mapzen Terrarium (AWS Open Data) ·{' '}
                        <button onClick={() => clearAllMapCache()} className="underline hover:text-slate-400">
                            clear cache
                        </button>{' '}
                        ·{' '}
                        <button onClick={() => PathFinder.clearCache()} className="underline hover:text-slate-400">
                            nav cache
                        </button>
                    </div>
        </div>
    );
};
