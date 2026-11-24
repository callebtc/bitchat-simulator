import React, { useEffect, useRef, useState } from 'react';

import { useSimulation } from '../context/SimulationContext';
import { useVisualization } from '../context/VisualizationContext';
import { BitchatAppSimulator } from '../../simulation/AppLayer/BitchatAppSimulator';
import { useScreenAnchor } from './ScreenAnchors';
import { useTerrain } from '../context/TerrainContext';

/**
 * Speech bubbles above devices when a chat message is sent (public mesh
 * broadcast or encrypted DM) or a DM is received. Polls app message logs at
 * 4 Hz — cheaper than instrumenting the protocol layer for a visual effect.
 */

const POLL_MS = 250;
const BUBBLE_LIFETIME_MS = 5200;
const MAX_BUBBLES = 14;
const MAX_POLLED_PEOPLE = 1500;

interface Bubble {
    key: string;
    personId: string;
    text: string;
    kind: 'public' | 'dm-out' | 'dm-in';
    peer?: string;
    born: number;
}

const BubbleView: React.FC<{ bubble: Bubble }> = ({ bubble }) => {
    const engine = useSimulation();
    const { heightAt } = useTerrain();
    const ref = useScreenAnchor(
        `bubble:${bubble.key}`,
        () => {
            const p = engine.getPerson(bubble.personId);
            return p ? { x: p.position.x, y: p.position.y, z: 3.3 + heightAt(p.position.x, p.position.y) } : null;
        },
        { maxDistance: 1600, scaleWithDistance: false }
    );
    const tone =
        bubble.kind === 'public'
            ? 'border-emerald-400/50 bg-emerald-950/80 text-emerald-50'
            : bubble.kind === 'dm-out'
              ? 'border-fuchsia-400/50 bg-fuchsia-950/80 text-fuchsia-50'
              : 'border-sky-400/50 bg-sky-950/80 text-sky-50';
    const tag = bubble.kind === 'public' ? '#mesh' : bubble.kind === 'dm-out' ? `🔒 → ${bubble.peer}` : `✉ from ${bubble.peer}`;
    return (
        <div ref={ref} className="absolute left-0 top-0 pb-7 will-change-transform" style={{ visibility: 'hidden' }}>
            <div className={`bubble-pop relative max-w-[220px] rounded-xl border px-2.5 py-1.5 shadow-2xl backdrop-blur-md ${tone}`}>
                <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wider opacity-70">{tag}</div>
                <div className="break-words text-[11px] leading-snug">{bubble.text}</div>
                <div
                    className={`absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r ${tone}`}
                />
            </div>
        </div>
    );
};

export const ChatBubbles: React.FC = () => {
    const engine = useSimulation();
    const { showChatBubbles } = useVisualization();
    const [bubbles, setBubbles] = useState<Bubble[]>([]);
    const seenRef = useRef<Map<string, number>>(new Map());

    useEffect(() => {
        if (!showChatBubbles) {
            setBubbles([]);
            return;
        }
        const seen = seenRef.current;
        seen.clear();
        // Prime counts so existing history doesn't burst into bubbles
        for (const p of engine.getAllPeople()) {
            const sim = p.device.appSimulator as BitchatAppSimulator | undefined;
            if (sim) seen.set(p.id, sim.messages.length);
        }

        const poll = () => {
            const now = performance.now();
            const fresh: Bubble[] = [];
            const people = engine.getAllPeople();
            const n = Math.min(people.length, MAX_POLLED_PEOPLE);
            for (let i = 0; i < n; i++) {
                const p = people[i];
                const sim = p.device.appSimulator as BitchatAppSimulator | undefined;
                if (!sim) continue;
                const prev = seen.get(p.id);
                const len = sim.messages.length;
                if (prev === undefined) {
                    seen.set(p.id, len);
                    continue;
                }
                if (len <= prev) {
                    if (len < prev) seen.set(p.id, len);
                    continue;
                }
                for (let k = prev; k < len; k++) {
                    const m = sim.messages[k];
                    const isDm = Boolean(m.recipientId);
                    if (!m.isOutgoing && !isDm) continue; // inbound broadcasts would flood the view
                    const other = m.isOutgoing ? m.recipientId : m.senderId;
                    const peerNick = other ? engine.getPersonByPeerId(other)?.device.nickname ?? other.substring(0, 6) : undefined;
                    fresh.push({
                        key: `${p.id}:${m.id}:${k}`,
                        personId: p.id,
                        text: m.text,
                        kind: !isDm ? 'public' : m.isOutgoing ? 'dm-out' : 'dm-in',
                        peer: peerNick,
                        born: now,
                    });
                }
                seen.set(p.id, len);
            }
            setBubbles(prev => {
                const alive = prev.filter(b => now - b.born < BUBBLE_LIFETIME_MS);
                if (fresh.length === 0 && alive.length === prev.length) return prev;
                return [...alive, ...fresh].slice(-MAX_BUBBLES);
            });
        };

        const timer = window.setInterval(poll, POLL_MS);
        const onReset = () => {
            seen.clear();
            setBubbles([]);
        };
        engine.events.on('reset', onReset);
        return () => {
            window.clearInterval(timer);
            engine.events.off('reset', onReset);
        };
    }, [engine, showChatBubbles]);

    return (
        <div className="pointer-events-none fixed inset-0 z-10 overflow-hidden">
            {bubbles.map(b => (
                <BubbleView key={b.key} bubble={b} />
            ))}
        </div>
    );
};
