import React, { useRef, useMemo, useEffect } from 'react';
import { useFrame, ThreeEvent } from '@react-three/fiber';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { useVisualization } from '../context/VisualizationContext';
import * as THREE from 'three';
import { Text } from '@react-three/drei';
import { getPeerColor } from '../../utils/colorUtils';
import { MessageType } from '../../protocol/BitchatPacket';

interface PersonNodeProps {
    id: string;
}

export const PersonNode: React.FC<PersonNodeProps> = ({ id }) => {
    const engine = useSimulation();
    const { selectedId, select, setDragging, highlightedId, setHighlightedId } = useSelection();
    const { showAnnouncePackets } = useVisualization();
    const meshRef = useRef<THREE.Group>(null);
    
    // Data
    const person = engine.getPerson(id);
    const peerIdHex = person?.device.peerIDHex || id; // Fallback
    
    // Derived state
    const isSelected = selectedId === id;
    const isHighlighted = highlightedId === peerIdHex;
    const isSomethingSelected = selectedId !== null;
    const isDimmed = isSomethingSelected && !isSelected && !isHighlighted;
    
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

                // Filter Announce Packets if visualization disabled
                if (!showAnnouncePackets && packet.type === MessageType.ANNOUNCE) return;

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
    }, [engine, peerIdHex, showAnnouncePackets]);
    
    useFrame((_, delta) => {
        if (!meshRef.current || !person) return;
        
        // Decay knock using stable exponential decay (frame-rate independent)
        const decay = 1 - Math.exp(-10 * delta);
        knockScale.current = THREE.MathUtils.lerp(knockScale.current, 1.0, decay);
        
        meshRef.current.position.x = person.position.x;
        meshRef.current.position.y = person.position.y;
        
        // Apply knock + selection scale + highlight scale
        // Highlight scale: 1.15, Selected: 1.2
        const baseScale = isSelected ? 1.2 : (isHighlighted ? 1.15 : 1.0);
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

    const handlePointerEnter = (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        setHighlightedId(peerIdHex);
        document.body.style.cursor = 'pointer';
    };

    const handlePointerLeave = (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (highlightedId === peerIdHex) {
            setHighlightedId(null);
        }
        document.body.style.cursor = 'default';
    };

    return (
        <group ref={meshRef} scale={isSelected ? 1.2 : 1}>
            <mesh 
                onPointerDown={handlePointerDown}
                onPointerEnter={handlePointerEnter}
                onPointerLeave={handlePointerLeave}
            >
                <circleGeometry args={[3.75, 32]} />
                <meshBasicMaterial 
                    color={color} 
                    transparent
                    opacity={isDimmed ? 0.4 : 1.0}
                />
            </mesh>
            <mesh>
                 <ringGeometry args={[3.75, isSelected ? 4.5 : (isHighlighted ? 4.35 : 3.9), 32]} />
                 <meshBasicMaterial 
                    color={isSelected || isHighlighted ? 'white' : 'black'} 
                    transparent
                    opacity={isDimmed ? 0.4 : 1.0}
                />
            </mesh>
            <Text 
                position={[0, -6, 0]} 
                fontSize={3}
                color={isHighlighted ? "#ffff00" : "white"}
                anchorX="center"
                anchorY="top"
                fillOpacity={isDimmed ? 0.4 : 1.0}
            >
                {peerIdHex.substring(0, 8)}
            </Text>
        </group>
    );
};
