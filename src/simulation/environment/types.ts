/**
 * Environment Types
 * GeoJSON-compatible types and simulator-specific structures for environment data
 */

// ============================================================================
// GeoJSON Types (simplified subset we need)
// ============================================================================

export interface GeoJSONPosition {
    /** Longitude */
    lng: number;
    /** Latitude */
    lat: number;
}

export interface GeoJSONPolygon {
    type: 'Polygon';
    /** Outer ring followed by optional holes. Each ring is array of [lng, lat] */
    coordinates: number[][][];
}

export interface GeoJSONFeature<G = GeoJSONPolygon, P = Record<string, unknown>> {
    type: 'Feature';
    geometry: G;
    properties: P;
}

export interface GeoJSONFeatureCollection<G = GeoJSONPolygon, P = Record<string, unknown>> {
    type: 'FeatureCollection';
    features: GeoJSONFeature<G, P>[];
}

// ============================================================================
// Material System
// ============================================================================

export enum Material {
    /** Open air - no attenuation */
    AIR = 'air',
    /** Building material - moderate attenuation */
    BUILDING = 'building',
}

/** Signal attenuation constants */
export const ATTENUATION_CONFIG = {
    /** Fixed loss when signal penetrates a building outer wall (dB) */
    WALL_LOSS: 15,
    /** Attenuation per meter when signal travels inside a building (dB/m) - used when peers are NOT in same building */
    BUILDING_DENSE_DB_M: 4.0,
    /** Attenuation per meter when signal travels inside a building (dB/m) - used when peers ARE in same building */
    BUILDING_INTERNAL_DB_M: 0.5,
};

/** Signal attenuation in dB per meter for each material (Legacy/Base values) */
export const MATERIAL_ATTENUATION: Record<Material, number> = {
    [Material.AIR]: 0,
    [Material.BUILDING]: 12, // dB per meter
};

// ============================================================================
// Building Representation
// ============================================================================

export interface Point2D {
    x: number;
    y: number;
}

export interface BoundingBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface Building {
    id: string;
    /** Material of this building */
    material: Material;
    /** Polygon vertices in local coordinates (meters) */
    vertices: Point2D[];
    /** Pre-computed bounding box for fast culling */
    bounds: BoundingBox;
    /** Original OSM properties if available */
    properties?: Record<string, unknown>;
}

// ============================================================================
// Environment Data
// ============================================================================

export interface EnvironmentBounds {
    /** Reference point for coordinate conversion (center of map) */
    center: GeoJSONPosition;
    /** Bounding box in lat/lon */
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
    /** Bounding box in local meters */
    localBounds: BoundingBox;
}

export interface EnvironmentData {
    bounds: EnvironmentBounds;
    buildings: Building[];
}

// ============================================================================
// Coordinate Conversion Helpers
// ============================================================================

/** Earth radius in meters */
const EARTH_RADIUS = 6371000;

/**
 * Convert lat/lon to local meters relative to a reference point.
 * Uses simple Mercator projection (accurate for small areas).
 */
export function latLonToLocal(
    lat: number,
    lon: number,
    refLat: number,
    refLon: number
): Point2D {
    const refLatRad = (refLat * Math.PI) / 180;

    // X: longitude difference in meters
    const x = ((lon - refLon) * Math.PI / 180) * EARTH_RADIUS * Math.cos(refLatRad);

    // Y: latitude difference in meters
    const y = ((lat - refLat) * Math.PI / 180) * EARTH_RADIUS;

    return { x, y };
}

/**
 * Convert local meters back to lat/lon.
 */
export function localToLatLon(
    x: number,
    y: number,
    refLat: number,
    refLon: number
): GeoJSONPosition {
    const refLatRad = (refLat * Math.PI) / 180;

    const lat = refLat + (y / EARTH_RADIUS) * (180 / Math.PI);
    const lng = refLon + (x / (EARTH_RADIUS * Math.cos(refLatRad))) * (180 / Math.PI);

    return { lat, lng };
}

/**
 * Calculate bounding box for a set of vertices.
 */
export function calculateBounds(vertices: Point2D[]): BoundingBox {
    if (vertices.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const v of vertices) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
    }

    return { minX, minY, maxX, maxY };
}
