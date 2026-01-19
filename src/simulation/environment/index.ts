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
} from './LineOfSight';
