import React, { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { PersonNode } from './PersonNode';
import { ConnectionEdge } from './ConnectionEdge';
import { BitchatConnection } from '../../simulation/BitchatConnection';

export const Scene: React.FC = () => {
    const engine = useSimulation();
    const { isDragging } = useSelection();
    const [personIds, setPersonIds] = useState<string[]>([]);
    const [connections, setConnections] = useState<BitchatConnection[]>([]);

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
        <div className="w-full h-screen bg-gray-900">
            <Canvas>
                <OrthographicCamera makeDefault position={[0, 0, 100]} zoom={2} />
                <OrbitControls enableRotate={false} enabled={!isDragging} />
                
                <ambientLight intensity={0.5} />
                
                {personIds.map(id => (
                    <PersonNode key={id} id={id} />
                ))}
                
                {connections.map(conn => (
                    <ConnectionEdge key={conn.id} connection={conn} />
                ))}
            </Canvas>
        </div>
    );
};
