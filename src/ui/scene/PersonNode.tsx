import React, { useRef, useMemo, useState } from 'react';
import { useFrame, ThreeEvent } from '@react-three/fiber';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import * as THREE from 'three';
import { Text } from '@react-three/drei';

interface PersonNodeProps {
    id: string;
}

export const PersonNode: React.FC<PersonNodeProps> = ({ id }) => {
    const engine = useSimulation();
    const { selectedId, select, setDragging } = useSelection();
    const meshRef = useRef<THREE.Group>(null);
    const [localDrag, setLocalDrag] = useState(false);
    
    // Initial color
    const baseColor = useMemo(() => new THREE.Color().setHSL(Math.random(), 0.7, 0.5), []);
    
    const isSelected = selectedId === id;

    useFrame(() => {
        if (!meshRef.current) return;
        
        const person = engine.getPerson(id);
        if (person) {
            meshRef.current.position.x = person.position.x;
            meshRef.current.position.y = person.position.y;
            
            // Highlight selected
            if (isSelected) {
               // Pulse effect?
            }
        }
    });
    
    const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        select(id, 'node');
        setLocalDrag(true);
        setDragging(true);
        const person = engine.getPerson(id);
        if (person) person.setVelocity({x: 0, y: 0}); 
        
        (e.target as Element).setPointerCapture(e.pointerId);
    };
    
    const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        setLocalDrag(false);
        setDragging(false);
        (e.target as Element).releasePointerCapture(e.pointerId);
    };
    
    const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
        if (localDrag) {

            e.stopPropagation();
            const person = engine.getPerson(id);
            if (person) {
                // Update Sim State
                person.position.x = e.point.x;
                person.position.y = e.point.y;
                person.setVelocity({x:0, y:0});
            }
        }
    };

    return (
        <group ref={meshRef}>
            <mesh 
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerMove={handlePointerMove}
            >
                <circleGeometry args={[5, 32]} />
                <meshBasicMaterial color={isSelected ? 'white' : baseColor} />
            </mesh>
            <mesh>
                 <ringGeometry args={[5, isSelected ? 6 : 5.2, 32]} />
                 <meshBasicMaterial color={isSelected ? 'cyan' : 'black'} />
            </mesh>
            <Text 
                position={[0, -8, 0]} 
                fontSize={4}
                color="white"
                anchorX="center"
                anchorY="top"
            >
                {id}
            </Text>
        </group>
    );
};
