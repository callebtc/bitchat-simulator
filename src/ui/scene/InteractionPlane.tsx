import React, { useRef } from 'react';
import { ThreeEvent } from '@react-three/fiber';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { findNearestConnectionAt, findNearestPersonAt } from './pickingUtils';

export const InteractionPlane: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, isDragging, setDragging, select, highlightedId, setHighlightedId } =
        useSelection();
    const lastHoverCheckRef = useRef<number>(0);

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
            return;
        }

        // Throttled O(1) spatial-grid hover check (30 Hz max, < 0.01 ms per check)
        const now = performance.now();
        if (now - lastHoverCheckRef.current < 32) return;
        lastHoverCheckRef.current = now;

        const hovered = findNearestPersonAt(engine, e.point.x, e.point.y, 5.5);
        const nextPeerHex = hovered ? hovered.device.peerIDHex : null;
        if (nextPeerHex !== highlightedId) {
            setHighlightedId(nextPeerHex);
            document.body.style.cursor = nextPeerHex ? 'pointer' : 'default';
        }
    };

    const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
        if (isDragging) {
            e.stopPropagation();
            setDragging(false);
        }
    };

    const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
        // Left Click (0): O(1) node pick -> edge pick -> deselect
        if (e.button === 0) {
            if (!isDragging) {
                const nearestPerson = findNearestPersonAt(engine, e.point.x, e.point.y, 5.5);
                if (nearestPerson) {
                    e.stopPropagation();
                    select(nearestPerson.id, 'node');
                    setDragging(true);
                    nearestPerson.setVelocity({ x: 0, y: 0 });
                    return;
                }

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

    const handlePointerOut = () => {
        if (highlightedId !== null) {
            setHighlightedId(null);
            document.body.style.cursor = 'default';
        }
    };

    return (
        <mesh
            position={[0, 0, -1]}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerDown={handlePointerDown}
            onPointerOut={handlePointerOut}
            visible={false}
        >
            <planeGeometry args={[10000, 10000]} />
            <meshBasicMaterial color="black" transparent opacity={0} />
        </mesh>
    );
};
