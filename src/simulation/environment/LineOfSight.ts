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
