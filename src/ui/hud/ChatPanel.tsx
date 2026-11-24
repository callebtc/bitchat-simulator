import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelection } from '../context/SelectionContext';
import { useSimulation } from '../context/SimulationContext';
import { BitchatAppSimulator, ChatMessage } from '../../simulation/AppLayer/BitchatAppSimulator';
import { PeerRouteProbe, probePeerRoute } from '../../simulation/MeshProbe';
import { getPeerColor } from '../../utils/colorUtils';

function formatSimTimestamp(ms: number): string {
    const totalSec = Math.max(0, ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = Math.floor(totalSec % 60);
    const tenths = Math.floor((totalSec * 10) % 10);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${tenths}`;
}

function getProbeBadgeStyle(probe: PeerRouteProbe): {
    label: string;
    detail: string;
    className: string;
    dotClass: string;
} {
    switch (probe.status) {
        case 'direct_wifi':
            return {
                label: 'DIRECT Wi-Fi Aware',
                detail: `${probe.directLink?.rssiDbm.toFixed(0) ?? '-50'} dBm · 1 hop`,
                className: 'bg-purple-950/70 border-purple-500/60 text-purple-200',
                dotClass: 'bg-purple-400',
            };
        case 'direct_ble':
            return {
                label: 'DIRECT BLE',
                detail: `${probe.directLink?.rssiDbm.toFixed(0) ?? '-60'} dBm · 1 hop`,
                className: 'bg-emerald-950/70 border-emerald-500/60 text-emerald-200',
                dotClass: 'bg-emerald-400',
            };
        case 'source_route':
            return {
                label: 'SOURCE ROUTE',
                detail: `${probe.hops} hops (confirmed MeshGraph)`,
                className: 'bg-amber-950/70 border-amber-500/60 text-amber-200',
                dotClass: 'bg-amber-400',
            };
        case 'flood_reachable':
            return {
                label: 'REACHABLE (FLOOD)',
                detail: `${probe.hops} hops (TTL ${probe.maxTtl})`,
                className: 'bg-cyan-950/70 border-cyan-500/60 text-cyan-200',
                dotClass: 'bg-cyan-400',
            };
        case 'exceeds_ttl':
            return {
                label: 'TOO FAR',
                detail: `${probe.hops} hops > TTL ${probe.maxTtl}`,
                className: 'bg-orange-950/70 border-orange-500/60 text-orange-200',
                dotClass: 'bg-orange-400',
            };
        case 'unreachable':
            return {
                label: 'NO PATH',
                detail: 'Partitioned (will queue in outbox)',
                className: 'bg-red-950/70 border-red-500/60 text-red-200',
                dotClass: 'bg-red-400',
            };
    }
}

export const ChatPanel: React.FC = () => {
    const {
        selectedId,
        chatRecipientId,
        setChatRecipientId,
        selectChatPair,
        isPickingRecipient,
        setPickingRecipient,
        highlightedId,
        requestCameraFocus,
    } = useSelection();
    const engine = useSimulation();

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [probe, setProbe] = useState<PeerRouteProbe | null>(null);
    const [inputText, setInputText] = useState('');
    const [autoScroll, setAutoScroll] = useState(true);
    const [filterDmOnly, setFilterDmOnly] = useState(true);
    const [, setTickVersion] = useState(0);

    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const person = selectedId ? engine.getPerson(selectedId) : null;
    const sim = person?.device.appSimulator as BitchatAppSimulator | undefined;
    const senderPeerHex = person?.device.peerIDHex ?? null;

    // While picking a target on the map, preview live probe for whichever node is hovered!
    const effectiveProbePeerHex =
        isPickingRecipient && highlightedId && highlightedId !== senderPeerHex
            ? highlightedId
            : chatRecipientId;

    const recipientPerson = chatRecipientId ? engine.getPersonByPeerId(chatRecipientId) : null;
    const previewPerson = effectiveProbePeerHex
        ? engine.getPersonByPeerId(effectiveProbePeerHex)
        : null;

    // Immediate sync on sender switch + 4 Hz live polling for messages, delivery ACKs, and route probe
    useEffect(() => {
        if (!sim || !senderPeerHex) {
            setMessages([]);
            setProbe(null);
            return;
        }

        const refresh = () => {
            setMessages([...sim.messages]);
            if (effectiveProbePeerHex && effectiveProbePeerHex !== senderPeerHex) {
                setProbe(probePeerRoute(engine, senderPeerHex, effectiveProbePeerHex));
            } else {
                setProbe(null);
            }
            setTickVersion(v => (v + 1) % 1_000_000);
        };

        refresh();
        const interval = setInterval(refresh, 250);
        return () => clearInterval(interval);
    }, [engine, sim, senderPeerHex, effectiveProbePeerHex]);

    // Focus text input whenever a DM recipient is selected
    useEffect(() => {
        if (chatRecipientId && !isPickingRecipient) {
            inputRef.current?.focus();
        }
    }, [chatRecipientId, isPickingRecipient]);

    const displayedMessages = useMemo(() => {
        if (!chatRecipientId || !filterDmOnly || !senderPeerHex) return messages;
        return messages.filter(
            m =>
                (m.senderId === senderPeerHex && m.recipientId === chatRecipientId) ||
                (m.senderId === chatRecipientId && m.recipientId === senderPeerHex)
        );
    }, [messages, chatRecipientId, filterDmOnly, senderPeerHex]);

    useEffect(() => {
        if (autoScroll && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [displayedMessages.length, autoScroll]);

    const handleSend = (overrideText?: string) => {
        const body = (overrideText ?? inputText).trim();
        if (!sim || !body) return;
        sim.sendMessage(body, chatRecipientId || undefined);
        if (overrideText === undefined) {
            setInputText('');
        }
        setMessages([...sim.messages]);
    };

    const handleSwapEndpoints = () => {
        if (!person || !recipientPerson) return;
        selectChatPair(recipientPerson.id, person.device.peerIDHex);
    };

    const handleFocusPair = () => {
        if (!person || !recipientPerson) return;
        const midX = (person.position.x + recipientPerson.position.x) * 0.5;
        const midY = (person.position.y + recipientPerson.position.y) * 0.5;
        const dx = Math.abs(person.position.x - recipientPerson.position.x);
        const dy = Math.abs(person.position.y - recipientPerson.position.y);
        const span = Math.max(dx, dy, 40);
        requestCameraFocus(midX, midY, Math.min(2500, span * 1.4 + 30));
    };

    const getDmDeliveryBadge = (msg: ChatMessage): React.ReactNode => {
        if (!msg.isOutgoing || !msg.recipientId || !sim) return null;
        const tracked = engine.telemetry.getTrackedMessage(msg.id);
        const delivery = tracked?.deliveries.get(msg.recipientId);
        const isAcked = sim.deliveredMessageIds.has(msg.id);

        if (isAcked) {
            const meta = delivery
                ? ` · ${delivery.latencyMs.toFixed(0)}ms · ${delivery.hops}h`
                : '';
            return (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/70 border border-emerald-700/60 text-emerald-300">
                    ✓✓ ACK{meta}
                </span>
            );
        }
        if (delivery) {
            return (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-cyan-950/70 border border-cyan-700/60 text-cyan-300">
                    ✓ RCVD · {delivery.latencyMs.toFixed(0)}ms · {delivery.hops}h
                </span>
            );
        }
        const outboxCount = sim.messageRouter.getOutboxCount(msg.recipientId);
        if (outboxCount > 0) {
            return (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-950/70 border border-amber-700/60 text-amber-300">
                    ⏳ HANDSHAKE / QUEUED
                </span>
            );
        }
        return (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-950/60 border border-fuchsia-800/50 text-fuchsia-300">
                📡 IN FLIGHT
            </span>
        );
    };

    if (!sim || !person) {
        return <div className="p-4 text-xs font-mono opacity-50">Select a node on the map to chat</div>;
    }

    const badge = probe ? getProbeBadgeStyle(probe) : null;

    return (
        <div className="flex flex-col h-full bg-black/95 font-mono text-xs">
            {/* Row 1: Sender -> Interactive To: Picker & Actions */}
            <div className="flex flex-wrap justify-between items-center gap-2 px-2.5 py-1.5 border-b border-gray-800 bg-gray-900/60 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] text-gray-500 uppercase">From</span>
                    <span
                        style={{ color: getPeerColor(person.device.peerIDHex) }}
                        className="font-bold bg-gray-900 px-1.5 py-0.5 rounded border border-cyan-800/60 truncate max-w-[140px]"
                        title={`Sender: ${person.device.nickname} (${person.device.peerIDHex})`}
                    >
                        {person.device.nickname} ({person.device.peerIDHex.substring(0, 6)})
                    </span>

                    {recipientPerson ? (
                        <button
                            onClick={handleSwapEndpoints}
                            className="text-gray-400 hover:text-cyan-300 px-1 py-0.5 rounded border border-gray-700 hover:border-cyan-600 transition-colors"
                            title="Swap sender and recipient"
                        >
                            ⇄
                        </button>
                    ) : (
                        <span className="text-gray-500">→</span>
                    )}

                    <span className="text-[10px] text-gray-500 uppercase">To</span>

                    {chatRecipientId ? (
                        <div className="flex items-center gap-1 bg-fuchsia-950/50 pl-2 pr-1 py-0.5 rounded border border-fuchsia-600/60">
                            <button
                                onClick={() => setPickingRecipient(!isPickingRecipient)}
                                className="flex items-center gap-1 hover:underline"
                                title="Click to pick a different recipient node on the map"
                            >
                                <span
                                    className="font-bold"
                                    style={{ color: getPeerColor(chatRecipientId) }}
                                >
                                    {recipientPerson
                                        ? `${recipientPerson.device.nickname} (${chatRecipientId.substring(0, 6)})`
                                        : `${chatRecipientId.substring(0, 8)}...`}
                                </span>
                            </button>
                            <button
                                onClick={() => setChatRecipientId(null)}
                                className="ml-1 px-1 text-red-400 hover:text-red-200 font-bold"
                                title="Switch back to BROADCAST"
                            >
                                ✕
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setPickingRecipient(!isPickingRecipient)}
                            className={`px-2 py-0.5 rounded border font-bold transition-all flex items-center gap-1.5 ${
                                isPickingRecipient
                                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200 animate-pulse'
                                    : 'bg-cyan-950/40 border-cyan-700/60 text-cyan-300 hover:bg-cyan-900/50 hover:border-cyan-400'
                            }`}
                            title="Click to select a recipient node on the map for Direct Messaging"
                        >
                            <span>{isPickingRecipient ? 'CLICK NODE ON MAP...' : '[BROADCAST]'}</span>
                            {!isPickingRecipient && (
                                <span className="text-[10px] text-cyan-400/80 font-normal">
                                    (click to pick DM)
                                </span>
                            )}
                        </button>
                    )}

                    {/* Explicit map-pick button always accessible */}
                    {chatRecipientId && (
                        <button
                            onClick={() => setPickingRecipient(!isPickingRecipient)}
                            className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                isPickingRecipient
                                    ? 'bg-cyan-600/40 border-cyan-400 text-white'
                                    : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-cyan-500 hover:text-cyan-300'
                            }`}
                            title="Pick another recipient on the map"
                        >
                            {isPickingRecipient ? 'Cancel Pick' : '⌖ Pick Node'}
                        </button>
                    )}
                </div>

                {/* Right-side controls */}
                <div className="flex items-center gap-2 shrink-0">
                    {recipientPerson && (
                        <>
                            <button
                                onClick={handleFocusPair}
                                className="px-2 py-0.5 rounded text-[10px] bg-gray-900 hover:bg-gray-800 border border-gray-700 text-cyan-300 transition-colors"
                                title="Pan & zoom camera to frame both nodes"
                            >
                                ⌖ Focus Pair
                            </button>
                            <button
                                onClick={() => setFilterDmOnly(f => !f)}
                                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                                    filterDmOnly
                                        ? 'bg-fuchsia-950/50 border-fuchsia-700/60 text-fuchsia-200'
                                        : 'bg-gray-900 border-gray-700 text-gray-400'
                                }`}
                                title="Toggle between this DM thread and all messages on this node"
                            >
                                {filterDmOnly ? 'This DM' : 'All Msgs'}
                            </button>
                        </>
                    )}
                    <label className="flex items-center gap-1 cursor-pointer select-none text-[10px] text-gray-300">
                        <input
                            type="checkbox"
                            checked={autoScroll}
                            onChange={e => setAutoScroll(e.target.checked)}
                        />
                        <span>Auto-scroll</span>
                    </label>
                </div>
            </div>

            {/* Row 2: Live Connection & Route Probe Bar (shown for active DM or live hover preview) */}
            {probe && badge && (
                <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1 border-b border-gray-800/80 bg-gray-950/90 text-[10px] shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        {isPickingRecipient && previewPerson && (
                            <span className="text-cyan-400 uppercase font-bold">
                                PREVIEW → {previewPerson.device.nickname}:
                            </span>
                        )}
                        <span
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border font-bold ${badge.className}`}
                        >
                            <span className={`w-1.5 h-1.5 rounded-full ${badge.dotClass}`} />
                            {badge.label}
                        </span>
                        <span className="text-gray-300">{badge.detail}</span>

                        {probe.displayPath && probe.displayPath.length >= 2 && (
                            <span
                                className="text-gray-500 truncate max-w-[340px]"
                                title={probe.displayPath.join(' → ')}
                            >
                                Path:{' '}
                                {probe.displayPath
                                    .map(hex => {
                                        const node = engine.getPersonByPeerId(hex);
                                        return node ? node.device.nickname : hex.substring(0, 6);
                                    })
                                    .join(' → ')}
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        <span
                            className={`px-1.5 py-0.5 rounded border ${
                                probe.noiseState === 'established'
                                    ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300'
                                    : probe.noiseState === 'handshaking'
                                      ? 'bg-purple-950/60 border-purple-700/60 text-purple-300'
                                      : 'bg-gray-900 border-gray-700 text-gray-400'
                            }`}
                        >
                            Noise:{' '}
                            {probe.noiseState === 'established'
                                ? 'Encrypted ✓'
                                : probe.noiseState === 'handshaking'
                                  ? 'Handshaking…'
                                  : 'New (XX on send)'}
                        </span>
                        {probe.outboxQueued > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-700/60 text-amber-300">
                                Outbox: {probe.outboxQueued}
                            </span>
                        )}
                        {chatRecipientId && !isPickingRecipient && (
                            <button
                                onClick={() =>
                                    handleSend(`ping @${formatSimTimestamp(engine.simTimeMs)}`)
                                }
                                className="px-2 py-0.5 rounded bg-fuchsia-900/50 hover:bg-fuchsia-800/70 border border-fuchsia-600/60 text-fuchsia-200 font-bold transition-colors"
                                title="Send a quick DM probe packet and watch it traverse the mesh"
                            >
                                ⚡ PROBE PING
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Message History */}
            <div className="flex-1 overflow-y-auto px-2.5 py-1.5 space-y-1">
                {displayedMessages.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-gray-600 text-[11px]">
                        {chatRecipientId
                            ? `No messages with ${recipientPerson?.device.nickname ?? chatRecipientId.substring(0, 8)} yet — type below or click ⚡ PROBE PING to trace a DM live.`
                            : 'Broadcast channel — click [BROADCAST] or any 2nd node on the map to probe & send a Direct Message.'}
                    </div>
                ) : (
                    displayedMessages.map(msg => {
                        const senderObj = engine.getPersonByPeerId(msg.senderId);
                        const recObj = msg.recipientId
                            ? engine.getPersonByPeerId(msg.recipientId)
                            : null;
                        return (
                            <div
                                key={msg.id}
                                className="break-words hover:bg-white/5 px-1 py-0.5 rounded flex items-baseline flex-wrap"
                            >
                                <span className="opacity-40 mr-2 text-[10px]">
                                    [{formatSimTimestamp(msg.timestamp)}]
                                </span>

                                <span
                                    className="font-bold"
                                    style={{ color: getPeerColor(msg.senderId) }}
                                >
                                    {senderObj?.device.nickname ?? msg.senderId.substring(0, 6)}
                                </span>

                                {msg.recipientId && (
                                    <>
                                        <span className="text-gray-500 mx-1">→</span>
                                        <span
                                            className="font-bold"
                                            style={{ color: getPeerColor(msg.recipientId) }}
                                        >
                                            {recObj?.device.nickname ??
                                                msg.recipientId.substring(0, 6)}
                                        </span>
                                    </>
                                )}

                                <span className="ml-2 text-gray-100">{msg.text}</span>
                                {getDmDeliveryBadge(msg)}
                            </div>
                        );
                    })
                )}
                <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="px-2.5 py-1.5 border-t border-gray-800 flex gap-2 shrink-0 bg-gray-950/80">
                <input
                    ref={inputRef}
                    type="text"
                    className="flex-1 bg-gray-900 border border-gray-700 rounded px-2.5 py-1 text-white focus:border-cyan-500 focus:outline-none"
                    placeholder={
                        recipientPerson
                            ? `Send encrypted DM to ${recipientPerson.device.nickname}...`
                            : 'Broadcast message to mesh...'
                    }
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSend()}
                />
                <button
                    onClick={() => handleSend()}
                    className={`px-3 py-1 rounded font-bold text-white transition-colors ${
                        chatRecipientId
                            ? 'bg-fuchsia-700 hover:bg-fuchsia-600'
                            : 'bg-cyan-700 hover:bg-cyan-600'
                    }`}
                >
                    {chatRecipientId ? 'SEND DM' : 'BROADCAST'}
                </button>
            </div>
        </div>
    );
};
