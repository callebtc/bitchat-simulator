import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { computeSunState } from './sun';
import { SkyDome, SkyEnvironment } from './SkyDome';

interface AtmosphereProps {
    hour: number;
    shadowMapSize: number | null;
}

const SHADOW_EXTENT_M = 240;
const SHADOW_SNAP_M = 4;
const MOON_DIRECTION = new THREE.Vector3(-0.35, 0.82, 0.45).normalize();
const MOON_COLOR = new THREE.Color(0.55, 0.65, 1.0);
const STAR_COUNT = 2600;
const STAR_RADIUS = 5000;

interface ControlsLike {
    target: THREE.Vector3;
}

/**
 * Sky dome, sun / moon light with camera-following shadow frustum,
 * hemisphere fill, distance fog and a star field that fades in at night.
 */
export const Atmosphere: React.FC<AtmosphereProps> = ({ hour, shadowMapSize }) => {
    const { scene, gl } = useThree();
    const controls = useThree(s => s.controls) as unknown as ControlsLike | null;
    const lightRef = useRef<THREE.DirectionalLight>(null);
    const starsRef = useRef<THREE.Points>(null);

    const sun = useMemo(() => computeSunState(hour), [hour]);
    // Re-bake IBL at 5-minute granularity so dragging the time slider stays smooth
    const envHour = Math.round(hour * 12) / 12;
    const envSun = useMemo(() => computeSunState(envHour), [envHour]);
    const lightDir = useMemo(
        () => (sun.night > 0.6 ? MOON_DIRECTION.clone() : sun.direction.clone()),
        [sun]
    );
    const lightColor = useMemo(
        () => sun.sunColor.clone().lerp(MOON_COLOR, sun.night),
        [sun]
    );
    const lightIntensity = Math.max(sun.sunIntensity, 0.45 * sun.night);

    const stars = useMemo(() => {
        const positions = new Float32Array(STAR_COUNT * 3);
        const colors = new Float32Array(STAR_COUNT * 3);
        let seed = 1337;
        const rand = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };
        for (let i = 0; i < STAR_COUNT; i++) {
            const u = rand();
            const v = rand() * 0.92 + 0.08; // upper hemisphere only
            const theta = u * Math.PI * 2;
            const y = v;
            const r = Math.sqrt(1 - y * y);
            positions.set([Math.cos(theta) * r * STAR_RADIUS, y * STAR_RADIUS, Math.sin(theta) * r * STAR_RADIUS], i * 3);
            const b = 0.35 + Math.pow(rand(), 3) * 1.4;
            const tint = rand();
            colors.set([b * (0.85 + tint * 0.15), b * 0.92, b * (1.05 - tint * 0.15)], i * 3);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return g;
    }, []);
    const starMaterial = useMemo(
        () =>
            new THREE.PointsMaterial({
                size: 1.7,
                sizeAttenuation: false,
                vertexColors: true,
                transparent: true,
                depthWrite: false,
                fog: false,
                toneMapped: false,
            }),
        []
    );
    useEffect(
        () => () => {
            stars.dispose();
            starMaterial.dispose();
        },
        [stars, starMaterial]
    );

    // Fog, background & exposure follow the time of day
    useEffect(() => {
        // Light aerial perspective by day; denser, darker haze at night hides the horizon
        const density = 0.00022 + 0.00038 * sun.night;
        scene.fog = new THREE.FogExp2(sun.fogColor.clone(), density);
        scene.background = sun.fogColor.clone();
        gl.toneMappingExposure = 0.92 + 0.25 * sun.night;
        starMaterial.opacity = Math.max(0, sun.night - 0.25) / 0.75;
        return () => {
            scene.fog = null;
        };
    }, [scene, gl, sun, starMaterial]);

    useEffect(() => {
        const light = lightRef.current;
        if (!light) return;
        scene.add(light.target);
        return () => {
            scene.remove(light.target);
        };
    }, [scene, shadowMapSize]);

    useFrame(({ camera }) => {
        const light = lightRef.current;
        if (light) {
            const t = controls?.target;
            const cx = t ? Math.round(t.x / SHADOW_SNAP_M) * SHADOW_SNAP_M : 0;
            const cz = t ? Math.round(t.z / SHADOW_SNAP_M) * SHADOW_SNAP_M : 0;
            light.target.position.set(cx, 0, cz);
            light.position.set(cx + lightDir.x * 600, lightDir.y * 600, cz + lightDir.z * 600);
            light.target.updateMatrixWorld();
        }
        starsRef.current?.position.copy(camera.position);
    });

    return (
        <>
            <SkyDome sun={sun} />
            <SkyEnvironment sun={envSun} intensity={0.55 + 0.25 * (1 - sun.night)} />
            <points ref={starsRef} geometry={stars} material={starMaterial} frustumCulled={false} renderOrder={-100} />
            <hemisphereLight args={[sun.skyColor, sun.groundColor, sun.hemiIntensity * 0.55]} />
            <directionalLight
                key={shadowMapSize ?? 'no-shadow'}
                ref={lightRef}
                color={lightColor}
                intensity={lightIntensity}
                castShadow={shadowMapSize !== null}
                shadow-mapSize-width={shadowMapSize ?? 512}
                shadow-mapSize-height={shadowMapSize ?? 512}
                shadow-camera-left={-SHADOW_EXTENT_M}
                shadow-camera-right={SHADOW_EXTENT_M}
                shadow-camera-top={SHADOW_EXTENT_M}
                shadow-camera-bottom={-SHADOW_EXTENT_M}
                shadow-camera-near={10}
                shadow-camera-far={1400}
                shadow-bias={-0.0004}
                shadow-normalBias={0.35}
            />
        </>
    );
};
