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
    BuildingHeightSource,
    RoadClass,
    RoadSegment,
    MapArea,
    MapAreaKind,
    MapContext,
    GeoJSONLineString,
    BoundingBox,
    Building,
    EnvironmentBounds,
    EnvironmentData,
    GeoJSONPosition,
    GeoJSONPolygon,
    GeoJSONFeature,
    GeoJSONFeatureCollection,
} from './types';

// Building heights (OSM Simple 3D Buildings)
export { resolveBuildingHeight, parseOsmLength, polygonArea, STOREY_HEIGHT_M } from './BuildingHeights';

// Environment Manager
export { EnvironmentManager } from './EnvironmentManager';
export type { MovementResult } from './EnvironmentManager';

// OSM Fetcher
export {
    fetchBuildingsFromOSM,
    fetchBuildingsAround,
    clearOSMCache,
    getOSMCacheStats,
    parseOverpassResponse,
    classifyOsmWay,
} from './OSMFetcher';
export type { OSMFeatureKind } from './OSMFetcher';

// Line of Sight
export {
    calculateLineAttenuation,
    calculateLineAttenuationStats,
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
