import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { PersonNode } from './PersonNode';
import { ConnectionEdge } from './ConnectionEdge';
import { BuildingLayer } from './BuildingLayer';
import { PathVisualizer } from './PathVisualizer';
import { RouteVisualizer } from './RouteVisualizer';
import { BitchatConnection } from '../../simulation/BitchatConnection';
import { InteractionPlane } from './InteractionPlane';
import { ScaleUpdater } from '../hud/ScaleIndicator';
import * as THREE from 'three';

const ViewTracker: React.FC = () => {
    const { camera } = useThree();
    const { viewCenter } = useSelection();
    
    useFrame(() => {
        viewCenter.current = { x: camera.position.x, y: camera.position.y };
    });
    
    return null;
};

// WASD keyboard navigation for camera panning
interface KeyboardNavigatorProps {
    controlsRef: React.RefObject<any>;
}

const KeyboardNavigator: React.FC<KeyboardNavigatorProps> = ({ controlsRef }) => {
    const { camera } = useThree();
    const keysPressed = useRef<Set<string>>(new Set());
    
    // Base speed in world units, will be scaled by zoom
    const BASE_SPEED = 200;
    
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't capture if user is typing in an input
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            const key = e.key.toLowerCase();
            if (['w', 'a', 's', 'd'].includes(key)) {
                keysPressed.current.add(key);
            }
        };
        
        const handleKeyUp = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase();
            keysPressed.current.delete(key);
        };
        
        // Clear keys when window loses focus
        const handleBlur = () => {
            keysPressed.current.clear();
        };
        
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);
        
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
        };
    }, []);
    
    useFrame((_, delta) => {
        if (keysPressed.current.size === 0) return;
        
        // Scale speed inversely by zoom (lower zoom = zoomed out = move faster)
        const orthoCamera = camera as THREE.OrthographicCamera;
        const speed = BASE_SPEED / orthoCamera.zoom * delta;
        
        let dx = 0;
        let dy = 0;
        
        if (keysPressed.current.has('w')) dy += speed;
        if (keysPressed.current.has('s')) dy -= speed;
        if (keysPressed.current.has('a')) dx -= speed;
        if (keysPressed.current.has('d')) dx += speed;
        
        // Normalize diagonal movement
        if (dx !== 0 && dy !== 0) {
            const factor = 1 / Math.sqrt(2);
            dx *= factor;
            dy *= factor;
        }
        
        // Update both camera position and OrbitControls target for proper panning
        camera.position.x += dx;
        camera.position.y += dy;
        
        // Also update OrbitControls target to keep panning in sync
        if (controlsRef.current) {
            controlsRef.current.target.x += dx;
            controlsRef.current.target.y += dy;
        }
    });
    
    return null;
};

export const Scene: React.FC = () => {
    const engine = useSimulation();
    const { isDragging, setHighlightedId } = useSelection();
    const [personIds, setPersonIds] = useState<string[]>([]);
    const [connections, setConnections] = useState<BitchatConnection[]>([]);
    const controlsRef = useRef<any>(null);
    
    // Clear highlight when mouse leaves the canvas entirely
    // This fixes stuck hover states when pointer events don't fire properly
    const handleCanvasPointerLeave = useCallback(() => {
        setHighlightedId(null);
        document.body.style.cursor = 'default';
    }, [setHighlightedId]);

    useEffect(() => {
        // Initial state
        setPersonIds(engine.getAllPeople().map(p => p.id));
        setConnections(engine.getAllConnections());

        // Listeners
        const onPersonAdded = (p: any) => {
            setPersonIds(prev => [...prev, p.id]);
        };
        const onPersonRemoved = (id: any) => {
            setPersonIds(prev => prev.filter(pid => pid !== id));
        };
        const onConnFormed = (c: BitchatConnection) => {
            setConnections(prev => [...prev, c]);
        };
        const onConnBroken = (c: BitchatConnection) => {
            setConnections(prev => prev.filter(conn => conn !== c));
        };
        const onReset = () => {
            setPersonIds([]);
            setConnections([]);
        };

        engine.events.on('person_added', onPersonAdded);
        engine.events.on('person_removed', onPersonRemoved);
        engine.events.on('connection_formed', onConnFormed);
        engine.events.on('connection_broken', onConnBroken);
        engine.events.on('reset', onReset);

        return () => {
            engine.events.off('person_added', onPersonAdded);
            engine.events.off('person_removed', onPersonRemoved);
            engine.events.off('connection_formed', onConnFormed);
            engine.events.off('connection_broken', onConnBroken);
            engine.events.off('reset', onReset);
        };
    }, [engine]);

    return (
        <div className="w-full h-screen bg-gray-900" onPointerLeave={handleCanvasPointerLeave}>
            <Canvas>
                <OrthographicCamera makeDefault position={[0, 0, 100]} zoom={2} />
                <OrbitControls 
                    ref={controlsRef}
                    enableRotate={false} 
                    enabled={!isDragging} 
                    mouseButtons={{
                        LEFT: THREE.MOUSE.PAN,
                        MIDDLE: THREE.MOUSE.DOLLY,
                        RIGHT: THREE.MOUSE.PAN
                    }}
                />
                <ViewTracker />
                <KeyboardNavigator controlsRef={controlsRef} />
                <ScaleUpdater />
                
                <ambientLight intensity={0.5} />
                
                <InteractionPlane />

                {/* Building layer (rendered below nodes) */}
                <BuildingLayer />

                {personIds.map(id => (
                    <PersonNode key={id} id={id} />
                ))}
                
                {connections.map(conn => (
                    <ConnectionEdge key={conn.id} connection={conn} />
                ))}
                
                {/* Path visualization for hover/animation */}
                <PathVisualizer />
                
                {/* Route visualization for source-routed packet flashes */}
                <RouteVisualizer />
            </Canvas>
        </div>
    );
};
