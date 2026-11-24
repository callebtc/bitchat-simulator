import React from 'react';
import { Grid } from '@react-three/drei';

interface GroundProps {
    night: number;
    hasCity: boolean;
    /** World height of the outer ground plane (just below the terrain's lowest point). */
    baseHeight: number;
}

/**
 * Infinite-feeling ground plane (receives shadows) plus a 10 m / 100 m survey
 * grid that fades with distance. The plane is pushed back with polygon offset
 * so coplanar map layers (roads, parks) always win the depth test.
 */
export const Ground: React.FC<GroundProps> = ({ night, hasCity, baseHeight }) => {
    // With a city loaded the base plane reads as concrete sidewalk / plaza; roads draw darker asphalt on top
    const base = hasCity ? '#5d5e60' : '#1d2127';
    const cell = night > 0.5 ? '#1f2a38' : '#2c343f';
    const section = night > 0.5 ? '#2b4560' : '#3d4b5c';
    return (
        <group position={[0, baseHeight, 0]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow renderOrder={-10}>
                <planeGeometry args={[40000, 40000]} />
                <meshStandardMaterial
                    color={base}
                    roughness={0.95}
                    metalness={0}
                    polygonOffset
                    polygonOffsetFactor={4}
                    polygonOffsetUnits={4}
                />
            </mesh>
            {!hasCity && (
            <Grid
                position={[0, 0.06, 0]}
                infiniteGrid
                followCamera={false}
                cellSize={10}
                cellThickness={0.6}
                cellColor={cell}
                sectionSize={100}
                sectionThickness={1.1}
                sectionColor={section}
                fadeDistance={hasCity ? 900 : 2200}
                fadeStrength={1.4}
                renderOrder={-5}
            />
            )}
        </group>
    );
};
