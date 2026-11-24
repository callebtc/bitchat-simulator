import React, { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { useVisualization } from '../context/VisualizationContext';
import { BitchatPerson } from '../../simulation/BitchatPerson';
import { BitchatConnection } from '../../simulation/BitchatConnection';
import { BitchatConnectionBLE, RSSI_CONFIG } from '../../simulation/BitchatConnectionBLE';
import { BitchatConnectionWifiAware } from '../../simulation/BitchatConnectionWifiAware';
import { BitchatAppSimulator } from '../../simulation/AppLayer/BitchatAppSimulator';
import { MessageType, BitchatPacket, toHex } from '../../protocol/BitchatPacket';
import { getPeerColor } from '../../utils/colorUtils';

/**
 * High-performance GPU-Instanced Mesh Renderer capable of 60 FPS with
 * 5,000+ nodes, 30,000+ connections, and 4,096 concurrent flying packets
 * in just 5 WebGL draw calls total (zero per-node/per-edge React components
 * and zero Three.js triangle raycasting on pointer move).
 */

const MAX_NODES = 10_000;
const MAX_BLE_SEGMENTS = 40_000; // Split-graph mode uses 2 segments per connection
const MAX_WIFI_SEGMENTS = 20_000;
const MAX_FLYING_PACKETS = 4_096;
const LABEL_CROWD_THRESHOLD = 60;

// Disable Three.js CPU triangle raycasting on all GPU-instanced meshes
// (O(1) spatial-grid picking is handled by InteractionPlane instead).
const noopRaycast = () => null;

// Reusable scratch objects (zero per-frame heap allocations)
const _tmpColor = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };
const _whiteColor = new THREE.Color(0xffffff);
const _blackColor = new THREE.Color(0x000000);
const _yellowColor = new THREE.Color(0xffff00);
const _cyanColor = new THREE.Color(0x00ffff);
const _greyColor = new THREE.Color(0x666666);
const _wifiColor = new THREE.Color(0xa855f7);
const _recipientRingColor = new THREE.Color(0xe879f9);
const _dimColor = new THREE.Color(0x1f2937);

/** Upload only the active [0, count) slice of a dynamic GPU BufferAttribute. */
function markBufferSubrange(attr: THREE.BufferAttribute, count: number): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count);
    attr.needsUpdate = true;
}

/** Direct column-major 2D scale+translate matrix write (5x faster than Matrix4.compose). */
function writeInstanceMatrix2D(
    arr: Float32Array,
    index: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number
): void {
    const o = index * 16;
    arr[o] = sx;
    arr[o + 1] = 0;
    arr[o + 2] = 0;
    arr[o + 3] = 0;
    arr[o + 4] = 0;
    arr[o + 5] = sy;
    arr[o + 6] = 0;
    arr[o + 7] = 0;
    arr[o + 8] = 0;
    arr[o + 9] = 0;
    arr[o + 10] = sz;
    arr[o + 11] = 0;
    arr[o + 12] = x;
    arr[o + 13] = y;
    arr[o + 14] = z;
    arr[o + 15] = 1;
}

const peerColorCache = new Map<string, THREE.Color>();
function getCachedPeerColor(peerIdHex: string): THREE.Color {
    let c = peerColorCache.get(peerIdHex);
    if (!c) {
        c = new THREE.Color(getPeerColor(peerIdHex));
        peerColorCache.set(peerIdHex, c);
    }
    return c;
}

function writeRssiColor(rssi: number, out: THREE.Color): void {
    const range = RSSI_CONFIG.MAX_RSSI - RSSI_CONFIG.DISCONNECT_THRESHOLD;
    const normalized = Math.max(
        0,
        Math.min(1, (rssi - RSSI_CONFIG.DISCONNECT_THRESHOLD) / range)
    );
    out.setHSL((normalized * 120) / 360, 0.8, 0.5);
}

interface FlyingPacketPool {
    active: Uint8Array;
    progress: Float32Array;
    direction: Int8Array;
    r: Float32Array;
    g: Float32Array;
    b: Float32Array;
    scale: Float32Array;
    connections: Array<BitchatConnection | null>;
    senderIds: Array<string>;
    cursor: number;
    activeCount: number;
}

function createPacketPool(): FlyingPacketPool {
    return {
        active: new Uint8Array(MAX_FLYING_PACKETS),
        progress: new Float32Array(MAX_FLYING_PACKETS),
        direction: new Int8Array(MAX_FLYING_PACKETS),
        r: new Float32Array(MAX_FLYING_PACKETS),
        g: new Float32Array(MAX_FLYING_PACKETS),
        b: new Float32Array(MAX_FLYING_PACKETS),
        scale: new Float32Array(MAX_FLYING_PACKETS),
        connections: new Array<BitchatConnection | null>(MAX_FLYING_PACKETS).fill(null),
        senderIds: new Array<string>(MAX_FLYING_PACKETS).fill(''),
        cursor: 0,
        activeCount: 0,
    };
}

export const InstancedMeshLayer: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType, chatRecipientId, highlightedId } = useSelection();
    const { showAnnouncePackets, highlightOwnMesh } = useVisualization();

    const fillMeshRef = useRef<THREE.InstancedMesh>(null);
    const ringMeshRef = useRef<THREE.InstancedMesh>(null);
    const packetMeshRef = useRef<THREE.InstancedMesh>(null);
    const bleLinesRef = useRef<THREE.LineSegments>(null);
    const wifiLinesRef = useRef<THREE.LineSegments>(null);

    // Knock-pop animation scales keyed by peerIDHex
    const knockScaleRef = useRef<Map<string, number>>(new Map());
    // Zero-allocation flying packet pool
    const packetPoolRef = useRef<FlyingPacketPool>(createPacketPool());

    // Keep latest visualization/selection flags in refs for event handler & useFrame
    const showAnnounceRef = useRef(showAnnouncePackets);
    showAnnounceRef.current = showAnnouncePackets;

    // Track small-crowd label list only when node count <= LABEL_CROWD_THRESHOLD (or hovered/selected)
    const [labelPeers, setLabelPeers] = useState<string[]>([]);

    // Pre-allocated geometries
    const {
        circleGeo,
        ringGeo,
        packetGeo,
        bleLineGeo,
        blePosAttr,
        bleColorAttr,
        wifiLineGeo,
        wifiPosAttr,
        wifiColorAttr,
    } = useMemo(() => {
        const cGeo = new THREE.CircleGeometry(3.75, 16);
        const rGeo = new THREE.RingGeometry(3.75, 4.35, 16);
        // 8-segment flat disc instead of 128-triangle 3D sphere (16x fewer GPU triangles, identical in 2D ortho!)
        const pGeo = new THREE.CircleGeometry(2.0, 8);

        const bGeo = new THREE.BufferGeometry();
        const bPos = new THREE.BufferAttribute(new Float32Array(MAX_BLE_SEGMENTS * 2 * 3), 3);
        const bCol = new THREE.BufferAttribute(new Float32Array(MAX_BLE_SEGMENTS * 2 * 3), 3);
        bPos.setUsage(THREE.DynamicDrawUsage);
        bCol.setUsage(THREE.DynamicDrawUsage);
        bGeo.setAttribute('position', bPos);
        bGeo.setAttribute('color', bCol);
        bGeo.setDrawRange(0, 0);

        const wGeo = new THREE.BufferGeometry();
        const wPos = new THREE.BufferAttribute(new Float32Array(MAX_WIFI_SEGMENTS * 2 * 3), 3);
        const wCol = new THREE.BufferAttribute(new Float32Array(MAX_WIFI_SEGMENTS * 2 * 3), 3);
        wPos.setUsage(THREE.DynamicDrawUsage);
        wCol.setUsage(THREE.DynamicDrawUsage);
        wGeo.setAttribute('position', wPos);
        wGeo.setAttribute('color', wCol);
        wGeo.setDrawRange(0, 0);

        return {
            circleGeo: cGeo,
            ringGeo: rGeo,
            packetGeo: pGeo,
            bleLineGeo: bGeo,
            blePosAttr: bPos,
            bleColorAttr: bCol,
            wifiLineGeo: wGeo,
            wifiPosAttr: wPos,
            wifiColorAttr: wCol,
        };
    }, []);

    useEffect(() => {
        return () => {
            circleGeo.dispose();
            ringGeo.dispose();
            packetGeo.dispose();
            bleLineGeo.dispose();
            wifiLineGeo.dispose();
        };
    }, [circleGeo, ringGeo, packetGeo, bleLineGeo, wifiLineGeo]);

    // Sync small-crowd label IDs only when population changes (zero per-frame overhead)
    useEffect(() => {
        const syncLabels = () => {
            const all = engine.getAllPeople();
            if (all.length <= LABEL_CROWD_THRESHOLD) {
                setLabelPeers(all.map(p => p.id));
            } else {
                setLabelPeers([]);
            }
        };
        syncLabels();
        engine.events.on('person_added', syncLabels);
        engine.events.on('person_removed', syncLabels);
        engine.events.on('reset', syncLabels);
        return () => {
            engine.events.off('person_added', syncLabels);
            engine.events.off('person_removed', syncLabels);
            engine.events.off('reset', syncLabels);
        };
    }, [engine]);

    // ONE global listener for all packet visualizations & node knock-pops (replaces N + E listeners!)
    useEffect(() => {
        const handlePacket = (data: {
            connectionId: string;
            packet: BitchatPacket;
            fromId: string;
        }) => {
            const p = data.packet;
            if (!showAnnounceRef.current && p.type === MessageType.ANNOUNCE) return;

            const conn = engine.getConnectionById(data.connectionId);
            if (!conn) return;

            const senderHex = toHex(p.senderID);
            const isRelay = data.fromId !== senderHex;

            if (!isRelay) {
                knockScaleRef.current.set(senderHex, 1.5);
            }

            // Pick color by packet type
            let baseHex = 0xffffff;
            if (p.type === MessageType.ANNOUNCE) baseHex = 0x00ffff;
            else if (p.type === MessageType.MESSAGE) baseHex = 0x00ff00;
            else if (
                p.type === MessageType.NOISE_HANDSHAKE ||
                p.type === MessageType.NOISE_ENCRYPTED
            ) {
                baseHex = 0xe879f9;
            } else if (
                p.type === MessageType.FRAGMENT ||
                p.type === MessageType.FILE_TRANSFER
            ) {
                baseHex = 0xf97316;
            } else if (p.type === MessageType.VOICE_FRAME) {
                baseHex = 0xf43f5e;
            } else if (p.type === MessageType.REQUEST_SYNC) {
                baseHex = 0x38bdf8;
            }
            if (p.route && p.route.length > 0) {
                baseHex = 0xffc107;
            }

            _tmpColor.setHex(baseHex);
            _tmpColor.getHSL(_hsl);
            if (isRelay) {
                _hsl.s *= 0.5;
                _hsl.l = 0.35;
            } else {
                _hsl.l = 0.6;
            }
            _tmpColor.setHSL(_hsl.h, _hsl.s, _hsl.l);

            const pool = packetPoolRef.current;
            const slot = pool.cursor;
            pool.cursor = (slot + 1) % MAX_FLYING_PACKETS;

            if (pool.active[slot] === 0) {
                pool.activeCount++;
            }
            pool.active[slot] = 1;
            pool.progress[slot] = 0;
            pool.direction[slot] = data.fromId === conn.endpointA.peerIDHex ? 1 : -1;
            pool.r[slot] = _tmpColor.r;
            pool.g[slot] = _tmpColor.g;
            pool.b[slot] = _tmpColor.b;
            pool.scale[slot] = isRelay ? 0.75 : 1.25;
            pool.connections[slot] = conn;
            pool.senderIds[slot] = senderHex;
        };

        const handleReset = () => {
            const pool = packetPoolRef.current;
            pool.active.fill(0);
            pool.connections.fill(null);
            pool.activeCount = 0;
            pool.cursor = 0;
            knockScaleRef.current.clear();
        };

        engine.events.on('packet_transmitted', handlePacket);
        engine.events.on('reset', handleReset);
        return () => {
            engine.events.off('packet_transmitted', handlePacket);
            engine.events.off('reset', handleReset);
        };
    }, [engine]);

    // Single unified 60 FPS GPU update loop for ALL nodes, connections, and flying packets
    useFrame((_, delta) => {
        const people = engine.getAllPeople();
        const nodeCount = Math.min(people.length, MAX_NODES);

        const selectedPerson =
            selectedId && selectionType === 'node' ? engine.getPerson(selectedId) : undefined;
        const selectedPeerHex = selectedPerson?.device.peerIDHex;
        const selectedSim = selectedPerson?.device.appSimulator as BitchatAppSimulator | undefined;
        const isGraphMode = Boolean(
            selectedPerson && highlightOwnMesh && selectedSim?.meshGraph
        );
        const isSomethingSelected = selectedId !== null;
        const decay = 1 - Math.exp(-10 * delta);
        const knocks = knockScaleRef.current;

        // --- 1. UPDATE INSTANCED NODES (2 draw calls total, direct Float32Array writes) ---
        const fillMesh = fillMeshRef.current;
        const ringMesh = ringMeshRef.current;
        if (fillMesh && ringMesh) {
            fillMesh.count = nodeCount;
            ringMesh.count = nodeCount;
            const fillMatArr = fillMesh.instanceMatrix.array as Float32Array;
            const ringMatArr = ringMesh.instanceMatrix.array as Float32Array;

            for (let i = 0; i < nodeCount; i++) {
                const person = people[i];
                const peerHex = person.device.peerIDHex;
                const isSelected = selectedId === person.id;
                const isRecipient = chatRecipientId === peerHex;
                const isHighlighted = highlightedId === peerHex;
                const isDimmed =
                    highlightOwnMesh &&
                    isSomethingSelected &&
                    !isSelected &&
                    !isRecipient &&
                    !isHighlighted;

                let kScale = knocks.size > 0 ? knocks.get(peerHex) ?? 1.0 : 1.0;
                if (kScale > 1.002) {
                    kScale = kScale + (1.0 - kScale) * decay;
                    if (kScale <= 1.002) {
                        knocks.delete(peerHex);
                        kScale = 1.0;
                    } else {
                        knocks.set(peerHex, kScale);
                    }
                }

                const baseScale = isSelected || isRecipient ? 1.25 : isHighlighted ? 1.15 : 1.0;
                const s = baseScale * kScale;
                const ringScale =
                    (isSelected || isRecipient ? 1.32 : isHighlighted ? 1.2 : 1.0) * kScale;
                const px = person.position.x;
                const py = person.position.y;

                writeInstanceMatrix2D(fillMatArr, i, px, py, 2, s, s, 1);
                writeInstanceMatrix2D(ringMatArr, i, px, py, 2.05, ringScale, ringScale, 1);

                const baseColor = getCachedPeerColor(peerHex);
                if (isDimmed) {
                    _tmpColor.copy(baseColor).multiplyScalar(0.35);
                    fillMesh.setColorAt(i, _tmpColor);
                    ringMesh.setColorAt(i, _dimColor);
                } else {
                    fillMesh.setColorAt(i, baseColor);
                    ringMesh.setColorAt(
                        i,
                        isRecipient
                            ? _recipientRingColor
                            : isSelected || isHighlighted
                              ? _whiteColor
                              : _blackColor
                    );
                }
            }

            if (nodeCount > 0) {
                markBufferSubrange(fillMesh.instanceMatrix, nodeCount * 16);
                if (fillMesh.instanceColor) {
                    markBufferSubrange(fillMesh.instanceColor, nodeCount * 3);
                }
                markBufferSubrange(ringMesh.instanceMatrix, nodeCount * 16);
                if (ringMesh.instanceColor) {
                    markBufferSubrange(ringMesh.instanceColor, nodeCount * 3);
                }
            }
        }

        // --- 2. UPDATE CONNECTION LINE SEGMENTS (2 draw calls total: BLE + Wi-Fi Aware) ---
        const connections = engine.getAllConnections();
        const blePos = blePosAttr.array as Float32Array;
        const bleCol = bleColorAttr.array as Float32Array;
        const wifiPos = wifiPosAttr.array as Float32Array;
        const wifiCol = wifiColorAttr.array as Float32Array;
        let bleVerts = 0;
        let wifiVerts = 0;
        const maxBleVerts = MAX_BLE_SEGMENTS * 2;
        const maxWifiVerts = MAX_WIFI_SEGMENTS * 2;

        const pushSeg = (
            posArr: Float32Array,
            colArr: Float32Array,
            vIdx: number,
            x1: number,
            y1: number,
            x2: number,
            y2: number,
            z: number,
            color: THREE.Color
        ): number => {
            const pOff = vIdx * 3;
            posArr[pOff] = x1;
            posArr[pOff + 1] = y1;
            posArr[pOff + 2] = z;
            posArr[pOff + 3] = x2;
            posArr[pOff + 4] = y2;
            posArr[pOff + 5] = z;

            colArr[pOff] = color.r;
            colArr[pOff + 1] = color.g;
            colArr[pOff + 2] = color.b;
            colArr[pOff + 3] = color.r;
            colArr[pOff + 4] = color.g;
            colArr[pOff + 5] = color.b;
            return vIdx + 2;
        };

        for (let i = 0; i < connections.length; i++) {
            const conn = connections[i];
            const posA = conn.endpointA.position;
            const posB = conn.endpointB.position;
            if (!posA || !posB) continue;

            const isConnSelected = selectedId === conn.id;
            const isEndpointSelected = selectedPerson
                ? conn.involves(selectedPerson.device)
                : false;
            const isHighlighted = isConnSelected || isEndpointSelected;

            if (isGraphMode && selectedSim && !isConnSelected) {
                const idA = conn.endpointA.peerIDHex;
                const idB = conn.endpointB.peerIDHex;
                const knownAtoB = selectedSim.meshGraph.hasNeighbor(idA, idB);
                const knownBtoA = selectedSim.meshGraph.hasNeighbor(idB, idA);
                if (!knownAtoB && !knownBtoA) {
                    if (bleVerts + 2 <= maxBleVerts) {
                        bleVerts = pushSeg(
                            blePos,
                            bleCol,
                            bleVerts,
                            posA.x,
                            posA.y,
                            posB.x,
                            posB.y,
                            0,
                            _dimColor
                        );
                    }
                    continue;
                }
                const midX = (posA.x + posB.x) * 0.5;
                const midY = (posA.y + posB.y) * 0.5;
                if (bleVerts + 4 <= maxBleVerts) {
                    bleVerts = pushSeg(
                        blePos,
                        bleCol,
                        bleVerts,
                        posA.x,
                        posA.y,
                        midX,
                        midY,
                        0.1,
                        knownAtoB ? _cyanColor : _greyColor
                    );
                    bleVerts = pushSeg(
                        blePos,
                        bleCol,
                        bleVerts,
                        posB.x,
                        posB.y,
                        midX,
                        midY,
                        0.1,
                        knownBtoA ? _cyanColor : _greyColor
                    );
                }
                continue;
            }

            const isDimmed = highlightOwnMesh && isSomethingSelected && !isHighlighted;
            const isWifi = conn instanceof BitchatConnectionWifiAware;

            if (isWifi) {
                if (wifiVerts + 2 > maxWifiVerts) continue;
                const c = isHighlighted ? _yellowColor : isDimmed ? _dimColor : _wifiColor;
                wifiVerts = pushSeg(
                    wifiPos,
                    wifiCol,
                    wifiVerts,
                    posA.x,
                    posA.y,
                    posB.x,
                    posB.y,
                    0.2,
                    c
                );
            } else {
                if (bleVerts + 2 > maxBleVerts) continue;
                if (isHighlighted) {
                    _tmpColor.copy(_yellowColor);
                } else if (isDimmed) {
                    _tmpColor.copy(_dimColor);
                } else if (conn instanceof BitchatConnectionBLE) {
                    writeRssiColor(conn.rssi, _tmpColor);
                } else {
                    _tmpColor.setHex(0x22c55e);
                }
                bleVerts = pushSeg(
                    blePos,
                    bleCol,
                    bleVerts,
                    posA.x,
                    posA.y,
                    posB.x,
                    posB.y,
                    0,
                    _tmpColor
                );
            }
        }

        bleLineGeo.setDrawRange(0, bleVerts);
        if (bleVerts > 0) {
            markBufferSubrange(blePosAttr, bleVerts * 3);
            markBufferSubrange(bleColorAttr, bleVerts * 3);
        }

        wifiLineGeo.setDrawRange(0, wifiVerts);
        if (wifiVerts > 0) {
            markBufferSubrange(wifiPosAttr, wifiVerts * 3);
            markBufferSubrange(wifiColorAttr, wifiVerts * 3);
        }

        // --- 3. UPDATE INSTANCED FLYING PACKETS (1 draw call total) ---
        const pktMesh = packetMeshRef.current;
        if (pktMesh) {
            const pool = packetPoolRef.current;
            let visibleCount = 0;
            if (pool.activeCount > 0) {
                const speed = 150 * delta;
                for (let i = 0; i < MAX_FLYING_PACKETS; i++) {
                    if (pool.active[i] === 0) continue;
                    const conn = pool.connections[i];
                    if (!conn || !conn.isActive || !conn.endpointA.position || !conn.endpointB.position) {
                        pool.active[i] = 0;
                        pool.connections[i] = null;
                        pool.activeCount--;
                        continue;
                    }

                    const pA = conn.endpointA.position;
                    const pB = conn.endpointB.position;
                    const dx = pB.x - pA.x;
                    const dy = pB.y - pA.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const nextProg = pool.progress[i] + speed / (dist > 1 ? dist : 1);

                    if (nextProg >= 1) {
                        pool.active[i] = 0;
                        pool.connections[i] = null;
                        pool.activeCount--;
                        continue;
                    }
                    pool.progress[i] = nextProg;

                    if (highlightOwnMesh && selectedPeerHex && pool.senderIds[i] !== selectedPeerHex) {
                        continue;
                    }

                    const t = pool.direction[i] === 1 ? nextProg : 1 - nextProg;
                    const x = pA.x + dx * t;
                    const y = pA.y + dy * t;
                    const sc = pool.scale[i];

                    writeInstanceMatrix2D(
                        pktMesh.instanceMatrix.array as Float32Array,
                        visibleCount,
                        x,
                        y,
                        1.2,
                        sc,
                        sc,
                        sc
                    );
                    _tmpColor.setRGB(pool.r[i], pool.g[i], pool.b[i]);
                    pktMesh.setColorAt(visibleCount, _tmpColor);
                    visibleCount++;
                }
            }
            pktMesh.count = visibleCount;
            if (visibleCount > 0) {
                markBufferSubrange(pktMesh.instanceMatrix, visibleCount * 16);
                if (pktMesh.instanceColor) {
                    markBufferSubrange(pktMesh.instanceColor, visibleCount * 3);
                }
            }
        }
    });

    // Determine which peer labels to render: all when <= 60 peers, else selected + recipient + hovered
    const activeLabelPeople: BitchatPerson[] = [];
    const labelIdsSeen = new Set<string>();
    const pushLabel = (p: BitchatPerson | undefined) => {
        if (!p || labelIdsSeen.has(p.id)) return;
        labelIdsSeen.add(p.id);
        activeLabelPeople.push(p);
    };
    if (labelPeers.length > 0) {
        for (let i = 0; i < labelPeers.length; i++) {
            pushLabel(engine.getPerson(labelPeers[i]));
        }
    } else {
        if (selectedId && selectionType === 'node') {
            pushLabel(engine.getPerson(selectedId));
        }
        if (chatRecipientId) {
            pushLabel(engine.getPersonByPeerId(chatRecipientId));
        }
        if (highlightedId) {
            pushLabel(engine.getPersonByPeerId(highlightedId));
        }
    }

    return (
        <group name="instanced-mesh-layer">
            {/* BLE Connections (1 draw call) */}
            <lineSegments
                ref={bleLinesRef}
                geometry={bleLineGeo}
                frustumCulled={false}
                raycast={noopRaycast}
            >
                <lineBasicMaterial vertexColors transparent opacity={0.65} />
            </lineSegments>

            {/* Wi-Fi Aware 5 GHz Connections (1 draw call) */}
            <lineSegments
                ref={wifiLinesRef}
                geometry={wifiLineGeo}
                frustumCulled={false}
                raycast={noopRaycast}
            >
                <lineBasicMaterial vertexColors transparent opacity={0.8} />
            </lineSegments>

            {/* Flying Packets (1 draw call) */}
            <instancedMesh
                ref={packetMeshRef}
                args={[packetGeo, undefined, MAX_FLYING_PACKETS]}
                frustumCulled={false}
                raycast={noopRaycast}
            >
                <meshBasicMaterial />
            </instancedMesh>

            {/* Node Fill Circles (1 draw call; O(1) spatial-grid picking via InteractionPlane) */}
            <instancedMesh
                ref={fillMeshRef}
                args={[circleGeo, undefined, MAX_NODES]}
                frustumCulled={false}
                raycast={noopRaycast}
            >
                <meshBasicMaterial />
            </instancedMesh>

            {/* Node Border Rings (1 draw call) */}
            <instancedMesh
                ref={ringMeshRef}
                args={[ringGeo, undefined, MAX_NODES]}
                frustumCulled={false}
                raycast={noopRaycast}
            >
                <meshBasicMaterial />
            </instancedMesh>

            {/* Selective Peer Labels (only <= 60 peers or focused/recipient/hovered node) */}
            {activeLabelPeople.map(person => {
                const isSender = selectedId === person.id && selectionType === 'node';
                const isRecipient = chatRecipientId === person.device.peerIDHex;
                const roleTag = isSender && chatRecipientId ? 'FROM' : isRecipient ? 'TO' : undefined;
                return (
                    <NodeLabel
                        key={person.id}
                        person={person}
                        isHighlighted={
                            highlightedId === person.device.peerIDHex || isSender || isRecipient
                        }
                        roleTag={roleTag}
                    />
                );
            })}
        </group>
    );
};

const NodeLabel: React.FC<{
    person: BitchatPerson;
    isHighlighted: boolean;
    roleTag?: 'FROM' | 'TO';
}> = ({ person, isHighlighted, roleTag }) => {
    const groupRef = useRef<THREE.Group>(null);
    useFrame(() => {
        if (!groupRef.current) return;
        groupRef.current.position.set(person.position.x, person.position.y - 6, 2.5);
    });
    const labelColor =
        roleTag === 'FROM'
            ? '#22d3ee'
            : roleTag === 'TO'
              ? '#e879f9'
              : isHighlighted
                ? '#ffff00'
                : 'white';
    const text = roleTag
        ? `${roleTag}: ${person.device.nickname} (${person.device.peerIDHex.substring(0, 6)})`
        : person.device.peerIDHex.substring(0, 8);
    return (
        <group ref={groupRef} position={[person.position.x, person.position.y - 6, 2.5]}>
            <Text fontSize={roleTag ? 3.5 : 3} color={labelColor} anchorX="center" anchorY="top">
                {text}
            </Text>
        </group>
    );
};
