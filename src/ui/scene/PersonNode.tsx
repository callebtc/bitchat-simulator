import React, { useRef, useMemo, useEffect } from 'react';
import { useFrame, ThreeEvent } from '@react-three/fiber';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import * as THREE from 'three';
import { Text } from '@react-three/drei';
import { getPeerColor } from '../../utils/colorUtils';

interface PersonNodeProps {
    id: string;
}

export const PersonNode: React.FC<PersonNodeProps> = ({ id }) => {
    const engine = useSimulation();
    const { selectedId, select, setDragging } = useSelection();
    const meshRef = useRef<THREE.Group>(null);
    
    // Data
    const person = engine.getPerson(id);
    const peerIdHex = person?.device.peerIDHex || id; // Fallback
    
    // Derived state
    const isSelected = selectedId === id;
    const isSomethingSelected = selectedId !== null;
    const isDimmed = isSomethingSelected && !isSelected;
    
    // Color (Use Peer ID)
    const color = useMemo(() => getPeerColor(peerIdHex), [peerIdHex]);
    
    // Knock Animation State
    const knockScale = useRef(1.0);
    
    // Listen for packet events to trigger knock
    useEffect(() => {
        const onPacket = (data: any) => {
            if (data.fromId === peerIdHex) {
                // Check if origin
                const packet = data.packet;
                const senderHex = Array.from(packet.senderID as Uint8Array)
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
                
                if (senderHex === peerIdHex) {
                    knockScale.current = 1.5; // Instant pop
                }
            }
        };
        engine.events.on('packet_transmitted', onPacket);
        return () => { engine.events.off('packet_transmitted', onPacket); };
    }, [engine, peerIdHex]);
    
    useFrame((_, delta) => {
        if (!meshRef.current || !person) return;
        
        // Decay knock
        knockScale.current += (1.0 - knockScale.current) * 10 * delta;
        
        meshRef.current.position.x = person.position.x;
        meshRef.current.position.y = person.position.y;
        
        // Apply knock + selection scale
        const baseScale = isSelected ? 1.2 : 1.0;
        meshRef.current.scale.setScalar(baseScale * knockScale.current);
    });
    
    const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation(); 
        select(id, 'node');
        setDragging(true);
        
        if (person) {
            person.setVelocity({x: 0, y: 0}); 
        }
    };

    return (
        <group ref={meshRef} scale={isSelected ? 1.2 : 1}>
            <mesh onPointerDown={handlePointerDown}>
                <circleGeometry args={[5, 32]} />
                <meshBasicMaterial 
                    color={color} 
                    transparent
                    opacity={isDimmed ? 0.4 : 1.0}
                />
            </mesh>
            <mesh>
                 <ringGeometry args={[5, isSelected ? 6 : 5.2, 32]} />
                 <meshBasicMaterial 
                    color={isSelected ? 'white' : 'black'} 
                    transparent
                    opacity={isDimmed ? 0.4 : 1.0}
                 />
            </mesh>
            <Text 
                position={[0, -8, 0]} 
                fontSize={4}
                color="white"
                anchorX="center"
                anchorY="top"
                fillOpacity={isDimmed ? 0.4 : 1.0}
            >
                {peerIdHex.substring(0, 8)}
            </Text>
        </group>
    );
};
