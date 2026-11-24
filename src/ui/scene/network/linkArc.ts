import { DEVICE_HEIGHT_M } from '../coords';

/**
 * Radio links are drawn as shallow parabolic arcs between device antennas.
 * The arc is purely a readability aid (BLE / Wi-Fi Aware propagation is
 * modeled as a straight line-of-sight path in `BitchatConnectionBLE`); its
 * apex grows with link length so overlapping links fan apart vertically.
 */
export function arcApexHeight(distance: number): number {
    return Math.min(24, 0.4 + distance * 0.085);
}

export interface ArcPoint {
    x: number;
    y: number;
    z: number;
}

/**
 * Point at parameter t ∈ [0, 1] along the link arc from (ax, ay) to (bx, by).
 * `ga` / `gb` are the ground heights under each endpoint (terrain).
 */
export function arcPoint(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    apex: number,
    t: number,
    out: ArcPoint,
    ga: number = 0,
    gb: number = 0
): ArcPoint {
    out.x = ax + (bx - ax) * t;
    out.y = ay + (by - ay) * t;
    out.z = DEVICE_HEIGHT_M + ga + (gb - ga) * t + 4 * apex * t * (1 - t);
    return out;
}
