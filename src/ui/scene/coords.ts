import * as THREE from 'three';

/**
 * Coordinate conventions
 * ----------------------
 * Simulation space is a right-handed local tangent plane in meters:
 *   +x = east, +y = north, +z = up (height above ground).
 *
 * Three.js world space is Y-up. Everything that renders simulation geometry
 * lives under a single `<SimRoot>` group rotated -90° about X, which maps
 *   sim (x, y, z)  →  world (x, z, -y)
 * so layers can author geometry directly in simulation meters while sky,
 * lights, fog and camera controls keep their native Y-up conventions.
 */
export const SIM_ROOT_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];

/** Height of a hand-held phone's antenna above ground (m). */
export const DEVICE_HEIGHT_M = 1.25;
/** Eye height for first-person camera (m). */
export const EYE_HEIGHT_M = 1.65;

export function simToWorld(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, z, -y);
}

export function worldToSim(world: THREE.Vector3): { x: number; y: number; z: number } {
    return { x: world.x, y: -world.z, z: world.y };
}

/** Compass heading (radians, 0 = north, clockwise) for a camera looking from `from` to `to` in world space. */
export function worldHeading(from: THREE.Vector3, to: THREE.Vector3): number {
    const dx = to.x - from.x;
    const dNorth = -(to.z - from.z);
    return Math.atan2(dx, dNorth);
}
