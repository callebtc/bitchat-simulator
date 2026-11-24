import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { LogEntry, LogCategory } from '../../simulation/LogManager';
import { Segmented, Switch, HudButton, cx } from './primitives';

/**
 * Simulation event console: category filter, "selected device only",
 * auto-follow, copy and clear. Timestamps are simulation time.
 */

const UI_BUFFER = 500;

const CATEGORY_STYLE: Record<LogCategory, string> = {
    GLOBAL: 'text-slate-300 bg-white/[0.06]',
    PACKET: 'text-cyan-300 bg-cyan-400/10',
    CONNECTION: 'text-emerald-300 bg-emerald-400/10',
    PERSON: 'text-amber-300 bg-amber-400/10',
    DEVICE: 'text-violet-300 bg-violet-400/10',
};
const CATEGORY_SHORT: Record<LogCategory, string> = {
    GLOBAL: 'SYS',
    PACKET: 'PKT',
    CONNECTION: 'LINK',
    PERSON: 'MOVE',
    DEVICE: 'DEV',
};

type Filter = 'ALL' | LogCategory;
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
    { id: 'ALL', label: 'All' },
    { id: 'PACKET', label: 'Packets' },
    { id: 'CONNECTION', label: 'Links' },
    { id: 'DEVICE', label: 'Devices' },
    { id: 'GLOBAL', label: 'System' },
];

function simStamp(ms: number): string {
    const t = Math.max(0, ms) / 1000;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m.toString().padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function detailText(details: LogEntry['details']): string {
    if (details === undefined || details === null) return '';
    if (typeof details === 'object') {
        return Object.entries(details as Record<string, unknown>)
            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
            .join('  ');
    }
    return String(details);
}

export const LogView: React.FC = () => {
    const engine = useSimulation();
    const { selectedId } = useSelection();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [filter, setFilter] = useState<Filter>('ALL');
    const [onlySelected, setOnlySelected] = useState(false);
    const [autoScroll, setAutoScroll] = useState(true);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setLogs(engine.logManager.getLogs().slice(-150));
        // Batch incoming entries per animation frame (announce storms log hundreds per second)
        let pending: LogEntry[] = [];
        let raf = 0;
        const flush = () => {
            raf = 0;
            const batch = pending;
            pending = [];
            setLogs(prev => {
                const next = prev.concat(batch);
                return next.length > UI_BUFFER ? next.slice(next.length - UI_BUFFER) : next;
            });
        };
        const unsubscribe = engine.logManager.subscribe(entry => {
            pending.push(entry);
            if (!raf) raf = requestAnimationFrame(flush);
        });
        const onReset = () => setLogs([]);
        engine.events.on('reset', onReset);
        return () => {
            unsubscribe();
            if (raf) cancelAnimationFrame(raf);
            engine.events.off('reset', onReset);
        };
    }, [engine]);

    const selected = selectedId ? engine.getPerson(selectedId) : undefined;
    const filtered = useMemo(
        () =>
            logs.filter(log => {
                if (filter !== 'ALL' && log.category !== filter) return false;
                if (onlySelected && selectedId) {
                    if (selected) return log.entityId === selected.id || log.entityId === selected.device.peerIDHex;
                    return log.entityId === selectedId;
                }
                return true;
            }),
        [logs, filter, onlySelected, selectedId, selected]
    );

    useEffect(() => {
        const el = listRef.current;
        if (autoScroll && el) el.scrollTop = el.scrollHeight;
    }, [filtered, autoScroll]);

    const copy = () => {
        const text = filtered
            .map(l => `[${simStamp(l.timestamp)}] [${l.category}] ${l.message} ${detailText(l.details)}`)
            .join('\n');
        void navigator.clipboard.writeText(text);
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.05] px-3 py-1.5">
                <Segmented size="xs" options={FILTERS} value={filter} onChange={setFilter} />
                <label
                    className={cx('ml-2 flex items-center gap-1.5 text-[11px]', selectedId ? 'text-slate-300' : 'text-slate-600')}
                    title={selectedId ? 'Only entries about the selected device' : 'Select a device to filter'}
                >
                    <Switch on={onlySelected && Boolean(selectedId)} onChange={setOnlySelected} />
                    Selected only
                </label>
                <span className="ml-auto font-mono text-[10px] text-slate-500">{filtered.length} entries</span>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
                    <Switch on={autoScroll} onChange={setAutoScroll} />
                    Follow
                </label>
                <HudButton small onClick={copy}>
                    Copy
                </HudButton>
                <HudButton small tone="danger" onClick={() => engine.logManager.clear()}>
                    Clear
                </HudButton>
            </div>

            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1 font-mono text-[11px] leading-[18px]">
                {filtered.map(log => {
                    const tone =
                        log.level === 'ERROR'
                            ? 'bg-rose-500/10'
                            : log.level === 'WARN'
                              ? 'bg-amber-400/[0.06]'
                              : 'hover:bg-white/[0.03]';
                    const details = detailText(log.details);
                    return (
                        <div key={log.id} className={cx('flex items-baseline gap-2 rounded px-1.5', tone)}>
                            <span className="w-[52px] shrink-0 tabular-nums text-slate-600">{simStamp(log.timestamp)}</span>
                            <span
                                className={cx(
                                    'w-[38px] shrink-0 rounded px-1 text-center text-[9px] font-semibold leading-[15px]',
                                    CATEGORY_STYLE[log.category]
                                )}
                            >
                                {CATEGORY_SHORT[log.category]}
                            </span>
                            {log.entityId && log.category === 'PACKET' ? (
                                <span className="w-[54px] shrink-0 truncate" style={{ color: log.color }}>
                                    {log.entityId.substring(0, 6)}
                                </span>
                            ) : (
                                <span className="w-[54px] shrink-0" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-slate-200" title={details ? `${log.message}  ${details}` : log.message}>
                                {log.message}
                                {details && <span className="ml-2 text-slate-500">{details}</span>}
                            </span>
                        </div>
                    );
                })}
                {filtered.length === 0 && <div className="py-6 text-center text-[11px] text-slate-600">No log entries</div>}
            </div>
        </div>
    );
};
