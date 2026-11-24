import React, { useEffect, useRef, useState } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { useCamera } from '../context/CameraContext';
import { useLayout } from '../context/LayoutContext';
import { useVisualization } from '../context/VisualizationContext';
import { BitchatAppSimulator, ChatMessage } from '../../simulation/AppLayer/BitchatAppSimulator';
import { BitchatConnectionBLE } from '../../simulation/BitchatConnectionBLE';
import { BitchatConnectionWifiAware } from '../../simulation/BitchatConnectionWifiAware';
import { PowerMode } from '../../simulation/BitchatDevice';
import { getPeerColor } from '../../utils/colorUtils';
import { formatClock } from '../scene/world/sun';
import { GLASS, Icon, cx } from './primitives';

/**
 * Simulated handset running the BitChat app for the followed (or selected)
 * device. Everything on screen is live simulator state: radio links in the
 * status bar, mesh peers, the public #mesh feed, Noise-encrypted DMs with
 * delivery ticks, and a composer that sends from this device.
 *
 * Docks bottom-right beside the inspector, scales to the space available,
 * and can be put away into a compact tab.
 */

const PHONE_W = 262;
const PHONE_H = 548;
const MAX_FEED = 60;

const nowStamp = (ms: number): string => {
    const t = Math.floor(ms / 1000);
    return `${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

const SignalBars: React.FC<{ level: number }> = ({ level }) => (
    <span className="inline-flex items-end gap-[1.5px]">
        {[1, 2, 3, 4].map(i => (
            <span key={i} className={cx('w-[3px] rounded-[1px]', i <= level ? 'bg-white' : 'bg-white/30')} style={{ height: 3 + i * 2 }} />
        ))}
    </span>
);

const Battery: React.FC<{ pct: number }> = ({ pct }) => (
    <span className="inline-flex items-center">
        <span className="relative flex h-[11px] w-[22px] items-center rounded-[3.5px] border border-white/45 p-[1.5px]">
            <span className={cx('h-full rounded-[1.5px]', pct < 20 ? 'bg-red-500' : 'bg-white')} style={{ width: `${pct}%` }} />
        </span>
        <span className="ml-[1px] h-[4px] w-[1.5px] rounded-r bg-white/45" />
    </span>
);

const FeedLine: React.FC<{ msg: ChatMessage; nick: (id: string) => string; delivered: boolean }> = ({ msg, nick, delivered }) => {
    const sender = msg.isOutgoing ? 'you' : nick(msg.senderId);
    const color = msg.isOutgoing ? '#34d399' : getPeerColor(msg.senderId);
    const isDm = Boolean(msg.recipientId);
    return (
        <div className="break-words font-mono text-[11px] leading-[1.5]">
            <span className="text-white/30">[{nowStamp(msg.timestamp)}] </span>
            {isDm && <span className="text-fuchsia-300/90">🔒 </span>}
            <span style={{ color }}>&lt;@{sender}&gt;</span> <span className="text-white/90">{msg.text}</span>
            {isDm && msg.isOutgoing && (
                <span className={cx('ml-1 text-[10px]', delivered ? 'text-emerald-400' : 'text-white/30')}>{delivered ? '✓✓' : '✓'}</span>
            )}
        </div>
    );
};

export const DevicePhone: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType } = useSelection();
    const { mode, followId } = useCamera();
    const { bottomPanelHeight, phoneOpen, setPhoneOpen } = useLayout();
    const { timeOfDay } = useVisualization();
    const [, tick] = useState(0);
    const [draft, setDraft] = useState('');
    const [view, setView] = useState<'chat' | 'peers'>('chat');
    const [dmPeer, setDmPeer] = useState<string | null>(null);
    const [viewportH, setViewportH] = useState(() => window.innerHeight);
    const feedRef = useRef<HTMLDivElement>(null);

    const personId = mode !== 'free' && followId ? followId : selectedId && selectionType === 'node' ? selectedId : null;
    const person = personId ? engine.getPerson(personId) : undefined;
    const sim = person?.device.appSimulator as BitchatAppSimulator | undefined;

    useEffect(() => {
        if (!personId) return;
        const t = window.setInterval(() => tick(n => n + 1), 300);
        return () => window.clearInterval(t);
    }, [personId]);

    useEffect(() => {
        const onResize = () => setViewportH(window.innerHeight);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // Switching device returns to its public channel
    useEffect(() => {
        setDmPeer(null);
        setView('chat');
    }, [personId]);

    const feedLen = sim?.messages.length ?? 0;
    useEffect(() => {
        const el = feedRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [feedLen, view, dmPeer, phoneOpen]);

    if (!person || !sim) return null;

    const device = person.device;
    const inspectorOpen = Boolean(selectedId && selectionType);
    const right = inspectorOpen ? 324 : 12;
    const bottom = bottomPanelHeight + 12;

    // ---- Live device state ----
    let ble = 0;
    let wifi = 0;
    let bestRssi: number | null = null;
    for (const c of device.connectionManager.getActiveConnections()) {
        if (c instanceof BitchatConnectionWifiAware) wifi++;
        else ble++;
        if (c instanceof BitchatConnectionBLE) bestRssi = bestRssi === null ? c.rssi : Math.max(bestRssi, c.rssi);
    }
    const bars = bestRssi === null ? 0 : bestRssi > -60 ? 4 : bestRssi > -70 ? 3 : bestRssi > -78 ? 2 : 1;
    const peers = sim.peerManager.getAllPeers();
    const direct = peers.filter(p => p.isDirect).length;
    const battery = device.powerMode === PowerMode.PERFORMANCE ? 64 : device.powerMode === PowerMode.NORMAL ? 82 : 93;
    const nick = (id: string) =>
        peers.find(p => p.id === id)?.nickname ?? engine.getPersonByPeerId(id)?.device.nickname ?? id.substring(0, 6);
    const feed = (
        dmPeer
            ? sim.messages.filter(m => m.recipientId && (m.recipientId === dmPeer || m.senderId === dmPeer))
            : sim.messages.filter(m => !m.recipientId || m.isOutgoing || m.recipientId === device.peerIDHex)
    ).slice(-MAX_FEED);

    const send = (e: React.FormEvent) => {
        e.preventDefault();
        const text = draft.trim();
        if (!text) return;
        if (dmPeer) sim.sendMessage(text, dmPeer);
        else sim.sendMessage(text);
        setDraft('');
    };

    // ---- Docked tab ----
    if (!phoneOpen) {
        return (
            <button
                onClick={() => setPhoneOpen(true)}
                className={cx(
                    GLASS,
                    'pointer-events-auto fixed z-20 flex items-center gap-2 rounded-full py-1.5 pl-2.5 pr-3 text-[11px] text-slate-200 transition-all hover:border-cyan-300/40'
                )}
                style={{ right, bottom }}
                title="Show phone"
            >
                <span className="text-emerald-400">{Icon.phone}</span>
                <span className="font-medium">{device.nickname}</span>
                <span className="font-mono text-[10px] text-slate-500">
                    {direct}·{peers.length} peers
                </span>
                <span className="text-slate-500">▴</span>
            </button>
        );
    }

    const scale = Math.max(0.55, Math.min(1, (viewportH - bottom - 24) / PHONE_H));

    return (
        <div
            className="pointer-events-auto fixed z-20 transition-[right] duration-300"
            style={{ right, bottom, width: PHONE_W * scale, height: PHONE_H * scale }}
        >
            <div style={{ width: PHONE_W, height: PHONE_H, transform: `scale(${scale})`, transformOrigin: 'bottom right' }} className="relative">
                {/* Put-away control */}
                <button
                    onClick={() => setPhoneOpen(false)}
                    title="Put phone away"
                    className={cx(
                        GLASS,
                        'absolute -left-9 top-6 flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:text-white'
                    )}
                >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
                        <polyline points="6 9 12 15 18 9" />
                    </svg>
                </button>

                {/* Hardware buttons */}
                <span className="absolute -left-[3px] top-[96px] h-[26px] w-[4px] rounded-l bg-gradient-to-r from-zinc-600 to-zinc-800" />
                <span className="absolute -left-[3px] top-[140px] h-[46px] w-[4px] rounded-l bg-gradient-to-r from-zinc-600 to-zinc-800" />
                <span className="absolute -left-[3px] top-[194px] h-[46px] w-[4px] rounded-l bg-gradient-to-r from-zinc-600 to-zinc-800" />
                <button
                    onClick={() => setPhoneOpen(false)}
                    title="Lock (put away)"
                    className="absolute -right-[3px] top-[158px] h-[70px] w-[4px] rounded-r bg-gradient-to-l from-zinc-600 to-zinc-800"
                />

                {/* Titanium frame */}
                <div
                    className="absolute inset-0 rounded-[50px] p-[3px] shadow-[0_30px_70px_rgba(0,0,0,0.6),0_8px_20px_rgba(0,0,0,0.4)]"
                    style={{ background: 'linear-gradient(145deg,#6b7078 0%,#2d3036 22%,#1b1d21 55%,#3a3e45 80%,#7a7f87 100%)' }}
                >
                    <div className="h-full w-full rounded-[47px] bg-black p-[7px] ring-1 ring-white/5">
                        {/* Screen */}
                        <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[40px] bg-[#050806]">
                            {/* Dynamic Island */}
                            <div className="absolute left-1/2 top-[10px] z-20 flex h-[28px] w-[94px] -translate-x-1/2 items-center justify-end rounded-full bg-black pr-2.5">
                                <span className="h-[9px] w-[9px] rounded-full bg-[#0d1424] ring-1 ring-[#1e2a44]" />
                            </div>

                            {/* Status bar */}
                            <div className="relative z-10 flex h-[48px] shrink-0 items-start justify-between px-7 pt-[15px] text-[13px] font-semibold text-white">
                                <span className="tabular-nums">{formatClock(timeOfDay)}</span>
                                <span className="flex items-center gap-1.5">
                                    <SignalBars level={bars} />
                                    <span className="text-[10px] font-bold text-sky-300" title="BLE links">
                                        ᛒ{ble}
                                    </span>
                                    {device.wifiAwareEnabled && (
                                        <span className="text-[10px] font-bold text-violet-300" title="Wi-Fi Aware links">
                                            ≋{wifi}
                                        </span>
                                    )}
                                    <Battery pct={battery} />
                                </span>
                            </div>

                            {/* App header */}
                            <div className="shrink-0 border-b border-emerald-400/15 px-4 pb-2 pt-1 font-mono">
                                <div className="flex items-center gap-2">
                                    {dmPeer ? (
                                        <button onClick={() => setDmPeer(null)} className="text-[15px] text-emerald-400" title="Back to #mesh">
                                            ‹
                                        </button>
                                    ) : null}
                                    <span className="text-[15px] font-bold text-emerald-400">bitchat/</span>
                                    {dmPeer ? (
                                        <span className="truncate text-[12px] text-fuchsia-300">🔒 @{nick(dmPeer)}</span>
                                    ) : (
                                        <span className="truncate text-[12px] text-emerald-200/70">@{device.nickname}</span>
                                    )}
                                    <button
                                        onClick={() => setView(view === 'peers' ? 'chat' : 'peers')}
                                        className={cx(
                                            'ml-auto flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] transition',
                                            view === 'peers' ? 'bg-emerald-400/15 text-emerald-300' : 'text-emerald-400 hover:bg-white/5'
                                        )}
                                        title="People nearby"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                                            <circle cx="9" cy="8" r="3.5" />
                                            <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.6 5.2" />
                                        </svg>
                                        {peers.length}
                                    </button>
                                </div>
                                <div className="mt-0.5 text-[10px] text-white/35">
                                    {dmPeer ? 'noise xx · end-to-end encrypted' : `#mesh · ${direct} in range · ${peers.length} reachable`}
                                </div>
                            </div>

                            {/* Body */}
                            <div ref={feedRef} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-4 py-2">
                                {view === 'peers' ? (
                                    <div className="space-y-0.5 font-mono">
                                        <div className="mb-1 text-[10px] uppercase tracking-wider text-white/35">tap to message privately</div>
                                        {[...peers]
                                            .sort((a, b) => a.hops - b.hops)
                                            .slice(0, 40)
                                            .map(p => (
                                                <button
                                                    key={p.id}
                                                    onClick={() => {
                                                        setDmPeer(p.id);
                                                        setView('chat');
                                                    }}
                                                    className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[11px] hover:bg-white/5"
                                                >
                                                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getPeerColor(p.id) }} />
                                                    <span className="truncate text-white/90">@{p.nickname}</span>
                                                    <span className={cx('ml-auto shrink-0 text-[10px]', p.isDirect ? 'text-emerald-400' : 'text-white/40')}>
                                                        {p.isDirect ? 'direct' : `${p.hops} hops`}
                                                    </span>
                                                </button>
                                            ))}
                                        {peers.length === 0 && <div className="pt-10 text-center text-[11px] text-white/35">nobody nearby yet…</div>}
                                    </div>
                                ) : feed.length === 0 ? (
                                    <div className="pt-16 text-center font-mono text-[11px] leading-relaxed text-white/30">
                                        {dmPeer ? 'no private messages yet' : 'no messages on #mesh yet'}
                                        <br />
                                        say something ↓
                                    </div>
                                ) : (
                                    feed.map((m, i) => (
                                        <FeedLine key={m.id + i} msg={m} nick={nick} delivered={sim.deliveredMessageIds.has(m.id)} />
                                    ))
                                )}
                            </div>

                            {/* Composer */}
                            <form onSubmit={send} className="shrink-0 px-3 pb-2 pt-1.5">
                                <div
                                    className={cx(
                                        'flex items-center gap-2 rounded-full border bg-white/[0.04] py-1 pl-3 pr-1',
                                        dmPeer ? 'border-fuchsia-400/30' : 'border-emerald-400/25'
                                    )}
                                >
                                    <input
                                        value={draft}
                                        onChange={e => setDraft(e.target.value)}
                                        placeholder={dmPeer ? `message @${nick(dmPeer)}` : 'type a message…'}
                                        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-white placeholder:text-white/30 focus:outline-none"
                                    />
                                    <button
                                        type="submit"
                                        disabled={!draft.trim()}
                                        className={cx(
                                            'flex h-6 w-6 items-center justify-center rounded-full text-black transition disabled:opacity-30',
                                            dmPeer ? 'bg-fuchsia-400' : 'bg-emerald-400'
                                        )}
                                        title="Send"
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                            <path d="M12 19V5M5 12l7-7 7 7" />
                                        </svg>
                                    </button>
                                </div>
                                <div className="mx-auto mt-2.5 h-[5px] w-[110px] rounded-full bg-white/70" />
                            </form>

                            {/* Glass glare */}
                            <div
                                className="pointer-events-none absolute inset-0 rounded-[40px]"
                                style={{ background: 'linear-gradient(118deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.015) 32%, rgba(255,255,255,0) 45%)' }}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
