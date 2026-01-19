import React, { useRef, useMemo, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import * as THREE from 'three';
import { BitchatConnection } from '../../simulation/BitchatConnection';
import { BitchatConnectionBLE, RSSI_CONFIG } from '../../simulation/BitchatConnectionBLE';
import { useSelection } from '../context/SelectionContext';
import { useVisualization } from '../context/VisualizationContext';
import { MessageType } from '../../protocol/BitchatPacket';
import { BitchatAppSimulator } from '../../simulation/AppLayer/BitchatAppSimulator';

interface ConnectionEdgeProps {
    connection: BitchatConnection;
}

interface FlyingPacket {
    id: string;
    progress: number; // 0 to 1
    direction: 1 | -1; // 1: A->B, -1: B->A
    color: string;
    isRelay: boolean;
    senderId: string;
    type: MessageType;
}

/**
 * Convert RSSI to a color (green -> yellow -> orange -> red).
 * Uses HSL for smooth transitions.
 */
function rssiToColor(rssi: number): THREE.Color {
    // Normalize RSSI: -30 (best) to -85 (worst) -> 1 to 0
    const range = RSSI_CONFIG.MAX_RSSI - RSSI_CONFIG.DISCONNECT_THRESHOLD;
    const normalized = Math.max(0, Math.min(1, 
        (rssi - RSSI_CONFIG.DISCONNECT_THRESHOLD) / range
    ));

    // Hue: 0 (red) to 120 (green)
    const hue = normalized * 120 / 360;
    const saturation = 0.8;
    const lightness = 0.5;

    const color = new THREE.Color();
    color.setHSL(hue, saturation, lightness);
    return color;
}

export const ConnectionEdge: React.FC<ConnectionEdgeProps> = ({ connection }) => {
    const lineRef = useRef<any>(null); // Reference to the Line (Line2) mesh
    const segmentARef = useRef<any>(null); // Segment A->Mid
    const segmentBRef = useRef<any>(null); // Segment B->Mid
    
    const { selectedId, select } = useSelection();
    const { showAnnouncePackets, highlightOwnMesh } = useVisualization();
    const engine = useSimulation();
    
    // Packet Visualization State
    const [packets, setPackets] = useState<FlyingPacket[]>([]);
    
    // Selection Logic
    const isConnectionSelected = selectedId === connection.id;
    
    // Check if one of the endpoints is selected
    let isEndpointSelected = false;
    if (selectedId) {
        const person = engine.getPerson(selectedId);
        if (person) {
            isEndpointSelected = connection.involves(person.device);
        }
    }
    
    const isHighlighted = isConnectionSelected || isEndpointSelected;
    
    // Graph Knowledge Visualization Logic
    let isGraphMode = false;
    let knownAtoB = false; // A knows B
    let knownBtoA = false; // B knows A
    let isUnknownMuted = false;

    if (selectedId && !isConnectionSelected && highlightOwnMesh) {
        // If a node is selected, we want to visualize ITS graph
        // (unless we selected the connection itself)
        const selectedPerson = engine.getPerson(selectedId);
        if (selectedPerson && selectedPerson.device.appSimulator) {
            // Check type safety - assume BitchatAppSimulator for now
            const sim = selectedPerson.device.appSimulator as unknown as BitchatAppSimulator;
            if (sim.meshGraph) {
                isGraphMode = true;
                const idA = connection.endpointA.peerIDHex;
                const idB = connection.endpointB.peerIDHex;
                
                knownAtoB = sim.meshGraph.hasNeighbor(idA, idB);
                knownBtoA = sim.meshGraph.hasNeighbor(idB, idA);

                // If completely unknown to the selected node, mute it
                if (!knownAtoB && !knownBtoA) {
                    isUnknownMuted = true;
                }
            }
        }
    }

    const isDimmed = highlightOwnMesh && ((selectedId !== null && !isHighlighted && !isGraphMode) || isUnknownMuted);

    // Resolve selected peer hex ID if a person is selected
    let selectedPeerIDHex: string | undefined;
    if (selectedId) {
        const person = engine.getPerson(selectedId);
        if (person) {
            selectedPeerIDHex = person.device.peerIDHex;
        }
    }

    // Listen for packets via EventBus
    useEffect(() => {
        const handlePacket = (data: any) => {
            if (data.connectionId !== connection.id) return;
            
            const direction = data.fromId === connection.endpointA.peerIDHex ? 1 : -1;
            const p = data.packet;
            
            // Check if this is an Origin transmission or a Relay
            const senderHex = Array.from(p.senderID as Uint8Array)
                .map(b => b.toString(16).padStart(2, '0')).join('');
                
            // Filter Announce Packets if visualization disabled
            if (!showAnnouncePackets && p.type === MessageType.ANNOUNCE) return;

            const isRelay = data.fromId !== senderHex;
            
            // Color Logic based on Type and TTL
            let colorObj = new THREE.Color();
            let baseColor = 0xffffff;
            if (p.type === MessageType.ANNOUNCE) baseColor = 0x00ffff;
            if (p.type === MessageType.MESSAGE) baseColor = 0x00ff00;
            
            // Source Routing Override
            if (p.route && p.route.length > 0) {
                baseColor = 0xFFC107; // Golden Orange
            }
            
            colorObj.setHex(baseColor);
            
            // Dim it based on TTL using HSL
            const hsl = { h: 0, s: 0, l: 0 };
            colorObj.getHSL(hsl);
            
            if (isRelay) {
                hsl.s *= 0.5;
                hsl.l = 0.3;
            } else {
                hsl.l = 0.6;
            }
            
            colorObj.setHSL(hsl.h, hsl.s, hsl.l);
            
            const color = '#' + colorObj.getHexString();
            
            setPackets(prev => [
                ...prev, 
                { id: Math.random().toString(), progress: 0, direction, color, isRelay, senderId: senderHex, type: p.type }
            ]);
        };
        
        engine.events.on('packet_transmitted', handlePacket);
        return () => { engine.events.off('packet_transmitted', handlePacket); };
    }, [connection, engine]);


    // Buffer for hit area
    const positions = useMemo(() => new Float32Array(6), []);
    
    // Buffers for Split View (Graph Mode)
    const positionsA = useMemo(() => new Float32Array(6), []);
    const positionsB = useMemo(() => new Float32Array(6), []);
    
    // Initial points for Line component
    const initialPoints = useMemo(() => {
        const posA = connection.endpointA.position || { x: 0, y: 0 };
        const posB = connection.endpointB.position || { x: 0, y: 0 };
        return [
            new THREE.Vector3(posA.x, posA.y, 0),
            new THREE.Vector3(posB.x, posB.y, 0)
        ];
    }, []);

    useFrame((_state, delta) => {
        const posA = connection.endpointA.position;
        const posB = connection.endpointB.position;
        
        if (posA && posB) {
            // Update Hit Area Logic
            positions[0] = posA.x; positions[1] = posA.y; positions[2] = 0;
            positions[3] = posB.x; positions[4] = posB.y; positions[5] = 0;
            
            if (isGraphMode && !isUnknownMuted) {
                // Split Mode Update
                const midX = (posA.x + posB.x) / 2;
                const midY = (posA.y + posB.y) / 2;

                // Segment A -> Mid
                positionsA[0] = posA.x; positionsA[1] = posA.y; positionsA[2] = 0;
                positionsA[3] = midX;   positionsA[4] = midY;   positionsA[5] = 0;

                // Segment B -> Mid
                positionsB[0] = posB.x; positionsB[1] = posB.y; positionsB[2] = 0;
                positionsB[3] = midX;   positionsB[4] = midY;   positionsB[5] = 0;
                
                if (segmentARef.current?.geometry?.setPositions) segmentARef.current.geometry.setPositions(positionsA);
                if (segmentBRef.current?.geometry?.setPositions) segmentBRef.current.geometry.setPositions(positionsB);

            } else {
                // Standard Mode Update
                if (lineRef.current?.geometry?.setPositions) {
                    lineRef.current.geometry.setPositions(positions);
                }
                
                // Update color for physical link
                if (lineRef.current && !isHighlighted && !isDimmed) {
                    if (connection instanceof BitchatConnectionBLE) {
                        const rssiColor = rssiToColor(connection.rssi);
                        if (lineRef.current.material) {
                            lineRef.current.material.color = rssiColor;
                        }
                    }
                }
            }
        }
        
        // Update Packets
        if (packets.length > 0) {
            setPackets(prev => {
                const next: FlyingPacket[] = [];
                const pA = connection.endpointA.position!;
                const pB = connection.endpointB.position!;
                const dx = pA.x - pB.x;
                const dy = pA.y - pB.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                const speed = 150;
                const increment = (speed * delta) / (dist || 1);
                
                prev.forEach(p => {
                    const newProg = p.progress + increment;
                    if (newProg < 1) {
                        next.push({ ...p, progress: newProg });
                    }
                });
                return next;
            });
        }
    });
    
    const handleClick = (e: any) => {
        e.stopPropagation();
        select(connection.id, 'connection');
    };

    // Render Logic Selection
    if (isGraphMode && !isUnknownMuted) {
        // --- GRAPH KNOWLEDGE VIEW ---
        const colorKnown = 0x00ffff; // Neon Cyan
        const colorUnknown = 0x888888; // Grey

        return (
            <group>
                {/* Segment A -> Mid */}
                <Line
                    ref={segmentARef}
                    points={[[0,0,0], [0,0,0]]} // Updated in useFrame
                    color={knownAtoB ? colorKnown : colorUnknown}
                    transparent
                    opacity={knownAtoB ? 1 : 0.5}
                    lineWidth={2}
                    dashed={!knownAtoB}
                    dashScale={2}
                    dashSize={2}
                    gapSize={1}
                />
                
                {/* Segment B -> Mid */}
                <Line
                    ref={segmentBRef}
                    points={[[0,0,0], [0,0,0]]} // Updated in useFrame
                    color={knownBtoA ? colorKnown : colorUnknown}
                    transparent
                    opacity={knownBtoA ? 1 : 0.5}
                    lineWidth={2}
                    dashed={!knownBtoA}
                    dashScale={2}
                    dashSize={2}
                    gapSize={1}
                />
                
                {/* Hit Area */}
                <line 
                    onClick={handleClick} 
                    onPointerOver={() => document.body.style.cursor = 'pointer'} 
                    onPointerOut={() => document.body.style.cursor = 'auto'}
                >
                     <bufferGeometry>
                        <bufferAttribute attach="attributes-position" count={2} array={positions} itemSize={3} />
                     </bufferGeometry>
                     <lineBasicMaterial transparent opacity={0} linewidth={10} /> 
                 </line>

                 {/* Flying Packets (Even in Graph Mode) */}
                 {packets
                    .filter(p => !selectedPeerIDHex || p.senderId === selectedPeerIDHex || p.type === MessageType.ANNOUNCE)
                    .map(p => {
                    const posA = connection.endpointA.position!;
                    const posB = connection.endpointB.position!;
                    const t = p.direction === 1 ? p.progress : (1 - p.progress);
                    const x = posA.x + (posB.x - posA.x) * t;
                    const y = posA.y + (posB.y - posA.y) * t;
                    
                    return (
                        <mesh key={p.id} position={[x, y, 0]}>
                            <sphereGeometry args={[p.isRelay ? 1.5 : 2.5, 8, 8]} />
                            <meshBasicMaterial color={p.color} />
                        </mesh>
                    );
                })}
            </group>
        );
    } else {
        // --- STANDARD / MUTED VIEW ---
        let lineColor: THREE.Color | string = 'green';
        if (isHighlighted) {
            lineColor = 'yellow';
        } else if (!isDimmed && connection instanceof BitchatConnectionBLE) {
            lineColor = rssiToColor(connection.rssi);
        }

        return (
            <group>
                <Line
                    ref={lineRef}
                    points={initialPoints}
                    color={lineColor}
                    transparent
                    opacity={isDimmed ? 0.1 : (isHighlighted ? 0.8 : 0.6)}
                    lineWidth={isHighlighted ? 3 : 1.5}
                />
                
                <line 
                    onClick={handleClick} 
                    onPointerOver={() => document.body.style.cursor = 'pointer'} 
                    onPointerOut={() => document.body.style.cursor = 'auto'}
                >
                     <bufferGeometry>
                        <bufferAttribute attach="attributes-position" count={2} array={positions} itemSize={3} />
                     </bufferGeometry>
                     <lineBasicMaterial transparent opacity={0} linewidth={10} /> 
                 </line>

                {/* Flying Packets */}
                {packets
                    .filter(p => !selectedPeerIDHex || p.senderId === selectedPeerIDHex || p.type === MessageType.ANNOUNCE)
                    .map(p => {
                    const posA = connection.endpointA.position!;
                    const posB = connection.endpointB.position!;
                    const t = p.direction === 1 ? p.progress : (1 - p.progress);
                    const x = posA.x + (posB.x - posA.x) * t;
                    const y = posA.y + (posB.y - posA.y) * t;
                    
                    return (
                        <mesh key={p.id} position={[x, y, 0]}>
                            <sphereGeometry args={[p.isRelay ? 1.5 : 2.5, 8, 8]} />
                            <meshBasicMaterial color={p.color} />
                        </mesh>
                    );
                })}
            </group>
        );
    }
};
