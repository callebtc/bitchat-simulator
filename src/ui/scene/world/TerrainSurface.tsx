import React, { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { Building, MapContext } from '../../../simulation/environment';
import { Heightfield } from '../../../simulation/environment/Terrain';
import { bakeMapTexture } from './mapTexture';
import { StreetLamps, streetLampPositions } from './StreetLamps';

interface TerrainSurfaceProps {
    field: Heightfield;
    mapContext: MapContext;
    buildings: Building[];
    night: number;
    shadows: boolean;
}

/** Max grid segments per side for the displaced terrain mesh. */
const MAX_SEGMENTS = 360;
const noopRaycast = () => null;

/**
 * Displaced terrain mesh (from the DEM heightfield) textured with the baked
 * street map, plus terrain-following street lamps.
 */
export const TerrainSurface: React.FC<TerrainSurfaceProps> = ({ field, mapContext, buildings, night, shadows }) => {
    const gl = useThree(s => s.gl);
    const extent = useMemo(
        () => ({ minX: field.minX, minY: field.minY, maxX: field.maxX, maxY: field.maxY }),
        [field]
    );

    const geometry = useMemo(() => {
        const w = extent.maxX - extent.minX;
        const h = extent.maxY - extent.minY;
        const segX = Math.min(MAX_SEGMENTS, Math.max(1, Math.round(w / field.cellSize)));
        const segY = Math.min(MAX_SEGMENTS, Math.max(1, Math.round(h / field.cellSize)));
        const g = new THREE.PlaneGeometry(w, h, segX, segY);
        g.translate((extent.minX + extent.maxX) / 2, (extent.minY + extent.maxY) / 2, 0);
        const pos = g.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
            pos.setZ(i, field.sample(pos.getX(i), pos.getY(i)));
        }
        g.computeVertexNormals();
        g.computeBoundingSphere();
        return g;
    }, [field, extent]);

    const texture = useMemo(
        () => bakeMapTexture(mapContext, buildings, extent, gl.capabilities.getMaxAnisotropy()),
        [mapContext, buildings, extent, gl]
    );

    const lamps = useMemo(() => streetLampPositions(mapContext, field), [mapContext, field]);

    useEffect(() => () => geometry.dispose(), [geometry]);
    useEffect(() => () => texture.dispose(), [texture]);

    return (
        <group name="terrain-surface">
            <mesh geometry={geometry} receiveShadow={shadows} raycast={noopRaycast} renderOrder={-9}>
                <meshStandardMaterial map={texture} roughness={0.93} metalness={0} />
            </mesh>
            <StreetLamps lamps={lamps} night={night} />
        </group>
    );
};
