import React, { useRef, useMemo, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import * as THREE from 'three';
import { BitchatConnection } from '../../simulation/BitchatConnection';
import { BitchatConnectionBLE, RSSI_CONFIG } from '../../simulation/BitchatConnectionBLE';
import { useSelection } from '../context/SelectionContext';
import { MessageType } from '../../protocol/BitchatPacket';

interface ConnectionEdgeProps {
    connection: BitchatConnection;
}

interface FlyingPacket {
    id: string;
    progress: number; // 0 to 1
    direction: 1 | -1; // 1: A->B, -1: B->A
    color: string;
    isRelay: boolean;
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
    const { selectedId, select } = useSelection();
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
    const isDimmed = selectedId !== null && !isHighlighted;

    // Listen for packets via EventBus
    useEffect(() => {
        const handlePacket = (data: any) => {
            if (data.connectionId !== connection.id) return;
            
            const direction = data.fromId === connection.endpointA.peerIDHex ? 1 : -1;
            const p = data.packet;
            
            // Check if this is an Origin transmission or a Relay
            const senderHex = Array.from(p.senderID as Uint8Array)
                .map(b => b.toString(16).padStart(2, '0')).join('');
            const isRelay = data.fromId !== senderHex;
            
            // Color Logic based on Type and TTL
            let colorObj = new THREE.Color();
            let baseColor = 0xffffff;
            if (p.type === MessageType.ANNOUNCE) baseColor = 0x00ffff;
            if (p.type === MessageType.MESSAGE) baseColor = 0x00ff00;
            
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
                { id: Math.random().toString(), progress: 0, direction, color, isRelay }
            ]);
        };
        
        engine.events.on('packet_transmitted', handlePacket);
        return () => { engine.events.off('packet_transmitted', handlePacket); };
    }, [connection, engine]);


    // Initial positions buffer
    const positions = useMemo(() => new Float32Array(6), []);
    
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
        // Update Line Geometry
        if (lineRef.current) {
            const posA = connection.endpointA.position;
            const posB = connection.endpointB.position;

            if (posA && posB) {
                positions[0] = posA.x; positions[1] = posA.y; positions[2] = 0;
                positions[3] = posB.x; positions[4] = posB.y; positions[5] = 0;
                
                // Update Line2 geometry
                // Line from drei uses Line2 which has geometry with setPositions
                if (lineRef.current.geometry?.setPositions) {
                    lineRef.current.geometry.setPositions(positions);
                }
            }
        }

        // Update line color based on RSSI (if BLE connection)
        if (lineRef.current && !isHighlighted && !isDimmed) {
            if (connection instanceof BitchatConnectionBLE) {
                const rssiColor = rssiToColor(connection.rssi);
                if (lineRef.current.material) {
                    lineRef.current.material.color = rssiColor;
                }
            }
        }
        
        // Update Packets
        if (packets.length > 0) {
            setPackets(prev => {
                const next: FlyingPacket[] = [];
                const posA = connection.endpointA.position!;
                const posB = connection.endpointB.position!;
                const dx = posA.x - posB.x;
                const dy = posA.y - posB.y;
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

    // Determine line color
    let lineColor: THREE.Color | string = 'green';
    if (isHighlighted) {
        lineColor = 'yellow';
    } else if (!isDimmed && connection instanceof BitchatConnectionBLE) {
        lineColor = rssiToColor(connection.rssi);
    }

    return (
        <group>
            {/* Visual Line using drei Line for thickness */}
            <Line
                ref={lineRef}
                points={initialPoints}
                color={lineColor}
                transparent
                opacity={isDimmed ? 0.2 : (isHighlighted ? 0.8 : 0.6)}
                lineWidth={isHighlighted ? 5 : 3}
            />
            
            {/* Click Hit Area (invisible thicker line) */}
             <line 
                onClick={handleClick} 
                onPointerOver={() => document.body.style.cursor = 'pointer'} 
                onPointerOut={() => document.body.style.cursor = 'auto'}
            >
                 <bufferGeometry>
                    <bufferAttribute 
                        attach="attributes-position" 
                        count={2} 
                        array={positions} 
                        itemSize={3} 
                    />
                 </bufferGeometry>
                 <lineBasicMaterial transparent opacity={0} linewidth={10} /> 
             </line>

            {/* Flying Packets */}
            {packets.map(p => {
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
};
