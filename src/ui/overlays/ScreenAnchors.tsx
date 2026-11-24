import React, { useCallback, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { simToWorld } from '../scene/coords';

/**
 * Screen anchors: crisp DOM overlays (labels, chat bubbles) pinned to
 * simulation-space points. A single projector inside the Canvas writes CSS
 * transforms in the same frame the 3D scene renders — no per-label React
 * renders and no frame lag.
 */

export interface AnchorPoint {
    x: number;
    y: number;
    z: number;
}

interface Anchor {
    el: HTMLElement;
    resolve: () => AnchorPoint | null;
    /** Hide beyond this camera distance (m). */
    maxDistance: number;
    /** Scale label down with distance (true) or keep constant size (false). */
    scaleWithDistance: boolean;
}

const anchors = new Map<string, Anchor>();
const _v = new THREE.Vector3();

export const ScreenAnchorProjector: React.FC = () => {
    useFrame(({ camera, size }) => {
        if (anchors.size === 0) return;
        for (const anchor of anchors.values()) {
            const p = anchor.resolve();
            if (!p) {
                anchor.el.style.visibility = 'hidden';
                continue;
            }
            simToWorld(p.x, p.y, p.z, _v);
            const dist = _v.distanceTo(camera.position);
            _v.project(camera);
            if (dist > anchor.maxDistance || _v.z > 1 || _v.z < -1) {
                anchor.el.style.visibility = 'hidden';
                continue;
            }
            const x = ((_v.x + 1) / 2) * size.width;
            const y = ((1 - _v.y) / 2) * size.height;
            const s = anchor.scaleWithDistance ? THREE.MathUtils.clamp(120 / dist, 0.78, 1) : 1;
            anchor.el.style.visibility = 'visible';
            anchor.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${s.toFixed(3)})`;
            anchor.el.style.zIndex = String(100000 - Math.round(dist));
        }
    });
    return null;
};

/** Returns a ref callback that pins the element to `resolve()` each frame. */
export function useScreenAnchor(
    key: string,
    resolve: () => AnchorPoint | null,
    options: { maxDistance?: number; scaleWithDistance?: boolean } = {}
): (el: HTMLElement | null) => void {
    const resolveRef = useRef(resolve);
    resolveRef.current = resolve;
    const { maxDistance = 900, scaleWithDistance = true } = options;

    // Registration follows the ref lifecycle (React calls the ref with null on
    // unmount or when the callback identity changes). An effect cleanup here
    // would also fire during StrictMode's simulated unmount and drop live anchors.
    return useCallback(
        (el: HTMLElement | null) => {
            if (!el) {
                anchors.delete(key);
                return;
            }
            el.style.visibility = 'hidden';
            anchors.set(key, {
                el,
                resolve: () => resolveRef.current(),
                maxDistance,
                scaleWithDistance,
            });
        },
        [key, maxDistance, scaleWithDistance]
    );
}
