import React, { useState, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import * as THREE from 'three';
import { BitchatPacket } from '../../protocol/BitchatPacket';

const FLASH_DURATION = 800; // ms
const FLASH_COLOR = '#FFC107'; // Golden Orange

interface ActiveFlash {
    id: string;
    pathIds: string[]; // [Sender, ...Hops, Recipient]
    startTime: number;
}

export const RouteVisualizer: React.FC = () => {
    const engine = useSimulation();
    const [flashes, setFlashes] = useState<ActiveFlash[]>([]);

    useEffect(() => {
        const handlePacket = (data: { connectionId: string, packet: BitchatPacket, fromId: string }) => {
            const { packet, fromId } = data;

            // 1. Check if source-routed
            if (!packet.route || packet.route.length === 0) return;

            // 2. Check if Originator (Sender == From)
            const senderHex = Array.from(packet.senderID)
                .map(b => b.toString(16).padStart(2, '0')).join('');
            
            if (senderHex !== fromId) return;

            // 3. Construct Path IDs
            const recipientHex = packet.recipientID 
                ? Array.from(packet.recipientID).map(b => b.toString(16).padStart(2, '0')).join('')
                : null;
            
            if (!recipientHex) return; // Should not happen for routed packets

            const routeHexes = packet.route.map(r => 
                Array.from(r).map(b => b.toString(16).padStart(2, '0')).join('')
            );

            const fullPath = [senderHex, ...routeHexes, recipientHex];

            // 4. Add Flash
            setFlashes(prev => [
                ...prev,
                {
                    id: Math.random().toString(36).substr(2, 9),
                    pathIds: fullPath,
                    startTime: performance.now()
                }
            ]);
        };

        engine.events.on('packet_transmitted', handlePacket);
        return () => {
            engine.events.off('packet_transmitted', handlePacket);
        };
    }, [engine]);

    // Prune old flashes
    useFrame(() => {
        if (flashes.length === 0) return;
        const now = performance.now();
        const active = flashes.filter(f => now - f.startTime < FLASH_DURATION);
        if (active.length !== flashes.length) {
            setFlashes(active);
        }
    });

    return (
        <group>
            {flashes.map(flash => (
                <FlashInstance key={flash.id} flash={flash} />
            ))}
        </group>
    );
};

const FlashInstance: React.FC<{ flash: ActiveFlash }> = ({ flash }) => {
    const engine = useSimulation();
    const lineRef = useRef<any>(null);
    const [opacity, setOpacity] = useState(1);
    
    // Helper to find person by device ID
    const getPersonByDeviceId = (deviceIdHex: string) => {
        return engine.getAllPeople().find(p => p.device.peerIDHex === deviceIdHex);
    };
    
    // Calculate points every frame to follow moving nodes
    useFrame(() => {
        const now = performance.now();
        const elapsed = now - flash.startTime;
        const progress = Math.min(elapsed / FLASH_DURATION, 1);
        
        // Fade out
        setOpacity(1 - Math.pow(progress, 2)); // Ease out

        if (lineRef.current) {
             const currentPoints: THREE.Vector3[] = [];
             let valid = true;
             
             for (const id of flash.pathIds) {
                 const person = getPersonByDeviceId(id);
                 if (person) {
                     currentPoints.push(new THREE.Vector3(person.position.x, person.position.y, 10)); 
                 } else {
                     valid = false;
                     break;
                 }
             }

             if (valid && currentPoints.length > 1) {
                 lineRef.current.geometry.setPositions(
                     currentPoints.flatMap(p => [p.x, p.y, 10]) // Line2 expects flat array
                 );
             }
        }
    });

    // Initial check for validity to prevent render if nodes missing
    const initialPoints = flash.pathIds.map(id => {
        const p = getPersonByDeviceId(id);
        return p ? new THREE.Vector3(p.position.x, p.position.y, 10) : null;
    }).filter(Boolean) as THREE.Vector3[];

    if (initialPoints.length < 2) return null;

    return (
        <Line
            ref={lineRef}
            points={initialPoints}
            color={FLASH_COLOR}
            lineWidth={4}
            transparent
            opacity={opacity}
            depthTest={false} // Draw on top
            renderOrder={100}
        />
    );
};
