import React, { useEffect, useRef } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { CameraMode, useCamera } from '../context/CameraContext';
import { BuildingStyle, GraphicsQuality, useVisualization } from '../context/VisualizationContext';
import { formatClock } from '../scene/world/sun';

/**
 * Top-center glass dock: camera mode, follow target, time of day,
 * building rendering style and graphics quality, plus a live compass/scale.
 */

const CAMERA_MODES: { id: CameraMode; label: string; hint: string; key: string }[] = [
    { id: 'free', label: 'Orbit', hint: 'Free orbit · drag to rotate, right-drag to pan', key: '1' },
    { id: 'follow', label: 'Follow', hint: 'Lock orbit target to the selected device', key: '2' },
    { id: 'chase', label: 'Chase', hint: 'Third-person camera behind the device', key: '3' },
    { id: 'fpv', label: 'Eyes', hint: 'First-person view from the device holder', key: '4' },
];

const STYLES: { id: BuildingStyle; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'glass', label: 'Glass' },
    { id: 'blueprint', label: 'Wire' },
];

const QUALITIES: { id: GraphicsQuality; label: string }[] = [
    { id: 'high', label: 'Ultra' },
    { id: 'balanced', label: 'High' },
    { id: 'fast', label: 'Fast' },
];

const TIME_PRESETS = [
    { label: '🌅', title: 'Dawn', hour: 6.8 },
    { label: '☀️', title: 'Noon', hour: 12.5 },
    { label: '🌇', title: 'Golden hour', hour: 17.0 },
    { label: '🌆', title: 'Blue hour', hour: 18.25 },
    { label: '🌙', title: 'Night', hour: 22.5 },
];

const Segmented = <T extends string>({
    options,
    value,
    onChange,
    disabled,
}: {
    options: { id: T; label: string; hint?: string }[];
    value: T;
    onChange: (v: T) => void;
    disabled?: (v: T) => boolean;
}) => (
    <div className="flex rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/10">
        {options.map(o => {
            const isOn = o.id === value;
            const isDisabled = disabled?.(o.id) ?? false;
            return (
                <button
                    key={o.id}
                    title={o.hint}
                    disabled={isDisabled}
                    onClick={() => onChange(o.id)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-all ${
                        isOn
                            ? 'bg-gradient-to-b from-cyan-400/25 to-cyan-500/10 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.25)] ring-1 ring-cyan-300/40'
                            : isDisabled
                              ? 'cursor-not-allowed text-slate-600'
                              : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
                    }`}
                >
                    {o.label}
                </button>
            );
        })}
    </div>
);

const Compass: React.FC = () => {
    const { telemetryRef, requestReset } = useCamera();
    const needleRef = useRef<HTMLDivElement>(null);
    const scaleBarRef = useRef<HTMLDivElement>(null);
    const scaleLabelRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        let raf = 0;
        const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
        const tick = () => {
            const t = telemetryRef.current;
            if (needleRef.current) {
                needleRef.current.style.transform = `rotate(${(-t.heading * 180) / Math.PI}deg)`;
            }
            // Pick a round distance that fits in ~70 px
            const mPerPx = t.metersPer100px / 100;
            let meters = nice[0];
            for (const n of nice) if (n / mPerPx <= 72) meters = n;
            if (scaleBarRef.current) scaleBarRef.current.style.width = `${Math.max(8, meters / mPerPx)}px`;
            if (scaleLabelRef.current) {
                scaleLabelRef.current.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [telemetryRef]);

    return (
        <div className="flex items-center gap-3">
            <button
                onClick={requestReset}
                title="Reset view (Home)"
                className="relative h-9 w-9 shrink-0 rounded-full bg-slate-950/60 ring-1 ring-white/15 transition hover:ring-cyan-300/50"
            >
                <div ref={needleRef} className="absolute inset-0 will-change-transform">
                    <span className="absolute left-1/2 top-0.5 -translate-x-1/2 text-[8px] font-bold text-rose-400">N</span>
                    <div className="absolute left-1/2 top-[11px] h-0 w-0 -translate-x-1/2 border-x-[4px] border-b-[9px] border-x-transparent border-b-rose-400" />
                    <div className="absolute left-1/2 top-[19px] h-0 w-0 -translate-x-1/2 border-x-[4px] border-t-[9px] border-x-transparent border-t-slate-500" />
                </div>
            </button>
            <div className="flex flex-col gap-1">
                <div ref={scaleBarRef} className="h-1.5 rounded-sm border-x border-b border-slate-300/70" style={{ width: 40 }} />
                <span ref={scaleLabelRef} className="font-mono text-[10px] text-slate-400">
                    —
                </span>
            </div>
        </div>
    );
};

export const ViewDock: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType } = useSelection();
    const { mode, followId, follow, setMode, requestReset } = useCamera();
    const {
        timeOfDay,
        setTimeOfDay,
        buildingStyle,
        setBuildingStyle,
        graphicsQuality,
        setGraphicsQuality,
    } = useVisualization();

    const candidateId = selectedId && selectionType === 'node' ? selectedId : followId;
    const followed = followId ? engine.getPerson(followId) : undefined;

    const changeMode = (m: CameraMode) => {
        if (m === 'free') setMode('free');
        else if (candidateId) follow(candidateId, m);
    };

    // Keyboard shortcuts: 1–4 camera modes, H/Home reset, Esc releases follow
    const modeRef = useRef(changeMode);
    modeRef.current = changeMode;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target;
            if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const m = CAMERA_MODES.find(cm => cm.key === e.key);
            if (m) modeRef.current(m.id);
            else if (e.key === 'h' || e.key === 'Home') requestReset();
            else if (e.key === 'Escape') setMode('free');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [requestReset, setMode]);

    const sunUp = timeOfDay > 6.2 && timeOfDay < 17.8;

    return (
        <div className="pointer-events-none fixed left-[316px] right-3 top-3 z-20 flex flex-col items-center gap-2">
            <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/65 px-3 py-2 shadow-[0_8px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
                <Compass />
                <div className="h-8 w-px bg-white/10" />
                <div className="flex flex-col gap-1">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">Camera</span>
                    <Segmented
                        options={CAMERA_MODES}
                        value={mode}
                        onChange={changeMode}
                        disabled={m => m !== 'free' && !candidateId}
                    />
                </div>
                <div className="h-8 w-px bg-white/10" />
                <div className="flex flex-col gap-1">
                    <span className="flex items-center justify-between text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        <span>Time</span>
                        <span className="font-mono normal-case tracking-normal text-amber-200/90">
                            {sunUp ? '☀' : '☾'} {formatClock(timeOfDay)}
                        </span>
                    </span>
                    <div className="flex items-center gap-2">
                        <input
                            type="range"
                            min={0}
                            max={24}
                            step={0.05}
                            value={timeOfDay}
                            onChange={e => setTimeOfDay(parseFloat(e.target.value))}
                            className="time-slider w-28"
                        />
                        <div className="hidden gap-0.5 xl:flex">
                            {TIME_PRESETS.map(p => (
                                <button
                                    key={p.title}
                                    title={p.title}
                                    onClick={() => setTimeOfDay(p.hour)}
                                    className="rounded px-1 py-0.5 text-[11px] opacity-70 grayscale-[30%] transition hover:bg-white/5 hover:opacity-100"
                                >
                                    {p.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="h-8 w-px bg-white/10" />
                <div className="flex flex-col gap-1">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">Buildings</span>
                    <Segmented options={STYLES} value={buildingStyle} onChange={setBuildingStyle} />
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quality</span>
                    <Segmented options={QUALITIES} value={graphicsQuality} onChange={setGraphicsQuality} />
                </div>
            </div>
            {followed && mode !== 'free' && (
                <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-950/60 px-3 py-1 text-[11px] text-emerald-100 shadow-lg backdrop-blur-md">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                    {mode === 'fpv' ? 'Seeing through' : mode === 'chase' ? 'Chasing' : 'Following'}{' '}
                    <strong className="font-semibold">{followed.device.nickname}</strong>
                    <button
                        onClick={() => setMode('free')}
                        className="ml-1 rounded-full bg-white/10 px-1.5 text-[10px] text-emerald-200 hover:bg-white/20"
                    >
                        Esc
                    </button>
                </div>
            )}
        </div>
    );
};
