import React from 'react';
import { ThreeEvent } from '@react-three/fiber';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';

export const InteractionPlane: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, isDragging, setDragging, select } = useSelection();

    const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
        if (isDragging && selectedId) {
            e.stopPropagation();
            const person = engine.getPerson(selectedId);
            if (person) {
                person.position.x = e.point.x;
                person.position.y = e.point.y;
                person.setVelocity({ x: 0, y: 0 }); // Stop momentum
                person.target = null; // Cancel any target move
            }
        }
    };

    const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
        if (isDragging) {
            e.stopPropagation();
            setDragging(false);
        }
    };

    const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
        // Left Click (0): Deselect
        if (e.button === 0) {
            if (!isDragging) {
                select(null, null);
            }
        }
        
        // Right Click (2): Move Target (RTS Style)
        if (e.button === 2) {
            if (selectedId && !isDragging) {
                const person = engine.getPerson(selectedId);
                if (person) {
                    // Set target
                    person.setTarget({ x: e.point.x, y: e.point.y });
                }
            }
        }
    };

    return (
        <mesh 
            position={[0, 0, -1]} // Slightly behind everything
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerDown={handlePointerDown}
            visible={false} // Invisible but interactive
        >
            <planeGeometry args={[10000, 10000]} />
            <meshBasicMaterial color="black" transparent opacity={0} />
        </mesh>
    );
};
