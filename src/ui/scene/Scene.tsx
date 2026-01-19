import React, { useEffect, useState, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { PersonNode } from './PersonNode';
import { ConnectionEdge } from './ConnectionEdge';
import { BuildingLayer } from './BuildingLayer';
import { PathVisualizer } from './PathVisualizer';
import { BitchatConnection } from '../../simulation/BitchatConnection';
import { InteractionPlane } from './InteractionPlane';
import { ScaleUpdater } from '../hud/ScaleIndicator';
import * as THREE from 'three';

const ViewTracker: React.FC = () => {
    const { camera } = useThree();
    const { setViewCenter } = useSelection();
    
    useFrame(() => {
        setViewCenter({ x: camera.position.x, y: camera.position.y });
    });
    
    return null;
};

export const Scene: React.FC = () => {
    const engine = useSimulation();
    const { isDragging, setHighlightedId } = useSelection();
    const [personIds, setPersonIds] = useState<string[]>([]);
    const [connections, setConnections] = useState<BitchatConnection[]>([]);
    
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
                    enableRotate={false} 
                    enabled={!isDragging} 
                    mouseButtons={{
                        LEFT: THREE.MOUSE.PAN,
                        MIDDLE: THREE.MOUSE.DOLLY,
                        RIGHT: THREE.MOUSE.PAN
                    }}
                />
                <ViewTracker />
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
            </Canvas>
        </div>
    );
};
