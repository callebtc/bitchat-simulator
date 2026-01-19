/**
 * OSMFetcher
 * Browser-based Overpass API client for fetching OpenStreetMap building data.
 * Includes localStorage caching for offline use.
 */

import { GeoJSONFeatureCollection, GeoJSONFeature, GeoJSONPolygon } from './types';

const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';
const CACHE_PREFIX = 'bitchat_osm_cache_';
const CACHE_VERSION = 1;

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
 * Build Overpass QL query for buildings in a bounding box.
 */
function buildOverpassQuery(
    minLat: number,
    minLon: number,
    maxLat: number,
    maxLon: number
): string {
    // Query for buildings (ways and relations with building tag)
    return `
[out:json][timeout:30];
(
  way["building"](${minLat},${minLon},${maxLat},${maxLon});
  relation["building"](${minLat},${minLon},${maxLat},${maxLon});
);
out body;
>;
out skel qt;
`.trim();
}

/**
 * Parse Overpass JSON response into GeoJSON.
 */
function parseOverpassResponse(data: any): GeoJSONFeatureCollection {
    const features: GeoJSONFeature[] = [];
    
    // Build node lookup
    const nodes = new Map<number, [number, number]>();
    for (const element of data.elements) {
        if (element.type === 'node') {
            nodes.set(element.id, [element.lon, element.lat]);
        }
    }

    // Process ways
    for (const element of data.elements) {
        if (element.type !== 'way') continue;
        if (!element.nodes || element.nodes.length < 4) continue;

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

        if (!valid || coordinates.length < 4) continue;

        const feature: GeoJSONFeature = {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [coordinates],
            } as GeoJSONPolygon,
            properties: {
                osmId: element.id,
                building: element.tags?.building || 'yes',
                name: element.tags?.name,
                height: element.tags?.height,
                levels: element.tags?.['building:levels'],
            },
        };

        features.push(feature);
    }

    return {
        type: 'FeatureCollection',
        features,
    };
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
    const query = buildOverpassQuery(minLat, minLon, maxLat, maxLon);

    const response = await fetch(OVERPASS_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(query)}`,
    });

    if (!response.ok) {
        throw new Error(`Overpass API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const geojson = parseOverpassResponse(data);

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
