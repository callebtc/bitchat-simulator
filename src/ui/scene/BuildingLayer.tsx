import React, { useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useSimulation } from '../context/SimulationContext';
import { Building } from '../../simulation/environment';

const BUILDING_FILL_COLOR = 0x4a90d9;
const BUILDING_FILL_OPACITY = 0.3;
const BUILDING_STROKE_COLOR = 0x7ab8f5;
const BUILDING_STROKE_OPACITY = 0.6;
const BUILDING_Z = -1;

/**
 * Merged GPU Building Layer:
 * Combines ALL building polygon fills into 1 single BufferGeometry draw call
 * and ALL building outlines into 1 single LineSegments draw call (2 draw calls
 * total even for 2,000+ city buildings).
 */
export const BuildingLayer: React.FC = () => {
    const engine = useSimulation();
    const [buildings, setBuildings] = useState<Building[]>([]);

    useEffect(() => {
        setBuildings(engine.environment.getBuildings());

        const handleEnvironmentLoaded = () => {
            setBuildings([...engine.environment.getBuildings()]);
        };
        const handleReset = () => {
            setBuildings([]);
        };

        engine.events.on('environment_loaded', handleEnvironmentLoaded);
        engine.events.on('reset', handleReset);

        return () => {
            engine.events.off('environment_loaded', handleEnvironmentLoaded);
            engine.events.off('reset', handleReset);
        };
    }, [engine]);

    const { fillGeometry, outlineGeometry } = useMemo(() => {
        if (buildings.length === 0) {
            return { fillGeometry: null, outlineGeometry: null };
        }

        const fillPositions: number[] = [];
        const outlinePositions: number[] = [];

        for (let bi = 0; bi < buildings.length; bi++) {
            const verts = buildings[bi].vertices;
            const n = verts.length;
            if (n < 3) continue;

            // Outline segments (each edge as a pair of vertices for LineSegments)
            for (let i = 0; i < n; i++) {
                const v1 = verts[i];
                const v2 = verts[i + 1 < n ? i + 1 : 0];
                outlinePositions.push(v1.x, v1.y, BUILDING_Z + 0.01);
                outlinePositions.push(v2.x, v2.y, BUILDING_Z + 0.01);
            }

            // Triangulate polygon via THREE.ShapeUtils.triangulateShape
            const contour = new Array<THREE.Vector2>(n);
            for (let i = 0; i < n; i++) {
                contour[i] = new THREE.Vector2(verts[i].x, verts[i].y);
            }
            const faces = THREE.ShapeUtils.triangulateShape(contour, []);
            for (let fi = 0; fi < faces.length; fi++) {
                const face = faces[fi];
                const a = verts[face[0]];
                const b = verts[face[1]];
                const c = verts[face[2]];
                fillPositions.push(a.x, a.y, BUILDING_Z);
                fillPositions.push(b.x, b.y, BUILDING_Z);
                fillPositions.push(c.x, c.y, BUILDING_Z);
            }
        }

        const fillGeo = new THREE.BufferGeometry();
        fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillPositions, 3));

        const outGeo = new THREE.BufferGeometry();
        outGeo.setAttribute('position', new THREE.Float32BufferAttribute(outlinePositions, 3));

        return { fillGeometry: fillGeo, outlineGeometry: outGeo };
    }, [buildings]);

    useEffect(() => {
        return () => {
            fillGeometry?.dispose();
            outlineGeometry?.dispose();
        };
    }, [fillGeometry, outlineGeometry]);

    if (!fillGeometry || !outlineGeometry) {
        return null;
    }

    return (
        <group name="building-layer">
            <mesh geometry={fillGeometry}>
                <meshBasicMaterial
                    color={BUILDING_FILL_COLOR}
                    transparent
                    opacity={BUILDING_FILL_OPACITY}
                    side={THREE.DoubleSide}
                />
            </mesh>
            <lineSegments geometry={outlineGeometry}>
                <lineBasicMaterial
                    color={BUILDING_STROKE_COLOR}
                    transparent
                    opacity={BUILDING_STROKE_OPACITY}
                />
            </lineSegments>
        </group>
    );
};
