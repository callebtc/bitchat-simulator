/**
 * LineOfSight
 * Ray-polygon intersection calculations for signal attenuation.
 */

import { Building, Point2D, ATTENUATION_CONFIG } from './types';

interface LineSegmentIntersection {
    /** Entry point into building */
    entry: Point2D;
    /** Exit point from building */
    exit: Point2D;
    /** Distance traveled through building */
    distance: number;
    /** Number of walls crossed (entry/exit) */
    wallsCrossed: number;
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
        // Check containment first
        const isAInside = pointInPolygon(a, building.vertices);
        const isBInside = pointInPolygon(b, building.vertices);

        // Same building optimization:
        // If both points are inside the SAME building, use low internal attenuation
        // and assume no perimeter walls are crossed (signal stays inside).
        if (isAInside && isBInside) {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            totalAttenuation += dist * ATTENUATION_CONFIG.BUILDING_INTERNAL_DB_M;
            continue;
        }

        // Calculate intersection with walls
        const intersection = getLinePolygonIntersection(a, b, building.vertices);
        
        if (intersection) {
            // "Shell" Model:
            // 1. Fixed loss per wall crossed
            // 2. Distance-based loss through internal material
            
            // Determine material rate based on containment (though logic above handles A&B inside)
            // If we are here, at least one point is outside (or passing through),
            // so we treat the internal medium as "dense" relative to open air,
            // or as "solid" per user request.
            const materialRate = ATTENUATION_CONFIG.BUILDING_DENSE_DB_M;
            
            const wallLoss = intersection.wallsCrossed * ATTENUATION_CONFIG.WALL_LOSS;
            const distLoss = intersection.distance * materialRate;
            
            totalAttenuation += wallLoss + distLoss;
        }
    }

    return totalAttenuation;
}

/**
 * Get detailed intersection info for a line through a polygon.
 * Returns entry point, exit point, distance, and wall count.
 */
export function getLinePolygonIntersection(
    a: Point2D,
    b: Point2D,
    vertices: Point2D[]
): { entry: Point2D; exit: Point2D; distance: number; wallsCrossed: number } | null {
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

    // Sort by parameter t (position along line)
    intersections.sort((x, y) => x.t - y.t);

    const isAInside = pointInPolygon(a, vertices);
    const isBInside = pointInPolygon(b, vertices);

    // Case 0: No intersections
    if (intersections.length === 0) {
        if (isAInside && isBInside) {
            // Entirely inside (no walls crossed relative to the segment, but contained)
            // Note: calculateLineAttenuation handles A&B inside specifically.
            // But if called generically:
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            return {
                entry: a,
                exit: b,
                distance: Math.sqrt(dx * dx + dy * dy),
                wallsCrossed: 0
            };
        }
        return null;
    }

    // Case 1: Single intersection (Entering or Exiting)
    if (intersections.length === 1) {
        const p = intersections[0].point;
        if (isAInside) {
            // Inside -> Out
            const dx = p.x - a.x;
            const dy = p.y - a.y;
            return {
                entry: a,
                exit: p,
                distance: Math.sqrt(dx * dx + dy * dy),
                wallsCrossed: 1
            };
        } else if (isBInside) {
            // Outside -> In
            const dx = b.x - p.x;
            const dy = b.y - p.y;
            return {
                entry: p,
                exit: b,
                distance: Math.sqrt(dx * dx + dy * dy),
                wallsCrossed: 1
            };
        }
        // Glancing blow or error, treat as null
        return null;
    }

    // Case 2: Two or more intersections (Pass through)
    // Take first and last (in case of complex non-convex shapes, this simplifies to "convex hull" equivalent distance)
    // For robust "shell" counting on non-convex, we'd count entries/exits, but simplest is 2 walls.
    const entry = intersections[0].point;
    const exit = intersections[intersections.length - 1].point;

    const dx = exit.x - entry.x;
    const dy = exit.y - entry.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // If passing through, we cross at least 2 walls (Entry + Exit)
    // (Technically could be more for concave, but 2 is the standard assumption for "shell")
    return { entry, exit, distance, wallsCrossed: 2 };
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
                wallsCrossed: intersection.wallsCrossed,
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

/**
 * Check if a line segment has clearance from a set of polygons.
 * Returns true if the segment does not intersect the interior of any polygon.
 * Grazing intersections (at t=0, t=1, or along an edge) are allowed.
 * 
 * @param a - Start point
 * @param b - End point
 * @param polygons - List of polygons (e.g., inflated obstacles)
 */
export function hasClearance(
    a: Point2D,
    b: Point2D,
    polygons: Point2D[][]
): boolean {
    const EPSILON = 1e-5;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    for (const poly of polygons) {
        // 1. Check for proper edge crossings
        const n = poly.length;
        for (let i = 0; i < n; i++) {
            const v1 = poly[i];
            const v2 = poly[(i + 1) % n];
            
            const intersection = lineSegmentIntersection(a, b, v1, v2);
            // Ignore intersections at endpoints (t=0 or t=1)
            // Only care if we cross the edge somewhere in the middle
            if (intersection && intersection.t > EPSILON && intersection.t < 1 - EPSILON) {
                return false;
            }
        }

        // 2. Check if segment goes through interior
        // If midpoint is inside and NOT on an edge, it's blocked
        // (This catches diagonals through the interior of a convex polygon)
        if (pointInPolygon(mid, poly)) {
             let onEdge = false;
             for (let i = 0; i < n; i++) {
                 const v1 = poly[i];
                 const v2 = poly[(i + 1) % n];
                 if (distancePointToSegment(mid, v1, v2) < EPSILON) {
                     onEdge = true;
                     break;
                 }
             }
             
             if (!onEdge) {
                 return false;
             }
        }
    }
    
    return true;
}

/**
 * Check if a point is strictly inside a polygon (not on the edge).
 */
export function isPointStrictlyInside(p: Point2D, polygon: Point2D[]): boolean {
    const EPSILON = 1e-5;
    if (!pointInPolygon(p, polygon)) return false;
    
    // Check if on edge
    const n = polygon.length;
    for (let i = 0; i < n; i++) {
        const v1 = polygon[i];
        const v2 = polygon[(i + 1) % n];
        if (distancePointToSegment(p, v1, v2) < EPSILON) {
            return false; // On edge, not strictly inside
        }
    }
    return true;
}

/**
 * Calculate distance from point p to line segment v1-v2.
 */
function distancePointToSegment(p: Point2D, v1: Point2D, v2: Point2D): number {
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;
    const lenSq = dx * dx + dy * dy;
    
    if (lenSq === 0) {
        const dpx = p.x - v1.x;
        const dpy = p.y - v1.y;
        return Math.sqrt(dpx * dpx + dpy * dpy);
    }
    
    // Project point onto line, clamped to segment
    let t = ((p.x - v1.x) * dx + (p.y - v1.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    
    const projX = v1.x + t * dx;
    const projY = v1.y + t * dy;
    
    const dpx = p.x - projX;
    const dpy = p.y - projY;
    
    return Math.sqrt(dpx * dpx + dpy * dpy);
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
