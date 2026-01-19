import React, { useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useSimulation } from '../context/SimulationContext';
import { Building } from '../../simulation/environment';

// Building visual style
const BUILDING_FILL_COLOR = 0x4a90d9;
const BUILDING_FILL_OPACITY = 0.3;
const BUILDING_STROKE_COLOR = 0x7ab8f5;
const BUILDING_STROKE_OPACITY = 0.6;
const BUILDING_Z = -1; // Below nodes and connections

interface BuildingMeshProps {
    building: Building;
}

const BuildingMesh: React.FC<BuildingMeshProps> = ({ building }) => {
    const { fillGeometry, outlinePositions } = useMemo(() => {
        // Create shape from vertices
        const shape = new THREE.Shape();
        const vertices = building.vertices;
        
        if (vertices.length < 3) {
            return { fillGeometry: null, outlinePositions: null };
        }

        // Build shape path
        shape.moveTo(vertices[0].x, vertices[0].y);
        for (let i = 1; i < vertices.length; i++) {
            shape.lineTo(vertices[i].x, vertices[i].y);
        }
        shape.closePath();

        // Create fill geometry
        const fillGeo = new THREE.ShapeGeometry(shape);

        // Create outline positions (closed loop)
        const outlineArray = new Float32Array((vertices.length + 1) * 3);
        for (let i = 0; i <= vertices.length; i++) {
            const v = vertices[i % vertices.length];
            outlineArray[i * 3] = v.x;
            outlineArray[i * 3 + 1] = v.y;
            outlineArray[i * 3 + 2] = BUILDING_Z + 0.01; // Slightly above fill
        }

        return { fillGeometry: fillGeo, outlinePositions: outlineArray };
    }, [building]);

    if (!fillGeometry || !outlinePositions) {
        return null;
    }

    return (
        <group>
            {/* Fill */}
            <mesh position={[0, 0, BUILDING_Z]} geometry={fillGeometry}>
                <meshBasicMaterial 
                    color={BUILDING_FILL_COLOR} 
                    transparent 
                    opacity={BUILDING_FILL_OPACITY}
                    side={THREE.DoubleSide}
                />
            </mesh>

            {/* Outline */}
            <line>
                <bufferGeometry>
                    <bufferAttribute
                        attach="attributes-position"
                        count={building.vertices.length + 1}
                        array={outlinePositions}
                        itemSize={3}
                    />
                </bufferGeometry>
                <lineBasicMaterial 
                    color={BUILDING_STROKE_COLOR} 
                    transparent 
                    opacity={BUILDING_STROKE_OPACITY}
                    linewidth={1}
                />
            </line>
        </group>
    );
};

export const BuildingLayer: React.FC = () => {
    const engine = useSimulation();
    const [buildings, setBuildings] = useState<Building[]>([]);

    useEffect(() => {
        // Get initial buildings
        setBuildings(engine.environment.getBuildings());

        // Listen for environment changes
        const handleEnvironmentLoaded = () => {
            setBuildings(engine.environment.getBuildings());
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

    // Limit rendering for performance (show max 500 buildings)
    const visibleBuildings = useMemo(() => {
        if (buildings.length <= 500) {
            return buildings;
        }
        // Sort by size (larger buildings first) and take top 500
        return [...buildings]
            .sort((a, b) => {
                const areaA = (a.bounds.maxX - a.bounds.minX) * (a.bounds.maxY - a.bounds.minY);
                const areaB = (b.bounds.maxX - b.bounds.minX) * (b.bounds.maxY - b.bounds.minY);
                return areaB - areaA;
            })
            .slice(0, 500);
    }, [buildings]);

    if (visibleBuildings.length === 0) {
        return null;
    }

    return (
        <group name="building-layer">
            {visibleBuildings.map(building => (
                <BuildingMesh key={building.id} building={building} />
            ))}
        </group>
    );
};
