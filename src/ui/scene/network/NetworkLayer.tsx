import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useSimulation } from '../../context/SimulationContext';
import { useSelection } from '../../context/SelectionContext';
import { useVisualization } from '../../context/VisualizationContext';
import { BitchatConnection } from '../../../simulation/BitchatConnection';
import { BitchatConnectionBLE, RSSI_CONFIG } from '../../../simulation/BitchatConnectionBLE';
import { BitchatConnectionWifiAware } from '../../../simulation/BitchatConnectionWifiAware';
import { BitchatAppSimulator } from '../../../simulation/AppLayer/BitchatAppSimulator';
import { BitchatPacket, MessageType, toHex } from '../../../protocol/BitchatPacket';
import { packetColorHex, writeRssiColor } from '../palette';
import { arcApexHeight, arcPoint, ArcPoint } from './linkArc';
import { useTerrain } from '../../context/TerrainContext';

/**
 * Radio network visualization:
 *  - BLE + Wi-Fi Aware links as arcs (2 draw calls, adaptive tessellation
 *    so 30k+ links stay inside a fixed vertex budget)
 *  - packets in flight riding the arcs (1 instanced draw call)
 *  - radio ripples expanding from transmitting devices to the nominal BLE
 *    range (1 instanced draw call)
 */

const SEGMENT_BUDGET = 240_000;
const MAX_ARC_SEGMENTS = 14;
const MAX_PACKETS = 4096;
const MAX_RIPPLES = 192;
const PACKET_SPEED_MPS = 110;
const RIPPLE_DURATION_S = 0.9;
/** Distance at which free-space BLE RSSI reaches the disconnect threshold (log-distance model). */
const NOMINAL_BLE_RANGE_M = Math.pow(
    10,
    (RSSI_CONFIG.AT_1M - RSSI_CONFIG.DISCONNECT_THRESHOLD) / (10 * RSSI_CONFIG.PATH_LOSS_EXPONENT)
);

const noopRaycast = () => null;
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _dim = new THREE.Color(0x141a24);
const _known = new THREE.Color(0x22d3ee);
const _unknown = new THREE.Color(0x4b5563);
const _focus = new THREE.Color(0xfde047);
const _wifi = new THREE.Color(0xb46cff);
const _p0: ArcPoint = { x: 0, y: 0, z: 0 };
const _p1: ArcPoint = { x: 0, y: 0, z: 0 };
const _m = new THREE.Matrix4();

interface PacketPool {
    active: Uint8Array;
    progress: Float32Array;
    forward: Uint8Array;
    color: Float32Array;
    scale: Float32Array;
    conn: Array<BitchatConnection | null>;
    sender: string[];
    cursor: number;
    live: number;
}

interface RipplePool {
    age: Float32Array;
    x: Float32Array;
    y: Float32Array;
    color: Float32Array;
    cursor: number;
}

function createPacketPool(): PacketPool {
    return {
        active: new Uint8Array(MAX_PACKETS),
        progress: new Float32Array(MAX_PACKETS),
        forward: new Uint8Array(MAX_PACKETS),
        color: new Float32Array(MAX_PACKETS * 3),
        scale: new Float32Array(MAX_PACKETS),
        conn: new Array<BitchatConnection | null>(MAX_PACKETS).fill(null),
        sender: new Array<string>(MAX_PACKETS).fill(''),
        cursor: 0,
        live: 0,
    };
}

function createRipplePool(): RipplePool {
    return {
        age: new Float32Array(MAX_RIPPLES).fill(RIPPLE_DURATION_S),
        x: new Float32Array(MAX_RIPPLES),
        y: new Float32Array(MAX_RIPPLES),
        color: new Float32Array(MAX_RIPPLES * 3),
        cursor: 0,
    };
}

function makeLineBuffers(maxSegments: number) {
    const geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(maxSegments * 6), 3).setUsage(
        THREE.DynamicDrawUsage
    );
    const col = new THREE.BufferAttribute(new Float32Array(maxSegments * 6), 3).setUsage(
        THREE.DynamicDrawUsage
    );
    geometry.setAttribute('position', pos);
    geometry.setAttribute('color', col);
    geometry.setDrawRange(0, 0);
    return { geometry, pos, col };
}

function flush(attr: THREE.BufferAttribute, count: number): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count);
    attr.needsUpdate = true;
}

export const NetworkLayer: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType } = useSelection();
    const { showAnnouncePackets, highlightOwnMesh, showLinks, showRadioPulses } = useVisualization();
    const { fieldRef } = useTerrain();

    const packetMeshRef = useRef<THREE.InstancedMesh>(null);
    const rippleMeshRef = useRef<THREE.InstancedMesh>(null);
    const packetsRef = useRef<PacketPool>(createPacketPool());
    const ripplesRef = useRef<RipplePool>(createRipplePool());

    const flagsRef = useRef({ showAnnouncePackets, showRadioPulses });
    flagsRef.current.showAnnouncePackets = showAnnouncePackets;
    flagsRef.current.showRadioPulses = showRadioPulses;

    const buffers = useMemo(() => {
        const ble = makeLineBuffers(SEGMENT_BUDGET);
        const wifi = makeLineBuffers(SEGMENT_BUDGET / 4);
        const packetGeo = new THREE.IcosahedronGeometry(0.34, 1);
        const rippleGeo = new THREE.RingGeometry(0.93, 1.0, 72);
        return { ble, wifi, packetGeo, rippleGeo };
    }, []);

    useEffect(
        () => () => {
            buffers.ble.geometry.dispose();
            buffers.wifi.geometry.dispose();
            buffers.packetGeo.dispose();
            buffers.rippleGeo.dispose();
        },
        [buffers]
    );

    useEffect(() => {
        const onPacket = (data: { connectionId: string; packet: BitchatPacket; fromId: string }) => {
            const packet = data.packet;
            const isAnnounce = packet.type === MessageType.ANNOUNCE;
            if (isAnnounce && !flagsRef.current.showAnnouncePackets) return;
            const conn = engine.getConnectionById(data.connectionId);
            if (!conn) return;

            const sender = toHex(packet.senderID);
            const isRelay = sender !== data.fromId;
            _c.setHex(packetColorHex(packet));

            const pool = packetsRef.current;
            const slot = pool.cursor;
            pool.cursor = (slot + 1) % MAX_PACKETS;
            if (!pool.active[slot]) pool.live++;
            pool.active[slot] = 1;
            pool.progress[slot] = 0;
            pool.forward[slot] = data.fromId === conn.endpointA.peerIDHex ? 1 : 0;
            const boost = isRelay ? 2.2 : 4.5; // HDR so packets bloom even in daylight
            pool.color[slot * 3] = _c.r * boost;
            pool.color[slot * 3 + 1] = _c.g * boost;
            pool.color[slot * 3 + 2] = _c.b * boost;
            pool.scale[slot] = isRelay ? 0.7 : 1.15;
            pool.conn[slot] = conn;
            pool.sender[slot] = sender;

            // One ripple per originated transmission burst (dedupe fan-out to N links)
            if (!isRelay && flagsRef.current.showRadioPulses) {
                const origin = engine.getPersonByPeerId(sender);
                if (!origin) return;
                const rp = ripplesRef.current;
                const last = (rp.cursor - 1 + MAX_RIPPLES) % MAX_RIPPLES;
                if (
                    rp.age[last] < 0.05 &&
                    rp.x[last] === origin.position.x &&
                    rp.y[last] === origin.position.y
                ) {
                    return;
                }
                const r = rp.cursor;
                rp.cursor = (r + 1) % MAX_RIPPLES;
                rp.age[r] = 0;
                rp.x[r] = origin.position.x;
                rp.y[r] = origin.position.y;
                const k = isAnnounce ? 0.35 : 1.1;
                rp.color[r * 3] = _c.r * k;
                rp.color[r * 3 + 1] = _c.g * k;
                rp.color[r * 3 + 2] = _c.b * k;
            }
        };
        const onReset = () => {
            packetsRef.current = createPacketPool();
            ripplesRef.current = createRipplePool();
        };
        engine.events.on('packet_transmitted', onPacket);
        engine.events.on('reset', onReset);
        return () => {
            engine.events.off('packet_transmitted', onPacket);
            engine.events.off('reset', onReset);
        };
    }, [engine]);

    useFrame((_, rawDelta) => {
        const delta = Math.min(rawDelta, 0.1);
        const connections = engine.getAllConnections();
        const field = fieldRef.current;
        const selectedPerson =
            selectedId && selectionType === 'node' ? engine.getPerson(selectedId) : undefined;
        const selectedSim = selectedPerson?.device.appSimulator as BitchatAppSimulator | undefined;
        const graphMode = Boolean(selectedPerson && highlightOwnMesh && selectedSim?.meshGraph);
        const focusMode = highlightOwnMesh && selectedId !== null;

        // ---------------- Links ----------------
        const blePos = buffers.ble.pos.array as Float32Array;
        const bleCol = buffers.ble.col.array as Float32Array;
        const wifiPos = buffers.wifi.pos.array as Float32Array;
        const wifiCol = buffers.wifi.col.array as Float32Array;
        let bleV = 0;
        let wifiV = 0;
        const bleMaxV = SEGMENT_BUDGET * 2;
        const wifiMaxV = (SEGMENT_BUDGET / 4) * 2;

        if (showLinks) {
            const segs = Math.max(
                1,
                Math.min(MAX_ARC_SEGMENTS, Math.floor(SEGMENT_BUDGET / Math.max(1, connections.length)))
            );

            for (let i = 0; i < connections.length; i++) {
                const conn = connections[i];
                const a = conn.endpointA.position;
                const b = conn.endpointB.position;
                if (!a || !b) continue;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const apex = arcApexHeight(Math.sqrt(dx * dx + dy * dy));
                const isWifi = conn instanceof BitchatConnectionWifiAware;

                const involvesFocus =
                    selectedId === conn.id ||
                    (selectedPerson ? conn.involves(selectedPerson.device) : false);

                // Colors for the A-half and B-half of the arc
                let colA: THREE.Color;
                let colB: THREE.Color;
                if (graphMode && selectedSim && selectedId !== conn.id) {
                    const ab = selectedSim.meshGraph.hasNeighbor(
                        conn.endpointA.peerIDHex,
                        conn.endpointB.peerIDHex
                    );
                    const ba = selectedSim.meshGraph.hasNeighbor(
                        conn.endpointB.peerIDHex,
                        conn.endpointA.peerIDHex
                    );
                    if (!ab && !ba) {
                        colA = colB = _dim;
                    } else {
                        colA = ab ? _known : _unknown;
                        colB = ba ? _known : _unknown;
                    }
                } else if (involvesFocus) {
                    colA = colB = _focus;
                } else if (focusMode) {
                    colA = colB = _dim;
                } else if (isWifi) {
                    colA = colB = _wifi;
                } else if (conn instanceof BitchatConnectionBLE) {
                    colA = colB = writeRssiColor(conn.rssi, _c2);
                } else {
                    colA = colB = _c2.setHex(0x22c55e);
                }

                const pos = isWifi ? wifiPos : blePos;
                const col = isWifi ? wifiCol : bleCol;
                let v = isWifi ? wifiV : bleV;
                if (v + segs * 2 > (isWifi ? wifiMaxV : bleMaxV)) continue;

                const ga = field ? field.sample(a.x, a.y) : 0;
                const gb = field ? field.sample(b.x, b.y) : 0;
                arcPoint(a.x, a.y, b.x, b.y, apex, 0, _p0, ga, gb);
                for (let s = 1; s <= segs; s++) {
                    arcPoint(a.x, a.y, b.x, b.y, apex, s / segs, _p1, ga, gb);
                    const c = s * 2 <= segs ? colA : colB;
                    const o = v * 3;
                    pos[o] = _p0.x;
                    pos[o + 1] = _p0.y;
                    pos[o + 2] = _p0.z;
                    pos[o + 3] = _p1.x;
                    pos[o + 4] = _p1.y;
                    pos[o + 5] = _p1.z;
                    col[o] = c.r;
                    col[o + 1] = c.g;
                    col[o + 2] = c.b;
                    col[o + 3] = c.r;
                    col[o + 4] = c.g;
                    col[o + 5] = c.b;
                    v += 2;
                    _p0.x = _p1.x;
                    _p0.y = _p1.y;
                    _p0.z = _p1.z;
                }
                if (isWifi) wifiV = v;
                else bleV = v;
            }
        }

        buffers.ble.geometry.setDrawRange(0, bleV);
        buffers.wifi.geometry.setDrawRange(0, wifiV);
        if (bleV) {
            flush(buffers.ble.pos, bleV * 3);
            flush(buffers.ble.col, bleV * 3);
        }
        if (wifiV) {
            flush(buffers.wifi.pos, wifiV * 3);
            flush(buffers.wifi.col, wifiV * 3);
        }

        // ---------------- Packets ----------------
        const pktMesh = packetMeshRef.current;
        if (pktMesh) {
            const pool = packetsRef.current;
            const mats = pktMesh.instanceMatrix.array as Float32Array;
            let visible = 0;
            if (pool.live > 0) {
                for (let i = 0; i < MAX_PACKETS; i++) {
                    if (!pool.active[i]) continue;
                    const conn = pool.conn[i];
                    const a = conn?.endpointA.position;
                    const b = conn?.endpointB.position;
                    if (!conn || !conn.isActive || !a || !b) {
                        pool.active[i] = 0;
                        pool.conn[i] = null;
                        pool.live--;
                        continue;
                    }
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const rate = Math.min(4, PACKET_SPEED_MPS / Math.max(dist, 1));
                    const prog = pool.progress[i] + rate * delta;
                    if (prog >= 1) {
                        pool.active[i] = 0;
                        pool.conn[i] = null;
                        pool.live--;
                        continue;
                    }
                    pool.progress[i] = prog;
                    if (focusMode && selectedPerson && pool.sender[i] !== selectedPerson.device.peerIDHex) {
                        continue;
                    }
                    const t = pool.forward[i] ? prog : 1 - prog;
                    arcPoint(
                        a.x,
                        a.y,
                        b.x,
                        b.y,
                        arcApexHeight(dist),
                        t,
                        _p0,
                        field ? field.sample(a.x, a.y) : 0,
                        field ? field.sample(b.x, b.y) : 0
                    );
                    const sc = pool.scale[i];
                    _m.makeScale(sc, sc, sc).setPosition(_p0.x, _p0.y, _p0.z);
                    _m.toArray(mats, visible * 16);
                    _c.setRGB(pool.color[i * 3], pool.color[i * 3 + 1], pool.color[i * 3 + 2]);
                    pktMesh.setColorAt(visible, _c);
                    visible++;
                }
            }
            pktMesh.count = visible;
            if (visible) {
                flush(pktMesh.instanceMatrix, visible * 16);
                if (pktMesh.instanceColor) flush(pktMesh.instanceColor, visible * 3);
            }
        }

        // ---------------- Ripples ----------------
        const ripMesh = rippleMeshRef.current;
        if (ripMesh) {
            const rp = ripplesRef.current;
            const mats = ripMesh.instanceMatrix.array as Float32Array;
            let visible = 0;
            for (let i = 0; i < MAX_RIPPLES; i++) {
                if (rp.age[i] >= RIPPLE_DURATION_S) continue;
                rp.age[i] += delta;
                const t = Math.min(1, rp.age[i] / RIPPLE_DURATION_S);
                const eased = 1 - Math.pow(1 - t, 2.2);
                const radius = 0.5 + eased * NOMINAL_BLE_RANGE_M;
                const gz = field ? field.sample(rp.x[i], rp.y[i]) : 0;
                _m.makeScale(radius, radius, 1).setPosition(rp.x[i], rp.y[i], gz + 0.22);
                _m.toArray(mats, visible * 16);
                const fade = (1 - t) * (1 - t);
                _c.setRGB(rp.color[i * 3] * fade, rp.color[i * 3 + 1] * fade, rp.color[i * 3 + 2] * fade);
                ripMesh.setColorAt(visible, _c);
                visible++;
            }
            ripMesh.count = visible;
            if (visible) {
                flush(ripMesh.instanceMatrix, visible * 16);
                if (ripMesh.instanceColor) flush(ripMesh.instanceColor, visible * 3);
            }
        }
    });

    return (
        <group name="network-layer">
            <lineSegments geometry={buffers.ble.geometry} frustumCulled={false} raycast={noopRaycast}>
                <lineBasicMaterial
                    vertexColors
                    transparent
                    opacity={0.75}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                />
            </lineSegments>
            <lineSegments geometry={buffers.wifi.geometry} frustumCulled={false} raycast={noopRaycast}>
                <lineBasicMaterial
                    vertexColors
                    transparent
                    opacity={0.9}
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                />
            </lineSegments>
            <instancedMesh
                ref={packetMeshRef}
                args={[buffers.packetGeo, undefined, MAX_PACKETS]}
                frustumCulled={false}
                raycast={noopRaycast}
            >
                <meshBasicMaterial toneMapped={false} />
            </instancedMesh>
            <instancedMesh
                ref={rippleMeshRef}
                args={[buffers.rippleGeo, undefined, MAX_RIPPLES]}
                frustumCulled={false}
                raycast={noopRaycast}
                renderOrder={3}
            >
                <meshBasicMaterial
                    toneMapped={false}
                    transparent
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    side={THREE.DoubleSide}
                />
            </instancedMesh>
        </group>
    );
};
