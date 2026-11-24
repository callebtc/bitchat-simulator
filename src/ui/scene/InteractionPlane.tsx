import React, { useEffect, useRef } from 'react';
import { ThreeEvent, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { findNearestConnectionAt, findNearestPersonAt } from './pickingUtils';

const DRAG_THRESHOLD_PX = 5;

export const InteractionPlane: React.FC = () => {
    const engine = useSimulation();
    const { camera } = useThree();
    const {
        selectedId,
        selectionType,
        isDragging,
        setDragging,
        select,
        setChatRecipientId,
        isPickingRecipient,
        setPickingRecipient,
        highlightedId,
        setHighlightedId,
    } = useSelection();

    const lastHoverCheckRef = useRef<number>(0);
    const dragCandidateRef = useRef<{
        personId: string;
        startClientX: number;
        startClientY: number;
    } | null>(null);

    // Cancel recipient picking on ESC
    useEffect(() => {
        if (!isPickingRecipient) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setPickingRecipient(false);
                document.body.style.cursor = 'default';
            }
        };
        document.body.style.cursor = 'crosshair';
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            document.body.style.cursor = 'default';
        };
    }, [isPickingRecipient, setPickingRecipient]);

    const getZoomScaledHitRadius = (baseMeters: number): number => {
        const ortho = camera as THREE.OrthographicCamera;
        const zoom = ortho && typeof ortho.zoom === 'number' && ortho.zoom > 0 ? ortho.zoom : 2;
        return Math.max(baseMeters, Math.min(20, 11 / zoom));
    };

    const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
        // Promote click on selected node into a drag only once mouse moves past threshold
        // (prevents simple clicks from freezing walking/BUSY nodes into MANUAL mode!)
        if (!isDragging && dragCandidateRef.current) {
            const dxPx = e.clientX - dragCandidateRef.current.startClientX;
            const dyPx = e.clientY - dragCandidateRef.current.startClientY;
            if (dxPx * dxPx + dyPx * dyPx >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
                const candidate = engine.getPerson(dragCandidateRef.current.personId);
                if (candidate) {
                    setDragging(true);
                    candidate.setVelocity({ x: 0, y: 0 });
                }
            }
        }

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

        const hitRadius = getZoomScaledHitRadius(5.5);
        const hovered = findNearestPersonAt(engine, e.point.x, e.point.y, hitRadius);
        const nextPeerHex = hovered ? hovered.device.peerIDHex : null;
        if (nextPeerHex !== highlightedId) {
            setHighlightedId(nextPeerHex);
            document.body.style.cursor = isPickingRecipient
                ? 'crosshair'
                : nextPeerHex
                  ? 'pointer'
                  : 'default';
        }
    };

    const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
        dragCandidateRef.current = null;
        if (isDragging) {
            e.stopPropagation();
            setDragging(false);
        }
    };

    const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
        // Left Click (0): 2-click DM workflow + O(1) node/edge picking
        if (e.button === 0 && !isDragging) {
            const nodeHitRadius = getZoomScaledHitRadius(5.5);
            const nearestPerson = findNearestPersonAt(engine, e.point.x, e.point.y, nodeHitRadius);

            // Case 1: Explicit "Pick DM Recipient" mode (clicked To: field)
            if (isPickingRecipient) {
                e.stopPropagation();
                if (nearestPerson && nearestPerson.id !== selectedId) {
                    setChatRecipientId(nearestPerson.device.peerIDHex);
                }
                setPickingRecipient(false);
                document.body.style.cursor = nearestPerson ? 'pointer' : 'default';
                return;
            }

            if (nearestPerson) {
                e.stopPropagation();

                // Case 2: Sender Node A is already selected and user clicked a SECOND node B ->
                // immediately set B as the DM recipient (unless Alt+Click to switch sender directly).
                if (
                    selectedId &&
                    selectionType === 'node' &&
                    nearestPerson.id !== selectedId &&
                    !e.altKey
                ) {
                    setChatRecipientId(nearestPerson.device.peerIDHex);
                    return;
                }

                // Case 3: First click (or clicking same node A, or Alt+Click) -> select sender A
                select(nearestPerson.id, 'node');
                dragCandidateRef.current = {
                    personId: nearestPerson.id,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                };
                return;
            }

            // Clicking an active connection edge inspects it
            const edgeHitRadius = getZoomScaledHitRadius(4.5);
            const nearestConn = findNearestConnectionAt(
                engine.getAllConnections(),
                e.point.x,
                e.point.y,
                edgeHitRadius
            );
            if (nearestConn) {
                select(nearestConn.id, 'connection');
            } else {
                // Clicking empty map clears selection so next click picks a fresh sender node
                select(null, null);
            }
        }

        // Right Click (2): Move Target (RTS Style)
        if (e.button === 2) {
            if (selectedId && selectionType === 'node' && !isDragging) {
                const person = engine.getPerson(selectedId);
                if (person) {
                    person.setTarget({ x: e.point.x, y: e.point.y });
                }
            }
        }
    };

    const handlePointerOut = () => {
        dragCandidateRef.current = null;
        if (highlightedId !== null) {
            setHighlightedId(null);
            if (!isPickingRecipient) {
                document.body.style.cursor = 'default';
            }
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
