/**
 * LineOfSight
 * Fast zero-allocation ray-polygon intersection calculations for signal attenuation
 * and collision detection.
 */

import { Building, Point2D, ATTENUATION_CONFIG } from './types';

interface LineSegmentIntersection {
    entry: Point2D;
    exit: Point2D;
    distance: number;
    wallsCrossed: number;
    building: Building;
}

export interface AttenuationStats {
    total: number;
    wallLoss: number;
    materialLoss: number;
    wallsCrossed: number;
}

/**
 * Compute segment-segment intersection parameter `t` along a->b, or -1 if none.
 * Zero heap allocation hot-path helper.
 */
function segmentIntersectT(
    ax: number,
    ay: number,
    dx1: number,
    dy1: number,
    cx: number,
    cy: number,
    dx2: number,
    dy2: number
): number {
    const denom = dx1 * dy2 - dy1 * dx2;
    if (denom > -1e-10 && denom < 1e-10) return -1;

    const dx3 = ax - cx;
    const dy3 = ay - cy;
    const t = (dx3 * dy2 - dy3 * dx2) / -denom;
    if (t < 0 || t > 1) return -1;

    const u = (dx1 * dy3 - dy1 * dx3) / denom;
    if (u < 0 || u > 1) return -1;

    return t;
}

/**
 * Calculate the total signal attenuation along a line from A to B.
 * Optimized with AABB rejection and zero-allocation segment intersection.
 */
export function calculateLineAttenuationStats(
    a: Point2D,
    b: Point2D,
    buildings: Building[]
): AttenuationStats {
    let wallLoss = 0;
    let materialLoss = 0;
    let wallsCrossed = 0;

    const ax = a.x;
    const ay = a.y;
    const bx = b.x;
    const by = b.y;
    const dx1 = bx - ax;
    const dy1 = by - ay;
    const lineMinX = ax < bx ? ax : bx;
    const lineMaxX = ax > bx ? ax : bx;
    const lineMinY = ay < by ? ay : by;
    const lineMaxY = ay > by ? ay : by;

    for (let bi = 0; bi < buildings.length; bi++) {
        const building = buildings[bi];
        const bb = building.bounds;
        if (
            bb.maxX < lineMinX ||
            bb.minX > lineMaxX ||
            bb.maxY < lineMinY ||
            bb.minY > lineMaxY
        ) {
            continue;
        }

        const verts = building.vertices;
        const isAInside =
            ax >= bb.minX &&
            ax <= bb.maxX &&
            ay >= bb.minY &&
            ay <= bb.maxY &&
            pointInPolygon(a, verts);
        const isBInside =
            bx >= bb.minX &&
            bx <= bb.maxX &&
            by >= bb.minY &&
            by <= bb.maxY &&
            pointInPolygon(b, verts);

        if (isAInside && isBInside) {
            const dist = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            materialLoss += dist * ATTENUATION_CONFIG.BUILDING_INTERNAL_DB_M;
            continue;
        }

        // Find min and max intersection t along a->b in a single zero-alloc pass
        let count = 0;
        let minT = Infinity;
        let maxT = -Infinity;
        const n = verts.length;

        for (let i = 0; i < n; i++) {
            const v1 = verts[i];
            const v2 = verts[i + 1 < n ? i + 1 : 0];
            const t = segmentIntersectT(
                ax,
                ay,
                dx1,
                dy1,
                v1.x,
                v1.y,
                v2.x - v1.x,
                v2.y - v1.y
            );
            if (t >= 0) {
                count++;
                if (t < minT) minT = t;
                if (t > maxT) maxT = t;
            }
        }

        if (count === 0) continue;

        let segDist = 0;
        let segWalls = 0;
        if (count === 1) {
            if (isAInside) {
                segDist = minT * Math.sqrt(dx1 * dx1 + dy1 * dy1);
                segWalls = 1;
            } else if (isBInside) {
                segDist = (1 - minT) * Math.sqrt(dx1 * dx1 + dy1 * dy1);
                segWalls = 1;
            } else {
                continue;
            }
        } else {
            segDist = (maxT - minT) * Math.sqrt(dx1 * dx1 + dy1 * dy1);
            segWalls = 2;
        }

        wallLoss += segWalls * ATTENUATION_CONFIG.WALL_LOSS;
        materialLoss += segDist * ATTENUATION_CONFIG.BUILDING_DENSE_DB_M;
        wallsCrossed += segWalls;
    }

    return {
        total: wallLoss + materialLoss,
        wallLoss,
        materialLoss,
        wallsCrossed,
    };
}

export function calculateLineAttenuation(
    a: Point2D,
    b: Point2D,
    buildings: Building[]
): number {
    return calculateLineAttenuationStats(a, b, buildings).total;
}

export function getLinePolygonIntersection(
    a: Point2D,
    b: Point2D,
    vertices: Point2D[]
): { entry: Point2D; exit: Point2D; distance: number; wallsCrossed: number } | null {
    const ax = a.x;
    const ay = a.y;
    const dx1 = b.x - ax;
    const dy1 = b.y - ay;
    const n = vertices.length;

    let count = 0;
    let minT = Infinity;
    let maxT = -Infinity;

    for (let i = 0; i < n; i++) {
        const v1 = vertices[i];
        const v2 = vertices[i + 1 < n ? i + 1 : 0];
        const t = segmentIntersectT(ax, ay, dx1, dy1, v1.x, v1.y, v2.x - v1.x, v2.y - v1.y);
        if (t >= 0) {
            count++;
            if (t < minT) minT = t;
            if (t > maxT) maxT = t;
        }
    }

    if (count === 0) {
        if (pointInPolygon(a, vertices) && pointInPolygon(b, vertices)) {
            return {
                entry: a,
                exit: b,
                distance: Math.sqrt(dx1 * dx1 + dy1 * dy1),
                wallsCrossed: 0,
            };
        }
        return null;
    }

    const totalLen = Math.sqrt(dx1 * dx1 + dy1 * dy1);

    if (count === 1) {
        const px = ax + minT * dx1;
        const py = ay + minT * dy1;
        if (pointInPolygon(a, vertices)) {
            return {
                entry: a,
                exit: { x: px, y: py },
                distance: minT * totalLen,
                wallsCrossed: 1,
            };
        }
        if (pointInPolygon(b, vertices)) {
            return {
                entry: { x: px, y: py },
                exit: b,
                distance: (1 - minT) * totalLen,
                wallsCrossed: 1,
            };
        }
        return null;
    }

    return {
        entry: { x: ax + minT * dx1, y: ay + minT * dy1 },
        exit: { x: ax + maxT * dx1, y: ay + maxT * dy1 },
        distance: (maxT - minT) * totalLen,
        wallsCrossed: 2,
    };
}

export function pointInPolygon(point: Point2D, vertices: Point2D[]): boolean {
    let inside = false;
    const n = vertices.length;
    const px = point.x;
    const py = point.y;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const vi = vertices[i];
        const vj = vertices[j];

        if (
            vi.y > py !== vj.y > py &&
            px < ((vj.x - vi.x) * (py - vi.y)) / (vj.y - vi.y) + vi.x
        ) {
            inside = !inside;
        }
    }

    return inside;
}

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

export function hasLineOfSight(a: Point2D, b: Point2D, buildings: Building[]): boolean {
    const ax = a.x;
    const ay = a.y;
    const bx = b.x;
    const by = b.y;
    const dx1 = bx - ax;
    const dy1 = by - ay;
    const lineMinX = ax < bx ? ax : bx;
    const lineMaxX = ax > bx ? ax : bx;
    const lineMinY = ay < by ? ay : by;
    const lineMaxY = ay > by ? ay : by;
    const totalLen = Math.sqrt(dx1 * dx1 + dy1 * dy1);

    const mid: Point2D = { x: (ax + bx) * 0.5, y: (ay + by) * 0.5 };

    for (let bi = 0; bi < buildings.length; bi++) {
        const building = buildings[bi];
        const bb = building.bounds;
        if (
            bb.maxX < lineMinX ||
            bb.minX > lineMaxX ||
            bb.maxY < lineMinY ||
            bb.minY > lineMaxY
        ) {
            continue;
        }

        const verts = building.vertices;
        const n = verts.length;
        let count = 0;
        let minT = Infinity;
        let maxT = -Infinity;

        for (let i = 0; i < n; i++) {
            const v1 = verts[i];
            const v2 = verts[i + 1 < n ? i + 1 : 0];
            const t = segmentIntersectT(ax, ay, dx1, dy1, v1.x, v1.y, v2.x - v1.x, v2.y - v1.y);
            if (t >= 0) {
                count++;
                if (t < minT) minT = t;
                if (t > maxT) maxT = t;
            }
        }

        if (count >= 2 && (maxT - minT) * totalLen > 0.1) {
            return false;
        }
        if (count === 1) {
            if (pointInPolygon(a, verts) && minT * totalLen > 0.1) return false;
            if (pointInPolygon(b, verts) && (1 - minT) * totalLen > 0.1) return false;
            if (totalLen > 0.1 && pointInPolygon(mid, verts)) return false;
        } else if (count === 0) {
            if (totalLen > 0.1 && (pointInPolygon(mid, verts) || (pointInPolygon(a, verts) && pointInPolygon(b, verts)))) {
                return false;
            }
        }
    }
    return true;
}

export function hasClearance(a: Point2D, b: Point2D, polygons: Point2D[][]): boolean {
    const EPSILON = 1e-5;
    const ax = a.x;
    const ay = a.y;
    const dx1 = b.x - ax;
    const dy1 = b.y - ay;
    const mid: Point2D = { x: (ax + b.x) * 0.5, y: (ay + b.y) * 0.5 };

    for (let pi = 0; pi < polygons.length; pi++) {
        const poly = polygons[pi];
        const n = poly.length;
        for (let i = 0; i < n; i++) {
            const v1 = poly[i];
            const v2 = poly[i + 1 < n ? i + 1 : 0];
            const t = segmentIntersectT(ax, ay, dx1, dy1, v1.x, v1.y, v2.x - v1.x, v2.y - v1.y);
            if (t > EPSILON && t < 1 - EPSILON) {
                return false;
            }
        }

        if (pointInPolygon(mid, poly)) {
            let onEdge = false;
            for (let i = 0; i < n; i++) {
                const v1 = poly[i];
                const v2 = poly[i + 1 < n ? i + 1 : 0];
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

export function isPointStrictlyInside(p: Point2D, polygon: Point2D[]): boolean {
    const EPSILON = 1e-5;
    if (!pointInPolygon(p, polygon)) return false;

    const n = polygon.length;
    for (let i = 0; i < n; i++) {
        const v1 = polygon[i];
        const v2 = polygon[i + 1 < n ? i + 1 : 0];
        if (distancePointToSegment(p, v1, v2) < EPSILON) {
            return false;
        }
    }
    return true;
}

function distancePointToSegment(p: Point2D, v1: Point2D, v2: Point2D): number {
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        const dpx = p.x - v1.x;
        const dpy = p.y - v1.y;
        return Math.sqrt(dpx * dpx + dpy * dpy);
    }

    let t = ((p.x - v1.x) * dx + (p.y - v1.y) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const dpx = p.x - (v1.x + t * dx);
    const dpy = p.y - (v1.y + t * dy);
    return Math.sqrt(dpx * dpx + dpy * dpy);
}

// ============================================================================
// Collision Detection Helpers
// ============================================================================

export interface CollisionResult {
    point: Point2D;
    normal: Point2D;
    edge: { v1: Point2D; v2: Point2D };
    t: number;
    building: Building;
}

export function getFirstIntersection(
    a: Point2D,
    b: Point2D,
    buildings: Building[]
): CollisionResult | null {
    const ax = a.x;
    const ay = a.y;
    const dx1 = b.x - ax;
    const dy1 = b.y - ay;

    let closestT = Infinity;
    let closestBuilding: Building | null = null;
    let closestV1: Point2D | null = null;
    let closestV2: Point2D | null = null;

    for (let bi = 0; bi < buildings.length; bi++) {
        const building = buildings[bi];
        const verts = building.vertices;
        const n = verts.length;

        for (let i = 0; i < n; i++) {
            const v1 = verts[i];
            const v2 = verts[i + 1 < n ? i + 1 : 0];
            const t = segmentIntersectT(ax, ay, dx1, dy1, v1.x, v1.y, v2.x - v1.x, v2.y - v1.y);
            if (t > 0.0001 && t < closestT) {
                closestT = t;
                closestBuilding = building;
                closestV1 = v1;
                closestV2 = v2;
            }
        }
    }

    if (!closestBuilding || !closestV1 || !closestV2) return null;

    return {
        point: { x: ax + closestT * dx1, y: ay + closestT * dy1 },
        normal: getEdgeNormal(closestV1, closestV2, a),
        edge: { v1: closestV1, v2: closestV2 },
        t: closestT,
        building: closestBuilding,
    };
}

export function getEdgeNormal(v1: Point2D, v2: Point2D, outsidePoint: Point2D): Point2D {
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) {
        return { x: 0, y: 1 };
    }

    const n1x = dy / len;
    const n1y = -dx / len;
    const n2x = -n1x;
    const n2y = -n1y;

    const toOutX = outsidePoint.x - (v1.x + v2.x) * 0.5;
    const toOutY = outsidePoint.y - (v1.y + v2.y) * 0.5;

    const dot1 = n1x * toOutX + n1y * toOutY;
    const dot2 = n2x * toOutX + n2y * toOutY;
    return dot1 > dot2 ? { x: n1x, y: n1y } : { x: n2x, y: n2y };
}

export function projectOntoSurface(vec: Point2D, normal: Point2D): Point2D {
    const dot = vec.x * normal.x + vec.y * normal.y;
    return {
        x: vec.x - dot * normal.x,
        y: vec.y - dot * normal.y,
    };
}
