/**
 * LineOfSight
 * Ray-polygon intersection calculations for signal attenuation.
 */

import { Building, Point2D, MATERIAL_ATTENUATION } from './types';

interface LineSegmentIntersection {
    /** Entry point into building */
    entry: Point2D;
    /** Exit point from building */
    exit: Point2D;
    /** Distance traveled through building */
    distance: number;
    /** The building intersected */
    building: Building;
}

/**
 * Calculate the total signal attenuation along a line from A to B.
 * Sums up attenuation from all buildings intersected.
 * 
 * @param a - Start point
 * @param b - End point  
 * @param buildings - Buildings to check (pre-filtered by bounding box)
 * @returns Total attenuation in dB
 */
export function calculateLineAttenuation(
    a: Point2D,
    b: Point2D,
    buildings: Building[]
): number {
    let totalAttenuation = 0;

    for (const building of buildings) {
        const intersection = getLinePolygonIntersection(a, b, building.vertices);
        if (intersection) {
            const attenuation = intersection.distance * MATERIAL_ATTENUATION[building.material];
            totalAttenuation += attenuation;
        }
    }

    return totalAttenuation;
}

/**
 * Get detailed intersection info for a line through a polygon.
 * Returns entry point, exit point, and distance through polygon.
 */
export function getLinePolygonIntersection(
    a: Point2D,
    b: Point2D,
    vertices: Point2D[]
): { entry: Point2D; exit: Point2D; distance: number } | null {
    const intersections: { point: Point2D; t: number }[] = [];
    const n = vertices.length;

    // Check intersection with each edge
    for (let i = 0; i < n; i++) {
        const v1 = vertices[i];
        const v2 = vertices[(i + 1) % n];

        const intersection = lineSegmentIntersection(a, b, v1, v2);
        if (intersection) {
            intersections.push(intersection);
        }
    }

    // Need at least 2 intersections (entry and exit)
    if (intersections.length < 2) {
        // Check if line is entirely inside polygon
        if (pointInPolygon(a, vertices) && pointInPolygon(b, vertices)) {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            return {
                entry: a,
                exit: b,
                distance: Math.sqrt(dx * dx + dy * dy),
            };
        }
        return null;
    }

    // Sort by parameter t (position along line)
    intersections.sort((x, y) => x.t - y.t);

    // Take first and last intersection as entry/exit
    const entry = intersections[0].point;
    const exit = intersections[intersections.length - 1].point;

    const dx = exit.x - entry.x;
    const dy = exit.y - entry.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return { entry, exit, distance };
}

/**
 * Calculate intersection point between two line segments.
 * Returns null if no intersection.
 * 
 * Line 1: a -> b
 * Line 2: c -> d
 */
function lineSegmentIntersection(
    a: Point2D,
    b: Point2D,
    c: Point2D,
    d: Point2D
): { point: Point2D; t: number } | null {
    const dx1 = b.x - a.x;
    const dy1 = b.y - a.y;
    const dx2 = d.x - c.x;
    const dy2 = d.y - c.y;

    const denominator = dx1 * dy2 - dy1 * dx2;

    // Parallel lines
    if (Math.abs(denominator) < 1e-10) {
        return null;
    }

    const dx3 = a.x - c.x;
    const dy3 = a.y - c.y;

    const t = (dx3 * dy2 - dy3 * dx2) / (-denominator);
    const u = (dx1 * dy3 - dy1 * dx3) / denominator;

    // Check if intersection is within both segments
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return {
            point: {
                x: a.x + t * dx1,
                y: a.y + t * dy1,
            },
            t,
        };
    }

    return null;
}

/**
 * Check if a point is inside a polygon using ray casting.
 */
function pointInPolygon(point: Point2D, vertices: Point2D[]): boolean {
    let inside = false;
    const n = vertices.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const vi = vertices[i];
        const vj = vertices[j];

        if (
            ((vi.y > point.y) !== (vj.y > point.y)) &&
            (point.x < (vj.x - vi.x) * (point.y - vi.y) / (vj.y - vi.y) + vi.x)
        ) {
            inside = !inside;
        }
    }

    return inside;
}

/**
 * Get all intersection details for visualization/debugging.
 */
export function getDetailedIntersections(
    a: Point2D,
    b: Point2D,
    buildings: Building[]
): LineSegmentIntersection[] {
    const results: LineSegmentIntersection[] = [];

    for (const building of buildings) {
        const intersection = getLinePolygonIntersection(a, b, building.vertices);
        if (intersection) {
            results.push({
                entry: intersection.entry,
                exit: intersection.exit,
                distance: intersection.distance,
                building,
            });
        }
    }

    return results;
}

/**
 * Check if there's any obstruction between two points.
 * Faster than calculating full attenuation when you just need yes/no.
 */
export function hasLineOfSight(
    a: Point2D,
    b: Point2D,
    buildings: Building[]
): boolean {
    for (const building of buildings) {
        const intersection = getLinePolygonIntersection(a, b, building.vertices);
        if (intersection && intersection.distance > 0.1) {
            return false;
        }
    }
    return true;
}

// ============================================================================
// Collision Detection Helpers
// ============================================================================

export interface CollisionResult {
    /** The point where collision occurred */
    point: Point2D;
    /** The normal vector of the wall (pointing outward) */
    normal: Point2D;
    /** The edge vertices that were hit */
    edge: { v1: Point2D; v2: Point2D };
    /** Parameter t along the movement line (0 = start, 1 = end) */
    t: number;
    /** The building that was hit */
    building: Building;
}

/**
 * Find the first intersection point when moving from A to B.
 * Returns the closest collision along the movement path.
 */
export function getFirstIntersection(
    a: Point2D,
    b: Point2D,
    buildings: Building[]
): CollisionResult | null {
    let closest: CollisionResult | null = null;
    let closestT = Infinity;

    for (const building of buildings) {
        const result = getFirstPolygonIntersection(a, b, building);
        if (result && result.t < closestT) {
            closest = result;
            closestT = result.t;
        }
    }

    return closest;
}

/**
 * Find the first intersection with a single polygon.
 */
function getFirstPolygonIntersection(
    a: Point2D,
    b: Point2D,
    building: Building
): CollisionResult | null {
    const vertices = building.vertices;
    const n = vertices.length;
    
    let closest: CollisionResult | null = null;
    let closestT = Infinity;

    // Check intersection with each edge
    for (let i = 0; i < n; i++) {
        const v1 = vertices[i];
        const v2 = vertices[(i + 1) % n];

        const intersection = lineSegmentIntersection(a, b, v1, v2);
        // Filter out intersections at the very start (t ≈ 0) to avoid detecting
        // collisions when starting exactly at a wall edge
        if (intersection && intersection.t < closestT && intersection.t > 0.0001) {
            // Calculate outward normal for this edge
            const normal = getEdgeNormal(v1, v2, a);
            
            closest = {
                point: intersection.point,
                normal,
                edge: { v1, v2 },
                t: intersection.t,
                building,
            };
            closestT = intersection.t;
        }
    }

    return closest;
}

/**
 * Calculate the outward-facing normal of an edge.
 * The normal points away from the polygon interior.
 * 
 * @param v1 - First vertex of edge
 * @param v2 - Second vertex of edge
 * @param outsidePoint - A point known to be outside the polygon (used to determine direction)
 */
export function getEdgeNormal(v1: Point2D, v2: Point2D, outsidePoint: Point2D): Point2D {
    // Edge direction
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;
    
    // Two possible perpendiculars: (dy, -dx) or (-dy, dx)
    // Normalize
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) {
        return { x: 0, y: 1 }; // Degenerate edge
    }
    
    const n1: Point2D = { x: dy / len, y: -dx / len };
    const n2: Point2D = { x: -dy / len, y: dx / len };
    
    // Choose the one pointing toward the outside point
    // Midpoint of edge
    const mid: Point2D = { x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 };
    
    // Vector from midpoint to outside point
    const toOutside: Point2D = { x: outsidePoint.x - mid.x, y: outsidePoint.y - mid.y };
    
    // Dot product to see which normal points toward outside
    const dot1 = n1.x * toOutside.x + n1.y * toOutside.y;
    const dot2 = n2.x * toOutside.x + n2.y * toOutside.y;
    
    return dot1 > dot2 ? n1 : n2;
}

/**
 * Check if a point is inside a polygon using ray casting.
 * Exported for use in collision detection.
 */
export { pointInPolygon };

/**
 * Project a vector onto a surface (remove the normal component).
 * Returns the component of `vec` that is parallel to the surface.
 */
export function projectOntoSurface(vec: Point2D, normal: Point2D): Point2D {
    // Remove normal component: result = vec - (vec · normal) * normal
    const dot = vec.x * normal.x + vec.y * normal.y;
    return {
        x: vec.x - dot * normal.x,
        y: vec.y - dot * normal.y,
    };
}
