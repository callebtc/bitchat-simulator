/**
 * Environment Module
 * 
 * Provides physical environment simulation including:
 * - Building polygons from OpenStreetMap
 * - Material-based signal attenuation
 * - Line-of-sight calculations
 */

// Types
export { Material, MATERIAL_ATTENUATION, latLonToLocal, localToLatLon, calculateBounds } from './types';
export type {
    Point2D,
    BoundingBox,
    Building,
    EnvironmentBounds,
    EnvironmentData,
    GeoJSONPosition,
    GeoJSONPolygon,
    GeoJSONFeature,
    GeoJSONFeatureCollection,
} from './types';

// Environment Manager
export { EnvironmentManager } from './EnvironmentManager';
export type { MovementResult } from './EnvironmentManager';

// OSM Fetcher
export {
    fetchBuildingsFromOSM,
    fetchBuildingsAround,
    clearOSMCache,
    getOSMCacheStats,
} from './OSMFetcher';

// Line of Sight
export {
    calculateLineAttenuation,
    getLinePolygonIntersection,
    getDetailedIntersections,
    hasLineOfSight,
    getFirstIntersection,
    getEdgeNormal,
    pointInPolygon,
    projectOntoSurface,
} from './LineOfSight';

export type { CollisionResult } from './LineOfSight';

// PathFinder
export { PathFinder } from './PathFinder';
export type { PathResult, GraphBuildProgress } from './PathFinder';

// Unified cache clear function
import { PathFinder } from './PathFinder';
import { clearOSMCache as clearOSMCacheFn } from './OSMFetcher';

/**
 * Clear all map-related cached data (OSM data + visibility graphs).
 */
export function clearAllMapCache(): void {
    clearOSMCacheFn();
    PathFinder.clearCache();
    console.log('[Environment] Cleared all map cache data');
}
