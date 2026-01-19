import React, { useRef, useMemo, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BitchatConnection } from '../../simulation/BitchatConnection';
import { BitchatDevice } from '../../simulation/BitchatDevice';
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
}

export const ConnectionEdge: React.FC<ConnectionEdgeProps> = ({ connection }) => {
    const geoRef = useRef<THREE.BufferGeometry>(null);
    const { selectedId, select } = useSelection();
    
    // Packet Visualization State
    const [packets, setPackets] = useState<FlyingPacket[]>([]);
    
    const isSelected = selectedId === connection.id;

    // Listen for packets
    useEffect(() => {
        const handlePacket = (p: any, from: BitchatDevice) => {
            const direction = from === connection.endpointA ? 1 : -1;
            let color = 'white';
            if (p.type === MessageType.ANNOUNCE) color = '#00ffff'; // Cyan
            if (p.type === MessageType.MESSAGE) color = '#00ff00'; // Green
            
            setPackets(prev => [
                ...prev, 
                { id: Math.random().toString(), progress: 0, direction, color }
            ]);
        };
        
        connection.onPacketSent = handlePacket;
        return () => { connection.onPacketSent = undefined; };
    }, [connection]);

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
                // Let's say fixed speed of 50 units/sec
                const posA = connection.endpointA.position!;
                const posB = connection.endpointB.position!;
                const dx = posA.x - posB.x;
                const dy = posA.y - posB.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                const speed = 100; // units per sec
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
            
            {/* Hit Area (Thick invisible line) - using a simple cylinder scaled to match? 
                Too complex to update cylinder orientation every frame in React without heavy calc.
                Alternative: Line with linewidth? WebGL linewidth is limited to 1 on many browsers.
                Alternative: MeshLine?
                Simple Hack: Just use the line. Raycasting usually has a threshold.
                If flaky, we can assume users click nodes mostly. 
                Let's stick to standard line events, ThreeJS Raycaster 'params.Line.threshold' can be adjusted globally.
             */}
             <line onClick={handleClick} onPointerOver={() => document.body.style.cursor = 'pointer'} onPointerOut={() => document.body.style.cursor = 'auto'}>
                 <bufferGeometry>
                    <bufferAttribute attach="attributes-position" count={2} array={positions} itemSize={3} />
                 </bufferGeometry>
                 <lineBasicMaterial transparent opacity={0} />
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
                        <sphereGeometry args={[1.5, 8, 8]} />
                        <meshBasicMaterial color={p.color} />
                    </mesh>
                );
            })}
        </group>
    );
};

