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
    // Only show path animation for user-initiated navigation (TARGET mode), not BUSY mode
    useEffect(() => {
        const people = engine.getAllPeople();
        
        const callbacks: { person: BitchatPerson; callback: () => void }[] = [];
        
        const createCallback = (person: BitchatPerson) => (path: Point[], target: Point) => {
            // Skip animation for BUSY mode - these are automatic and would cause flickering
            if (person.mode === MovementMode.BUSY) return;
            
            setAnimatedPath({
                personId: person.id,
                waypoints: path,
                target,
                startTime: performance.now(),
            });
        };
        
        for (const person of people) {
            const callback = createCallback(person);
            person.onPathCalculated = callback;
            callbacks.push({ person, callback: () => { person.onPathCalculated = undefined; } });
        }
        
        // Listen for new people
        const onPersonAdded = (person: BitchatPerson) => {
            const callback = createCallback(person);
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
    const [currentPos, setCurrentPos] = useState({ x: person.position.x, y: person.position.y });
    
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
            
            // Only show arrow if speed is significant (> 0.1)
            const isVisible = speed > 0.1;
            arrowRef.current.visible = isVisible;
            
            if (isVisible) {
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
        
        // Track position for line updates
        setCurrentPos({ x: person.position.x, y: person.position.y });
    });

    // Build path points for the line: use path if available, otherwise direct line to target
    const linePoints = useMemo(() => {
        // If we have a remaining path, use it
        if (remainingPath && remainingPath.length >= 2) {
            return remainingPath.map(p => new THREE.Vector3(p.x, p.y, 0.5));
        }
        // Otherwise, if we have a target, draw direct line
        if (person.target) {
            return [
                new THREE.Vector3(currentPos.x, currentPos.y, 0.5),
                new THREE.Vector3(person.target.x, person.target.y, 0.5)
            ];
        }
        return null;
    }, [remainingPath, person.target, currentPos.x, currentPos.y]);
    
    // Determine the target position for the marker
    const targetPosition = person.target || (remainingPath && remainingPath.length > 0 ? remainingPath[remainingPath.length - 1] : null);

    return (
        <group ref={groupRef}>
            {/* Velocity Arrow */}
            {isMoving && (
                <group ref={arrowRef}>
                    <VelocityArrow />
                </group>
            )}
            
            {/* Path/Target Line - always in world coordinates */}
            {linePoints && linePoints.length >= 2 && (
                <group position={[-currentPos.x, -currentPos.y, 0]}>
                    <Line
                        points={linePoints}
                        color={PATH_COLOR}
                        lineWidth={2}
                        dashed
                        dashSize={3}
                        gapSize={2}
                        transparent
                        opacity={PATH_OPACITY}
                    />
                    {/* Target marker */}
                    {targetPosition && (
                        <TargetMarker position={targetPosition} />
                    )}
                </group>
            )}
        </group>
    );
};

/** Arrow shape for velocity visualization */
const VelocityArrow: React.FC = () => {
    const points = useMemo(() => [
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(10, 0, 1),
        new THREE.Vector3(10 - ARROW_HEAD_SIZE, ARROW_HEAD_SIZE / 2, 1),
        new THREE.Vector3(10, 0, 1),
        new THREE.Vector3(10 - ARROW_HEAD_SIZE, -ARROW_HEAD_SIZE / 2, 1)
    ], []);

    return (
        <Line 
            points={points} 
            color={VELOCITY_COLOR} 
            lineWidth={3} 
        />
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

/** Animated path reveal when a new path is calculated - same style as hover */
const PathAnimation: React.FC<{ path: AnimatedPath; onComplete: () => void }> = ({ path, onComplete }) => {
    const [opacity, setOpacity] = useState(1);
    const ringRef = useRef<THREE.Mesh>(null);
    
    const pathPoints = useMemo(() => {
        return path.waypoints.map(p => new THREE.Vector3(p.x, p.y, 0.6));
    }, [path.waypoints]);
    
    useFrame(({ clock }) => {
        const elapsed = performance.now() - path.startTime;
        
        if (elapsed > ANIMATION_DURATION) {
            onComplete();
            return;
        }
        
        if (elapsed < ANIMATION_REVEAL) {
            // Reveal phase: full opacity
            setOpacity(PATH_OPACITY);
        } else {
            // Fade phase
            const fadeProgress = (elapsed - ANIMATION_REVEAL) / (ANIMATION_DURATION - ANIMATION_REVEAL);
            setOpacity(PATH_OPACITY * (1 - fadeProgress));
        }
        
        // Pulse the target marker
        if (ringRef.current) {
            const pulse = 1 + Math.sin(clock.elapsedTime * 4) * 0.2;
            ringRef.current.scale.setScalar(pulse);
        }
    });
    
    if (pathPoints.length < 2) return null;
    
    return (
        <group>
            {/* Dashed path line - same style as hover */}
            <Line
                points={pathPoints}
                color={PATH_COLOR}
                lineWidth={2}
                dashed
                dashSize={3}
                gapSize={2}
                transparent
                opacity={opacity}
            />
            {/* Target marker - same style as hover */}
            <group position={[path.target.x, path.target.y, 0.6]}>
                <mesh ref={ringRef}>
                    <ringGeometry args={[4, 5, 16]} />
                    <meshBasicMaterial 
                        color={PATH_COLOR} 
                        transparent 
                        opacity={opacity} 
                    />
                </mesh>
                <mesh>
                    <circleGeometry args={[2, 16]} />
                    <meshBasicMaterial 
                        color={PATH_COLOR} 
                        transparent 
                        opacity={opacity * 0.5} 
                    />
                </mesh>
            </group>
        </group>
    );
};
