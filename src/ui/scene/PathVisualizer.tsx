/**
 * PathVisualizer
 * Shows velocity arrow and obstacle-aware walking path when hovering over a walking person.
 * Updates all Three.js geometries and opacities directly in useFrame (zero 60 FPS React setState)
 * and renders path geometry in true world space so it never drifts or cuts through buildings.
 */

import React, { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { MovementMode, BitchatPerson } from '../../simulation/BitchatPerson';
import { hasLineOfSight } from '../../simulation/environment/LineOfSight';
import { Point } from '../../simulation/types';
import * as THREE from 'three';

const noopRaycast = () => null;

const VELOCITY_COLOR = '#22c55e'; // Emerald
const PATH_COLOR = '#10b981'; // Teal-emerald (visually distinct from DM probe colors)
const ARROW_LENGTH_SCALE = 0.5;
const ARROW_HEAD_SIZE = 3;
const PATH_OPACITY = 0.65;
const ANIMATION_DURATION = 1000; // ms
const ANIMATION_REVEAL = 300; // ms

interface AnimatedPath {
    personId: string;
    waypoints: Point[];
    target: Point;
    startTime: number;
}

export const PathVisualizer: React.FC = () => {
    const engine = useSimulation();
    const { highlightedId, isPickingRecipient } = useSelection();
    const [animatedPath, setAnimatedPath] = useState<AnimatedPath | null>(null);

    const hoveredPerson = useMemo(() => {
        if (!highlightedId || isPickingRecipient) return null;
        return engine.getPersonByPeerId(highlightedId) ?? null;
    }, [highlightedId, isPickingRecipient, engine]);

    // Subscribe to user-initiated TARGET path calculations (skip automatic BUSY/RANDOM_WALK recalculations)
    useEffect(() => {
        const attach = (person: BitchatPerson) => {
            person.onPathCalculated = (path: Point[], target: Point) => {
                if (person.mode !== MovementMode.TARGET) return;
                setAnimatedPath({
                    personId: person.id,
                    waypoints: path,
                    target,
                    startTime: performance.now(),
                });
            };
        };

        const people = engine.getAllPeople();
        for (let i = 0; i < people.length; i++) {
            attach(people[i]);
        }

        const onPersonAdded = (person: BitchatPerson) => attach(person);
        const onReset = () => setAnimatedPath(null);

        engine.events.on('person_added', onPersonAdded);
        engine.events.on('reset', onReset);

        return () => {
            engine.events.off('person_added', onPersonAdded);
            engine.events.off('reset', onReset);
            const current = engine.getAllPeople();
            for (let i = 0; i < current.length; i++) {
                current[i].onPathCalculated = undefined;
            }
        };
    }, [engine]);

    return (
        <group name="walking-path-visualizer">
            {hoveredPerson && <HoverVisualization person={hoveredPerson} />}
            {animatedPath && (
                <PathAnimation path={animatedPath} onComplete={() => setAnimatedPath(null)} />
            )}
        </group>
    );
};

/** Compute valid remaining walking path points, never drawing straight through buildings. */
function getSafeWalkingPath(
    person: BitchatPerson,
    engine: ReturnType<typeof useSimulation>
): Point[] | null {
    const remaining = person.getRemainingPath();
    if (remaining && remaining.length >= 2) {
        return remaining;
    }

    if (person.target) {
        if (engine.environment.getBuildingCount() === 0) {
            return [
                { x: person.position.x, y: person.position.y },
                { x: person.target.x, y: person.target.y },
            ];
        }
        const candidates = engine.environment.getBuildingsInPath(person.position, person.target);
        if (candidates.length === 0 || hasLineOfSight(person.position, person.target, candidates)) {
            return [
                { x: person.position.x, y: person.position.y },
                { x: person.target.x, y: person.target.y },
            ];
        }
    }

    return null;
}

/** World-space hover overlay for walking direction + obstacle-avoiding waypoint path. */
const HoverVisualization: React.FC<{ person: BitchatPerson }> = ({ person }) => {
    const engine = useSimulation();
    const arrowHolderRef = useRef<THREE.Group>(null);
    const arrowRef = useRef<THREE.Group>(null);
    const lineRef = useRef<any>(null);
    const targetGroupRef = useRef<THREE.Group>(null);
    const targetRingRef = useRef<THREE.Mesh>(null);
    const waypointDotsRef = useRef<THREE.InstancedMesh>(null);

    const [pathSignature, setPathSignature] = useState<string>('');
    const lastSigRef = useRef<string>('');

    const { dotGeo, dummyMatrix } = useMemo(
        () => ({
            dotGeo: new THREE.CircleGeometry(1.4, 12),
            dummyMatrix: new THREE.Matrix4(),
        }),
        []
    );

    useEffect(() => () => dotGeo.dispose(), [dotGeo]);

    // Initial points snapshot when waypoint count or target changes
    const initialPath = useMemo(() => {
        void pathSignature;
        return getSafeWalkingPath(person, engine);
    }, [person, engine, pathSignature]);

    const initialLinePoints = useMemo(() => {
        if (!initialPath || initialPath.length < 2) return null;
        return initialPath.map(p => new THREE.Vector3(p.x, p.y, 1.5));
    }, [initialPath]);

    useFrame(({ clock }) => {
        const isMoving = person.mode !== MovementMode.STILL;

        // 1. Update velocity arrow in place (zero React state updates)
        if (arrowHolderRef.current) {
            arrowHolderRef.current.position.set(person.position.x, person.position.y, 2.2);
        }
        if (arrowRef.current) {
            const vx = person.velocity.x;
            const vy = person.velocity.y;
            const speed = Math.sqrt(vx * vx + vy * vy);
            const show = isMoving && speed > 0.1;
            arrowRef.current.visible = show;
            if (show) {
                arrowRef.current.rotation.z = Math.atan2(vy, vx);
                const length = Math.min(speed * ARROW_LENGTH_SCALE, 20);
                arrowRef.current.scale.set(length / 10, 1, 1);
            }
        }

        // 2. Check if waypoint count/target changed (only triggers React remount when topology changes)
        const activePath = getSafeWalkingPath(person, engine);
        const sig = activePath
            ? `${activePath.length}:${activePath[activePath.length - 1].x.toFixed(1)},${activePath[activePath.length - 1].y.toFixed(1)}`
            : 'none';
        if (sig !== lastSigRef.current) {
            lastSigRef.current = sig;
            setPathSignature(sig);
        }

        // 3. Smoothly update world-space line positions, intermediate waypoint dots, and target ring
        if (activePath && activePath.length >= 2) {
            if (lineRef.current?.geometry?.setPositions) {
                const flat: number[] = [];
                for (let i = 0; i < activePath.length; i++) {
                    flat.push(activePath[i].x, activePath[i].y, 1.5);
                }
                lineRef.current.geometry.setPositions(flat);
                if (lineRef.current.computeLineDistances) {
                    lineRef.current.computeLineDistances();
                }
            }

            if (waypointDotsRef.current) {
                let dotCount = 0;
                for (let i = 1; i < activePath.length - 1 && dotCount < 32; i++) {
                    dummyMatrix.makeTranslation(activePath[i].x, activePath[i].y, 1.6);
                    waypointDotsRef.current.setMatrixAt(dotCount++, dummyMatrix);
                }
                waypointDotsRef.current.count = dotCount;
                if (dotCount > 0) {
                    waypointDotsRef.current.instanceMatrix.needsUpdate = true;
                }
            }

            const lastPt = activePath[activePath.length - 1];
            if (targetGroupRef.current) {
                targetGroupRef.current.visible = true;
                targetGroupRef.current.position.set(lastPt.x, lastPt.y, 1.6);
            }
            if (targetRingRef.current) {
                const pulse = 1 + Math.sin(clock.elapsedTime * 4) * 0.18;
                targetRingRef.current.scale.setScalar(pulse);
            }
        } else {
            if (targetGroupRef.current) targetGroupRef.current.visible = false;
            if (waypointDotsRef.current) waypointDotsRef.current.count = 0;
        }
    });

    return (
        <group>
            {/* Velocity Arrow attached to person's position */}
            <group ref={arrowHolderRef} position={[person.position.x, person.position.y, 2.2]}>
                <group ref={arrowRef} visible={false}>
                    <VelocityArrow />
                </group>
            </group>

            {/* True world-space walking path (never nested under moving person transform) */}
            {initialLinePoints && (
                <Line
                    key={pathSignature}
                    ref={lineRef}
                    points={initialLinePoints}
                    color={PATH_COLOR}
                    lineWidth={2}
                    dashed
                    dashSize={3}
                    gapSize={2}
                    transparent
                    opacity={PATH_OPACITY}
                    raycast={noopRaycast}
                />
            )}

            {/* Intermediate corner waypoint dots */}
            <instancedMesh
                ref={waypointDotsRef}
                args={[dotGeo, undefined, 32]}
                frustumCulled={false}
                raycast={noopRaycast}
            >
                <meshBasicMaterial color={PATH_COLOR} transparent opacity={0.85} />
            </instancedMesh>

            {/* Pulsing destination marker */}
            <group ref={targetGroupRef} visible={false}>
                <mesh ref={targetRingRef} raycast={noopRaycast}>
                    <ringGeometry args={[3.6, 4.6, 20]} />
                    <meshBasicMaterial color={PATH_COLOR} transparent opacity={PATH_OPACITY} />
                </mesh>
                <mesh raycast={noopRaycast}>
                    <circleGeometry args={[1.8, 16]} />
                    <meshBasicMaterial color={PATH_COLOR} transparent opacity={PATH_OPACITY * 0.55} />
                </mesh>
            </group>
        </group>
    );
};

const VelocityArrow: React.FC = () => {
    const points = useMemo(
        () => [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(10, 0, 0),
            new THREE.Vector3(10 - ARROW_HEAD_SIZE, ARROW_HEAD_SIZE / 2, 0),
            new THREE.Vector3(10, 0, 0),
            new THREE.Vector3(10 - ARROW_HEAD_SIZE, -ARROW_HEAD_SIZE / 2, 0),
        ],
        []
    );

    return <Line points={points} color={VELOCITY_COLOR} lineWidth={3} raycast={noopRaycast} />;
};

/** Animated path reveal when user right-clicks a new TARGET destination (zero 60 FPS setState). */
const PathAnimation: React.FC<{ path: AnimatedPath; onComplete: () => void }> = ({
    path,
    onComplete,
}) => {
    const lineRef = useRef<any>(null);
    const ringRef = useRef<THREE.Mesh>(null);
    const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);
    const dotMatRef = useRef<THREE.MeshBasicMaterial>(null);
    const completedRef = useRef(false);

    const pathPoints = useMemo(() => {
        return path.waypoints.map(p => new THREE.Vector3(p.x, p.y, 1.8));
    }, [path.waypoints]);

    useFrame(({ clock }) => {
        if (completedRef.current) return;
        const elapsed = performance.now() - path.startTime;

        if (elapsed > ANIMATION_DURATION) {
            completedRef.current = true;
            onComplete();
            return;
        }

        const opacity =
            elapsed < ANIMATION_REVEAL
                ? PATH_OPACITY
                : PATH_OPACITY * (1 - (elapsed - ANIMATION_REVEAL) / (ANIMATION_DURATION - ANIMATION_REVEAL));

        if (lineRef.current?.material) {
            lineRef.current.material.opacity = opacity;
        }
        if (ringMatRef.current) {
            ringMatRef.current.opacity = opacity;
        }
        if (dotMatRef.current) {
            dotMatRef.current.opacity = opacity * 0.5;
        }
        if (ringRef.current) {
            const pulse = 1 + Math.sin(clock.elapsedTime * 4) * 0.2;
            ringRef.current.scale.setScalar(pulse);
        }
    });

    if (pathPoints.length < 2) return null;

    return (
        <group>
            <Line
                ref={lineRef}
                points={pathPoints}
                color={PATH_COLOR}
                lineWidth={2.5}
                dashed
                dashSize={3}
                gapSize={2}
                transparent
                opacity={PATH_OPACITY}
                raycast={noopRaycast}
            />
            <group position={[path.target.x, path.target.y, 1.8]}>
                <mesh ref={ringRef} raycast={noopRaycast}>
                    <ringGeometry args={[4, 5, 16]} />
                    <meshBasicMaterial
                        ref={ringMatRef}
                        color={PATH_COLOR}
                        transparent
                        opacity={PATH_OPACITY}
                    />
                </mesh>
                <mesh raycast={noopRaycast}>
                    <circleGeometry args={[2, 16]} />
                    <meshBasicMaterial
                        ref={dotMatRef}
                        color={PATH_COLOR}
                        transparent
                        opacity={PATH_OPACITY * 0.5}
                    />
                </mesh>
            </group>
        </group>
    );
};
