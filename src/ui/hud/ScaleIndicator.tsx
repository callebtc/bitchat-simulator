import React, { useState, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { OrthographicCamera } from 'three';

interface ScaleIndicatorProps {
    bottomOffset?: number;
}

export const ScaleIndicator: React.FC<ScaleIndicatorProps> = ({ bottomOffset = 32 }) => {
    const { camera } = useThree();
    const [scaleData, setScaleData] = useState({ width: 0, label: '' });
    const lastZoomRef = useRef<number>(0);

    useFrame(() => {
        if (!(camera instanceof OrthographicCamera)) return;

        // Current zoom level
        const zoom = camera.zoom;

        // Optimization: only update if zoom changed significantly
        if (Math.abs(zoom - lastZoomRef.current) < 0.01) return;
        lastZoomRef.current = zoom;

        // Logic:
        // We want a bar that is roughly 100-200 pixels wide.
        // In Orthographic camera (drei default), 1 unit = 'zoom' pixels (usually).
        // Let's verify this assumption:
        // By default, Drei's OrthographicCamera sets boundaries such that 
        // the view size matches the canvas size, but scaled by zoom.
        // Actually, typically: 1 world unit = 1 pixel at zoom=1?
        // Let's assume 1 world unit = 1 meter.
        // Pixels per meter = zoom.

        const pixelsPerMeter = zoom;
        
        // Target width in pixels
        const targetWidthPx = 150;
        
        // How many meters is that?
        const rawMeters = targetWidthPx / pixelsPerMeter;
        
        // Find nearest nice number (1, 2, 5, 10, 20, 50, 100...)
        const magnitude = Math.pow(10, Math.floor(Math.log10(rawMeters)));
        const residual = rawMeters / magnitude;
        
        let niceScalar;
        if (residual >= 5) niceScalar = 5;
        else if (residual >= 2) niceScalar = 2;
        else niceScalar = 1;
        
        const niceMeters = niceScalar * magnitude;
        const finalWidthPx = niceMeters * pixelsPerMeter;

        setScaleData({
            width: finalWidthPx,
            label: `${niceMeters >= 1000 ? (niceMeters/1000) + ' km' : niceMeters + ' m'}`
        });
    });

    if (scaleData.width === 0) return null;

    return (
        <Html fullscreen style={{ pointerEvents: 'none' }}>
            <div 
                className="absolute right-8 flex flex-col items-end opacity-80 transition-all duration-300"
                style={{ bottom: (bottomOffset + 16) + 'px' }}
            >
                <div 
                    className="border-b-2 border-l-2 border-r-2 border-white mb-1"
                    style={{ width: scaleData.width, height: '8px' }}
                />
                <span className="text-white text-xs font-mono font-bold text-shadow">
                    {scaleData.label}
                </span>
            </div>
        </Html>
    );
};
