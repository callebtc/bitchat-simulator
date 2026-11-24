import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { Building } from '../../../simulation/environment';
import { Heightfield } from '../../../simulation/environment/Terrain';
import { BuildingStyle } from '../../context/VisualizationContext';
import { buildCityGeometry } from './cityGeometry';
import { createBuildingMaterial } from './buildingMaterial';

interface CityLayerProps {
    buildings: Building[];
    terrain: Heightfield | null;
    style: BuildingStyle;
    night: number;
    shadows: boolean;
}

const noopRaycast = () => null;

/**
 * Extruded 3D city: one draw call for all building volumes (procedural
 * facade shader) and one for architectural edge lines.
 */
export const CityLayer: React.FC<CityLayerProps> = ({ buildings, terrain, style, night, shadows }) => {
    const city = useMemo(
        () =>
            buildings.length
                ? buildCityGeometry(buildings, terrain ? b => terrain.minUnder(b.vertices) : undefined)
                : null,
        [buildings, terrain]
    );
    const { material, uniforms } = useMemo(() => createBuildingMaterial(), []);
    const blueprintMaterial = useMemo(
        () =>
            new THREE.MeshBasicMaterial({
                color: 0x38bdf8,
                transparent: true,
                opacity: 0.07,
                depthWrite: false,
                side: THREE.DoubleSide,
                toneMapped: false,
            }),
        []
    );
    const edgeMaterial = useMemo(
        () => new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
        []
    );

    useEffect(
        () => () => {
            city?.volumes.dispose();
            city?.edges.dispose();
        },
        [city]
    );
    useEffect(
        () => () => {
            material.dispose();
            blueprintMaterial.dispose();
            edgeMaterial.dispose();
        },
        [material, blueprintMaterial, edgeMaterial]
    );

    // Style & lighting-dependent material state
    useEffect(() => {
        uniforms.uNight.value = night;
        const glass = style === 'glass';
        material.transparent = glass;
        material.opacity = glass ? 0.32 : 1;
        material.depthWrite = !glass;
        material.side = glass ? THREE.DoubleSide : THREE.FrontSide;
        material.needsUpdate = true;

        if (style === 'blueprint') {
            edgeMaterial.color.setRGB(0.25, 0.75, 1.0).multiplyScalar(1.6);
            edgeMaterial.opacity = 0.85;
        } else if (glass) {
            edgeMaterial.color.setRGB(0.55, 0.8, 1.0);
            edgeMaterial.opacity = 0.55;
        } else {
            // Subtle ink lines by day; faint cyan rim at night
            edgeMaterial.color.setRGB(0.05, 0.06, 0.07).lerp(new THREE.Color(0.12, 0.35, 0.5), night);
            edgeMaterial.opacity = 0.35 + 0.25 * night;
        }
        edgeMaterial.needsUpdate = true;
    }, [style, night, material, uniforms, edgeMaterial]);

    if (!city) return null;

    const solid = style === 'solid';
    return (
        <group name="city-layer">
            <mesh
                geometry={city.volumes}
                material={style === 'blueprint' ? blueprintMaterial : material}
                castShadow={solid && shadows}
                receiveShadow={solid && shadows}
                raycast={noopRaycast}
                renderOrder={style === 'solid' ? 0 : 5}
            />
            <lineSegments geometry={city.edges} material={edgeMaterial} raycast={noopRaycast} renderOrder={6} />
        </group>
    );
};
