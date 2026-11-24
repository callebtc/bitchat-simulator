import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import { useSimulation } from '../../context/SimulationContext';
import { useSelection } from '../../context/SelectionContext';
import { useCamera } from '../../context/CameraContext';
import { useTerrain } from '../../context/TerrainContext';
import { DEVICE_HEIGHT_M, EYE_HEIGHT_M, simToWorld, worldHeading } from '../coords';

/**
 * Camera controller.
 *
 * Mouse (free / follow / chase): left-drag orbit, right-drag pan,
 * wheel zoom toward cursor. Keyboard: WASD pan relative to view, Q/E orbit,
 * R/F zoom, Shift = fast. First-person: drag to look around.
 *
 * Follow modes translate the orbit target and camera together so the user's
 * chosen angle and distance are preserved while tracking a moving device.
 */

const FLY_DURATION_S = 0.9;
const CHASE_DISTANCE_M = 9;
const CHASE_HEIGHT_M = 4.2;
const MIN_POLAR = 0.05;
const MAX_POLAR = 1.5;

interface FlyState {
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromCam: THREE.Vector3;
    toCam: THREE.Vector3;
    t: number;
}

const _personWorld = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _spherical = new THREE.Spherical();

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const CameraRig: React.FC = () => {
    const engine = useSimulation();
    const { camera, gl, size } = useThree();
    const { focusRequest, isDragging, viewCenterRef } = useSelection();
    const { mode, followId, release, telemetryRef, resetNonce } = useCamera();
    const { heightAt } = useTerrain();

    const controlsRef = useRef<OrbitControlsImpl>(null);
    const keysRef = useRef<Set<string>>(new Set());
    const flyRef = useRef<FlyState | null>(null);
    const lastFocusNonce = useRef(0);
    const headingRef = useRef(0);
    const userInteractingUntil = useRef(0);
    const fpvLook = useRef({ yaw: 0, pitch: -0.12, dragging: false, lastX: 0, lastY: 0 });

    // Initial establishing shot
    useEffect(() => {
        camera.position.set(170, 210, 250);
        camera.lookAt(0, 0, 0);
    }, [camera]);

    // Keyboard navigation
    useEffect(() => {
        const isTyping = (e: KeyboardEvent) =>
            e.target instanceof HTMLInputElement ||
            e.target instanceof HTMLTextAreaElement ||
            e.target instanceof HTMLSelectElement;
        const down = (e: KeyboardEvent) => {
            if (isTyping(e) || e.metaKey || e.ctrlKey) return;
            const k = e.key.toLowerCase();
            if (['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'shift'].includes(k)) keysRef.current.add(k);
        };
        const up = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase());
        const blur = () => keysRef.current.clear();
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        window.addEventListener('blur', blur);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
            window.removeEventListener('blur', blur);
        };
    }, []);

    // First-person mouse look
    useEffect(() => {
        if (mode !== 'fpv') return;
        const el = gl.domElement;
        const look = fpvLook.current;
        look.yaw = 0;
        look.pitch = -0.12;
        const onDown = (e: PointerEvent) => {
            look.dragging = true;
            look.lastX = e.clientX;
            look.lastY = e.clientY;
        };
        const onMove = (e: PointerEvent) => {
            if (!look.dragging) return;
            look.yaw -= (e.clientX - look.lastX) * 0.004;
            look.pitch = THREE.MathUtils.clamp(look.pitch - (e.clientY - look.lastY) * 0.004, -1.2, 1.0);
            look.lastX = e.clientX;
            look.lastY = e.clientY;
        };
        const onUp = () => {
            look.dragging = false;
        };
        el.addEventListener('pointerdown', onDown);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            el.removeEventListener('pointerdown', onDown);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [mode, gl]);

    // Track manual orbit interaction so chase mode doesn't fight the user
    useEffect(() => {
        const c = controlsRef.current;
        if (!c) return;
        const onStart = () => {
            userInteractingUntil.current = Infinity;
        };
        const onEnd = () => {
            userInteractingUntil.current = performance.now() + 1800;
        };
        c.addEventListener('start', onStart);
        c.addEventListener('end', onEnd);
        return () => {
            c.removeEventListener('start', onStart);
            c.removeEventListener('end', onEnd);
        };
    }, []);

    // Leaving first-person: back the camera out behind the person
    const prevMode = useRef(mode);
    useEffect(() => {
        const c = controlsRef.current;
        if (prevMode.current === 'fpv' && mode !== 'fpv' && c) {
            _forward.set(Math.sin(headingRef.current), 0, -Math.cos(headingRef.current));
            camera.position.copy(c.target).addScaledVector(_forward, -18).add(new THREE.Vector3(0, 10, 0));
            camera.up.set(0, 1, 0);
        }
        prevMode.current = mode;
    }, [mode, camera]);

    // Release follow when the target disappears
    useEffect(() => {
        if (!followId) return;
        const onRemoved = (id: string) => {
            if (id === followId) release();
        };
        engine.events.on('person_removed', onRemoved);
        engine.events.on('reset', release);
        return () => {
            engine.events.off('person_removed', onRemoved);
            engine.events.off('reset', release);
        };
    }, [engine, followId, release]);

    const startFly = (toTarget: THREE.Vector3, distance?: number, elevation?: number) => {
        const c = controlsRef.current;
        if (!c) return;
        const dir = _offset.copy(camera.position).sub(c.target);
        const dist = distance ?? dir.length();
        dir.normalize();
        if (elevation !== undefined) {
            // Keep the current compass heading but force a fixed viewing elevation
            const az = Math.atan2(dir.x, dir.z);
            dir.set(Math.sin(az) * Math.cos(elevation), Math.sin(elevation), Math.cos(az) * Math.cos(elevation));
        } else if (dir.y > 0.97) {
            // Keep a pleasant oblique angle when arriving from straight overhead
            dir.set(0.35, 0.85, 0.4).normalize();
        }
        flyRef.current = {
            fromTarget: c.target.clone(),
            toTarget: toTarget.clone(),
            fromCam: camera.position.clone(),
            toCam: toTarget.clone().addScaledVector(dir, dist),
            t: 0,
        };
    };

    // External focus requests (e.g. "frame DM pair")
    useEffect(() => {
        if (!focusRequest || focusRequest.nonce === lastFocusNonce.current) return;
        lastFocusNonce.current = focusRequest.nonce;
        if (mode !== 'free') release();
        startFly(
            simToWorld(focusRequest.x, focusRequest.y, heightAt(focusRequest.x, focusRequest.y), new THREE.Vector3()),
            focusRequest.distance
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusRequest]);

    // Reset to an overview of the whole scene
    useEffect(() => {
        if (resetNonce === 0) return;
        const people = engine.getAllPeople();
        const bounds = engine.environment.getBounds()?.localBounds;
        let cx = 0;
        let cy = 0;
        let span = 200;
        if (bounds) {
            cx = (bounds.minX + bounds.maxX) / 2;
            cy = (bounds.minY + bounds.maxY) / 2;
            span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
        } else if (people.length) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const p of people) {
                minX = Math.min(minX, p.position.x);
                maxX = Math.max(maxX, p.position.x);
                minY = Math.min(minY, p.position.y);
                maxY = Math.max(maxY, p.position.y);
            }
            cx = (minX + maxX) / 2;
            cy = (minY + maxY) / 2;
            span = Math.max(maxX - minX, maxY - minY, 120);
        }
        // Frame the core of the capture area; OSM extents overshoot the requested radius
        startFly(simToWorld(cx, cy, heightAt(cx, cy), new THREE.Vector3()), Math.min(span * 0.85, 900) + 60, 0.92);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetNonce]);

    // Hand control back to orbit when a follow mode begins
    useEffect(() => {
        if (mode !== 'free') flyRef.current = null;
        if (mode === 'chase') userInteractingUntil.current = 0;
        if (mode === 'follow' && followId) {
            const person = engine.getPerson(followId);
            const c = controlsRef.current;
            if (person && c) {
                const dist = camera.position.distanceTo(c.target);
                startFly(
                    simToWorld(
                        person.position.x,
                        person.position.y,
                        DEVICE_HEIGHT_M + heightAt(person.position.x, person.position.y),
                        new THREE.Vector3()
                    ),
                    Math.min(dist, 60)
                );
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, followId]);

    useFrame((_, rawDelta) => {
        const delta = Math.min(rawDelta, 0.1);
        const c = controlsRef.current;
        if (!c) return;
        const keys = keysRef.current;
        const target = c.target;

        // ---- Fly-to animation ----
        const fly = flyRef.current;
        if (fly) {
            fly.t = Math.min(1, fly.t + delta / FLY_DURATION_S);
            const k = easeInOut(fly.t);
            target.lerpVectors(fly.fromTarget, fly.toTarget, k);
            camera.position.lerpVectors(fly.fromCam, fly.toCam, k);
            if (fly.t >= 1) flyRef.current = null;
        }

        // ---- Follow / chase / FPV ----
        const person = followId && mode !== 'free' ? engine.getPerson(followId) : undefined;
        if (person) {
            const v = person.velocity;
            const speed = Math.hypot(v.x, v.y);
            if (speed > 0.08) {
                // Compass heading from simulation velocity (0 = north, clockwise)
                const h = Math.atan2(v.x, v.y);
                let d = h - headingRef.current;
                d = Math.atan2(Math.sin(d), Math.cos(d));
                headingRef.current += d * (1 - Math.exp(-4 * delta));
            }
            const heading = headingRef.current;

            if (mode === 'fpv') {
                c.enabled = false;
                simToWorld(person.position.x, person.position.y, EYE_HEIGHT_M + heightAt(person.position.x, person.position.y), _personWorld);
                const look = fpvLook.current;
                const yaw = heading + look.yaw;
                _forward.set(Math.sin(yaw) * Math.cos(look.pitch), Math.sin(look.pitch), -Math.cos(yaw) * Math.cos(look.pitch));
                camera.position.copy(_personWorld).addScaledVector(_forward, 0.12);
                _look.copy(camera.position).add(_forward);
                camera.lookAt(_look);
                target.copy(_personWorld).addScaledVector(_forward, 5);
                if (flyRef.current) flyRef.current = null;
            } else {
                c.enabled = !isDragging;
                simToWorld(
                    person.position.x,
                    person.position.y,
                    DEVICE_HEIGHT_M + heightAt(person.position.x, person.position.y),
                    _personWorld
                );
                const activeFly = flyRef.current;
                if (!activeFly) {
                    _delta.copy(_personWorld).sub(target).multiplyScalar(1 - Math.exp(-10 * delta));
                    target.add(_delta);
                    camera.position.add(_delta);
                } else {
                    activeFly.toTarget.copy(_personWorld);
                }
                if (mode === 'chase' && performance.now() > userInteractingUntil.current && !flyRef.current) {
                    _forward.set(Math.sin(heading), 0, -Math.cos(heading));
                    _desired
                        .copy(target)
                        .addScaledVector(_forward, -CHASE_DISTANCE_M)
                        .add(_offset.set(0, CHASE_HEIGHT_M, 0));
                    camera.position.lerp(_desired, 1 - Math.exp(-3 * delta));
                }
            }
        } else {
            c.enabled = !isDragging;
        }

        // ---- Keyboard flight (free & follow modes) ----
        if (keys.size > 0 && mode !== 'fpv') {
            const fast = keys.has('shift') ? 3 : 1;
            const dist = camera.position.distanceTo(target);
            const panSpeed = Math.max(12, dist * 0.9) * fast * delta;
            camera.getWorldDirection(_forward);
            _forward.y = 0;
            _forward.normalize();
            _right.crossVectors(_forward, camera.up).normalize();
            _delta.set(0, 0, 0);
            if (keys.has('w')) _delta.add(_forward);
            if (keys.has('s')) _delta.sub(_forward);
            if (keys.has('d')) _delta.add(_right);
            if (keys.has('a')) _delta.sub(_right);
            if (_delta.lengthSq() > 0) {
                if (mode !== 'free') release();
                flyRef.current = null;
                _delta.normalize().multiplyScalar(panSpeed);
                target.add(_delta);
                camera.position.add(_delta);
            }
            const orbit = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0);
            const zoom = (keys.has('f') ? 1 : 0) - (keys.has('r') ? 1 : 0);
            if (orbit !== 0 || zoom !== 0) {
                _offset.copy(camera.position).sub(target);
                _spherical.setFromVector3(_offset);
                _spherical.theta += orbit * 1.4 * fast * delta;
                _spherical.radius = THREE.MathUtils.clamp(
                    _spherical.radius * Math.exp(zoom * 1.6 * fast * delta),
                    2,
                    5000
                );
                _offset.setFromSpherical(_spherical);
                camera.position.copy(target).add(_offset);
            }
        }

        if (mode !== 'fpv') c.update();

        // ---- Telemetry for HUD (compass / scale) ----
        const tel = telemetryRef.current;
        const dist = camera.position.distanceTo(target);
        tel.distance = dist;
        tel.heading = worldHeading(camera.position, target);
        tel.pitch = Math.asin(THREE.MathUtils.clamp((camera.position.y - target.y) / Math.max(dist, 1e-3), -1, 1));
        const persp = camera as THREE.PerspectiveCamera;
        const viewHeightAtTarget = 2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2);
        tel.metersPer100px = (viewHeightAtTarget / Math.max(size.height, 1)) * 100;
        tel.targetX = target.x;
        tel.targetY = -target.z;
        viewCenterRef.current.x = tel.targetX;
        viewCenterRef.current.y = tel.targetY;
    });

    return (
        <OrbitControls
            ref={controlsRef}
            makeDefault
            enableDamping
            dampingFactor={0.09}
            minDistance={2}
            maxDistance={5000}
            minPolarAngle={MIN_POLAR}
            maxPolarAngle={MAX_POLAR}
            zoomToCursor
            screenSpacePanning={false}
            rotateSpeed={0.55}
            zoomSpeed={1.1}
            panSpeed={1.0}
            mouseButtons={{
                LEFT: THREE.MOUSE.ROTATE,
                MIDDLE: THREE.MOUSE.DOLLY,
                RIGHT: THREE.MOUSE.PAN,
            }}
        />
    );
};
