import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useSimulation } from '../../context/SimulationContext';
import { useSelection } from '../../context/SelectionContext';
import { useVisualization } from '../../context/VisualizationContext';
import { BitchatPacket, toHex } from '../../../protocol/BitchatPacket';
import { peerColor, skinTone, trouserTone } from '../palette';
import { createMarkerMaterial, MARKER_HEIGHT_M, MarkerState } from './markerMaterial';
import { useTerrain } from '../../context/TerrainContext';

/**
 * GPU-instanced pedestrians carrying BitChat phones.
 *
 * Draw calls: legs, arms, torso, head, phone screen, ground halo, plus two
 * marker passes (visible + occluded ghost) — constant regardless of crowd size.
 * Figures are rendered only inside the camera frustum and within
 * `FIGURE_LOD_M`; beyond that, screen-space markers keep every device legible.
 *
 * Gait: stride phase advances with distance walked, so leg/arm swing and head
 * bob stay physically locked to ground speed (no foot sliding).
 */

const MAX_PEOPLE = 10_000;
const FIGURE_LOD_M = 380;
const STRIDE_RAD_PER_M = 4.4; // ≈ 1.43 m per full gait cycle at walking pace
const HEADING_SMOOTHING = 10;

interface Gait {
    phase: number;
    heading: number;
    speed: number;
}

function makeCapsuleZ(radius: number, length: number, topAtOrigin: boolean): THREE.BufferGeometry {
    const g = new THREE.CapsuleGeometry(radius, length, 3, 8);
    g.rotateX(Math.PI / 2);
    if (topAtOrigin) g.translate(0, 0, -(length / 2 + radius));
    return g;
}

const _base = new THREE.Matrix4();
const _part = new THREE.Matrix4();
const _out = new THREE.Matrix4();
const _scale = new THREE.Matrix4();
const _color = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _recipient = new THREE.Color(0xe879f9);
const _camPos = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _projView = new THREE.Matrix4();
/** SimRoot model matrix (sim → world) and its inverse (world → sim). */
const _simRoot = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const _simRootInverse = new THREE.Matrix4().makeRotationX(Math.PI / 2);

function writePart(
    mesh: THREE.InstancedMesh,
    index: number,
    ox: number,
    oy: number,
    oz: number,
    pitch: number,
    sx = 1,
    sy = 1,
    sz = 1
): void {
    _part.makeRotationY(pitch);
    if (sx !== 1 || sy !== 1 || sz !== 1) {
        _scale.makeScale(sx, sy, sz);
        _part.multiply(_scale);
    }
    _part.setPosition(ox, oy, oz);
    _out.multiplyMatrices(_base, _part);
    _out.toArray(mesh.instanceMatrix.array as Float32Array, index * 16);
}

function commit(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    if (count === 0) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.addUpdateRange(0, count * 3);
        mesh.instanceColor.needsUpdate = true;
    }
}

const noopRaycast = () => null;

export const PeopleLayer: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType, chatRecipientId, highlightedId } = useSelection();
    const { highlightOwnMesh } = useVisualization();
    const { fieldRef } = useTerrain();

    const legsRef = useRef<THREE.InstancedMesh>(null);
    const armsRef = useRef<THREE.InstancedMesh>(null);
    const torsoRef = useRef<THREE.InstancedMesh>(null);
    const headRef = useRef<THREE.InstancedMesh>(null);
    const phoneRef = useRef<THREE.InstancedMesh>(null);
    const haloRef = useRef<THREE.InstancedMesh>(null);

    const gaitRef = useRef<Map<string, Gait>>(new Map());
    const flashRef = useRef<Map<string, number>>(new Map());

    const geo = useMemo(() => {
        const leg = makeCapsuleZ(0.068, 0.74, true);
        const arm = makeCapsuleZ(0.047, 0.5, true);
        const torso = makeCapsuleZ(0.165, 0.4, false);
        const head = new THREE.SphereGeometry(0.112, 12, 10);
        const phone = new THREE.BoxGeometry(0.014, 0.078, 0.158);
        const halo = new THREE.RingGeometry(0.42, 0.56, 32);
        return { leg, arm, torso, head, phone, halo };
    }, []);

    const markerData = useMemo(() => {
        const positions = new Float32Array(MAX_PEOPLE * 3);
        const colors = new Float32Array(MAX_PEOPLE * 3);
        const states = new Float32Array(MAX_PEOPLE);
        const g = new THREE.BufferGeometry();
        const pAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
        const cAttr = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
        const sAttr = new THREE.BufferAttribute(states, 1).setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('position', pAttr);
        g.setAttribute('color', cAttr);
        g.setAttribute('aState', sAttr);
        g.setDrawRange(0, 0);
        return { geometry: g, pAttr, cAttr, sAttr };
    }, []);

    const markerMaterials = useMemo(
        () => ({ visible: createMarkerMaterial(false), ghost: createMarkerMaterial(true) }),
        []
    );

    useEffect(
        () => () => {
            Object.values(geo).forEach(g => g.dispose());
            markerData.geometry.dispose();
            markerMaterials.visible.dispose();
            markerMaterials.ghost.dispose();
        },
        [geo, markerData, markerMaterials]
    );

    // Phone screens flash when their owner originates a packet
    useEffect(() => {
        const onPacket = (data: { packet: BitchatPacket; fromId: string }) => {
            const sender = toHex(data.packet.senderID);
            if (sender === data.fromId) flashRef.current.set(sender, 1);
        };
        const onReset = () => {
            gaitRef.current.clear();
            flashRef.current.clear();
        };
        engine.events.on('packet_transmitted', onPacket);
        engine.events.on('reset', onReset);
        return () => {
            engine.events.off('packet_transmitted', onPacket);
            engine.events.off('reset', onReset);
        };
    }, [engine]);

    useFrame(({ camera }, rawDelta) => {
        const delta = Math.min(rawDelta, 0.1);
        const legs = legsRef.current;
        const arms = armsRef.current;
        const torso = torsoRef.current;
        const head = headRef.current;
        const phone = phoneRef.current;
        const halo = haloRef.current;
        if (!legs || !arms || !torso || !head || !phone || !halo) return;

        const people = engine.getAllPeople();
        const n = Math.min(people.length, MAX_PEOPLE);
        const field = fieldRef.current;
        const gaits = gaitRef.current;
        const flashes = flashRef.current;
        const flashDecay = Math.exp(-4 * delta);
        const headingBlend = 1 - Math.exp(-HEADING_SMOOTHING * delta);

        // Camera position & frustum in simulation space (undo SimRoot rotation)
        _camPos.copy(camera.position).applyMatrix4(_simRootInverse);
        _projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _projView.multiply(_simRoot);
        _frustum.setFromProjectionMatrix(_projView);

        const selectedPerson =
            selectedId && selectionType === 'node' ? engine.getPerson(selectedId) : undefined;
        const isFocusMode = highlightOwnMesh && selectedId !== null;

        const mPos = markerData.pAttr.array as Float32Array;
        const mCol = markerData.cAttr.array as Float32Array;
        const mState = markerData.sAttr.array as Float32Array;

        let fig = 0;
        const lodSq = FIGURE_LOD_M * FIGURE_LOD_M;

        for (let i = 0; i < n; i++) {
            const person = people[i];
            const peerHex = person.device.peerIDHex;
            const px = person.position.x;
            const py = person.position.y;
            const vx = person.velocity.x;
            const vy = person.velocity.y;
            const speed = Math.sqrt(vx * vx + vy * vy);
            const gz = field ? field.sample(px, py) : 0;

            let gait = gaits.get(person.id);
            if (!gait) {
                gait = { phase: (i * 1.37) % (Math.PI * 2), heading: Math.atan2(vy, vx) || 0, speed };
                gaits.set(person.id, gait);
            }
            gait.speed += (speed - gait.speed) * headingBlend;
            if (speed > 0.05) {
                const target = Math.atan2(vy, vx);
                let d = target - gait.heading;
                d = Math.atan2(Math.sin(d), Math.cos(d));
                gait.heading += d * headingBlend;
            }
            gait.phase += gait.speed * STRIDE_RAD_PER_M * delta;

            let flash = flashes.size > 0 ? flashes.get(peerHex) ?? 0 : 0;
            if (flash > 0) {
                flash *= flashDecay;
                if (flash < 0.02) {
                    flashes.delete(peerHex);
                    flash = 0;
                } else {
                    flashes.set(peerHex, flash);
                }
            }

            const isSelected = selectedPerson?.id === person.id;
            const isRecipient = chatRecipientId === peerHex;
            const isHovered = highlightedId === peerHex;
            const isDimmed = isFocusMode && !isSelected && !isRecipient && !isHovered;
            const baseColor = peerColor(peerHex);

            // --- Marker (always written; shader fades it near the camera) ---
            mPos[i * 3] = px;
            mPos[i * 3 + 1] = py;
            mPos[i * 3 + 2] = MARKER_HEIGHT_M + gz;
            if (isDimmed) {
                _color.copy(baseColor).multiplyScalar(0.3);
            } else {
                _color.copy(baseColor);
            }
            mCol[i * 3] = _color.r;
            mCol[i * 3 + 1] = _color.g;
            mCol[i * 3 + 2] = _color.b;
            mState[i] = isSelected
                ? MarkerState.Selected
                : isRecipient
                  ? MarkerState.Recipient
                  : isHovered
                    ? MarkerState.Hovered
                    : isDimmed
                      ? MarkerState.Dimmed
                      : flash > 0.4
                        ? MarkerState.Transmitting
                        : MarkerState.Normal;

            // --- Figure LOD + frustum culling ---
            const dx = px - _camPos.x;
            const dy = py - _camPos.y;
            if (dx * dx + dy * dy > lodSq && !isSelected && !isRecipient) continue;
            _sphere.center.set(px, py, gz + 1);
            _sphere.radius = 1.2;
            if (!_frustum.intersectsSphere(_sphere)) continue;

            const stride = Math.min(1, gait.speed / 1.4);
            const swing = Math.sin(gait.phase) * 0.55 * stride;
            const bob = Math.abs(Math.cos(gait.phase)) * 0.035 * stride;

            _base.makeRotationZ(gait.heading);
            _base.setPosition(px, py, gz + bob);

            writePart(legs, fig * 2, 0, 0.095, 0.9, swing);
            writePart(legs, fig * 2 + 1, 0, -0.095, 0.9, -swing);
            // Left arm swings opposite the left leg; right arm holds the phone up
            writePart(arms, fig * 2, 0, 0.215, 1.45, -swing * 0.8);
            writePart(arms, fig * 2 + 1, 0.02, -0.2, 1.45, -1.05 + swing * 0.08);
            writePart(torso, fig, 0, 0, 1.2, 0, 0.72, 1, 1);
            writePart(head, fig, 0.01, 0, 1.66, 0);
            writePart(phone, fig, 0.36, -0.15, 1.2, 0.55);
            writePart(halo, fig, 0, 0, 0.03 - bob, 0, isSelected || isRecipient ? 1.7 : isHovered ? 1.35 : 1);

            const shirt = isDimmed ? _color.copy(baseColor).multiplyScalar(0.35) : baseColor;
            torso.setColorAt(fig, shirt);
            arms.setColorAt(fig * 2, shirt);
            arms.setColorAt(fig * 2 + 1, shirt);
            const trousers = trouserTone(peerHex);
            legs.setColorAt(fig * 2, trousers);
            legs.setColorAt(fig * 2 + 1, trousers);
            head.setColorAt(fig, skinTone(peerHex));

            _color.copy(baseColor).lerp(_white, 0.35).multiplyScalar(1.2 + flash * 4);
            phone.setColorAt(fig, _color);

            if (isSelected) _color.copy(_white).multiplyScalar(1.3);
            else if (isRecipient) _color.copy(_recipient).multiplyScalar(1.3);
            else if (isHovered) _color.copy(baseColor).multiplyScalar(1.5);
            else _color.copy(baseColor).multiplyScalar(isDimmed ? 0.25 : 0.9 + flash * 2);
            halo.setColorAt(fig, _color);

            fig++;
        }

        commit(legs, fig * 2);
        commit(arms, fig * 2);
        commit(torso, fig);
        commit(head, fig);
        commit(phone, fig);
        commit(halo, fig);

        markerData.geometry.setDrawRange(0, n);
        if (n > 0) {
            for (const attr of [markerData.pAttr, markerData.cAttr, markerData.sAttr]) {
                attr.clearUpdateRanges();
                attr.addUpdateRange(0, n * attr.itemSize);
                attr.needsUpdate = true;
            }
        }
    });

    return (
        <group name="people-layer">
            <instancedMesh
                ref={legsRef}
                args={[geo.leg, undefined, MAX_PEOPLE * 2]}
                frustumCulled={false}
                castShadow
                raycast={noopRaycast}
            >
                <meshStandardMaterial roughness={0.9} />
            </instancedMesh>
            <instancedMesh
                ref={armsRef}
                args={[geo.arm, undefined, MAX_PEOPLE * 2]}
                frustumCulled={false}
                castShadow
                raycast={noopRaycast}
            >
                <meshStandardMaterial roughness={0.75} />
            </instancedMesh>
            <instancedMesh
                ref={torsoRef}
                args={[geo.torso, undefined, MAX_PEOPLE]}
                frustumCulled={false}
                castShadow
                raycast={noopRaycast}
            >
                <meshStandardMaterial roughness={0.7} />
            </instancedMesh>
            <instancedMesh
                ref={headRef}
                args={[geo.head, undefined, MAX_PEOPLE]}
                frustumCulled={false}
                castShadow
                raycast={noopRaycast}
            >
                <meshStandardMaterial roughness={0.6} />
            </instancedMesh>
            <instancedMesh
                ref={phoneRef}
                args={[geo.phone, undefined, MAX_PEOPLE]}
                frustumCulled={false}
                raycast={noopRaycast}
            >
                <meshBasicMaterial toneMapped={false} />
            </instancedMesh>
            <instancedMesh
                ref={haloRef}
                args={[geo.halo, undefined, MAX_PEOPLE]}
                frustumCulled={false}
                raycast={noopRaycast}
                renderOrder={2}
            >
                <meshBasicMaterial
                    toneMapped={false}
                    transparent
                    opacity={0.9}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                />
            </instancedMesh>
            <points
                geometry={markerData.geometry}
                material={markerMaterials.ghost}
                frustumCulled={false}
                raycast={noopRaycast}
                renderOrder={20}
            />
            <points
                geometry={markerData.geometry}
                material={markerMaterials.visible}
                frustumCulled={false}
                raycast={noopRaycast}
                renderOrder={21}
            />
        </group>
    );
};
