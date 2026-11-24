import { describe, it, expect } from 'vitest';
import { SimulationEngine } from '../SimulationEngine';
import { BitchatPerson } from '../BitchatPerson';
import { BitchatDevice } from '../BitchatDevice';
import { BitchatAppSimulator } from '../AppLayer/BitchatAppSimulator';
import { probePeerRoute } from '../MeshProbe';

function spawnChain(count: number, spacingM: number, wifiAware: boolean = false): {
    engine: SimulationEngine;
    people: BitchatPerson[];
} {
    const engine = new SimulationEngine({ seed: 777, gattHandshakeMs: 100 });
    const people: BitchatPerson[] = [];
    for (let i = 0; i < count; i++) {
        const dev = BitchatDevice.createRandom(engine.rng);
        dev.nickname = `Node-${i}`;
        dev.wifiAwareEnabled = wifiAware;
        dev.appSimulator = new BitchatAppSimulator(dev, 'android');
        const p = new BitchatPerson(`p_${i}`, { x: i * spacingM, y: 0 }, dev);
        engine.addPerson(p);
        people.push(p);
    }
    return { engine, people };
}

describe('MeshProbe (live DM reachability & route probing)', () => {
    it('detects direct BLE, confirmed source-route, and partitioned unreachable peers', () => {
        const { engine, people } = spawnChain(4, 45);
        // Add an isolated 5th peer far away
        const isoDev = BitchatDevice.createRandom(engine.rng);
        isoDev.nickname = 'Isolated';
        isoDev.appSimulator = new BitchatAppSimulator(isoDev, 'android');
        const iso = new BitchatPerson('p_iso', { x: 2000, y: 0 }, isoDev);
        engine.addPerson(iso);

        // Let BLE links form and announces propagate so MeshGraph confirms bidirectional edges
        engine.runFor(4000, 50);

        const p0 = people[0].device.peerIDHex;
        const p1 = people[1].device.peerIDHex;
        const p3 = people[3].device.peerIDHex;
        const pIso = iso.device.peerIDHex;

        const direct = probePeerRoute(engine, p0, p1);
        expect(direct.status).toBe('direct_ble');
        expect(direct.canDeliver).toBe(true);
        expect(direct.hops).toBe(1);
        expect(direct.directLink?.transport).toBe('BLE');

        const multi = probePeerRoute(engine, p0, p3);
        expect(multi.canDeliver).toBe(true);
        expect(multi.hops).toBeGreaterThanOrEqual(2);
        expect(['source_route', 'flood_reachable']).toContain(multi.status);
        expect(multi.displayPath?.[0]).toBe(p0);
        expect(multi.displayPath?.[multi.displayPath.length - 1]).toBe(p3);

        const unreachable = probePeerRoute(engine, p0, pIso);
        expect(unreachable.status).toBe('unreachable');
        expect(unreachable.canDeliver).toBe(false);
        expect(unreachable.displayPath).toBeNull();
    });

    it('flags physical paths longer than maxTtl as exceeds_ttl', () => {
        // 10 nodes spaced 50 m apart -> 9 hops end-to-end (> maxTtl 7)
        const { engine, people } = spawnChain(10, 50);
        // Disable announcing so only physical links form without gossip shortcuts
        for (const p of people) {
            (p.device.appSimulator as BitchatAppSimulator).isAnnouncing = false;
        }
        engine.runFor(1500, 50);

        const first = people[0].device.peerIDHex;
        const last = people[9].device.peerIDHex;
        const probe = probePeerRoute(engine, first, last);
        expect(probe.physicalPath).not.toBeNull();
        expect(probe.hops).toBeGreaterThan(probe.maxTtl);
        expect(probe.status).toBe('exceeds_ttl');
        expect(probe.canDeliver).toBe(false);
    });
});
