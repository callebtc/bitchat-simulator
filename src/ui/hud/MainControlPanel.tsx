import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { useLayout } from '../context/LayoutContext';
import { useVisualization } from '../context/VisualizationContext';
import { addRandomNode, setupDemo } from '../../simulation/DemoSetup';
import { MovementMode } from '../../simulation/BitchatPerson';
import { BitchatAppSimulator } from '../../simulation/AppLayer/BitchatAppSimulator';
import { MeshPolicyPreset } from '../../simulation/AppLayer/MeshPolicy';
import { usePersistedState } from '../../utils/usePersistedState';
import { EnvironmentSection } from './EnvironmentSection';
import { ViewSection } from './ViewSection';
import { formatSimClock, usePerformance } from './PerformanceStats';
import { HudButton, HudPanel, Icon, Row, Section, Segmented, Stat, Switch, ToggleChip, cx } from './primitives';

/**
 * Left control rail: status header, KPIs, then View · Layers · Population ·
 * Location · Telemetry sections. Refreshes at 4 Hz; graph history is kept in
 * a ref so the 3D view never re-renders because of it.
 */

interface HistoryPoint {
    time: number;
    value: number;
}

const HISTORY_MS = 30_000;
const LONG_PRESS_MS = 400;
const CHARGE_STEP_MS = 50;
const MAX_CHARGE = 1000;

const Sparkline: React.FC<{ data: HistoryPoint[]; color: string; label: string; unit?: string }> = ({
    data,
    color,
    label,
    unit,
}) => {
    const W = 100;
    const H = 32;
    const { line, area } = useMemo(() => {
        if (data.length < 2) return { line: '', area: '' };
        const now = data[data.length - 1].time;
        const max = Math.max(...data.map(d => d.value), 1);
        const pts = data.map(
            d =>
                `${(((d.time - (now - HISTORY_MS)) / HISTORY_MS) * W).toFixed(1)},${(H - (d.value / max) * (H - 2) - 1).toFixed(1)}`
        );
        return { line: pts.join(' '), area: `0,${H} ${pts.join(' ')} ${W},${H}` };
    }, [data]);
    const last = data.length ? data[data.length - 1].value : 0;
    return (
        <div className="min-w-0 flex-1 rounded-lg bg-white/[0.03] px-2 pb-1 pt-1.5 ring-1 ring-white/[0.05]">
            <div className="flex items-baseline justify-between">
                <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</span>
                <span className="font-mono text-[11px] tabular-nums" style={{ color }}>
                    {last.toFixed(0)}
                    {unit && <span className="text-slate-500">{unit}</span>}
                </span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 block h-8 w-full">
                <polygon points={area} fill={color} opacity={0.12} />
                <polyline points={line} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
            </svg>
        </div>
    );
};

export const MainControlPanel: React.FC = () => {
    const engine = useSimulation();
    const { viewCenterRef } = useSelection();
    const { bottomPanelHeight } = useLayout();
    const viz = useVisualization();
    const perf = usePerformance();

    const [collapsed, setCollapsed] = usePersistedState('main_panel_collapsed', false);
    const [spawnBusy, setSpawnBusy] = useState(false);
    const [fleetPolicy, setFleetPolicy] = useState<MeshPolicyPreset>('android');
    const [fleetWifiAware, setFleetWifiAware] = useState(false);
    const history = useRef({ links: [] as HistoryPoint[], pps: [] as HistoryPoint[] });
    const [, refresh] = useState(0);

    useEffect(() => {
        const onReset = () => {
            history.current = { links: [], pps: [] };
            refresh(n => n + 1);
        };
        engine.events.on('reset', onReset);
        const interval = setInterval(() => {
            const now = Date.now();
            const h = history.current;
            h.links.push({ time: now, value: engine.getAllConnections().length });
            h.pps.push({ time: now, value: engine.telemetry.getSnapshot(engine.simTimeMs).recentPackets1s });
            const cutoff = now - HISTORY_MS;
            h.links = h.links.filter(d => d.time > cutoff);
            h.pps = h.pps.filter(d => d.time > cutoff);
            refresh(n => n + 1);
        }, 250);
        return () => {
            engine.events.off('reset', onReset);
            clearInterval(interval);
        };
    }, [engine]);

    // ---- Derived stats ----
    const peerCount = engine.getAllPeople().length;
    const conns = engine.getAllConnections();
    let wifiLinks = 0;
    for (let i = 0; i < conns.length; i++) if (conns[i].transportType === 'WIFI_AWARE') wifiLinks++;
    const bleLinks = conns.length - wifiLinks;
    const t = engine.telemetry.getSnapshot(engine.simTimeMs);
    const delivery =
        t.originatedByKind.dm > 0
            ? t.deliveryRatio.dm
            : t.originatedByKind.broadcast > 0
              ? t.deliveryRatio.broadcast
              : null;
    const buildingCount = engine.environment.getBuildingCount();

    // ---- Population actions ----
    const spawnBatch = (count: number) => {
        const preferOutdoors = engine.environment.getBuildingCount() > 0 && count >= 10;
        for (let i = 0; i < count; i++) {
            addRandomNode(engine, {
                center: viewCenterRef.current,
                preferOutdoors,
                initialMode: spawnBusy ? MovementMode.BUSY : MovementMode.RANDOM_WALK,
                policyPreset: fleetPolicy,
                wifiAwareEnabled: fleetWifiAware,
            });
        }
        refresh(n => n + 1);
    };

    const setPolicy = (preset: MeshPolicyPreset) => {
        setFleetPolicy(preset);
        engine.getAllPeople().forEach(p => (p.device.appSimulator as BitchatAppSimulator | undefined)?.setPolicy(preset));
    };

    const setWifiAware = (on: boolean) => {
        setFleetWifiAware(on);
        engine.getAllPeople().forEach(p => (p.device.wifiAwareEnabled = on));
    };

    // Long-press "+ Add" charges a batch size
    const [charge, setCharge] = useState(0);
    const chargeRef = useRef(0);
    const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const chargeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const stopTimers = () => {
        if (pressTimer.current) clearTimeout(pressTimer.current);
        if (chargeTimer.current) clearInterval(chargeTimer.current);
        pressTimer.current = null;
        chargeTimer.current = null;
    };
    useEffect(() => stopTimers, []);
    const onAddDown = (e: React.PointerEvent) => {
        e.preventDefault();
        pressTimer.current = setTimeout(() => {
            chargeRef.current = 1;
            setCharge(1);
            chargeTimer.current = setInterval(() => {
                const c = chargeRef.current;
                chargeRef.current = Math.min(MAX_CHARGE, c + (c >= 100 ? 25 : c >= 20 ? 5 : 1));
                setCharge(chargeRef.current);
            }, CHARGE_STEP_MS);
        }, LONG_PRESS_MS);
    };
    const onAddUp = () => {
        stopTimers();
        spawnBatch(chargeRef.current > 0 ? chargeRef.current : 1);
        chargeRef.current = 0;
        setCharge(0);
    };
    const onAddCancel = () => {
        stopTimers();
        chargeRef.current = 0;
        setCharge(0);
    };

    const speedTone =
        perf.speedRatio >= 0.85 ? 'text-emerald-400' : perf.speedRatio >= 0.4 ? 'text-amber-400' : 'text-orange-400';

    return (
        <HudPanel
            className="absolute left-3 top-3 z-20 w-[300px] overflow-hidden"
            style={{ maxHeight: `calc(100vh - ${bottomPanelHeight + 24}px)` }}
        >
            {/* Header */}
            <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
                <div className="flex items-baseline gap-1">
                    <span className="font-mono text-[13px] font-bold tracking-tight text-emerald-400">bitchat</span>
                    <span className="rounded bg-cyan-400/10 px-1 text-[9px] font-semibold uppercase tracking-wider text-cyan-300">
                        sim
                    </span>
                </div>
                <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> live
                </span>
                <div className="ml-auto flex items-center gap-2 font-mono text-[10px] tabular-nums text-slate-400">
                    <span title="Frames per second">{perf.fps.toFixed(0)}fps</span>
                    <span title="Simulation clock">{formatSimClock(perf.simTimeMs)}</span>
                    <span title="Simulation speed vs real time" className={speedTone}>
                        {perf.speedRatio.toFixed(2)}×
                    </span>
                </div>
                <button
                    onClick={() => setCollapsed(!collapsed)}
                    title={collapsed ? 'Expand' : 'Collapse'}
                    className="rounded p-0.5 text-slate-500 hover:bg-white/5 hover:text-slate-200"
                >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                        <polyline points={collapsed ? '6 9 12 15 18 9' : '18 15 12 9 6 15'} />
                    </svg>
                </button>
            </div>

            {!collapsed && (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {/* KPI strip */}
                    <div className="grid grid-cols-4 gap-1.5 px-3 pb-3">
                        <Stat label="Peers" value={peerCount} tone="text-cyan-300" />
                        <Stat
                            label="Links"
                            value={conns.length}
                            tone="text-emerald-300"
                            sub={wifiLinks ? `${bleLinks} BLE · ${wifiLinks} Wi-Fi` : 'BLE'}
                        />
                        <Stat label="Pkt/s" value={t.recentPackets1s} />
                        <Stat
                            label="Deliv"
                            value={delivery === null ? '—' : `${Math.round(delivery * 100)}%`}
                            tone={delivery === null ? 'text-slate-500' : delivery > 0.9 ? 'text-emerald-300' : 'text-amber-300'}
                        />
                    </div>

                    <Section title="View" icon={Icon.eye} persistKey="rail_view_open">
                        <ViewSection />
                    </Section>

                    <Section title="Layers" icon={Icon.layers} persistKey="rail_layers_open">
                        <div className="grid grid-cols-3 gap-1">
                            <ToggleChip label="Links" on={viz.showLinks} onChange={viz.setShowLinks} color="#4ade80" />
                            <ToggleChip label="Pulses" on={viz.showRadioPulses} onChange={viz.setShowRadioPulses} color="#38bdf8" />
                            <ToggleChip
                                label="Announce"
                                on={viz.showAnnouncePackets}
                                onChange={viz.setShowAnnouncePackets}
                                color="#22d3ee"
                            />
                            <ToggleChip label="Names" on={viz.showLabels} onChange={viz.setShowLabels} color="#e2e8f0" />
                            <ToggleChip label="Bubbles" on={viz.showChatBubbles} onChange={viz.setShowChatBubbles} color="#a7f3d0" />
                            <ToggleChip label="Focus" on={viz.highlightOwnMesh} onChange={viz.setHighlightOwnMesh} color="#fde047" />
                        </div>
                    </Section>

                    <Section title="Population" icon={Icon.users} persistKey="rail_population_open" meta={`${peerCount} · ${fleetPolicy}`}>
                        <div className="flex gap-1">
                            <button
                                onPointerDown={onAddDown}
                                onPointerUp={onAddUp}
                                onPointerLeave={onAddCancel}
                                onContextMenu={e => e.preventDefault()}
                                title="Click: add 1 · hold: charge a batch"
                                className={cx(
                                    'relative flex-1 overflow-hidden rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                                    charge > 0
                                        ? 'border-cyan-300/60 bg-cyan-400/20 text-white'
                                        : 'border-cyan-400/30 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/20'
                                )}
                            >
                                {charge > 0 && (
                                    <span
                                        className="absolute inset-y-0 left-0 bg-cyan-300/25"
                                        style={{ width: `${(charge / MAX_CHARGE) * 100}%` }}
                                    />
                                )}
                                <span className="relative">{charge > 0 ? `+${charge}` : '+ Add'}</span>
                            </button>
                            {[100, 500, 1000].map(n => (
                                <HudButton key={n} onClick={() => spawnBatch(n)}>
                                    +{n >= 1000 ? `${n / 1000}k` : n}
                                </HudButton>
                            ))}
                            <HudButton
                                tone="danger"
                                title="Reset to 5 demo devices"
                                onClick={() =>
                                    setupDemo(engine, 5, {
                                        policyPreset: fleetPolicy,
                                        wifiAwareEnabled: fleetWifiAware,
                                        initialMode: MovementMode.RANDOM_WALK,
                                    })
                                }
                            >
                                Reset
                            </HudButton>
                        </div>
                        <div className="mt-2 divide-y divide-white/[0.04]">
                            <Row label="Client policy" hint="Relay / routing behaviour applied to every device">
                                <Segmented
                                    size="xs"
                                    options={[
                                        { id: 'android', label: 'Android' },
                                        { id: 'ios', label: 'iOS' },
                                    ] as const}
                                    value={fleetPolicy}
                                    onChange={setPolicy}
                                />
                            </Row>
                            <Row label="Wi-Fi Aware (5 GHz)">
                                <Switch on={fleetWifiAware} onChange={setWifiAware} tone="violet" />
                            </Row>
                            <Row label="Spawn indoors (busy)">
                                <Switch on={spawnBusy} onChange={setSpawnBusy} tone="amber" />
                            </Row>
                        </div>
                        <HudButton
                            tone="amber"
                            className="mt-1.5 w-full"
                            onClick={() => engine.getAllPeople().forEach(p => p.setMode(MovementMode.BUSY))}
                        >
                            Send everyone indoors
                        </HudButton>
                    </Section>

                    <Section
                        title="Location"
                        icon={Icon.pin}
                        persistKey="rail_location_open"
                        meta={buildingCount ? `${buildingCount} buildings` : 'open field'}
                    >
                        <EnvironmentSection />
                    </Section>

                    <Section title="Telemetry" icon={Icon.chart} persistKey="rail_telemetry_open" defaultOpen={false}>
                        <div className="flex gap-1.5">
                            <Sparkline data={history.current.links} color="#4ade80" label="Links" />
                            <Sparkline data={history.current.pps} color="#22d3ee" label="Packets" unit="/s" />
                        </div>
                        <div className="mt-1.5 grid grid-cols-4 gap-1">
                            <Stat label="10s" value={t.recentPackets10s} />
                            <Stat label="1m" value={t.recentPackets60s} />
                            <Stat
                                label="Total"
                                value={t.packetsSent >= 10000 ? `${(t.packetsSent / 1000).toFixed(0)}k` : t.packetsSent}
                            />
                            <Stat label="Amp" value={`${t.packetAmplification.toFixed(1)}×`} tone="text-amber-300" />
                        </div>
                        <div className="mt-1.5 grid grid-cols-3 gap-1">
                            <Stat
                                label="p50/p95"
                                value={
                                    t.latencyMs.all.count > 0
                                        ? `${t.latencyMs.all.p50.toFixed(0)}/${t.latencyMs.all.p95.toFixed(0)}`
                                        : '—'
                                }
                                sub="ms latency"
                            />
                            <Stat label="Src route" value={`${(t.sourceRouteHitRate * 100).toFixed(0)}%`} sub="hit rate" />
                            <Stat label="Dupes" value={t.drops.duplicate} sub="suppressed" />
                        </div>
                    </Section>
                </div>
            )}
        </HudPanel>
    );
};
