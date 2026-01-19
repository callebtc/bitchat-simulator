import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BitchatConnection } from '../../simulation/BitchatConnection';

interface ConnectionEdgeProps {
    connection: BitchatConnection;
}

export const ConnectionEdge: React.FC<ConnectionEdgeProps> = ({ connection }) => {
    const geoRef = useRef<THREE.BufferGeometry>(null);
    
    // Create initial positions buffer (2 points * 3 coords)
    // useMemo ensures we keep the same TypedArray instance
    const positions = useMemo(() => new Float32Array(6), []);

    useFrame(() => {
        if (!geoRef.current) return;
        
        const posA = connection.endpointA.position;
        const posB = connection.endpointB.position;

        if (posA && posB) {
            positions[0] = posA.x;
            positions[1] = posA.y;
            positions[2] = 0;
            
            positions[3] = posB.x;
            positions[4] = posB.y;
            positions[5] = 0;
            
            geoRef.current.attributes.position.needsUpdate = true;
        }
    });

    return (
        <line>
            <bufferGeometry ref={geoRef}>
                <bufferAttribute
                    attach="attributes-position"
                    count={2}
                    array={positions}
                    itemSize={3}
                />
            </bufferGeometry>
            <lineBasicMaterial color="green" transparent opacity={0.4} linewidth={1} />
        </line>
    );
};
