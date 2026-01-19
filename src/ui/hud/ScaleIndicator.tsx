import React, { useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { OrthographicCamera } from 'three';
import { useScale } from '../context/ScaleContext';
import { useLayout } from '../context/LayoutContext';

/**
 * Updates the scale context based on the current camera zoom.
 * Must be placed inside <Canvas>.
 */
export const ScaleUpdater: React.FC = () => {
    const { camera } = useThree();
    const { setScaleData } = useScale();
    const lastZoomRef = useRef<number>(0);

    useFrame(() => {
        if (!(camera instanceof OrthographicCamera)) return;

        const zoom = camera.zoom;

        // Optimization: only update if zoom changed significantly
        if (Math.abs(zoom - lastZoomRef.current) < 0.01) return;
        lastZoomRef.current = zoom;

        // Logic:
        // In Orthographic camera (drei default), 1 unit = 'zoom' pixels (usually).
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

    return null;
};

/**
 * Renders the scale indicator UI.
 * Must be placed OUTSIDE <Canvas>.
 */
export const ScaleOverlay: React.FC = () => {
    const { scaleData } = useScale();
    const { bottomPanelHeight } = useLayout();

    if (scaleData.width === 0) return null;

    return (
        <div 
            className="absolute right-8 flex flex-col items-end opacity-80 transition-all duration-300 pointer-events-none select-none z-10"
            style={{ bottom: (bottomPanelHeight + 16) + 'px' }}
        >
            <div 
                className="border-b-2 border-l-2 border-r-2 border-white mb-1"
                style={{ width: scaleData.width, height: '8px' }}
            />
            <span className="text-white text-xs font-mono font-bold text-shadow">
                {scaleData.label}
            </span>
        </div>
    );
};
