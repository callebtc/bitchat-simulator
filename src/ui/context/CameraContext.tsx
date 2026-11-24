import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * Camera modes
 *  - `free`   : orbit / pan / zoom around a ground target.
 *  - `follow` : orbit target locked to a person; user keeps full rotate & zoom.
 *  - `chase`  : third-person camera that settles behind the person's heading.
 *  - `fpv`    : first-person view from the person's eyes (drag to look around).
 */
export type CameraMode = 'free' | 'follow' | 'chase' | 'fpv';

/** Live camera telemetry written every frame by the rig (no React re-renders). */
export interface CameraTelemetry {
    /** Compass heading of the view direction, radians (0 = north, clockwise). */
    heading: number;
    /** Camera pitch below horizon, radians. */
    pitch: number;
    /** Distance from camera to orbit target, meters. */
    distance: number;
    /** Meters spanned by 100 CSS pixels at the orbit target. */
    metersPer100px: number;
    /** Orbit target in simulation coordinates. */
    targetX: number;
    targetY: number;
}

interface CameraContextType {
    mode: CameraMode;
    /** BitchatPerson.id being followed (for follow / chase / fpv). */
    followId: string | null;
    follow: (personId: string, mode?: Exclude<CameraMode, 'free'>) => void;
    setMode: (mode: CameraMode) => void;
    release: () => void;
    telemetryRef: React.MutableRefObject<CameraTelemetry>;
    /** Increments to request a top-down "frame everything" reset. */
    resetNonce: number;
    requestReset: () => void;
}

const defaultTelemetry: CameraTelemetry = {
    heading: 0,
    pitch: 0.8,
    distance: 400,
    metersPer100px: 50,
    targetX: 0,
    targetY: 0,
};

const CameraContext = createContext<CameraContextType>({
    mode: 'free',
    followId: null,
    follow: () => {},
    setMode: () => {},
    release: () => {},
    telemetryRef: { current: defaultTelemetry },
    resetNonce: 0,
    requestReset: () => {},
});

export const CameraProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [mode, setModeState] = useState<CameraMode>('free');
    const [followId, setFollowId] = useState<string | null>(null);
    const [resetNonce, setResetNonce] = useState(0);
    const telemetryRef = useRef<CameraTelemetry>({ ...defaultTelemetry });

    const follow = useCallback((personId: string, nextMode: Exclude<CameraMode, 'free'> = 'follow') => {
        setFollowId(personId);
        setModeState(nextMode);
    }, []);

    const release = useCallback(() => {
        setModeState('free');
        setFollowId(null);
    }, []);

    const setMode = useCallback((next: CameraMode) => {
        setModeState(next);
        if (next === 'free') setFollowId(null);
    }, []);

    const requestReset = useCallback(() => {
        setModeState('free');
        setFollowId(null);
        setResetNonce(n => n + 1);
    }, []);

    const value = useMemo<CameraContextType>(
        () => ({ mode, followId, follow, setMode, release, telemetryRef, resetNonce, requestReset }),
        [mode, followId, follow, setMode, release, resetNonce, requestReset]
    );

    return <CameraContext.Provider value={value}>{children}</CameraContext.Provider>;
};

export const useCamera = (): CameraContextType => useContext(CameraContext);
