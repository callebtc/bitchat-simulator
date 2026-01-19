import React, { useEffect, useRef, useState } from 'react';
import { useSimulation } from '../context/SimulationContext';

interface PerformanceData {
    fps: number;
    simTimeMs: number;
}

export const PerformanceStats: React.FC = () => {
    const engine = useSimulation();
    const [perfData, setPerfData] = useState<PerformanceData>({ fps: 0, simTimeMs: 0 });
    
    // Refs for FPS calculation
    const frameTimesRef = useRef<number[]>([]);
    const lastFrameTimeRef = useRef<number>(performance.now());
    const rafIdRef = useRef<number>(0);
    
    // Ref for simulation start time
    const simStartTimeRef = useRef<number>(performance.now());
    
    useEffect(() => {
        // Reset simulation time on reset event
        const handleReset = () => {
            simStartTimeRef.current = performance.now();
        };
        engine.events.on('reset', handleReset);
        
        // FPS tracking loop
        const measureFrame = () => {
            const now = performance.now();
            const delta = now - lastFrameTimeRef.current;
            lastFrameTimeRef.current = now;
            
            // Keep last 60 frame times for averaging
            frameTimesRef.current.push(delta);
            if (frameTimesRef.current.length > 60) {
                frameTimesRef.current.shift();
            }
            
            rafIdRef.current = requestAnimationFrame(measureFrame);
        };
        
        rafIdRef.current = requestAnimationFrame(measureFrame);
        
        // Update display every 200ms
        const interval = setInterval(() => {
            const frameTimes = frameTimesRef.current;
            let fps = 0;
            
            if (frameTimes.length > 0) {
                const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
                fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
            }
            
            const simTimeMs = performance.now() - simStartTimeRef.current;
            
            setPerfData({ fps, simTimeMs });
        }, 200);
        
        return () => {
            engine.events.off('reset', handleReset);
            cancelAnimationFrame(rafIdRef.current);
            clearInterval(interval);
        };
    }, [engine]);
    
    // Format simulation time
    const formatSimTime = (ms: number): string => {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    return (
        <div className="flex justify-center gap-6 text-[10px] font-mono">
            <span><span className="text-gray-600">FPS</span> <span className="text-white">{perfData.fps.toFixed(0)}</span></span>
            <span><span className="text-gray-600">TIME</span> <span className="text-white">{formatSimTime(perfData.simTimeMs)}</span></span>
        </div>
    );
};
