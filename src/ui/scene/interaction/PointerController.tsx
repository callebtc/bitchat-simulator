import React, { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useSimulation } from '../../context/SimulationContext';
import { useSelection } from '../../context/SelectionContext';
import { useCamera } from '../../context/CameraContext';
import { useTerrain } from '../../context/TerrainContext';
import { useMotion } from '../../context/MotionContext';
import { BitchatPerson } from '../../../simulation/BitchatPerson';
import { BitchatConnection } from '../../../simulation/BitchatConnection';
import { simToWorld } from '../coords';
import { arcApexHeight, arcPoint, ArcPoint } from '../network/linkArc';

/**
 * Pointer interaction in screen space.
 *
 * Perspective picking projects each device (body center) to pixels and picks
 * the nearest within `PICK_RADIUS_PX`, preferring nearer-to-camera devices on
 * ties. This is O(N) per throttled hover but avoids triangle raycasts against
 * instanced figures and works identically for 3D figures and far markers.
 *
 *  - Left click: select device / link / clear. While the chat tab's "To:"
 *    picker is active, the click picks the DM recipient instead.
 *  - Left drag on selected device: carry it (moves on the ground plane).
 *  - Right click (no drag): send selected device walking to that spot.
 *  - Left / right drag elsewhere: orbit / pan (OrbitControls).
 */

const PICK_RADIUS_PX = 16;
const LINK_PICK_RADIUS_PX = 8;
const CLICK_SLOP_PX = 5;
const HOVER_INTERVAL_MS = 33;

const _v = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();
const _a: ArcPoint = { x: 0, y: 0, z: 0 };

interface PressState {
    button: number;
    x: number;
    y: number;
    dragPersonId: string | null;
    moved: boolean;
}

export const PointerController: React.FC = () => {
    const engine = useSimulation();
    const { camera, gl, controls } = useThree();
    const selection = useSelection();
    const { mode } = useCamera();
    const { fieldRef } = useTerrain();
    const motion = useMotion();

    // Latest selection state for native listeners
    const selRef = useRef(selection);
    selRef.current = selection;
    const modeRef = useRef(mode);
    modeRef.current = mode;

    const pressRef = useRef<PressState | null>(null);
    const lastHoverRef = useRef(0);

    useEffect(() => {
        const el = gl.domElement;
        const container = el.parentElement ?? el;

        const toScreen = (x: number, y: number, z: number): { sx: number; sy: number; depth: number } | null => {
            simToWorld(x, y, z, _v);
            const depth = _v.distanceTo(camera.position);
            _v.project(camera);
            if (_v.z > 1 || _v.z < -1) return null;
            const rect = el.getBoundingClientRect();
            return {
                sx: rect.left + ((_v.x + 1) / 2) * rect.width,
                sy: rect.top + ((1 - _v.y) / 2) * rect.height,
                depth,
            };
        };

        const pickPerson = (clientX: number, clientY: number): BitchatPerson | null => {
            const people = engine.getAllPeople();
            let best: BitchatPerson | null = null;
            let bestScore = Infinity;
            const r2 = PICK_RADIUS_PX * PICK_RADIUS_PX;
            for (let i = 0; i < people.length; i++) {
                const p = people[i];
                // Test both body center and floating marker so either is clickable
                const pos = motion.positionOf(p.id, p.position);
                const gz = fieldRef.current?.sample(pos.x, pos.y) ?? 0;
                for (const z of [1.1, 2.35]) {
                    const s = toScreen(pos.x, pos.y, z + gz);
                    if (!s) continue;
                    const d2 = (s.sx - clientX) ** 2 + (s.sy - clientY) ** 2;
                    if (d2 > r2) continue;
                    const score = d2 + s.depth * 0.02;
                    if (score < bestScore) {
                        bestScore = score;
                        best = p;
                    }
                }
            }
            return best;
        };

        const pickConnection = (clientX: number, clientY: number): BitchatConnection | null => {
            const conns = engine.getAllConnections();
            let best: BitchatConnection | null = null;
            let bestD2 = LINK_PICK_RADIUS_PX * LINK_PICK_RADIUS_PX;
            for (const conn of conns) {
                const a = conn.endpointA.position;
                const b = conn.endpointB.position;
                if (!a || !b) continue;
                const apex = arcApexHeight(Math.hypot(b.x - a.x, b.y - a.y));
                const field = fieldRef.current;
                const ga = field ? field.sample(a.x, a.y) : 0;
                const gb = field ? field.sample(b.x, b.y) : 0;
                let prev: { sx: number; sy: number } | null = null;
                for (let k = 0; k <= 6; k++) {
                    arcPoint(a.x, a.y, b.x, b.y, apex, k / 6, _a, ga, gb);
                    const s = toScreen(_a.x, _a.y, _a.z);
                    if (!s) {
                        prev = null;
                        continue;
                    }
                    if (prev) {
                        const dx = s.sx - prev.sx;
                        const dy = s.sy - prev.sy;
                        const len2 = dx * dx + dy * dy;
                        let t = len2 > 0 ? ((clientX - prev.sx) * dx + (clientY - prev.sy) * dy) / len2 : 0;
                        t = Math.max(0, Math.min(1, t));
                        const px = prev.sx + dx * t - clientX;
                        const py = prev.sy + dy * t - clientY;
                        const d2 = px * px + py * py;
                        if (d2 < bestD2) {
                            bestD2 = d2;
                            best = conn;
                        }
                    }
                    prev = s;
                }
            }
            return best;
        };

        const groundPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
            const rect = el.getBoundingClientRect();
            _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
            _ray.setFromCamera(_ndc, camera);
            // Fixed-point iteration against the terrain: intersect a horizontal
            // plane at the current height estimate, resample, repeat.
            const field = fieldRef.current;
            _ground.constant = 0;
            for (let iter = 0; iter < (field ? 4 : 1); iter++) {
                if (!_ray.ray.intersectPlane(_ground, _hit)) return null;
                if (!field) break;
                _ground.constant = -field.sample(_hit.x, -_hit.z);
            }
            return { x: _hit.x, y: -_hit.z };
        };

        const setCursor = (c: string) => {
            el.style.cursor = c;
        };

        const onPointerDown = (e: PointerEvent) => {
            if (modeRef.current === 'fpv') return;
            const sel = selRef.current;
            let dragPersonId: string | null = null;
            if (e.button === 0 && sel.selectedId && sel.selectionType === 'node' && !sel.isPickingRecipient) {
                const hit = pickPerson(e.clientX, e.clientY);
                if (hit && hit.id === sel.selectedId) {
                    dragPersonId = hit.id;
                    // Block OrbitControls from starting a rotate for this gesture
                    if (controls) (controls as unknown as { enabled: boolean }).enabled = false;
                }
            }
            pressRef.current = { button: e.button, x: e.clientX, y: e.clientY, dragPersonId, moved: false };
        };

        const onPointerMove = (e: PointerEvent) => {
            const press = pressRef.current;
            const sel = selRef.current;
            if (press) {
                const moved = (e.clientX - press.x) ** 2 + (e.clientY - press.y) ** 2 > CLICK_SLOP_PX ** 2;
                if (moved && !press.moved) {
                    press.moved = true;
                    if (press.dragPersonId) sel.setDragging(true);
                }
                if (press.moved && press.dragPersonId) {
                    const person = engine.getPerson(press.dragPersonId);
                    const g = groundPoint(e.clientX, e.clientY);
                    if (person && g) {
                        person.position.x = g.x;
                        person.position.y = g.y;
                        person.setVelocity({ x: 0, y: 0 });
                        person.target = null;
                    }
                    return;
                }
                if (press.moved) return; // orbiting / panning
            }

            if (e.target !== el) return; // pointer is over HUD, not the 3D view
            const now = performance.now();
            if (now - lastHoverRef.current < HOVER_INTERVAL_MS) return;
            lastHoverRef.current = now;
            const hovered = pickPerson(e.clientX, e.clientY);
            const next = hovered ? hovered.device.peerIDHex : null;
            if (next !== sel.highlightedId) {
                sel.setHighlightedId(next);
            }
            setCursor(sel.isPickingRecipient ? 'crosshair' : next ? 'pointer' : 'grab');
        };

        const onPointerUp = (e: PointerEvent) => {
            const press = pressRef.current;
            pressRef.current = null;
            if (controls) (controls as unknown as { enabled: boolean }).enabled = modeRef.current !== 'fpv';
            const sel = selRef.current;
            if (!press) return;
            if (press.dragPersonId && press.moved) {
                sel.setDragging(false);
                return;
            }
            if (press.moved || modeRef.current === 'fpv') return;

            if (press.button === 2) {
                if (sel.selectedId && sel.selectionType === 'node') {
                    const person = engine.getPerson(sel.selectedId);
                    const g = groundPoint(e.clientX, e.clientY);
                    if (person && g) person.setTarget(g);
                }
                return;
            }
            if (press.button !== 0) return;

            const person = pickPerson(e.clientX, e.clientY);
            if (sel.isPickingRecipient) {
                if (person && person.id !== sel.selectedId) sel.setChatRecipientId(person.device.peerIDHex);
                sel.setPickingRecipient(false);
                return;
            }
            if (person) {
                // A plain click always (re)selects. DM recipients are chosen only via
                // the chat tab's "To:" picker (isPickingRecipient, handled above).
                sel.select(person.id, 'node');
                return;
            }
            const conn = pickConnection(e.clientX, e.clientY);
            sel.select(conn ? conn.id : null, conn ? 'connection' : null);
        };

        const onLeave = () => {
            const sel = selRef.current;
            if (sel.highlightedId) sel.setHighlightedId(null);
        };
        const onContextMenu = (e: MouseEvent) => e.preventDefault();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && selRef.current.isPickingRecipient) selRef.current.setPickingRecipient(false);
        };

        container.addEventListener('pointerdown', onPointerDown, { capture: true });
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        el.addEventListener('pointerleave', onLeave);
        el.addEventListener('contextmenu', onContextMenu);
        window.addEventListener('keydown', onKey);
        return () => {
            container.removeEventListener('pointerdown', onPointerDown, { capture: true });
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            el.removeEventListener('pointerleave', onLeave);
            el.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('keydown', onKey);
        };
    }, [engine, camera, gl, controls, fieldRef, motion]);

    return null;
};
