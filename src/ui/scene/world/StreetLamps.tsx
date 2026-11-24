import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { MapContext } from '../../../simulation/environment';
import { Heightfield } from '../../../simulation/environment/Terrain';

const LAMP_SPACING_M = 30;
const LAMP_CURB_OFFSET_M = 1.2;
const MAX_LAMPS = 4000;

/**
 * Lamp posts every ~30 m along drivable roads, staggered between curbs,
 * as (x, y, groundZ) triples.
 */
export function streetLampPositions(ctx: MapContext, field: Heightfield): Float32Array {
    const out: number[] = [];
    for (const road of ctx.roads) {
        if (road.roadClass !== 'major' && road.roadClass !== 'minor') continue;
        const off = road.width / 2 + LAMP_CURB_OFFSET_M;
        for (let i = 0; i < road.points.length - 1 && out.length < MAX_LAMPS * 3; i++) {
            const a = road.points[i];
            const b = road.points[i + 1];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            if (len < 1e-3) continue;
            const ux = (b.x - a.x) / len;
            const uy = (b.y - a.y) / len;
            for (let d = LAMP_SPACING_M / 2; d < len; d += LAMP_SPACING_M) {
                const side = Math.floor(d / LAMP_SPACING_M) % 2 === 0 ? 1 : -1;
                const x = a.x + ux * d - uy * off * side;
                const y = a.y + uy * d + ux * off * side;
                out.push(x, y, field.sample(x, y));
            }
        }
    }
    return new Float32Array(out);
}

/**
 * Instanced street lamps: posts + emissive heads, plus additive light pools
 * on the pavement that fade in at dusk. Pools are faked (no dynamic lights)
 * so thousands of lamps cost three draw calls.
 */

const POST_HEIGHT_M = 6.5;
const POOL_RADIUS_M = 9;
const noopRaycast = () => null;

export const StreetLamps: React.FC<{ lamps: Float32Array; night: number }> = ({ lamps, night }) => {
    const postRef = useRef<THREE.InstancedMesh>(null);
    const headRef = useRef<THREE.InstancedMesh>(null);
    const poolRef = useRef<THREE.InstancedMesh>(null);
    const count = lamps.length / 3;

    const geo = useMemo(() => {
        const post = new THREE.CylinderGeometry(0.07, 0.1, POST_HEIGHT_M, 6);
        post.rotateX(Math.PI / 2);
        post.translate(0, 0, POST_HEIGHT_M / 2);
        const head = new THREE.BoxGeometry(0.7, 0.28, 0.12);
        head.translate(0, 0, POST_HEIGHT_M);
        const pool = new THREE.PlaneGeometry(POOL_RADIUS_M * 2, POOL_RADIUS_M * 2);
        pool.translate(0, 0, 0.12);
        return { post, head, pool };
    }, []);

    const poolMaterial = useMemo(
        () =>
            new THREE.ShaderMaterial({
                uniforms: { uIntensity: { value: 0 } },
                vertexShader: /* glsl */ `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: /* glsl */ `
                    uniform float uIntensity;
                    varying vec2 vUv;
                    void main() {
                        float r = length(vUv - 0.5) * 2.0;
                        float falloff = pow(max(0.0, 1.0 - r), 2.2);
                        gl_FragColor = vec4(vec3(1.0, 0.72, 0.42) * falloff * uIntensity, 1.0);
                    }
                `,
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                toneMapped: false,
            }),
        []
    );
    const headMaterial = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);

    useEffect(() => {
        const m = new THREE.Matrix4();
        for (const ref of [postRef, headRef, poolRef]) {
            const mesh = ref.current;
            if (!mesh) continue;
            for (let i = 0; i < count; i++) {
                m.makeTranslation(lamps[i * 3], lamps[i * 3 + 1], lamps[i * 3 + 2]);
                mesh.setMatrixAt(i, m);
            }
            mesh.count = count;
            mesh.instanceMatrix.needsUpdate = true;
            mesh.computeBoundingSphere();
        }
    }, [lamps, count]);

    useEffect(() => {
        poolMaterial.uniforms.uIntensity.value = 0.55 * night;
        // Sodium-white heads: dim grey by day, glowing HDR at night
        headMaterial.color.setRGB(0.35, 0.35, 0.33).lerp(new THREE.Color(3.2, 2.4, 1.5), night);
    }, [night, poolMaterial, headMaterial]);

    useEffect(
        () => () => {
            geo.post.dispose();
            geo.head.dispose();
            geo.pool.dispose();
            poolMaterial.dispose();
            headMaterial.dispose();
        },
        [geo, poolMaterial, headMaterial]
    );

    if (count === 0) return null;
    return (
        <group name="street-lamps" key={count}>
            <instancedMesh ref={postRef} args={[geo.post, undefined, count]} castShadow raycast={noopRaycast}>
                <meshStandardMaterial color="#2c3036" roughness={0.6} metalness={0.5} />
            </instancedMesh>
            <instancedMesh ref={headRef} args={[geo.head, headMaterial, count]} raycast={noopRaycast} />
            <instancedMesh
                ref={poolRef}
                args={[geo.pool, poolMaterial, count]}
                raycast={noopRaycast}
                renderOrder={-4}
                visible={night > 0.05}
            />
        </group>
    );
};
