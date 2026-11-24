import React, { useEffect, useRef, useState } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useSelection } from '../context/SelectionContext';
import { useCamera } from '../context/CameraContext';
import { useLayout } from '../context/LayoutContext';
import { BitchatAppSimulator, ChatMessage } from '../../simulation/AppLayer/BitchatAppSimulator';
import { BitchatConnectionBLE } from '../../simulation/BitchatConnectionBLE';
import { BitchatConnectionWifiAware } from '../../simulation/BitchatConnectionWifiAware';
import { PowerMode } from '../../simulation/BitchatDevice';
import { getPeerColor } from '../../utils/colorUtils';

/**
 * Simulated handset: renders the followed device's live BitChat app state as
 * a phone screen — status bar (sim clock, radio links, power profile), mesh
 * peers, IRC-style chat feed, and a composer that sends from this device.
 */

const MAX_FEED = 40;

function simClock(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600) % 24;
    const m = Math.floor(total / 60) % 60;
    const s = total % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function signalBars(rssi: number | null): number {
    if (rssi === null) return 0;
    if (rssi > -60) return 4;
    if (rssi > -70) return 3;
    if (rssi > -78) return 2;
    return 1;
}

const Bars: React.FC<{ n: number }> = ({ n }) => (
    <span className="inline-flex items-end gap-[1.5px]">
        {[1, 2, 3, 4].map(i => (
            <span key={i} className={`w-[2.5px] rounded-[1px] ${i <= n ? 'bg-slate-100' : 'bg-slate-600'}`} style={{ height: 2 + i * 2 }} />
        ))}
    </span>
);

const FeedLine: React.FC<{ msg: ChatMessage; nick: (id: string) => string; delivered: boolean }> = ({ msg, nick, delivered }) => {
    const sender = msg.isOutgoing ? 'me' : nick(msg.senderId);
    const color = msg.isOutgoing ? '#4ade80' : getPeerColor(msg.senderId);
    const isDm = Boolean(msg.recipientId);
    return (
        <div className="break-words font-mono text-[10.5px] leading-[1.45]">
            <span className="text-slate-600">[{simClock(msg.timestamp).substring(3)}] </span>
            {isDm && <span className="text-fuchsia-400">🔒 </span>}
            <span style={{ color }}>&lt;@{sender}&gt;</span>{' '}
            {isDm && msg.isOutgoing && msg.recipientId && (
                <span className="text-fuchsia-300">→@{nick(msg.recipientId)} </span>
            )}
            <span className="text-slate-200">{msg.text}</span>
            {isDm && msg.isOutgoing && <span className={delivered ? 'text-emerald-400' : 'text-slate-600'}> {delivered ? '✓✓' : '✓'}</span>}
        </div>
    );
};

export const DevicePhone: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType } = useSelection();
    const { mode, followId } = useCamera();
    const { bottomPanelHeight } = useLayout();
    const [, tick] = useState(0);
    const [draft, setDraft] = useState('');
    const [tab, setTab] = useState<'chat' | 'peers'>('chat');
    const feedRef = useRef<HTMLDivElement>(null);

    const personId = mode !== 'free' ? followId : null;
    const person = personId ? engine.getPerson(personId) : undefined;
    const sim = person?.device.appSimulator as BitchatAppSimulator | undefined;

    useEffect(() => {
        if (!personId) return;
        const t = window.setInterval(() => tick(n => n + 1), 300);
        return () => window.clearInterval(t);
    }, [personId]);

    const msgCount = sim?.messages.length ?? 0;
    useEffect(() => {
        const el = feedRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [msgCount, tab]);

    if (!person || !sim) return null;

    const device = person.device;
    const conns = device.connectionManager.getActiveConnections();
    let ble = 0;
    let wifi = 0;
    let bestRssi: number | null = null;
    for (const c of conns) {
        if (c instanceof BitchatConnectionWifiAware) wifi++;
        else ble++;
        if (c instanceof BitchatConnectionBLE) bestRssi = bestRssi === null ? c.rssi : Math.max(bestRssi, c.rssi);
    }
    const peers = sim.peerManager.getAllPeers();
    const direct = peers.filter(p => p.isDirect).length;
    const feed = sim.messages.slice(-MAX_FEED);
    const nick = (id: string) =>
        sim.peerManager.getAllPeers().find(p => p.id === id)?.nickname ??
        engine.getPersonByPeerId(id)?.device.nickname ??
        id.substring(0, 6);
    const battery =
        device.powerMode === PowerMode.PERFORMANCE ? 64 : device.powerMode === PowerMode.NORMAL ? 78 : 91;

    const send = (e: React.FormEvent) => {
        e.preventDefault();
        const text = draft.trim();
        if (!text) return;
        sim.sendMessage(text);
        setDraft('');
    };

    const insetRight = selectedId && selectionType ? 'right-[304px]' : 'right-4';

    return (
        <div
            className={`pointer-events-auto fixed z-20 ${insetRight} transition-all`}
            style={{ bottom: bottomPanelHeight + 16 }}
        >
            <div className="relative w-[236px] rounded-[34px] border border-white/15 bg-gradient-to-b from-slate-700 via-slate-900 to-black p-[7px] shadow-[0_20px_60px_rgba(0,0,0,0.65),inset_0_0_0_1px_rgba(255,255,255,0.06)]">
                <div className="relative h-[420px] overflow-hidden rounded-[28px] bg-[#05070a]">
                    {/* Dynamic island */}
                    <div className="absolute left-1/2 top-2 z-10 h-[18px] w-[72px] -translate-x-1/2 rounded-full bg-black" />
                    {/* Status bar */}
                    <div className="flex items-center justify-between px-5 pb-1 pt-2.5 text-[10px] font-semibold text-slate-100">
                        <span className="font-mono">{simClock(engine.simTimeMs).substring(0, 5)}</span>
                        <span className="flex items-center gap-1.5">
                            <Bars n={signalBars(bestRssi)} />
                            <span className="text-[9px] text-sky-300">ᛒ{ble}</span>
                            {device.wifiAwareEnabled && <span className="text-[9px] text-violet-300">≋{wifi}</span>}
                            <span className="flex h-[9px] w-[18px] items-center rounded-[2px] border border-slate-300 p-[1px]">
                                <span className="h-full rounded-[1px] bg-slate-100" style={{ width: `${battery}%` }} />
                            </span>
                        </span>
                    </div>

                    {/* App header */}
                    <div className="mt-3 border-b border-emerald-500/20 px-3 pb-2">
                        <div className="flex items-baseline justify-between">
                            <span className="font-mono text-[13px] font-bold text-emerald-400">bitchat/</span>
                            <span className="font-mono text-[10px] text-emerald-300/80">#mesh</span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between font-mono text-[9.5px] text-slate-500">
                            <span>
                                @<span className="text-slate-300">{device.nickname}</span>
                            </span>
                            <span>
                                <span className="text-emerald-400">●</span> {direct} direct · {peers.length} mesh
                            </span>
                        </div>
                        <div className="mt-1.5 flex gap-1">
                            {(['chat', 'peers'] as const).map(t => (
                                <button
                                    key={t}
                                    onClick={() => setTab(t)}
                                    className={`rounded px-2 py-0.5 font-mono text-[9.5px] ${tab === t ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-500 hover:text-slate-300'}`}
                                >
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Body */}
                    <div ref={feedRef} className="h-[272px] space-y-1 overflow-y-auto px-3 py-2">
                        {tab === 'chat' ? (
                            feed.length === 0 ? (
                                <div className="pt-16 text-center font-mono text-[10px] text-slate-600">
                                    no messages yet
                                    <br />
                                    say hi to the mesh ↓
                                </div>
                            ) : (
                                feed.map((m, i) => (
                                    <FeedLine key={m.id + i} msg={m} nick={nick} delivered={sim.deliveredMessageIds.has(m.id)} />
                                ))
                            )
                        ) : (
                            [...peers]
                                .sort((a, b) => a.hops - b.hops)
                                .slice(0, 40)
                                .map(p => (
                                    <div key={p.id} className="flex items-center justify-between font-mono text-[10px]">
                                        <span className="flex items-center gap-1.5 truncate">
                                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: getPeerColor(p.id) }} />
                                            <span className="truncate text-slate-200">{p.nickname}</span>
                                        </span>
                                        <span className={p.isDirect ? 'text-emerald-400' : 'text-slate-500'}>
                                            {p.isDirect ? 'direct' : `${p.hops} hop${p.hops === 1 ? '' : 's'}`}
                                        </span>
                                    </div>
                                ))
                        )}
                    </div>

                    {/* Composer */}
                    <form onSubmit={send} className="absolute bottom-0 left-0 right-0 border-t border-white/5 bg-black/60 px-2.5 pb-4 pt-2">
                        <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-950/20 px-2.5 py-1">
                            <span className="font-mono text-[10px] text-emerald-500">&gt;</span>
                            <input
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                                placeholder="message #mesh"
                                className="min-w-0 flex-1 bg-transparent font-mono text-[10.5px] text-slate-100 placeholder:text-slate-600 focus:outline-none"
                            />
                            <button type="submit" className="font-mono text-[10px] font-bold text-emerald-400 hover:text-emerald-300">
                                ↵
                            </button>
                        </div>
                        <div className="mx-auto mt-2 h-1 w-20 rounded-full bg-slate-500/60" />
                    </form>
                </div>
            </div>
        </div>
    );
};
