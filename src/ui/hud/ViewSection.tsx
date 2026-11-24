import React, { useEffect, useRef } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { CameraMode, useCamera } from '../context/CameraContext';
import { BuildingStyle, GraphicsQuality, useVisualization } from '../context/VisualizationContext';
import { formatClock } from '../scene/world/sun';
import { HudButton, Segmented } from './primitives';

/**
 * View controls for the left rail: compass + scale, camera mode, time of day,
 * building style and render quality. Keyboard shortcuts live in
 * `ViewShortcuts` so they work even when the rail is collapsed.
 */

const CAMERA_MODES: ReadonlyArray<{ id: CameraMode; label: string; hint: string }> = [
    { id: 'free', label: 'Orbit', hint: 'Free orbit · drag rotate, right-drag pan, wheel zoom (1)' },
    { id: 'follow', label: 'Follow', hint: 'Lock the orbit target to the selected device (2)' },
    { id: 'chase', label: 'Chase', hint: 'Third-person camera behind the device (3)' },
    { id: 'fpv', label: 'Eyes', hint: 'First-person view, drag to look around (4)' },
];

const STYLES: ReadonlyArray<{ id: BuildingStyle; label: string }> = [
    { id: 'solid', label: 'Solid' },
    { id: 'glass', label: 'Glass' },
    { id: 'blueprint', label: 'Wire' },
];

const QUALITIES: ReadonlyArray<{ id: GraphicsQuality; label: string; hint: string }> = [
    { id: 'high', label: 'Ultra', hint: '4K shadows, bloom, 1.5× resolution' },
    { id: 'balanced', label: 'High', hint: '2K shadows, bloom' },
    { id: 'fast', label: 'Fast', hint: 'No shadows or bloom' },
];

const TIME_PRESETS = [
    { glyph: '◒', title: 'Dawn', hour: 6.8 },
    { glyph: '☀', title: 'Noon', hour: 12.5 },
    { glyph: '◓', title: 'Golden hour', hour: 17.0 },
    { glyph: '◐', title: 'Blue hour', hour: 18.25 },
    { glyph: '☾', title: 'Night', hour: 22.5 },
];

const NICE_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

const Compass: React.FC = () => {
    const { telemetryRef, requestReset } = useCamera();
    const needleRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const labelRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        let raf = 0;
        const tick = () => {
            const t = telemetryRef.current;
            if (needleRef.current) needleRef.current.style.transform = `rotate(${(-t.heading * 180) / Math.PI}deg)`;
            const mPerPx = t.metersPer100px / 100;
            let meters = NICE_SCALES[0];
            for (const n of NICE_SCALES) if (n / mPerPx <= 64) meters = n;
            if (barRef.current) barRef.current.style.width = `${Math.max(8, meters / mPerPx)}px`;
            if (labelRef.current) labelRef.current.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [telemetryRef]);

    return (
        <div className="flex items-center gap-2.5">
            <button
                onClick={requestReset}
                title="Reset view (H)"
                className="relative h-8 w-8 shrink-0 rounded-full bg-black/40 ring-1 ring-white/10 transition hover:ring-cyan-300/50"
            >
                <div ref={needleRef} className="absolute inset-0 will-change-transform">
                    <span className="absolute left-1/2 top-[1px] -translate-x-1/2 text-[7px] font-bold text-rose-400">N</span>
                    <div className="absolute left-1/2 top-[9px] h-0 w-0 -translate-x-1/2 border-x-[3.5px] border-b-[7px] border-x-transparent border-b-rose-400" />
                    <div className="absolute left-1/2 top-[16px] h-0 w-0 -translate-x-1/2 border-x-[3.5px] border-t-[7px] border-x-transparent border-t-slate-500" />
                </div>
            </button>
            <div className="flex flex-col gap-0.5">
                <div ref={barRef} className="h-1 rounded-sm border-x border-b border-slate-400/70" style={{ width: 32 }} />
                <span ref={labelRef} className="font-mono text-[9px] text-slate-500">
                    —
                </span>
            </div>
        </div>
    );
};

/** Keyboard: 1–4 camera modes, H reset view, Esc stops following. */
export const ViewShortcuts: React.FC = () => {
    const { selectedId, selectionType } = useSelection();
    const { followId, follow, setMode, requestReset } = useCamera();
    const stateRef = useRef({ selectedId, selectionType, followId });
    stateRef.current = { selectedId, selectionType, followId };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target;
            if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const idx = ['1', '2', '3', '4'].indexOf(e.key);
            if (idx >= 0) {
                const m = CAMERA_MODES[idx].id;
                const s = stateRef.current;
                const candidate = s.selectedId && s.selectionType === 'node' ? s.selectedId : s.followId;
                if (m === 'free') setMode('free');
                else if (candidate) follow(candidate, m);
            } else if (e.key === 'h' || e.key === 'Home') requestReset();
            else if (e.key === 'Escape') setMode('free');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [follow, setMode, requestReset]);

    return null;
};

export const ViewSection: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType } = useSelection();
    const { mode, followId, follow, setMode } = useCamera();
    const { timeOfDay, setTimeOfDay, buildingStyle, setBuildingStyle, graphicsQuality, setGraphicsQuality } =
        useVisualization();

    const candidateId = selectedId && selectionType === 'node' ? selectedId : followId;
    const followed = followId && mode !== 'free' ? engine.getPerson(followId) : undefined;
    const sunUp = timeOfDay > 6.2 && timeOfDay < 17.8;

    const changeMode = (m: CameraMode) => {
        if (m === 'free') setMode('free');
        else if (candidateId) follow(candidateId, m);
    };

    return (
        <div className="space-y-2.5">
            <div className="flex items-center gap-2.5">
                <Compass />
                <Segmented
                    className="flex-1"
                    size="xs"
                    options={CAMERA_MODES}
                    value={mode}
                    onChange={changeMode}
                    disabled={m => m !== 'free' && !candidateId}
                />
            </div>

            {followed && (
                <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-100 ring-1 ring-emerald-400/25">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                    <span className="truncate">
                        {mode === 'fpv' ? 'Eyes of' : mode === 'chase' ? 'Chasing' : 'Following'}{' '}
                        <strong className="font-semibold">{followed.device.nickname}</strong>
                    </span>
                    <HudButton small className="ml-auto" onClick={() => setMode('free')}>
                        Esc
                    </HudButton>
                </div>
            )}

            <div>
                <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] text-slate-500">Time of day</span>
                    <span className="font-mono text-[10px] text-amber-200/90">
                        {sunUp ? '☀' : '☾'} {formatClock(timeOfDay)}
                    </span>
                </div>
                <input
                    type="range"
                    min={0}
                    max={24}
                    step={0.05}
                    value={timeOfDay}
                    onChange={e => setTimeOfDay(parseFloat(e.target.value))}
                    className="time-slider w-full"
                />
                <div className="mt-1 flex justify-between">
                    {TIME_PRESETS.map(p => (
                        <button
                            key={p.title}
                            title={p.title}
                            onClick={() => setTimeOfDay(p.hour)}
                            className="rounded px-1.5 text-[10px] text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                        >
                            <span className="mr-0.5">{p.glyph}</span>
                            {p.title.split(' ')[0]}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <div>
                    <div className="mb-1 text-[10px] text-slate-500">Buildings</div>
                    <Segmented size="xs" options={STYLES} value={buildingStyle} onChange={setBuildingStyle} />
                </div>
                <div>
                    <div className="mb-1 text-[10px] text-slate-500">Quality</div>
                    <Segmented size="xs" options={QUALITIES} value={graphicsQuality} onChange={setGraphicsQuality} />
                </div>
            </div>
        </div>
    );
};
