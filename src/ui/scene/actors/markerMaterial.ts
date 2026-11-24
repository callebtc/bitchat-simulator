import * as THREE from 'three';

/** Height of the floating device marker above ground (m). */
export const MARKER_HEIGHT_M = 2.35;

export enum MarkerState {
    Normal = 0,
    Hovered = 1,
    Selected = 2,
    Recipient = 3,
    Dimmed = 4,
    Transmitting = 5,
}

/**
 * Constant-pixel-size device markers. They represent every person without a
 * 3D figure (far away, zoomed out, culled by the figure cap) and fade out
 * where `aFigure` says a figure is drawn. The `ghost` pass renders through
 * buildings at low alpha so indoor devices are never lost.
 */
export function createMarkerMaterial(ghost: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: {
            uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        },
        vertexShader: /* glsl */ `
            uniform float uPixelRatio;
            attribute vec3 color;
            attribute float aState;
            attribute float aFigure;
            varying vec3 vColor;
            varying float vState;
            varying float vFade;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                float dist = -mv.z;
                vColor = color;
                vState = aState;
                float emphasized = step(0.5, aState) * step(aState, 3.5);
                // Dots stand in for people without a 3D figure; where a figure is drawn
                // they cross-fade out (aFigure → 1). Emphasized dots stay until close.
                float figureHide = aFigure * (1.0 - emphasized * smoothstep(14.0, 26.0, dist));
                vFade = (1.0 - figureHide) * smoothstep(3.0, 8.0, dist);
                float size = 7.5;
                if (aState > 0.5 && aState < 1.5) size = 11.0;
                else if (aState > 1.5 && aState < 3.5) size = 14.0;
                else if (aState > 3.5 && aState < 4.5) size = 5.0;
                else if (aState > 4.5) size = 10.0;
                gl_PointSize = size * uPixelRatio;
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: /* glsl */ `
            varying vec3 vColor;
            varying float vState;
            varying float vFade;
            void main() {
                vec2 c = gl_PointCoord * 2.0 - 1.0;
                float r = length(c);
                if (r > 1.0) discard;
                float edge = 1.0 - smoothstep(0.82, 1.0, r);
                float core = 1.0 - smoothstep(0.58, 0.7, r);
                vec3 ring = vec3(0.02, 0.03, 0.05);
                if (vState > 0.5 && vState < 1.5) ring = vec3(1.0, 1.0, 0.6);
                else if (vState > 1.5 && vState < 2.5) ring = vec3(1.0);
                else if (vState > 2.5 && vState < 3.5) ring = vec3(0.91, 0.47, 0.98);
                else if (vState > 4.5) ring = vColor * 1.8;
                vec3 col = mix(ring, vColor * 1.25, core);
                float alpha = edge * vFade * ${ghost ? '0.3' : '1.0'};
                if (alpha < 0.01) discard;
                gl_FragColor = vec4(col, alpha);
            }
        `,
        transparent: true,
        depthWrite: false,
        depthTest: !ghost,
        toneMapped: false,
    });
}
