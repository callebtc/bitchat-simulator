import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../SeededRandom';
import { EventScheduler } from '../EventScheduler';
import { SimulationEngine } from '../SimulationEngine';
import { setupDemo } from '../DemoSetup';
import { BitchatConnectionBLE, RSSI_CONFIG } from '../BitchatConnectionBLE';
import { BitchatDevice } from '../BitchatDevice';
import { TelemetryCollector } from '../TelemetryCollector';

describe('Determinism, EventScheduler & Telemetry (Phase 1)', () => {
    it('SeededRandom reproduces identical sequences and independent forks', () => {
        const a = new SeededRandom(42);
        const b = new SeededRandom(42);
        for (let i = 0; i < 20; i++) {
            expect(a.next()).toBe(b.next());
        }
        expect(a.fork('radio').nextBytes(16)).toEqual(b.fork('radio').nextBytes(16));
        expect(a.fork('radio').next()).not.toBe(a.fork('motion').next());
    });

    it('EventScheduler fires events in strict chronological & insertion order and honors cancel', () => {
        const sched = new EventScheduler();
        const fired: string[] = [];

        sched.scheduleAt(50, () => fired.push('50-a'));
        const cancelMe = sched.scheduleAt(30, () => fired.push('30-cancelled'));
        sched.scheduleAt(50, () => fired.push('50-b'));
        sched.scheduleAt(15, now => {
            fired.push(`15@${now}`);
            // Dynamic scheduling inside callback
            sched.scheduleIn(20, innerNow => fired.push(`35@${innerNow}`));
        });

        expect(sched.cancel(cancelMe)).toBe(true);
        expect(sched.drainUntil(40)).toBe(2);
        expect(fired).toEqual(['15@15', '35@35']);
        expect(sched.now()).toBe(40);

        expect(sched.drainUntil(60)).toBe(2);
        expect(fired).toEqual(['15@15', '35@35', '50-a', '50-b']);
    });

    it('SimulationEngine produces identical state across two runs with the same seed', () => {
        const run = (seed: number) => {
            const engine = new SimulationEngine({ seed });
            setupDemo(engine, 6);
            engine.runFor(5000, 50);
            return {
                positions: engine.getAllPeople().map(p => ({
                    id: p.id,
                    peer: p.device.peerIDHex,
                    x: p.position.x,
                    y: p.position.y,
                })),
                conns: engine.getAllConnections().map(c => c.id).sort(),
                telemetry: engine.telemetry.getSnapshot(engine.simTimeMs),
            };
        };

        const r1 = run(2026);
        const r2 = run(2026);
        expect(r1).toEqual(r2);
    });

    it('BitchatConnectionBLE advances noisePhase by dt, not absolute timestamp', () => {
        const rng = new SeededRandom(7);
        const d1 = BitchatDevice.createRandom(rng);
        const d2 = BitchatDevice.createRandom(rng);
        d1.position = { x: 0, y: 0 };
        d2.position = { x: 10, y: 0 };
        d1.bluetoothStrength = 50;
        d2.bluetoothStrength = 50;

        // Run two identical links starting at very different epoch offsets (0 vs 1_000_000 ms)
        const c1 = new BitchatConnectionBLE(d1, d2, d1, new SeededRandom(99));
        const c2 = new BitchatConnectionBLE(d1, d2, d1, new SeededRandom(99));

        const origAmp = RSSI_CONFIG.NOISE_AMPLITUDE;
        RSSI_CONFIG.NOISE_AMPLITUDE = 3;
        try {
            for (let i = 0; i < 20; i++) {
                c1.updateRSSI(i * 50);
                c2.updateRSSI(1_000_000 + i * 50);
            }
            expect(c1.rssi).toBeCloseTo(c2.rssi, 8);
        } finally {
            RSSI_CONFIG.NOISE_AMPLITUDE = origAmp;
        }
    });

    it('TelemetryCollector computes delivery ratios, latency percentiles, and amplification', () => {
        const t = new TelemetryCollector();
        t.recordMessageOriginated('m1', 'broadcast', 'A', 1000, 100, 4);
        t.recordMessageDelivered('m1', 'B', 1100, 1);
        t.recordMessageDelivered('m1', 'C', 1300, 2);
        t.recordMessageDelivered('m1', 'D', 1500, 3);
        // Duplicate delivery to B should be ignored
        t.recordMessageDelivered('m1', 'B', 1600, 2);

        t.recordPacketTransmitted(1000, 120, false);
        t.recordPacketTransmitted(1100, 120, true);
        t.recordPacketTransmitted(1200, 120, true);
        t.recordSourceRouteHopForwarded();
        t.recordSourceRouteHopForwarded();
        t.recordSourceRouteFallback();

        const snap = t.getSnapshot(1500);
        expect(snap.deliveryRatio.broadcast).toBeCloseTo(0.75, 5);
        expect(snap.latencyMs.broadcast.count).toBe(3);
        expect(snap.latencyMs.broadcast.p50).toBe(300);
        expect(snap.latencyMs.broadcast.max).toBe(500);
        expect(snap.goodputBytesDelivered).toBe(300);
        expect(snap.wireBytesSent).toBe(360);
        expect(snap.byteAmplification).toBeCloseTo(1.2, 5);
        expect(snap.sourceRouteHitRate).toBeCloseTo(2 / 3, 5);
    });
});
