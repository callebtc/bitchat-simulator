/**
 * PathVisualizer
 * Shows velocity arrows and ghost paths when hovering over walking persons.
 */

import React, { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { MovementMode, BitchatPerson } from '../../simulation/BitchatPerson';
import { Point } from '../../simulation/types';
import * as THREE from 'three';

/** Visual style constants */
const VELOCITY_COLOR = '#22c55e';  // Green
const PATH_COLOR = '#06b6d4';      // Cyan
const ARROW_LENGTH_SCALE = 0.5;    // Velocity to arrow length multiplier
const ARROW_HEAD_SIZE = 3;
const PATH_OPACITY = 0.5;
const ANIMATION_DURATION = 1000;   // ms
const ANIMATION_REVEAL = 300;      // ms for reveal phase

interface AnimatedPath {
    personId: string;
    waypoints: Point[];
    target: Point;
    startTime: number;
}

export const PathVisualizer: React.FC = () => {
    const engine = useSimulation();
    const { highlightedId } = useSelection();
    const [animatedPath, setAnimatedPath] = useState<AnimatedPath | null>(null);
    
    // Find the person being hovered (match by peerIdHex)
    const hoveredPerson = useMemo(() => {
        if (!highlightedId) return null;
        return engine.getAllPeople().find(p => p.device.peerIDHex === highlightedId) ?? null;
    }, [highlightedId, engine]);

    // Subscribe to path calculation events
    useEffect(() => {
        const people = engine.getAllPeople();
        
        const callbacks: { person: BitchatPerson; callback: () => void }[] = [];
        
        for (const person of people) {
            const callback = (path: Point[], target: Point) => {
                setAnimatedPath({
                    personId: person.id,
                    waypoints: path,
                    target,
                    startTime: performance.now(),
                });
            };
            person.onPathCalculated = callback;
            callbacks.push({ person, callback: () => { person.onPathCalculated = undefined; } });
        }
        
        // Listen for new people
        const onPersonAdded = (person: BitchatPerson) => {
            const callback = (path: Point[], target: Point) => {
                setAnimatedPath({
                    personId: person.id,
                    waypoints: path,
                    target,
                    startTime: performance.now(),
                });
            };
            person.onPathCalculated = callback;
            callbacks.push({ person, callback: () => { person.onPathCalculated = undefined; } });
        };
        
        engine.events.on('person_added', onPersonAdded);
        
        return () => {
            engine.events.off('person_added', onPersonAdded);
            callbacks.forEach(({ callback }) => callback());
        };
    }, [engine]);

    return (
        <group>
            {/* Hover visualization for selected person */}
            {hoveredPerson && (
                <HoverVisualization person={hoveredPerson} />
            )}
            
            {/* Path reveal animation */}
            {animatedPath && (
                <PathAnimation 
                    path={animatedPath} 
                    onComplete={() => setAnimatedPath(null)}
                />
            )}
        </group>
    );
};

/** Visualization shown when hovering over a walking person */
const HoverVisualization: React.FC<{ person: BitchatPerson }> = ({ person }) => {
    const groupRef = useRef<THREE.Group>(null);
    const arrowRef = useRef<THREE.Group>(null);
    
    // Determine if person is moving
    const isMoving = person.mode !== MovementMode.STILL;
    
    // Get remaining path
    const remainingPath = person.getRemainingPath();
    
    useFrame(() => {
        if (!groupRef.current) return;
        
        // Update arrow position/rotation based on velocity
        if (arrowRef.current && isMoving) {
            const vx = person.velocity.x;
            const vy = person.velocity.y;
            const speed = Math.sqrt(vx * vx + vy * vy);
            
            if (speed > 0.1) {
                const angle = Math.atan2(vy, vx);
                arrowRef.current.rotation.z = angle;
                
                // Scale arrow by speed
                const length = Math.min(speed * ARROW_LENGTH_SCALE, 20);
                arrowRef.current.scale.x = length / 10; // Normalize
            }
        }
        
        // Update group position to follow person
        groupRef.current.position.x = person.position.x;
        groupRef.current.position.y = person.position.y;
    });

    // Build path points for the line
    const pathPoints = useMemo(() => {
        if (!remainingPath || remainingPath.length < 2) return null;
        return remainingPath.map(p => new THREE.Vector3(p.x, p.y, 0.5));
    }, [remainingPath]);

    return (
        <group ref={groupRef}>
            {/* Velocity Arrow */}
            {isMoving && (
                <group ref={arrowRef}>
                    <VelocityArrow />
                </group>
            )}
            
            {/* Ghost Path (relative to current position, so need world coords) */}
            {pathPoints && pathPoints.length >= 2 && (
                <group position={[-person.position.x, -person.position.y, 0]}>
                    <Line
                        points={pathPoints}
                        color={PATH_COLOR}
                        lineWidth={2}
                        dashed
                        dashSize={3}
                        gapSize={2}
                        transparent
                        opacity={PATH_OPACITY}
                    />
                    {/* Target marker */}
                    {person.target && (
                        <TargetMarker position={person.target} />
                    )}
                </group>
            )}
        </group>
    );
};

/** Arrow shape for velocity visualization */
const VelocityArrow: React.FC = () => {
    return (
        <line>
            <bufferGeometry>
                <bufferAttribute
                    attach="attributes-position"
                    count={5}
                    array={new Float32Array([
                        0, 0, 1,
                        10, 0, 1,
                        10 - ARROW_HEAD_SIZE, ARROW_HEAD_SIZE / 2, 1,
                        10, 0, 1,
                        10 - ARROW_HEAD_SIZE, -ARROW_HEAD_SIZE / 2, 1,
                    ])}
                    itemSize={3}
                />
            </bufferGeometry>
            <lineBasicMaterial color={VELOCITY_COLOR} linewidth={2} />
        </line>
    );
};

/** Pulsing target marker */
const TargetMarker: React.FC<{ position: Point }> = ({ position }) => {
    const ringRef = useRef<THREE.Mesh>(null);
    
    useFrame(({ clock }) => {
        if (!ringRef.current) return;
        const pulse = 1 + Math.sin(clock.elapsedTime * 4) * 0.2;
        ringRef.current.scale.setScalar(pulse);
    });
    
    return (
        <group position={[position.x, position.y, 0.5]}>
            <mesh ref={ringRef}>
                <ringGeometry args={[4, 5, 16]} />
                <meshBasicMaterial 
                    color={PATH_COLOR} 
                    transparent 
                    opacity={PATH_OPACITY} 
                />
            </mesh>
            {/* Center dot */}
            <mesh>
                <circleGeometry args={[2, 16]} />
                <meshBasicMaterial 
                    color={PATH_COLOR} 
                    transparent 
                    opacity={PATH_OPACITY * 0.5} 
                />
            </mesh>
        </group>
    );
};

/** Animated path reveal when a new path is calculated */
const PathAnimation: React.FC<{ path: AnimatedPath; onComplete: () => void }> = ({ path, onComplete }) => {
    const [opacity, setOpacity] = useState(1);
    
    const pathPoints = useMemo(() => {
        return path.waypoints.map(p => new THREE.Vector3(p.x, p.y, 0.6));
    }, [path.waypoints]);
    
    useFrame(() => {
        const elapsed = performance.now() - path.startTime;
        
        if (elapsed > ANIMATION_DURATION) {
            onComplete();
            return;
        }
        
        if (elapsed < ANIMATION_REVEAL) {
            // Reveal phase: full opacity
            setOpacity(1);
        } else {
            // Fade phase
            const fadeProgress = (elapsed - ANIMATION_REVEAL) / (ANIMATION_DURATION - ANIMATION_REVEAL);
            setOpacity(1 - fadeProgress);
        }
    });
    
    if (pathPoints.length < 2) return null;
    
    return (
        <Line
            points={pathPoints}
            color={PATH_COLOR}
            lineWidth={3}
            transparent
            opacity={opacity}
        />
    );
};
