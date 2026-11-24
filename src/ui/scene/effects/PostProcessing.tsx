import React, { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Replaces NaN / Inf with black and clamps extreme HDR values. Bloom's
 * separable blur would otherwise smear a single invalid fragment (e.g. a
 * degenerate fat-line segment) across the entire frame.
 */
const SanitizeShader = {
    uniforms: { tDiffuse: { value: null }, uMax: { value: 48.0 } },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uMax;
        varying vec2 vUv;
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
            gl_FragColor = vec4(clamp(c.rgb, 0.0, uMax), c.a);
        }
    `,
};

interface PostProcessingProps {
    bloomStrength: number;
    /** Linear HDR luminance above which pixels bloom (high by day so sunlit facades don't glow). */
    bloomThreshold: number;
}

/**
 * HDR pipeline: scene → 4× MSAA half-float target → selective-looking bloom
 * (only HDR > 1 emitters such as phone screens, packets, lit windows exceed
 * the threshold) → tone mapping + sRGB output.
 *
 * Takes over rendering by registering a positive-priority frame callback.
 */
export const PostProcessing: React.FC<PostProcessingProps> = ({ bloomStrength, bloomThreshold }) => {
    const { gl, scene, camera, size } = useThree();

    const { composer, bloom } = useMemo(() => {
        const target = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType,
            samples: 4,
        });
        const c = new EffectComposer(gl, target);
        c.addPass(new RenderPass(scene, camera));
        c.addPass(new ShaderPass(SanitizeShader));
        const b = new UnrealBloomPass(new THREE.Vector2(1, 1), bloomStrength, 0.55, 0.92);
        c.addPass(b);
        c.addPass(new OutputPass());
        return { composer: c, bloom: b };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gl, scene, camera]);

    useEffect(() => {
        composer.setPixelRatio(gl.getPixelRatio());
        composer.setSize(size.width, size.height);
    }, [composer, gl, size]);

    useEffect(() => {
        bloom.strength = bloomStrength;
        bloom.threshold = bloomThreshold;
    }, [bloom, bloomStrength, bloomThreshold]);

    useEffect(() => () => composer.dispose(), [composer]);

    useFrame((_, delta) => {
        composer.render(delta);
    }, 1);

    return null;
};
