import React, { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';

import { useVisualization } from '../context/VisualizationContext';
import { SIM_ROOT_ROTATION } from './coords';
import { CameraRig } from './camera/CameraRig';
import { PointerController } from './interaction/PointerController';
import { Atmosphere } from './world/Atmosphere';
import { Ground } from './world/Ground';
import { CityLayer } from './world/CityLayer';
import { TerrainSurface } from './world/TerrainSurface';
import { useTerrain } from '../context/TerrainContext';
import { useEnvironmentSnapshot } from './world/useEnvironmentSnapshot';
import { computeSunState } from './world/sun';
import { PeopleLayer } from './actors/PeopleLayer';
import { SelectionBeacons } from './actors/SelectionBeacons';
import { NetworkLayer } from './network/NetworkLayer';
import { PostProcessing } from './effects/PostProcessing';
import { PathVisualizer } from './PathVisualizer';
import { RouteVisualizer } from './RouteVisualizer';
import { ProbeVisualizer } from './ProbeVisualizer';
import { ScreenAnchorProjector } from '../overlays/ScreenAnchors';

/**
 * Root 3D view.
 *
 * World (Y-up): sky, lights, ground, camera.
 * SimRoot (rotated so authored geometry uses simulation meters, z-up):
 * city, map context, people, radio network, route / probe overlays.
 */
const SimWorld: React.FC = () => {
    const { timeOfDay, buildingStyle, graphicsQuality } = useVisualization();
    const env = useEnvironmentSnapshot();
    const { field } = useTerrain();
    const night = useMemo(() => computeSunState(timeOfDay).night, [timeOfDay]);
    const shadowMapSize = graphicsQuality === 'high' ? 4096 : graphicsQuality === 'balanced' ? 2048 : null;
    const shadows = shadowMapSize !== null;
    const hasCity = env.buildings.length > 0;

    return (
        <>
            <Atmosphere hour={timeOfDay} shadowMapSize={shadowMapSize} />
            <Ground night={night} hasCity={hasCity} baseHeight={field ? field.minHeight - 0.4 : 0} />
            <CameraRig />
            <PointerController />
            <ScreenAnchorProjector />

            <group name="sim-root" rotation={SIM_ROOT_ROTATION}>
                {field && hasCity && (
                    <TerrainSurface
                        field={field}
                        mapContext={env.mapContext}
                        buildings={env.buildings}
                        night={night}
                        shadows={shadows}
                    />
                )}
                <CityLayer
                    buildings={env.buildings}
                    terrain={field}
                    style={buildingStyle}
                    night={night}
                    shadows={shadows}
                />
                <PeopleLayer />
                <SelectionBeacons />
                <NetworkLayer />
                <ProbeVisualizer />
                <PathVisualizer />
                <RouteVisualizer />
            </group>

            {graphicsQuality !== 'fast' && (
                <PostProcessing bloomStrength={0.45 + 0.2 * night} bloomThreshold={2.4 - 1.3 * night} />
            )}
        </>
    );
};

export const Scene: React.FC = () => {
    const { graphicsQuality } = useVisualization();
    return (
        <div className="fixed inset-0 bg-[#05070b]">
            <Canvas
                shadows={graphicsQuality !== 'fast' ? { type: THREE.PCFSoftShadowMap } : false}
                // Pixel ratio is the dominant GPU cost with HDR MSAA + bloom on retina displays
                dpr={graphicsQuality === 'high' ? [1, 1.5] : graphicsQuality === 'balanced' ? [1, 1.25] : [1, 1]}
                camera={{ fov: 45, near: 0.5, far: 20000, position: [170, 210, 250] }}
                gl={{
                    powerPreference: 'high-performance',
                    antialias: graphicsQuality === 'fast',
                    stencil: false,
                }}
                onCreated={({ gl }) => {
                    gl.toneMapping = THREE.ACESFilmicToneMapping;
                    gl.outputColorSpace = THREE.SRGBColorSpace;
                }}
            >
                <SimWorld />
            </Canvas>
        </div>
    );
};
