import { useEffect, useRef, useState } from 'react';

import { useSimulation } from '../context/SimulationContext';

export interface PerformanceData {
    fps: number;
    simTimeMs: number;
    /** Simulation-time / wall-time ratio (1.0 = real time). */
    speedRatio: number;
}

/** Rolling 60-frame FPS plus simulation clock and speed, sampled at 5 Hz. */
export function usePerformance(): PerformanceData {
    const engine = useSimulation();
    const [data, setData] = useState<PerformanceData>({ fps: 0, simTimeMs: 0, speedRatio: 1 });
    const frames = useRef<number[]>([]);

    useEffect(() => {
        let last = performance.now();
        let raf = 0;
        const measure = () => {
            const now = performance.now();
            frames.current.push(now - last);
            if (frames.current.length > 60) frames.current.shift();
            last = now;
            raf = requestAnimationFrame(measure);
        };
        raf = requestAnimationFrame(measure);
        const interval = setInterval(() => {
            const f = frames.current;
            const avg = f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0;
            setData({ fps: avg > 0 ? 1000 / avg : 0, simTimeMs: engine.simTimeMs, speedRatio: engine.simSpeedRatio });
        }, 200);
        return () => {
            cancelAnimationFrame(raf);
            clearInterval(interval);
        };
    }, [engine]);

    return data;
}

export function formatSimClock(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
        ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
        : `${m}:${s.toString().padStart(2, '0')}`;
}
