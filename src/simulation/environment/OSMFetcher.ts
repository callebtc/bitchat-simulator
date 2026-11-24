/**
 * OSMFetcher
 * Browser-based Overpass API client for fetching OpenStreetMap building data.
 * Includes localStorage caching for offline use.
 */

import {
    GeoJSONFeatureCollection,
    GeoJSONFeature,
    GeoJSONPolygon,
    GeoJSONLineString,
} from './types';

const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter'
];

const CACHE_PREFIX = 'bitchat_osm_cache_';
// v2: adds roads / parks / water map context and `properties.kind`
const CACHE_VERSION = 2;

interface CacheEntry {
    version: number;
    timestamp: number;
    data: GeoJSONFeatureCollection;
}

interface FetchOptions {
    /** Use cached data if available (default: true) */
    useCache?: boolean;
    /** Cache timeout in milliseconds (default: 24 hours) */
    cacheTimeout?: number;
    /** Progress callback (progress: 0-1, status: string) */
    onProgress?: (progress: number, status: string) => void;
    /** Per-mirror request timeout in milliseconds (default: 45 s). */
    timeoutMs?: number;
    /** Start the next mirror if the current one hasn't answered within this many ms (default: 5 s). */
    hedgeDelayMs?: number;
}

/**
 * Generate cache key from bounding box.
 */
function getCacheKey(minLat: number, minLon: number, maxLat: number, maxLon: number): string {
    // Round to 4 decimal places for cache key consistency
    const key = `${minLat.toFixed(4)}_${minLon.toFixed(4)}_${maxLat.toFixed(4)}_${maxLon.toFixed(4)}`;
    return CACHE_PREFIX + key;
}

/**
 * Build Overpass QL query for buildings plus render-only map context
 * (roads, green space, water, squares) in a bounding box. One request keeps
 * public Overpass mirrors happy and the cache entry atomic.
 */
function buildOverpassQuery(
    minLat: number,
    minLon: number,
    maxLat: number,
    maxLon: number
): string {
    const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
    return `
[out:json][timeout:60];
(
  way["building"](${bbox});
  relation["building"](${bbox});
  way["highway"](${bbox});
  way["leisure"~"^(park|garden|playground|pitch|common|dog_park)$"](${bbox});
  way["landuse"~"^(grass|park|recreation_ground|forest|meadow|village_green|cemetery)$"](${bbox});
  way["natural"~"^(water|wood|scrub|grassland)$"](${bbox});
  way["place"="square"](${bbox});
);
out body;
>;
out skel qt;
`.trim();
}

/** Feature kinds emitted by the parser (stored in `properties.kind`). */
export type OSMFeatureKind = 'building' | 'road' | 'park' | 'water' | 'plaza';

type OsmTags = Record<string, string>;

const SKIPPED_HIGHWAYS = new Set(['construction', 'proposed', 'corridor', 'elevator', 'platform', 'bus_stop']);

/** Classify a way by its tags. Untagged ways are building-relation members. */
export function classifyOsmWay(tags: OsmTags | undefined): OSMFeatureKind | null {
    if (!tags || Object.keys(tags).length === 0) return 'building';
    if (tags.building || tags['building:part']) return 'building';
    if (tags.highway) {
        if (SKIPPED_HIGHWAYS.has(tags.highway)) return null;
        if (tags.area === 'yes' && (tags.highway === 'pedestrian' || tags.highway === 'footway')) {
            return 'plaza';
        }
        return 'road';
    }
    if (tags.place === 'square') return 'plaza';
    if (tags.natural === 'water' || tags.water) return 'water';
    if (tags.leisure || tags.landuse || tags.natural) return 'park';
    return null;
}

const ROAD_WIDTHS: Record<string, number> = {
    motorway: 16,
    trunk: 14,
    primary: 13,
    secondary: 11,
    tertiary: 9,
    residential: 7,
    unclassified: 7,
    living_street: 6,
    service: 4.5,
    pedestrian: 5,
    track: 3.5,
    cycleway: 2.2,
    footway: 2.2,
    path: 1.8,
    steps: 2.0,
};

/** Carriageway width (m) from `width` / `lanes` tags or class default. */
export function estimateRoadWidth(tags: OsmTags): number {
    const w = parseFloat(tags.width ?? '');
    if (Number.isFinite(w) && w > 0.5 && w < 80) return w;
    const lanes = parseInt(tags.lanes ?? '', 10);
    if (Number.isFinite(lanes) && lanes > 0 && lanes < 12) return lanes * 3.3;
    const base = tags.highway?.replace(/_link$/, '') ?? 'residential';
    return ROAD_WIDTHS[base] ?? 6;
}

export interface OverpassElement {
    type: 'node' | 'way' | 'relation';
    id: number;
    lat?: number;
    lon?: number;
    nodes?: number[];
    tags?: OsmTags;
}

/**
 * Parse Overpass JSON response into GeoJSON. Buildings, plazas, parks and
 * water become Polygons; roads become LineStrings. Every feature carries
 * `properties.kind` so consumers can split physical from render-only data.
 */
export function parseOverpassResponse(data: { elements?: OverpassElement[] }): GeoJSONFeatureCollection {
    const features: GeoJSONFeature[] = [];
    const elements = Array.isArray(data?.elements) ? data.elements : [];

    // Build node lookup
    const nodes = new Map<number, [number, number]>();
    // Deduplicate ways (skeleton re-output after `>` lacks tags; keep tagged copy)
    const ways = new Map<number, OverpassElement>();
    for (const element of elements) {
        if (element.type === 'node' && element.lat !== undefined && element.lon !== undefined) {
            nodes.set(element.id, [element.lon, element.lat]);
        } else if (element.type === 'way') {
            const prev = ways.get(element.id);
            if (!prev || (!prev.tags && element.tags)) ways.set(element.id, element);
        }
    }

    for (const element of ways.values()) {
        if (!element.nodes || element.nodes.length < 2) continue;
        const kind = classifyOsmWay(element.tags);
        if (!kind) continue;

        const coordinates: number[][] = [];
        let valid = true;
        for (const nodeId of element.nodes) {
            const coord = nodes.get(nodeId);
            if (!coord) {
                valid = false;
                break;
            }
            coordinates.push(coord);
        }
        if (!valid) continue;

        const tags = element.tags ?? {};

        if (kind === 'road') {
            features.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates } as GeoJSONLineString,
                properties: {
                    kind,
                    osmId: element.id,
                    highway: tags.highway,
                    name: tags.name,
                    width: estimateRoadWidth(tags),
                },
            });
            continue;
        }

        // Closed rings need >= 4 coordinates (first == last)
        if (coordinates.length < 4) continue;

        if (kind === 'building') {
            features.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [coordinates] } as GeoJSONPolygon,
                properties: {
                    kind,
                    osmId: element.id,
                    building: tags.building || 'yes',
                    name: tags.name,
                    height: tags.height,
                    levels: tags['building:levels'],
                },
            });
        } else {
            features.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [coordinates] } as GeoJSONPolygon,
                properties: { kind, osmId: element.id, name: tags.name },
            });
        }
    }

    return {
        type: 'FeatureCollection',
        features,
    };
}

/**
 * Hedged mirror fetch: launch the first mirror, then start the next one every
 * `hedgeDelayMs` (or immediately after a failure) until one returns a valid
 * response. The first success wins and aborts the rest; public Overpass
 * instances are frequently overloaded, so waiting serially on timeouts made
 * loads take minutes.
 */
function fetchFromMirrors(
    query: string,
    timeoutMs: number,
    hedgeDelayMs: number,
    onProgress?: (progress: number, status: string) => void
): Promise<{ elements?: OverpassElement[] }> {
    return new Promise((resolve, reject) => {
        let next = 0;
        let inFlight = 0;
        let settled = false;
        let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
        let lastError: Error | null = null;
        const controllers: AbortController[] = [];

        const launch = (): void => {
            if (settled || next >= OVERPASS_MIRRORS.length) return;
            const mi = next++;
            const mirror = OVERPASS_MIRRORS[mi];
            inFlight++;
            const controller = new AbortController();
            controllers.push(controller);
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            if (hedgeTimer) clearTimeout(hedgeTimer);
            hedgeTimer = setTimeout(launch, hedgeDelayMs);
            console.log(`[OSMFetcher] Trying mirror: ${mirror}`);
            onProgress?.(0.15 + (0.3 * mi) / OVERPASS_MIRRORS.length, `Downloading from ${new URL(mirror).hostname}...`);

            fetch(mirror, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `data=${encodeURIComponent(query)}`,
                signal: controller.signal,
            })
                .then(async response => {
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`);
                    }
                    onProgress?.(0.5, 'Parsing map data...');
                    const data = (await response.json()) as { elements?: OverpassElement[] };
                    if (settled) return;
                    settled = true;
                    if (hedgeTimer) clearTimeout(hedgeTimer);
                    controllers.forEach(c => c !== controller && c.abort());
                    resolve(data);
                })
                .catch(e => {
                    if (settled) return;
                    lastError = e instanceof Error ? e : new Error(String(e));
                    console.warn(`[OSMFetcher] Mirror ${mirror} failed:`, lastError.message);
                    launch(); // fail over immediately instead of waiting for the hedge timer
                })
                .finally(() => {
                    clearTimeout(timer);
                    inFlight--;
                    if (!settled && inFlight === 0 && next >= OVERPASS_MIRRORS.length) {
                        settled = true;
                        if (hedgeTimer) clearTimeout(hedgeTimer);
                        reject(lastError ?? new Error('All OSM mirrors failed'));
                    }
                });
        };

        launch();
    });
}

/**
 * Fetch buildings from OpenStreetMap Overpass API.
 * 
 * @param minLat - Minimum latitude of bounding box
 * @param minLon - Minimum longitude of bounding box
 * @param maxLat - Maximum latitude of bounding box
 * @param maxLon - Maximum longitude of bounding box
 * @param options - Fetch options
 * @returns GeoJSON FeatureCollection of buildings
 */
export async function fetchBuildingsFromOSM(
    minLat: number,
    minLon: number,
    maxLat: number,
    maxLon: number,
    options: FetchOptions = {}
): Promise<GeoJSONFeatureCollection> {
    const {
        useCache = true,
        cacheTimeout = 24 * 60 * 60 * 1000, // 24 hours
        onProgress,
        timeoutMs = 45000,
        hedgeDelayMs = 5000,
    } = options;

    const cacheKey = getCacheKey(minLat, minLon, maxLat, maxLon);

    // Try cache first
    if (useCache) {
        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const entry: CacheEntry = JSON.parse(cached);
                if (
                    entry.version === CACHE_VERSION &&
                    Date.now() - entry.timestamp < cacheTimeout
                ) {
                    console.log('[OSMFetcher] Using cached data');
                    return entry.data;
                }
            }
        } catch (e) {
            console.warn('[OSMFetcher] Cache read error:', e);
        }
    }

    // Fetch from API
    console.log('[OSMFetcher] Fetching from Overpass API...');
    onProgress?.(0.1, 'Connecting to OSM...');

    const query = buildOverpassQuery(minLat, minLon, maxLat, maxLon);
    let fetchedData: { elements?: OverpassElement[] };
    try {
        fetchedData = await fetchFromMirrors(query, timeoutMs, hedgeDelayMs, onProgress);
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`OpenStreetMap servers are busy (${reason}). Try again in a moment or pick a smaller radius.`);
    }

    onProgress?.(0.8, 'Processing features...');
    const geojson = parseOverpassResponse(fetchedData);

    console.log(`[OSMFetcher] Fetched ${geojson.features.length} buildings`);

    // Cache result
    if (useCache) {
        try {
            const entry: CacheEntry = {
                version: CACHE_VERSION,
                timestamp: Date.now(),
                data: geojson,
            };
            localStorage.setItem(cacheKey, JSON.stringify(entry));
        } catch (e) {
            console.warn('[OSMFetcher] Cache write error:', e);
        }
    }

    onProgress?.(1.0, 'Done');
    return geojson;
}

/**
 * Fetch buildings around a center point with a given radius.
 * 
 * @param centerLat - Center latitude
 * @param centerLon - Center longitude
 * @param radiusMeters - Radius in meters
 * @param options - Fetch options
 */
export async function fetchBuildingsAround(
    centerLat: number,
    centerLon: number,
    radiusMeters: number,
    options: FetchOptions = {}
): Promise<GeoJSONFeatureCollection> {
    // Approximate conversion: 1 degree latitude ≈ 111,000 meters
    const latDelta = radiusMeters / 111000;
    // Longitude varies with latitude
    const lonDelta = radiusMeters / (111000 * Math.cos(centerLat * Math.PI / 180));

    return fetchBuildingsFromOSM(
        centerLat - latDelta,
        centerLon - lonDelta,
        centerLat + latDelta,
        centerLon + lonDelta,
        options
    );
}

/**
 * Clear all cached OSM data.
 */
export function clearOSMCache(): void {
    const keysToRemove: string[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CACHE_PREFIX)) {
            keysToRemove.push(key);
        }
    }

    for (const key of keysToRemove) {
        localStorage.removeItem(key);
    }

    console.log(`[OSMFetcher] Cleared ${keysToRemove.length} cached entries`);
}

/**
 * Get cache statistics.
 */
export function getOSMCacheStats(): { count: number; totalSize: number } {
    let count = 0;
    let totalSize = 0;

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CACHE_PREFIX)) {
            count++;
            const value = localStorage.getItem(key);
            if (value) {
                totalSize += value.length * 2; // UTF-16 = 2 bytes per char
            }
        }
    }

    return { count, totalSize };
}
