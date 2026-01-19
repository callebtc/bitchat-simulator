import React, { useRef, useMemo } from 'react';
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
    
    // Initial color
    const baseColor = useMemo(() => new THREE.Color().setHSL(Math.random(), 0.7, 0.5), []);
    
    const isSelected = selectedId === id;

    useFrame(() => {
        if (!meshRef.current) return;
        
        const person = engine.getPerson(id);
        if (person) {
            meshRef.current.position.x = person.position.x;
            meshRef.current.position.y = person.position.y;
        }
    });
    
    const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation(); // Don't trigger background click
        select(id, 'node');
        setDragging(true);
        
        const person = engine.getPerson(id);
        if (person) {
            person.setVelocity({x: 0, y: 0}); 
            // Also stop random walk or target move? We'll handle that in Person logic update later
        }
    };

    return (
        <group ref={meshRef}>
            <mesh onPointerDown={handlePointerDown}>
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
