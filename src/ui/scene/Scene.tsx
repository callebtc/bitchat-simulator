import React, { useCallback, useRef, useEffect } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera } from '@react-three/drei';
import { useSelection } from '../context/SelectionContext';
import { InstancedMeshLayer } from './InstancedMeshLayer';
import { BuildingLayer } from './BuildingLayer';
import { PathVisualizer } from './PathVisualizer';
import { RouteVisualizer } from './RouteVisualizer';
import { ProbeVisualizer } from './ProbeVisualizer';
import { InteractionPlane } from './InteractionPlane';
import { ScaleUpdater } from '../hud/ScaleIndicator';
import * as THREE from 'three';

const ViewTracker: React.FC = () => {
    const { camera } = useThree();
    const { viewCenterRef } = useSelection();

    // Writes to a mutable ref — zero React re-renders per frame!
    useFrame(() => {
        viewCenterRef.current.x = camera.position.x;
        viewCenterRef.current.y = camera.position.y;
    });

    return null;
};

const CameraFocuser: React.FC<{ controlsRef: React.RefObject<any> }> = ({ controlsRef }) => {
    const { camera } = useThree();
    const { focusRequest } = useSelection();
    const lastNonceRef = useRef<number>(0);

    useEffect(() => {
        if (!focusRequest || focusRequest.nonce === lastNonceRef.current) return;
        lastNonceRef.current = focusRequest.nonce;

        const ortho = camera as THREE.OrthographicCamera;
        ortho.position.x = focusRequest.x;
        ortho.position.y = focusRequest.y;
        if (focusRequest.zoom !== undefined && Number.isFinite(focusRequest.zoom)) {
            ortho.zoom = Math.max(0.25, Math.min(8, focusRequest.zoom));
            ortho.updateProjectionMatrix();
        }
        if (controlsRef.current) {
            controlsRef.current.target.x = focusRequest.x;
            controlsRef.current.target.y = focusRequest.y;
            controlsRef.current.update();
        }
    }, [camera, controlsRef, focusRequest]);

    return null;
};

interface KeyboardNavigatorProps {
    controlsRef: React.RefObject<any>;
}

const KeyboardNavigator: React.FC<KeyboardNavigatorProps> = ({ controlsRef }) => {
    const { camera } = useThree();
    const keysPressed = useRef<Set<string>>(new Set());
    const BASE_SPEED = 200;

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            const key = e.key.toLowerCase();
            if (['w', 'a', 's', 'd'].includes(key)) {
                keysPressed.current.add(key);
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            keysPressed.current.delete(e.key.toLowerCase());
        };

        const handleBlur = () => {
            keysPressed.current.clear();
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
        };
    }, []);

    useFrame((_, delta) => {
        if (keysPressed.current.size === 0) return;

        const orthoCamera = camera as THREE.OrthographicCamera;
        const speed = (BASE_SPEED / orthoCamera.zoom) * delta;

        let dx = 0;
        let dy = 0;

        if (keysPressed.current.has('w')) dy += speed;
        if (keysPressed.current.has('s')) dy -= speed;
        if (keysPressed.current.has('a')) dx -= speed;
        if (keysPressed.current.has('d')) dx += speed;

        if (dx !== 0 && dy !== 0) {
            const factor = 1 / Math.sqrt(2);
            dx *= factor;
            dy *= factor;
        }

        camera.position.x += dx;
        camera.position.y += dy;

        if (controlsRef.current) {
            controlsRef.current.target.x += dx;
            controlsRef.current.target.y += dy;
        }
    });

    return null;
};

export const Scene: React.FC = () => {
    const { isDragging, setHighlightedId } = useSelection();
    const controlsRef = useRef<any>(null);

    const handleCanvasPointerLeave = useCallback(() => {
        setHighlightedId(null);
        document.body.style.cursor = 'default';
    }, [setHighlightedId]);

    return (
        <div className="w-full h-screen bg-gray-900" onPointerLeave={handleCanvasPointerLeave}>
            <Canvas dpr={[1, 1.5]} gl={{ powerPreference: 'high-performance', antialias: true }}>
                <OrthographicCamera makeDefault position={[0, 0, 100]} zoom={2} />
                <OrbitControls
                    ref={controlsRef}
                    enableRotate={false}
                    enabled={!isDragging}
                    mouseButtons={{
                        LEFT: THREE.MOUSE.PAN,
                        MIDDLE: THREE.MOUSE.DOLLY,
                        RIGHT: THREE.MOUSE.PAN,
                    }}
                />
                <ViewTracker />
                <CameraFocuser controlsRef={controlsRef} />
                <KeyboardNavigator controlsRef={controlsRef} />
                <ScaleUpdater />

                <ambientLight intensity={0.5} />

                <InteractionPlane />

                {/* Merged 2-draw-call building layer */}
                <BuildingLayer />

                {/* GPU-instanced nodes, connections, and flying packets (5 draw calls total) */}
                <InstancedMeshLayer />

                {/* Live DM Route Probe & Packet Hop Follower */}
                <ProbeVisualizer />

                {/* Path visualization for hover/animation */}
                <PathVisualizer />

                {/* Route visualization for source-routed packet flashes */}
                <RouteVisualizer />
            </Canvas>
        </div>
    );
};
