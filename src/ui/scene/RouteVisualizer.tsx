import React, { useState, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { useSimulation } from '../context/SimulationContext';
import * as THREE from 'three';
import { BitchatPacket, toHex } from '../../protocol/BitchatPacket';

const FLASH_DURATION = 800; // ms
const FLASH_COLOR = '#FFC107';
const MAX_CONCURRENT_FLASHES = 24;

interface ActiveFlash {
    id: string;
    pathIds: string[];
    startTime: number;
}

export const RouteVisualizer: React.FC = () => {
    const engine = useSimulation();
    const [flashes, setFlashes] = useState<ActiveFlash[]>([]);

    useEffect(() => {
        const handlePacket = (data: {
            connectionId: string;
            packet: BitchatPacket;
            fromId: string;
        }) => {
            const { packet, fromId } = data;
            if (!packet.route || packet.route.length === 0) return;

            const senderHex = toHex(packet.senderID);
            if (senderHex !== fromId) return;

            const recipientHex = packet.recipientID ? toHex(packet.recipientID) : null;
            if (!recipientHex) return;

            const routeHexes = packet.route.map(toHex);
            const fullPath = [senderHex, ...routeHexes, recipientHex];

            setFlashes(prev => {
                const next =
                    prev.length >= MAX_CONCURRENT_FLASHES
                        ? prev.slice(prev.length - MAX_CONCURRENT_FLASHES + 1)
                        : prev;
                return [
                    ...next,
                    {
                        id: `${performance.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        pathIds: fullPath,
                        startTime: performance.now(),
                    },
                ];
            });
        };

        engine.events.on('packet_transmitted', handlePacket);
        return () => {
            engine.events.off('packet_transmitted', handlePacket);
        };
    }, [engine]);

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

    useFrame(() => {
        if (!lineRef.current) return;
        const elapsed = performance.now() - flash.startTime;
        const progress = Math.min(elapsed / FLASH_DURATION, 1);

        // Mutate material opacity directly in useFrame (zero React re-renders!)
        if (lineRef.current.material) {
            lineRef.current.material.opacity = 1 - progress * progress;
        }

        const flat: number[] = [];
        for (let i = 0; i < flash.pathIds.length; i++) {
            const person = engine.getPersonByPeerId(flash.pathIds[i]);
            if (!person) return;
            flat.push(person.position.x, person.position.y, 10);
        }
        if (flat.length >= 6 && lineRef.current.geometry?.setPositions) {
            lineRef.current.geometry.setPositions(flat);
        }
    });

    const initialPoints: THREE.Vector3[] = [];
    for (let i = 0; i < flash.pathIds.length; i++) {
        const p = engine.getPersonByPeerId(flash.pathIds[i]);
        if (p) initialPoints.push(new THREE.Vector3(p.position.x, p.position.y, 10));
    }

    if (initialPoints.length < 2) return null;

    return (
        <Line
            ref={lineRef}
            points={initialPoints}
            color={FLASH_COLOR}
            lineWidth={4}
            transparent
            opacity={1}
            depthTest={false}
            renderOrder={100}
        />
    );
};
