import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { SunState } from './sun';

/**
 * Analytic gradient sky: zenith → horizon blend, below-horizon haze, a sun
 * disc with Mie-like forward glow, and a warm city-light band at night.
 * The horizon color equals the fog color, so distant geometry dissolves into
 * the sky with no visible seam. Follows the camera (infinitely far away).
 */
export function createSkyMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: {
            uZenith: { value: new THREE.Color() },
            uHorizon: { value: new THREE.Color() },
            uSunDir: { value: new THREE.Vector3(0, 1, 0) },
            uSunColor: { value: new THREE.Color() },
            uSunVisible: { value: 1 },
            uGolden: { value: 0 },
            uNight: { value: 0 },
        },
        vertexShader: /* glsl */ `
            varying vec3 vDir;
            void main() {
                vDir = normalize(position);
                vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position = p.xyww; // pin to far plane
            }
        `,
        fragmentShader: /* glsl */ `
            uniform vec3 uZenith;
            uniform vec3 uHorizon;
            uniform vec3 uSunDir;
            uniform vec3 uSunColor;
            uniform float uSunVisible;
            uniform float uGolden;
            uniform float uNight;
            varying vec3 vDir;
            void main() {
                vec3 d = normalize(vDir);
                float h = d.y;
                float up = pow(clamp(h, 0.0, 1.0), 0.45);
                vec3 col = mix(uHorizon, uZenith, up);
                // Below the horizon: hazy ground reflection
                col = mix(col, uHorizon * 0.82, smoothstep(0.0, -0.08, h));
                float mu = max(dot(d, normalize(uSunDir)), 0.0);
                float glow = pow(mu, 6.0) * (0.25 + 0.9 * uGolden) + pow(mu, 64.0) * 0.6;
                float disc = smoothstep(0.99955, 0.9998, mu) * 6.0;
                col += uSunColor * (glow + disc) * uSunVisible;
                // Night: warm light-pollution band hugging the skyline
                col += vec3(0.11, 0.07, 0.045) * uNight * exp(-max(h, 0.0) * 9.0);
                gl_FragColor = vec4(col, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
    });
}

export function updateSkyMaterial(material: THREE.ShaderMaterial, sun: SunState): void {
    const u = material.uniforms;
    (u.uZenith.value as THREE.Color).copy(sun.zenithColor);
    (u.uHorizon.value as THREE.Color).copy(sun.fogColor);
    (u.uSunDir.value as THREE.Vector3).copy(sun.direction);
    (u.uSunColor.value as THREE.Color).copy(sun.sunColor);
    u.uSunVisible.value = THREE.MathUtils.smoothstep(sun.elevation, -0.04, 0.02);
    u.uGolden.value = sun.golden;
    u.uNight.value = sun.night;
}

export const SkyDome: React.FC<{ sun: SunState }> = ({ sun }) => {
    const meshRef = useRef<THREE.Mesh>(null);
    const material = useMemo(() => createSkyMaterial(), []);

    useEffect(() => updateSkyMaterial(material, sun), [material, sun]);
    useEffect(() => () => material.dispose(), [material]);

    useFrame(({ camera }) => {
        meshRef.current?.position.copy(camera.position);
    });

    return (
        <mesh ref={meshRef} material={material} frustumCulled={false} renderOrder={-1000}>
            <sphereGeometry args={[1000, 32, 16]} />
        </mesh>
    );
};

/**
 * Image-based lighting baked from the same analytic sky (PMREM). Glass
 * reflects the real sky color for the current time of day and shadowed
 * facades receive physically plausible skylight instead of flat ambient.
 */
export const SkyEnvironment: React.FC<{ sun: SunState; intensity: number }> = ({ sun, intensity }) => {
    const { gl, scene } = useThree();
    const env = useMemo(() => {
        const s = new THREE.Scene();
        const material = createSkyMaterial();
        material.depthTest = false;
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), material);
        s.add(mesh);
        return { scene: s, material, mesh, pmrem: new THREE.PMREMGenerator(gl) };
    }, [gl]);

    useEffect(() => {
        updateSkyMaterial(env.material, sun);
        const rt = env.pmrem.fromScene(env.scene, 0, 0.1, 1000);
        scene.environment = rt.texture;
        return () => {
            if (scene.environment === rt.texture) scene.environment = null;
            rt.dispose();
        };
    }, [env, sun, scene]);

    useEffect(() => {
        scene.environmentIntensity = intensity;
    }, [scene, intensity]);

    useEffect(
        () => () => {
            env.pmrem.dispose();
            env.material.dispose();
            env.mesh.geometry.dispose();
        },
        [env]
    );

    return null;
};
