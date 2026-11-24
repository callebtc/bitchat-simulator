import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { PeerRouteProbe, probePeerRoute } from '../../simulation/MeshProbe';
import { BitchatPacket, MessageType, toHex } from '../../protocol/BitchatPacket';

const noopRaycast = () => null;

const MAX_DM_HOP_PULSES = 64;
const HOP_PULSE_TTL_MS = 2_400;

interface ActiveDmHopPulse {
    fromPeerHex: string;
    toPeerHex: string;
    startWallMs: number;
    colorHex: number;
}

function getProbeColor(status: PeerRouteProbe['status']): string {
    switch (status) {
        case 'direct_wifi':
            return '#c084fc'; // bright purple for 5 GHz Wi-Fi Aware
        case 'direct_ble':
            return '#22c55e'; // bright emerald for direct BLE
        case 'source_route':
            return '#f59e0b'; // amber/gold for confirmed MeshGraph source route
        case 'flood_reachable':
            return '#22d3ee'; // cyan for physically reachable multi-hop flood
        case 'exceeds_ttl':
            return '#fb923c'; // orange for > maxTtl
        case 'unreachable':
            return '#ef4444'; // red for partitioned / no path
    }
}

/**
 * Live visual DM probe & packet-hop follower:
 * - Draws pulsing FROM/TO rings around sender and recipient (or hovered node while picking)
 * - Draws live color-coded reachability path (Direct / Source Route / Flood / Unreachable)
 * - Highlights every hop traversed by Noise XX handshakes, encrypted DMs, and DELIVERED ACKs
 *   between the active pair so users can follow a DM traveling through the mesh in real time.
 */
export const ProbeVisualizer: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType, chatRecipientId, isPickingRecipient, highlightedId } =
        useSelection();

    const senderPerson =
        selectedId && selectionType === 'node' ? engine.getPerson(selectedId) : undefined;
    const senderPeerHex = senderPerson?.device.peerIDHex ?? null;

    // While picking a recipient, hovering any other node previews the live probe path!
    const targetPeerHex =
        isPickingRecipient && highlightedId && highlightedId !== senderPeerHex
            ? highlightedId
            : chatRecipientId;

    const [probe, setProbe] = useState<PeerRouteProbe | null>(null);

    const senderRingRef = useRef<THREE.Mesh>(null);
    const targetRingRef = useRef<THREE.Mesh>(null);
    const pathLineRef = useRef<any>(null);
    const hopDotsRef = useRef<THREE.InstancedMesh>(null);
    const dmTrailLineRef = useRef<THREE.LineSegments>(null);
    const dmCometMeshRef = useRef<THREE.InstancedMesh>(null);
    const dmPulsesRef = useRef<ActiveDmHopPulse[]>([]);

    const { ringGeo, hopDotGeo, cometGeo, dmTrailGeo, dmTrailPos, dmTrailCol } = useMemo(() => {
        const rGeo = new THREE.RingGeometry(5.2, 6.8, 32);
        const hGeo = new THREE.CircleGeometry(2.4, 16);
        const cGeo = new THREE.CircleGeometry(3.2, 16);

        const tGeo = new THREE.BufferGeometry();
        const tPos = new THREE.BufferAttribute(new Float32Array(MAX_DM_HOP_PULSES * 2 * 3), 3);
        const tCol = new THREE.BufferAttribute(new Float32Array(MAX_DM_HOP_PULSES * 2 * 3), 3);
        tPos.setUsage(THREE.DynamicDrawUsage);
        tCol.setUsage(THREE.DynamicDrawUsage);
        tGeo.setAttribute('position', tPos);
        tGeo.setAttribute('color', tCol);
        tGeo.setDrawRange(0, 0);

        return {
            ringGeo: rGeo,
            hopDotGeo: hGeo,
            cometGeo: cGeo,
            dmTrailGeo: tGeo,
            dmTrailPos: tPos,
            dmTrailCol: tCol,
        };
    }, []);

    useEffect(() => {
        return () => {
            ringGeo.dispose();
            hopDotGeo.dispose();
            cometGeo.dispose();
            dmTrailGeo.dispose();
        };
    }, [ringGeo, hopDotGeo, cometGeo, dmTrailGeo]);

    // Refresh reachability probe at 4 Hz while a pair (or hover preview) is active
    useEffect(() => {
        if (!senderPeerHex || !targetPeerHex || senderPeerHex === targetPeerHex) {
            setProbe(null);
            return;
        }
        const update = () => {
            setProbe(probePeerRoute(engine, senderPeerHex, targetPeerHex));
        };
        update();
        const interval = setInterval(update, 250);
        return () => clearInterval(interval);
    }, [engine, senderPeerHex, targetPeerHex]);

    // Clear DM hop pulses when active pair changes
    useEffect(() => {
        dmPulsesRef.current = [];
    }, [senderPeerHex, chatRecipientId]);

    // Follow every Noise XX handshake, encrypted DM, fragment, and ACK hop between the pair!
    useEffect(() => {
        if (!senderPeerHex || !chatRecipientId) return;

        const handlePacket = (data: {
            connectionId: string;
            packet: BitchatPacket;
            fromId: string;
        }) => {
            const p = data.packet;
            if (
                p.type !== MessageType.NOISE_HANDSHAKE &&
                p.type !== MessageType.NOISE_ENCRYPTED &&
                p.type !== MessageType.MESSAGE &&
                p.type !== MessageType.FRAGMENT
            ) {
                return;
            }
            if (!p.recipientID) return;

            const pktSender = toHex(p.senderID);
            const pktRecipient = toHex(p.recipientID);

            const isForward = pktSender === senderPeerHex && pktRecipient === chatRecipientId;
            const isReverse = pktSender === chatRecipientId && pktRecipient === senderPeerHex;
            if (!isForward && !isReverse) return;

            const conn = engine.getConnectionById(data.connectionId);
            if (!conn) return;
            const hopToHex =
                conn.endpointA.peerIDHex === data.fromId
                    ? conn.endpointB.peerIDHex
                    : conn.endpointA.peerIDHex;

            // Color code: violet = Noise XX handshake, bright fuchsia = forward DM, emerald = return ACK/reply
            let colorHex = 0xf0abfc;
            if (p.type === MessageType.NOISE_HANDSHAKE) {
                colorHex = 0xa855f7;
            } else if (isForward) {
                colorHex = 0xf43f5e;
            } else if (isReverse) {
                colorHex = 0x34d399;
            }

            const list = dmPulsesRef.current;
            if (list.length >= MAX_DM_HOP_PULSES) {
                list.shift();
            }
            list.push({
                fromPeerHex: data.fromId,
                toPeerHex: hopToHex,
                startWallMs: performance.now(),
                colorHex,
            });
        };

        engine.events.on('packet_transmitted', handlePacket);
        return () => {
            engine.events.off('packet_transmitted', handlePacket);
        };
    }, [engine, senderPeerHex, chatRecipientId]);

    const dummyMatrix = useMemo(() => new THREE.Matrix4(), []);
    const tmpColor = useMemo(() => new THREE.Color(), []);

    useFrame(({ clock }) => {
        const t = clock.getElapsedTime();
        const pulse = 1 + Math.sin(t * 5.0) * 0.12;

        // 1. Update sender ring
        const sPerson = senderPeerHex ? engine.getPersonByPeerId(senderPeerHex) : undefined;
        if (senderRingRef.current) {
            if (sPerson && (targetPeerHex || isPickingRecipient)) {
                senderRingRef.current.visible = true;
                senderRingRef.current.position.set(sPerson.position.x, sPerson.position.y, 2.3);
                senderRingRef.current.scale.set(pulse, pulse, 1);
            } else {
                senderRingRef.current.visible = false;
            }
        }

        // 2. Update target ring
        const tPerson = targetPeerHex ? engine.getPersonByPeerId(targetPeerHex) : undefined;
        if (targetRingRef.current) {
            if (tPerson && sPerson && tPerson.id !== sPerson.id) {
                targetRingRef.current.visible = true;
                targetRingRef.current.position.set(tPerson.position.x, tPerson.position.y, 2.3);
                targetRingRef.current.scale.set(pulse, pulse, 1);
            } else {
                targetRingRef.current.visible = false;
            }
        }

        // 3. Update live probe polyline & intermediate hop dots
        if (pathLineRef.current && probe && sPerson && tPerson) {
            const pathPeers = probe.displayPath ?? [probe.fromPeerHex, probe.toPeerHex];
            const flat: number[] = [];
            const hopMesh = hopDotsRef.current;
            let hopCount = 0;

            for (let i = 0; i < pathPeers.length; i++) {
                const node = engine.getPersonByPeerId(pathPeers[i]);
                if (!node) continue;
                flat.push(node.position.x, node.position.y, 4.5);
                if (hopMesh && i > 0 && i < pathPeers.length - 1 && hopCount < 16) {
                    dummyMatrix.makeTranslation(node.position.x, node.position.y, 4.7);
                    hopMesh.setMatrixAt(hopCount, dummyMatrix);
                    hopCount++;
                }
            }
            if (flat.length >= 6 && pathLineRef.current.geometry?.setPositions) {
                pathLineRef.current.geometry.setPositions(flat);
                if (pathLineRef.current.computeLineDistances) {
                    pathLineRef.current.computeLineDistances();
                }
            }
            if (hopMesh) {
                hopMesh.count = hopCount;
                if (hopCount > 0) {
                    hopMesh.instanceMatrix.needsUpdate = true;
                }
            }
        } else if (hopDotsRef.current) {
            hopDotsRef.current.count = 0;
        }

        // 4. Update live DM hop trails + traveling comets
        const nowWall = performance.now();
        const pulses = dmPulsesRef.current;
        const posArr = dmTrailPos.array as Float32Array;
        const colArr = dmTrailCol.array as Float32Array;
        const cometMesh = dmCometMeshRef.current;

        let segVerts = 0;
        let cometCount = 0;
        let writeIdx = 0;

        for (let i = 0; i < pulses.length; i++) {
            const pulseItem = pulses[i];
            const age = nowWall - pulseItem.startWallMs;
            if (age > HOP_PULSE_TTL_MS) continue;
            pulses[writeIdx++] = pulseItem;

            const pA = engine.getPersonByPeerId(pulseItem.fromPeerHex);
            const pB = engine.getPersonByPeerId(pulseItem.toPeerHex);
            if (!pA || !pB) continue;

            const fade = Math.max(0.15, 1 - age / HOP_PULSE_TTL_MS);
            tmpColor.setHex(pulseItem.colorHex).multiplyScalar(fade);

            const off = segVerts * 3;
            posArr[off] = pA.position.x;
            posArr[off + 1] = pA.position.y;
            posArr[off + 2] = 6.0;
            posArr[off + 3] = pB.position.x;
            posArr[off + 4] = pB.position.y;
            posArr[off + 5] = 6.0;

            colArr[off] = tmpColor.r;
            colArr[off + 1] = tmpColor.g;
            colArr[off + 2] = tmpColor.b;
            colArr[off + 3] = tmpColor.r;
            colArr[off + 4] = tmpColor.g;
            colArr[off + 5] = tmpColor.b;
            segVerts += 2;

            // Animate bright traveling packet dot along the hop during first 650 ms
            if (cometMesh && age < 650 && cometCount < MAX_DM_HOP_PULSES) {
                const prog = age / 650;
                const cx = pA.position.x + (pB.position.x - pA.position.x) * prog;
                const cy = pA.position.y + (pB.position.y - pA.position.y) * prog;
                dummyMatrix.makeTranslation(cx, cy, 6.5);
                cometMesh.setMatrixAt(cometCount, dummyMatrix);
                tmpColor.setHex(pulseItem.colorHex);
                cometMesh.setColorAt(cometCount, tmpColor);
                cometCount++;
            }
        }
        pulses.length = writeIdx;

        dmTrailGeo.setDrawRange(0, segVerts);
        if (segVerts > 0) {
            dmTrailPos.clearUpdateRanges();
            dmTrailPos.addUpdateRange(0, segVerts * 3);
            dmTrailPos.needsUpdate = true;
            dmTrailCol.clearUpdateRanges();
            dmTrailCol.addUpdateRange(0, segVerts * 3);
            dmTrailCol.needsUpdate = true;
        }

        if (cometMesh) {
            cometMesh.count = cometCount;
            if (cometCount > 0) {
                cometMesh.instanceMatrix.clearUpdateRanges();
                cometMesh.instanceMatrix.addUpdateRange(0, cometCount * 16);
                cometMesh.instanceMatrix.needsUpdate = true;
                if (cometMesh.instanceColor) {
                    cometMesh.instanceColor.clearUpdateRanges();
                    cometMesh.instanceColor.addUpdateRange(0, cometCount * 3);
                    cometMesh.instanceColor.needsUpdate = true;
                }
            }
        }
    });

    // Build initial points for Line when probe changes
    const linePoints = useMemo(() => {
        if (!probe) return null;
        const ids = probe.displayPath ?? [probe.fromPeerHex, probe.toPeerHex];
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < ids.length; i++) {
            const p = engine.getPersonByPeerId(ids[i]);
            if (p) pts.push(new THREE.Vector3(p.position.x, p.position.y, 4.5));
        }
        return pts.length >= 2 ? pts : null;
    }, [engine, probe]);

    const probeColor = probe ? getProbeColor(probe.status) : '#22d3ee';
    const isDashed =
        probe !== null &&
        (probe.status === 'flood_reachable' ||
            probe.status === 'exceeds_ttl' ||
            probe.status === 'unreachable');

    return (
        <group name="dm-probe-visualizer">
            {/* Pulsing Sender Halo (cyan) */}
            <mesh ref={senderRingRef} geometry={ringGeo} visible={false} raycast={noopRaycast}>
                <meshBasicMaterial color="#22d3ee" transparent opacity={0.95} depthTest={false} />
            </mesh>

            {/* Pulsing Recipient Halo (fuchsia) */}
            <mesh ref={targetRingRef} geometry={ringGeo} visible={false} raycast={noopRaycast}>
                <meshBasicMaterial color="#e879f9" transparent opacity={0.95} depthTest={false} />
            </mesh>

            {/* Live Route Probe Polyline */}
            {probe && linePoints && (
                <Line
                    key={`${probe.fromPeerHex}-${probe.toPeerHex}-${probe.status}-${linePoints.length}`}
                    ref={pathLineRef}
                    points={linePoints}
                    color={probeColor}
                    lineWidth={probe.status === 'source_route' || probe.status === 'direct_ble' || probe.status === 'direct_wifi' ? 3.5 : 2.5}
                    dashed={isDashed}
                    dashSize={5}
                    gapSize={3}
                    transparent
                    opacity={isPickingRecipient ? 0.75 : 0.92}
                    depthTest={false}
                    renderOrder={90}
                />
            )}

            {/* Intermediate Hop Waypoint Dots */}
            <instancedMesh
                ref={hopDotsRef}
                args={[hopDotGeo, undefined, 16]}
                frustumCulled={false}
                raycast={noopRaycast}
                renderOrder={95}
            >
                <meshBasicMaterial color={probeColor} depthTest={false} />
            </instancedMesh>

            {/* Active DM / Noise Handshake / ACK Hop Trails */}
            <lineSegments
                ref={dmTrailLineRef}
                geometry={dmTrailGeo}
                frustumCulled={false}
                raycast={noopRaycast}
                renderOrder={105}
            >
                <lineBasicMaterial vertexColors transparent opacity={0.95} depthTest={false} />
            </lineSegments>

            {/* Traveling DM Packet Comets */}
            <instancedMesh
                ref={dmCometMeshRef}
                args={[cometGeo, undefined, MAX_DM_HOP_PULSES]}
                frustumCulled={false}
                raycast={noopRaycast}
                renderOrder={110}
            >
                <meshBasicMaterial depthTest={false} />
            </instancedMesh>
        </group>
    );
};
