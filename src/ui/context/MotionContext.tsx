import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';

import { useSimulation } from './SimulationContext';
import { MotionSmoother } from '../scene/motion/MotionSmoother';

/**
 * Shares one MotionSmoother between the 3D scene and DOM overlays so every
 * consumer (figures, links, camera follow, labels, bubbles, picking) sees
 * identical, smoothly interpolated positions.
 */
const MotionContext = createContext<MotionSmoother>(new MotionSmoother());

export const MotionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const engine = useSimulation();
    const smoother = useMemo(() => new MotionSmoother(), []);

    useEffect(() => {
        const onReset = () => smoother.clear();
        engine.events.on('reset', onReset);
        return () => engine.events.off('reset', onReset);
    }, [engine, smoother]);

    return <MotionContext.Provider value={smoother}>{children}</MotionContext.Provider>;
};

export const useMotion = (): MotionSmoother => useContext(MotionContext);

/** Advances interpolation once per frame, before any layer reads positions. */
export const MotionDriver: React.FC = () => {
    const engine = useSimulation();
    const smoother = useMotion();
    useFrame(() => smoother.update(engine, performance.now()), -10);
    return null;
};
