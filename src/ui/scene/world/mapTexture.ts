import * as THREE from 'three';

import { Building, MapContext, RoadClass } from '../../../simulation/environment';

/**
 * Bakes map context (sidewalks, roads, lane markings, parks, plazas, water,
 * building plinths) into one canvas texture that drapes over the terrain
 * mesh. Baking avoids coplanar z-fighting entirely and follows any slope.
 */

const TARGET_M_PER_PX = 0.4;

const ROAD_FILL: Record<RoadClass, string> = {
    major: '#2b2d31',
    minor: '#323439',
    service: '#3b3d42',
    footway: '#8c8b88',
};
const CURB = '#9a9894';
const GROUND = '#77777a';
const PARK = '#4b7a3e';
const PLAZA = '#a3a19b';
const WATER = '#21405e';
const PLINTH = '#5c5d60';
const MARKING = 'rgba(236, 214, 140, 0.85)';
const EDGE_LINE = 'rgba(235, 235, 235, 0.55)';

export interface MapTextureExtent {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export function bakeMapTexture(
    ctx: MapContext,
    buildings: Building[],
    extent: MapTextureExtent,
    maxAnisotropy: number
): THREE.CanvasTexture {
    const w = extent.maxX - extent.minX;
    const h = extent.maxY - extent.minY;
    const longest = Math.max(w, h);
    const size = Math.min(4096, Math.max(1024, Math.pow(2, Math.ceil(Math.log2(longest / TARGET_M_PER_PX)))));
    const sx = size / w;
    const sy = size / h;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2D canvas unavailable');

    const px = (x: number) => (x - extent.minX) * sx;
    const py = (y: number) => (extent.maxY - y) * sy;
    const scale = (sx + sy) / 2;

    g.fillStyle = GROUND;
    g.fillRect(0, 0, size, size);

    // Subtle concrete paving grain so large plazas aren't flat colour
    g.globalAlpha = 0.06;
    for (let i = 0; i < size * 6; i++) {
        g.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
        g.fillRect(Math.random() * size, Math.random() * size, 2, 2);
    }
    g.globalAlpha = 1;

    const fillPoly = (verts: { x: number; y: number }[], style: string) => {
        if (verts.length < 3) return;
        g.beginPath();
        g.moveTo(px(verts[0].x), py(verts[0].y));
        for (let i = 1; i < verts.length; i++) g.lineTo(px(verts[i].x), py(verts[i].y));
        g.closePath();
        g.fillStyle = style;
        g.fill();
    };

    for (const a of ctx.areas) {
        fillPoly(a.vertices, a.kind === 'park' ? PARK : a.kind === 'water' ? WATER : PLAZA);
    }

    const strokeRoad = (pts: { x: number; y: number }[], width: number, style: string, dash?: number[]) => {
        if (pts.length < 2) return;
        g.beginPath();
        g.moveTo(px(pts[0].x), py(pts[0].y));
        for (let i = 1; i < pts.length; i++) g.lineTo(px(pts[i].x), py(pts[i].y));
        g.lineWidth = Math.max(1, width * scale);
        g.strokeStyle = style;
        g.setLineDash(dash ?? []);
        g.stroke();
    };

    g.lineCap = 'round';
    g.lineJoin = 'round';
    const drivable: RoadClass[] = ['major', 'minor', 'service'];
    // Curbs / sidewalks first (wider, light), then carriageways on top
    for (const r of ctx.roads) {
        if (drivable.includes(r.roadClass)) strokeRoad(r.points, r.width + 3.2, CURB);
    }
    for (const cls of ['footway', 'service', 'minor', 'major'] as RoadClass[]) {
        for (const r of ctx.roads) {
            if (r.roadClass === cls) strokeRoad(r.points, r.width, ROAD_FILL[cls]);
        }
    }
    g.lineCap = 'butt';
    for (const r of ctx.roads) {
        if (r.roadClass === 'major' || r.roadClass === 'minor') {
            strokeRoad(r.points, 0.18, MARKING, [3 * scale, 4.5 * scale]);
        }
        if (r.roadClass === 'major' && r.width >= 10) {
            // Lane-edge lines a little inside the curb
            const off = r.width / 2 - 0.6;
            for (const side of [-1, 1]) {
                const shifted = r.points.map((p, i) => {
                    const a = r.points[Math.max(0, i - 1)];
                    const b = r.points[Math.min(r.points.length - 1, i + 1)];
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const len = Math.hypot(dx, dy) || 1;
                    return { x: p.x - (dy / len) * off * side, y: p.y + (dx / len) * off * side };
                });
                strokeRoad(shifted, 0.15, EDGE_LINE);
            }
        }
    }
    g.setLineDash([]);

    for (const b of buildings) fillPoly(b.vertices, PLINTH);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAnisotropy;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
}
