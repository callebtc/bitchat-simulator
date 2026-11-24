import * as THREE from 'three';

/**
 * Physically based facade material with procedural windows.
 *
 * Uses `aFacade` (see `cityGeometry.ts`) to lay out a storey × bay window grid
 * in wall-space meters. Window panes get glass roughness/metalness by day and
 * deterministic per-window interior lighting at night (`uNight`).
 *
 * Anti-aliasing: the window grid is box-filtered analytically over each
 * pixel's footprint (`filteredPulse`), and per-window lighting blends to its
 * expected value once windows approach pixel size. Without this the pattern
 * aliases and lit windows strobe while the camera moves (bloom amplifies it).
 */
export interface BuildingMaterialUniforms {
    uNight: { value: number };
    uStoreyHeight: { value: number };
}

export function createBuildingMaterial(): {
    material: THREE.MeshStandardMaterial;
    uniforms: BuildingMaterialUniforms;
} {
    const uniforms: BuildingMaterialUniforms = {
        uNight: { value: 0 },
        uStoreyHeight: { value: 3.2 },
    };

    const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.86,
        metalness: 0.04,
        side: THREE.FrontSide,
    });

    material.onBeforeCompile = shader => {
        shader.uniforms.uNight = uniforms.uNight;
        shader.uniforms.uStoreyHeight = uniforms.uStoreyHeight;

        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
attribute vec4 aFacade;
varying vec4 vFacade;`
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
vFacade = aFacade;`
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
uniform float uNight;
uniform float uStoreyHeight;
varying vec4 vFacade;
float facadeHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
// Integral of a unit-period pulse that is 1 on [lo, hi) and 0 elsewhere.
float pulseIntegral(float x, float lo, float hi) {
    return floor(x) * (hi - lo) + clamp(fract(x), lo, hi) - lo;
}
// Box-filtered pulse: exact average coverage over the pixel footprint [x - w/2, x + w/2].
// Converges to the duty cycle (hi - lo) as w grows, so the pattern cannot alias.
float filteredPulse(float x, float w, float lo, float hi) {
    w = max(w, 1e-4);
    return (pulseIntegral(x + 0.5 * w, lo, hi) - pulseIntegral(x - 0.5 * w, lo, hi)) / w;
}`
            )
            .replace(
                '#include <color_fragment>',
                `#include <color_fragment>
float isWall = step(-500.0, vFacade.y);
float bSeed = vFacade.w;
float tower = step(34.0, vFacade.z) * step(bSeed, 0.65);
float bay = mix(3.0, 1.6, tower);
vec2 cell = vec2(vFacade.x / bay, vFacade.y / uStoreyHeight);
vec2 winId = floor(cell);
vec2 winF = fract(cell);
float groundFloor = 1.0 - step(1.0, winId.y);
float belowParapet = step(vFacade.y, vFacade.z - 0.9);
vec2 lo = mix(mix(vec2(0.2, 0.3), vec2(0.07, 0.06), groundFloor), vec2(0.05, 0.1), tower);
vec2 hi = mix(mix(vec2(0.8, 0.86), vec2(0.93, 0.8), groundFloor), vec2(0.95, 0.92), tower);
// Pixel footprint in window cells. Slightly widened so edges stay soft in motion.
vec2 fw = fwidth(cell) * 1.15;
float fwMax = max(fw.x, fw.y);
// Analytically anti-aliased window coverage (separable box filter). Far away
// this becomes the average glazing ratio instead of a crawling moiré.
float win = filteredPulse(cell.x, fw.x, lo.x, hi.x) * filteredPulse(cell.y, fw.y, lo.y, hi.y)
    * isWall * belowParapet * step(0.0, vFacade.y);
// Floor slab bands (filtered the same way) give scale when windows are sub-pixel
float slab = isWall * filteredPulse(cell.y, fw.y, 0.0, 0.035) * 0.18;
diffuseColor.rgb *= 1.0 - slab;
// Ambient-occlusion-ish darkening near the ground plane
diffuseColor.rgb *= mix(1.0, 0.62 + 0.38 * smoothstep(0.0, 4.0, max(vFacade.y, 0.0)), isWall);
vec3 glassTint = mix(vec3(0.06, 0.085, 0.11), vec3(0.09, 0.14, 0.2), tower);
diffuseColor.rgb = mix(diffuseColor.rgb, glassTint, win * 0.9);`
            )
            .replace(
                '#include <roughnessmap_fragment>',
                `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.14, win);`
            )
            .replace(
                '#include <metalnessmap_fragment>',
                `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.55, win);`
            )
            .replace(
                '#include <emissivemap_fragment>',
                `#include <emissivemap_fragment>
float occupancy = facadeHash(winId + vec2(bSeed * 97.31, bSeed * 13.7));
float litThreshold = 0.76 - 0.3 * groundFloor - 0.06 * tower;
float isLit = step(litThreshold, occupancy);
float tone = facadeHash(winId * 1.73 + bSeed * 41.0);
vec3 warm = vec3(1.0, 0.68, 0.38);
vec3 cool = vec3(0.62, 0.78, 1.0);
vec3 interior = mix(warm, cool, step(0.78, tone)) * (0.55 + 0.6 * tone);
// Shop fronts glow brighter
float glow = isLit * (1.0 + groundFloor * 0.6);
// Per-window on/off is a hash of the window id: once a pixel spans more than
// ~1/4 window, neighbouring pixels sample different windows each frame and the
// lights strobe while the camera moves. Blend to the expected value instead
// (lit fraction × mean interior colour) so distant facades glow steadily.
float lodBlend = smoothstep(0.18, 0.45, fwMax);
vec3 meanInterior = mix(warm, cool, 0.22) * 0.85;
vec3 perWindow = interior * glow;
vec3 averaged = meanInterior * (1.0 - litThreshold) * (1.0 + groundFloor * 0.6);
totalEmissiveRadiance += mix(perWindow, averaged, lodBlend) * win * uNight * 0.75;`
            );
    };
    material.customProgramCacheKey = () => 'bitchat-building-v4';

    return { material, uniforms };
}
