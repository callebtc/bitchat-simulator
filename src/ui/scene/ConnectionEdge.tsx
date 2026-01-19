import React, { useRef, useMemo, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useSimulation } from '../context/SimulationContext'; // Import engine
import * as THREE from 'three';
import { BitchatConnection } from '../../simulation/BitchatConnection';
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

export const ConnectionEdge: React.FC<ConnectionEdgeProps> = ({ connection }) => {
    const geoRef = useRef<THREE.BufferGeometry>(null);
    const { selectedId, select } = useSelection();
    const engine = useSimulation(); // Get engine
    
    // Packet Visualization State
    const [packets, setPackets] = useState<FlyingPacket[]>([]);
    
    const isSelected = selectedId === connection.id;

    // Listen for packets via EventBus
    useEffect(() => {
        const handlePacket = (data: any) => {
            if (data.connectionId !== connection.id) return;
            
            const direction = data.fromId === connection.endpointA.peerIDHex ? 1 : -1;
            const p = data.packet;
            
            // Check if this is an Origin transmission or a Relay
            const senderHex = Array.from(p.senderID as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('');
            const isRelay = data.fromId !== senderHex;
            
            // Color Logic based on Type and TTL
            // TTL 7 -> 1
            
            let colorObj = new THREE.Color();
            let baseColor = 0xffffff;
            if (p.type === MessageType.ANNOUNCE) baseColor = 0x00ffff;
            if (p.type === MessageType.MESSAGE) baseColor = 0x00ff00;
            
            colorObj.setHex(baseColor);
            
            // Dim it based on TTL using HSL
            const hsl = { h: 0, s: 0, l: 0 };
            colorObj.getHSL(hsl);
            
            if (isRelay) {
                // Relay: Darker, desaturated
                hsl.s *= 0.5; // Desaturate
                hsl.l = 0.3;  // Fixed dimness
            } else {
                // Origin: Bright
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

    useFrame((_state, delta) => {
        // Update Line Geometry
        if (geoRef.current) {
            const posA = connection.endpointA.position;
            const posB = connection.endpointB.position;

            if (posA && posB) {
                positions[0] = posA.x; positions[1] = posA.y; positions[2] = 0;
                positions[3] = posB.x; positions[4] = posB.y; positions[5] = 0;
                geoRef.current.attributes.position.needsUpdate = true;
            }
        }
        
        // Update Packets
        if (packets.length > 0) {
            setPackets(prev => {
                const next: FlyingPacket[] = [];
                // Speed: 1 unit per second? No, inverse to length?
                // Let's say fixed speed of 100 units/sec
                const posA = connection.endpointA.position!;
                const posB = connection.endpointB.position!;
                const dx = posA.x - posB.x;
                const dy = posA.y - posB.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                const speed = 150; // faster
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

    return (
        <group>
            {/* Visual Line */}
            <line>
                <bufferGeometry ref={geoRef}>
                    <bufferAttribute
                        attach="attributes-position"
                        count={2}
                        array={positions}
                        itemSize={3}
                    />
                </bufferGeometry>
                <lineBasicMaterial 
                    color={isSelected ? 'yellow' : 'green'} 
                    transparent 
                    opacity={isSelected ? 0.8 : 0.3} 
                    linewidth={1} 
                />
            </line>
            
            {/* Click Hit Area (using wider invisible line if possible, or just the line) */}
             <line onClick={handleClick} onPointerOver={() => document.body.style.cursor = 'pointer'} onPointerOut={() => document.body.style.cursor = 'auto'}>
                 <bufferGeometry>
                    <bufferAttribute attach="attributes-position" count={2} array={positions} itemSize={3} />
                 </bufferGeometry>
                 <lineBasicMaterial transparent opacity={0} linewidth={10} /> 
             </line>

            {/* Flying Packets */}
            {packets.map(p => {
                const posA = connection.endpointA.position!;
                const posB = connection.endpointB.position!;
                // Lerp
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

