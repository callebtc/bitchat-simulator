import React from 'react';
import { ThreeEvent } from '@react-three/fiber';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { findNearestConnectionAt } from './InstancedMeshLayer';

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
                person.setVelocity({ x: 0, y: 0 });
                person.target = null;
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
        // Left Click (0): Pick nearest connection if clicked close to an edge, else deselect
        if (e.button === 0) {
            if (!isDragging) {
                const nearestConn = findNearestConnectionAt(
                    engine.getAllConnections(),
                    e.point.x,
                    e.point.y,
                    4.5
                );
                if (nearestConn) {
                    select(nearestConn.id, 'connection');
                } else {
                    select(null, null);
                }
            }
        }

        // Right Click (2): Move Target (RTS Style)
        if (e.button === 2) {
            if (selectedId && !isDragging) {
                const person = engine.getPerson(selectedId);
                if (person) {
                    person.setTarget({ x: e.point.x, y: e.point.y });
                }
            }
        }
    };

    return (
        <mesh
            position={[0, 0, -1]}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerDown={handlePointerDown}
            visible={false}
        >
            <planeGeometry args={[10000, 10000]} />
            <meshBasicMaterial color="black" transparent opacity={0} />
        </mesh>
    );
};
