import { describe, it, expect } from 'vitest';

import { SimulationEngine } from '../SimulationEngine';
import { BitchatPerson, MovementMode } from '../BitchatPerson';
import { BitchatDevice } from '../BitchatDevice';
import { BitchatAppSimulator } from '../AppLayer/BitchatAppSimulator';
import { NoiseSessionManager } from '../AppLayer/NoiseSessionManager';
import { probePeerRoute } from '../MeshProbe';

/**
 * End-to-end private DM reliability (Noise XX handshake + NOISE_ENCRYPTED +
 * DELIVERED ACK) under realistic mesh conditions: multi-hop relay jitter that
 * reorders msg3 and the first transport message, lossy links that kill source
 * routes, and peers whose Noise session state diverges.
 */

interface Node {
    person: BitchatPerson;
    sim: BitchatAppSimulator;
}

function crowd(seed: number, count: number, spread: number, preset: 'android' | 'ios'): { engine: SimulationEngine; nodes: Node[] } {
    const engine = new SimulationEngine({ seed });
    const nodes: Node[] = [];
    for (let i = 0; i < count; i++) {
        const d = BitchatDevice.createRandom(engine.rng);
        d.nickname = `n${i}`;
        const sim = new BitchatAppSimulator(d, preset);
        d.setAppSimulator(sim);
        const p = new BitchatPerson(
            `p${i}`,
            { x: (engine.rng.next() - 0.5) * spread, y: (engine.rng.next() - 0.5) * spread },
            d,
            engine.rng.fork(`p${i}`)
        );
        engine.addPerson(p);
        p.setMode(MovementMode.RANDOM_WALK);
        nodes.push({ person: p, sim });
    }
    return { engine, nodes };
}

function pair(seed: number): { engine: SimulationEngine; a: BitchatAppSimulator; b: BitchatAppSimulator } {
    const engine = new SimulationEngine({ seed });
    const dA = BitchatDevice.createRandom(engine.rng);
    const dB = BitchatDevice.createRandom(engine.rng);
    const a = new BitchatAppSimulator(dA, 'android');
    const b = new BitchatAppSimulator(dB, 'android');
    dA.setAppSimulator(a);
    dB.setAppSimulator(b);
    dA.alwaysScan = true;
    dB.alwaysScan = true;
    engine.addPerson(new BitchatPerson('A', { x: 0, y: 0 }, dA));
    engine.addPerson(new BitchatPerson('B', { x: 12, y: 0 }, dB));
    return { engine, a, b };
}

describe('DM reliability', () => {
    it.each([
        [77, 'android'],
        [78, 'android'],
        [79, 'ios'],
        [80, 'ios'],
    ] as const)('delivers DMs across a moving 30-person crowd (seed %i, %s)', (seed, preset) => {
        const { engine, nodes } = crowd(seed, 30, 160, preset);
        engine.runFor(10_000, 50);

        const sent: Array<{ id: string; to: Node; reachable: boolean }> = [];
        for (let round = 0; round < 20; round++) {
            const a = nodes[engine.rng.nextInt(0, nodes.length - 1)];
            let b = nodes[engine.rng.nextInt(0, nodes.length - 1)];
            if (b === a) b = nodes[(nodes.indexOf(a) + 1) % nodes.length];
            const reachable = probePeerRoute(engine, a.person.device.peerIDHex, b.person.device.peerIDHex).canDeliver;
            const id = a.sim.sendPrivateMessage(`hello ${round}`, b.person.device.peerIDHex);
            sent.push({ id, to: b, reachable });
            engine.runFor(3_000, 50);
        }
        engine.runFor(40_000, 50);

        const reachable = sent.filter(s => s.reachable);
        const delivered = reachable.filter(s => s.to.sim.messages.some(m => m.id === s.id && !m.isOutgoing));
        // Before the fix this was ~40% (reordered msg3, dead source routes, no resend).
        // A moving crowd can partition after send, so allow one straggler.
        expect(delivered.length).toBeGreaterThanOrEqual(reachable.length - 1);
        // Resends must never surface as duplicate messages at the recipient
        for (const s of sent) {
            expect(s.to.sim.messages.filter(m => m.id === s.id && !m.isOutgoing).length).toBeLessThanOrEqual(1);
        }
    });

    it('recovers when the recipient silently lost its Noise session', () => {
        const { engine, a, b } = pair(91);
        engine.runFor(3_000, 50);
        const bHex = b.device.peerIDHex;
        const aHex = a.device.peerIDHex;

        const first = a.sendPrivateMessage('first', bHex);
        engine.runFor(2_000, 50);
        expect(b.messages.some(m => m.id === first)).toBe(true);
        expect(a.noiseManager.hasEstablishedSession(bHex)).toBe(true);

        // B forgets the session (e.g. app restart / peer expiry); A still thinks it is live
        b.noiseManager.removeSession(aHex);
        const second = a.sendPrivateMessage('after desync', bHex);
        engine.runFor(20_000, 50);

        const got = b.messages.filter(m => m.id === second && !m.isOutgoing);
        expect(got).toHaveLength(1);
        expect(got[0].text).toBe('after desync');
        expect(a.deliveredMessageIds.has(second)).toBe(true);
        expect(a.noiseManager.hasEstablishedSession(bHex)).toBe(true);
        expect(b.noiseManager.hasEstablishedSession(aHex)).toBe(true);
    });

    it('re-sends msg3 when a duplicate msg2 shows the responder never completed', () => {
        const initiator = new NoiseSessionManager('aa');
        const responder = new NoiseSessionManager('bb');
        const msg1 = initiator.initiateHandshake('bb', 0);
        expect(msg1).not.toBeNull();
        const r2 = responder.handleHandshakeMessage('aa', msg1 as Uint8Array, 10);
        const r3 = initiator.handleHandshakeMessage('bb', r2.responsePayload as Uint8Array, 20);
        expect(r3.becameEstablished).toBe(true);
        // msg3 lost; responder re-sends msg2 (e.g. after a retried msg1)
        const again = initiator.handleHandshakeMessage('bb', r2.responsePayload as Uint8Array, 30);
        expect(again.becameEstablished).toBe(false);
        expect(again.responsePayload?.[0]).toBe(3);
        expect(responder.handleHandshakeMessage('aa', again.responsePayload as Uint8Array, 40).becameEstablished).toBe(true);
    });
});
