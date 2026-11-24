import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { useSimulation } from '../../context/SimulationContext';
import { useSelection } from '../../context/SelectionContext';
import { useTerrain } from '../../context/TerrainContext';

const BEACON_HEIGHT_M = 60;

function createBeaconMaterial(color: THREE.Color): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
        uniforms: { uColor: { value: color }, uTime: { value: 0 } },
        vertexShader: /* glsl */ `
            varying float vH;
            varying float vDepth;
            void main() {
                vH = uv.y;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vDepth = -mv.z;
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform vec3 uColor;
            uniform float uTime;
            varying float vH;
            varying float vDepth;
            void main() {
                // Fade in from the person's head upward and when the camera is close
                float fade = pow(1.0 - vH, 2.0) * smoothstep(0.035, 0.08, vH);
                float near = smoothstep(6.0, 45.0, vDepth);
                float pulse = 0.75 + 0.25 * sin(uTime * 3.0 - vH * 18.0);
                gl_FragColor = vec4(uColor * pulse, fade * near * 0.5);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
    });
}

/** Vertical light columns marking the selected sender (white) and DM recipient (magenta). */
export const SelectionBeacons: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType, chatRecipientId } = useSelection();
    const { heightAt } = useTerrain();
    const senderRef = useRef<THREE.Mesh>(null);
    const recipientRef = useRef<THREE.Mesh>(null);

    const geometry = useMemo(() => {
        const g = new THREE.CylinderGeometry(0.22, 0.22, BEACON_HEIGHT_M, 16, 1, true);
        g.rotateX(Math.PI / 2);
        g.translate(0, 0, BEACON_HEIGHT_M / 2);
        // Cylinder uv.y runs along the axis; after rotation it still maps base → top
        return g;
    }, []);
    const materials = useMemo(
        () => ({
            sender: createBeaconMaterial(new THREE.Color(0.75, 0.95, 1.0)),
            recipient: createBeaconMaterial(new THREE.Color(0.91, 0.47, 0.98)),
        }),
        []
    );

    useFrame(({ clock }) => {
        const t = clock.getElapsedTime();
        materials.sender.uniforms.uTime.value = t;
        materials.recipient.uniforms.uTime.value = t;
        const sender = selectedId && selectionType === 'node' ? engine.getPerson(selectedId) : undefined;
        const recipient = chatRecipientId ? engine.getPersonByPeerId(chatRecipientId) : undefined;
        if (senderRef.current) {
            senderRef.current.visible = Boolean(sender);
            if (sender) senderRef.current.position.set(sender.position.x, sender.position.y, heightAt(sender.position.x, sender.position.y));
        }
        if (recipientRef.current) {
            recipientRef.current.visible = Boolean(recipient);
            if (recipient) recipientRef.current.position.set(
                    recipient.position.x,
                    recipient.position.y,
                    heightAt(recipient.position.x, recipient.position.y)
                );
        }
    });

    return (
        <group name="selection-beacons">
            <mesh ref={senderRef} geometry={geometry} material={materials.sender} renderOrder={30} visible={false} />
            <mesh ref={recipientRef} geometry={geometry} material={materials.recipient} renderOrder={30} visible={false} />
        </group>
    );
};
