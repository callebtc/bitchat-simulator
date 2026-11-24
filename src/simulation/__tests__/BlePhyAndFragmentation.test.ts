import { describe, it, expect } from 'vitest';
import { SimulationEngine } from '../SimulationEngine';
import { BitchatPerson } from '../BitchatPerson';
import { BitchatDevice, PowerMode } from '../BitchatDevice';
import { BitchatConnectionBLE } from '../BitchatConnectionBLE';
import { BitchatAppSimulator } from '../AppLayer/BitchatAppSimulator';
import { FragmentManager } from '../AppLayer/FragmentManager';
import { resolveBlePowerProfile } from '../PowerProfile';
import { RadioMedium } from '../RadioMedium';
import {
    MessageType,
    SpecialRecipients,
    createPacket,
} from '../../protocol/BitchatPacket';
import { BinaryProtocol } from '../../protocol/BinaryProtocol';
import { SeededRandom } from '../SeededRandom';

describe('Phase 3: BLE PHY, Dual-Role Links, SINR, GATT Queues & Fragmentation', () => {
    it('enforces Android PowerProfile scan duty cycles and RSSI thresholds', () => {
        const perf = resolveBlePowerProfile(PowerMode.PERFORMANCE, false);
        expect(perf.continuousScan).toBe(true);
        expect(perf.rssiThresholdDbm).toBe(-95);

        const normal = resolveBlePowerProfile(PowerMode.NORMAL, false);
        expect(normal.scanOnMs).toBe(8_000);
        expect(normal.scanOffMs).toBe(2_000);
        expect(normal.rssiThresholdDbm).toBe(-85);

        const eco = resolveBlePowerProfile(PowerMode.ECO, false);
        expect(eco.scanOnMs).toBe(2_000);
        expect(eco.scanOffMs).toBe(28_000);
        expect(eco.rssiThresholdDbm).toBe(-75);

        const ulp = resolveBlePowerProfile(PowerMode.ULTRA_LOW_POWER, false);
        expect(ulp.scanOnMs).toBe(1_000);
        expect(ulp.scanOffMs).toBe(29_000);
        expect(ulp.rssiThresholdDbm).toBe(-65);

        const bg = resolveBlePowerProfile(PowerMode.NORMAL, true, false);
        expect(bg.scanOnMs).toBe(1_000);
        expect(bg.scanOffMs).toBe(59_000);

        // Two devices at 25 m (~ -75 dBm): ULP (-65 dBm threshold) refuses to connect, PERFORMANCE (-95) connects
        const engineUlp = new SimulationEngine({ seed: 11 });
        const d1 = BitchatDevice.createRandom(engineUlp.rng);
        const d2 = BitchatDevice.createRandom(engineUlp.rng);
        d1.powerMode = PowerMode.ULTRA_LOW_POWER;
        d2.powerMode = PowerMode.ULTRA_LOW_POWER;
        d1.alwaysScan = true;
        engineUlp.addPerson(new BitchatPerson('p1', { x: 0, y: 0 }, d1));
        engineUlp.addPerson(new BitchatPerson('p2', { x: 25, y: 0 }, d2));
        engineUlp.runFor(1_500, 50);
        expect(engineUlp.getAllConnections().length).toBe(0);

        const enginePerf = new SimulationEngine({ seed: 11 });
        const d3 = BitchatDevice.createRandom(enginePerf.rng);
        const d4 = BitchatDevice.createRandom(enginePerf.rng);
        d3.powerMode = PowerMode.PERFORMANCE;
        d3.alwaysScan = true;
        enginePerf.addPerson(new BitchatPerson('p3', { x: 0, y: 0 }, d3));
        enginePerf.addPerson(new BitchatPerson('p4', { x: 25, y: 0 }, d4));
        enginePerf.runFor(1_000, 50);
        expect(enginePerf.getAllConnections().length).toBeGreaterThanOrEqual(1);
    });

    it('models dual-role concurrent BLE links on Android and collapses them on iOS policy', () => {
        // Android: both devices scanning simultaneously form directed A->B and B->A GATT links
        const androidEngine = new SimulationEngine({ seed: 22 });
        const dA = BitchatDevice.createRandom(androidEngine.rng);
        const dB = BitchatDevice.createRandom(androidEngine.rng);
        dA.setAppSimulator(new BitchatAppSimulator(dA, 'android'));
        dB.setAppSimulator(new BitchatAppSimulator(dB, 'android'));
        dA.alwaysScan = true;
        dB.alwaysScan = true;

        androidEngine.addPerson(new BitchatPerson('A', { x: 0, y: 0 }, dA));
        androidEngine.addPerson(new BitchatPerson('B', { x: 10, y: 0 }, dB));
        androidEngine.runFor(800, 50);

        expect(androidEngine.getAllConnections().length).toBe(2);
        expect(androidEngine.telemetry.getSnapshot(androidEngine.simTimeMs).dualLinksObserved).toBeGreaterThanOrEqual(1);

        // iOS policy: collapseDuplicateLinks = true -> only 1 link allowed between the pair
        const iosEngine = new SimulationEngine({ seed: 22 });
        const iA = BitchatDevice.createRandom(iosEngine.rng);
        const iB = BitchatDevice.createRandom(iosEngine.rng);
        iA.setAppSimulator(new BitchatAppSimulator(iA, 'ios'));
        iB.setAppSimulator(new BitchatAppSimulator(iB, 'ios'));
        iA.alwaysScan = true;
        iB.alwaysScan = true;

        iosEngine.addPerson(new BitchatPerson('A', { x: 0, y: 0 }, iA));
        iosEngine.addPerson(new BitchatPerson('B', { x: 10, y: 0 }, iB));
        iosEngine.runFor(800, 50);

        expect(iosEngine.getAllConnections().length).toBe(1);
    });

    it('evicts oldest client connections before server connections on total cap', () => {
        const rng = new SeededRandom(33);
        const hub = BitchatDevice.createRandom(rng);
        hub.connectionSettings = { maxClients: 2, maxServers: 2, maxTotal: 2 };

        const peer1 = BitchatDevice.createRandom(rng);
        const peer2 = BitchatDevice.createRandom(rng);
        const peer3 = BitchatDevice.createRandom(rng);

        // Link 1: hub is client (initiator = hub -> peer1)
        const cClient = new BitchatConnectionBLE(hub, peer1, hub, rng, 'BLE:hub->p1');
        // Link 2: hub is server (initiator = peer2 -> hub)
        const cServer1 = new BitchatConnectionBLE(peer2, hub, peer2, rng, 'BLE:p2->hub');
        // Link 3: hub is server (initiator = peer3 -> hub)
        const cServer2 = new BitchatConnectionBLE(peer3, hub, peer3, rng, 'BLE:p3->hub');

        hub.connectionManager.addConnection(cClient);
        hub.connectionManager.addConnection(cServer1);
        expect(hub.connectionManager.getActiveConnections().length).toBe(2);

        // Adding a 3rd link hits maxTotal=2: must evict client link (cClient), keeping cServer1 & cServer2
        hub.connectionManager.addConnection(cServer2);
        const activeIds = hub.connectionManager.getActiveConnections().map(c => c.linkID);
        expect(activeIds).toEqual(['BLE:p2->hub', 'BLE:p3->hub']);
        expect(cClient.isActive).toBe(false);
    });

    it('serializes GATT writes per direction and drops overflow past 256-packet queue cap', () => {
        const engine = new SimulationEngine({ seed: 44 });
        const dA = BitchatDevice.createRandom(engine.rng);
        const dB = BitchatDevice.createRandom(engine.rng);
        dA.alwaysScan = true;

        const receivedTimes: number[] = [];
        dB.onPacketReceived = () => {
            receivedTimes.push(engine.simTimeMs);
        };

        engine.addPerson(new BitchatPerson('A', { x: 0, y: 0 }, dA));
        engine.addPerson(new BitchatPerson('B', { x: 5, y: 0 }, dB));
        engine.runFor(700, 50);

        const conn = engine.getAllConnections()[0];
        expect(conn).toBeDefined();

        // Blast 270 packets instantly -> queue cap is 256 (including 1 in-flight), 14 dropped as queue_full
        for (let i = 0; i < 270; i++) {
            const pkt = createPacket(
                MessageType.MESSAGE,
                dA.peerID,
                new TextEncoder().encode(`burst-${i}`),
                7,
                SpecialRecipients.BROADCAST,
                engine.simTimeMs + i
            );
            conn.send(pkt, dA, engine.simTimeMs);
        }

        const snapAfterBurst = engine.telemetry.getSnapshot(engine.simTimeMs);
        expect(snapAfterBurst.drops.queue_full).toBe(14);

        // Step a few seconds and confirm serialized delivery over time (not all delivered at once)
        engine.runFor(500, 50);
        expect(receivedTimes.length).toBeGreaterThan(5);
        expect(receivedTimes.length).toBeLessThan(257);
    });

    it('models spatial 2.4 GHz SINR interference and channel selectivity', () => {
        const medium = new RadioMedium({ enabled: true });

        // Quiet channel: strong RSSI (-65 dBm) vs thermal noise (-102 dBm) => SINR = 37 dB, PER = 0
        const txId1 = medium.registerTransmission({
            band: '2.4GHz',
            txDeviceId: 'tx1',
            txPosition: { x: 0, y: 0 },
            txStrength: 50,
            channel: 10,
            startMs: 100,
            endMs: 120,
        });
        const quiet = medium.evaluateReception({
            txId: txId1,
            band: '2.4GHz',
            rssiDbm: -65,
            rxPosition: { x: 10, y: 0 },
            rxStrength: 50,
            channel: 10,
            wireBytes: 200,
            startMs: 100,
            endMs: 120,
            environment: null,
        });
        expect(quiet.interfererCount).toBe(0);
        expect(quiet.sinrDb).toBeCloseTo(37, 1);
        expect(quiet.packetErrorRate).toBe(0);

        // Orthogonal channel interferer (ch 25) right next to receiver => zero impact
        medium.registerTransmission({
            band: '2.4GHz',
            txDeviceId: 'orth',
            txPosition: { x: 11, y: 0 },
            txStrength: 50,
            channel: 25,
            startMs: 100,
            endMs: 120,
        });
        const withOrth = medium.evaluateReception({
            txId: txId1,
            band: '2.4GHz',
            rssiDbm: -65,
            rxPosition: { x: 10, y: 0 },
            rxStrength: 50,
            channel: 10,
            wireBytes: 200,
            startMs: 100,
            endMs: 120,
            environment: null,
        });
        expect(withOrth.interfererCount).toBe(0);

        // Co-channel interferer (ch 10) at 2 m from receiver => strong interference, high PER
        medium.registerTransmission({
            band: '2.4GHz',
            txDeviceId: 'jam',
            txPosition: { x: 12, y: 0 },
            txStrength: 50,
            channel: 10,
            startMs: 105,
            endMs: 125,
        });
        const interfered = medium.evaluateReception({
            txId: txId1,
            band: '2.4GHz',
            rssiDbm: -65,
            rxPosition: { x: 10, y: 0 },
            rxStrength: 50,
            channel: 10,
            wireBytes: 200,
            startMs: 100,
            endMs: 120,
            environment: null,
        });
        expect(interfered.interfererCount).toBe(1);
        expect(interfered.sinrDb).toBeLessThan(0);
        expect(interfered.packetErrorRate).toBeGreaterThan(0.9);
    });

    it('fragments >512 B FILE_TRANSFER with v2 source-route inheritance, 20ms pacing, and multi-hop reassembly', () => {
        const engine = new SimulationEngine({ seed: 55 });
        const dA = BitchatDevice.createRandom(engine.rng);
        const dB = BitchatDevice.createRandom(engine.rng);
        const dC = BitchatDevice.createRandom(engine.rng);

        const simA = new BitchatAppSimulator(dA, 'android');
        const simB = new BitchatAppSimulator(dB, 'android');
        const simC = new BitchatAppSimulator(dC, 'android');
        dA.setAppSimulator(simA);
        dB.setAppSimulator(simB);
        dC.setAppSimulator(simC);

        dA.alwaysScan = true;
        dB.alwaysScan = true;
        // 3-node chain: A(0) -- B(35) -- C(70); A-C distance 70m is below -85 dBm connect threshold
        engine.addPerson(new BitchatPerson('A', { x: 0, y: 0 }, dA));
        engine.addPerson(new BitchatPerson('B', { x: 35, y: 0 }, dB));
        engine.addPerson(new BitchatPerson('C', { x: 70, y: 0 }, dC));

        // Let links form and bidirectional announces propagate so A knows route A -> B -> C
        engine.runFor(4_000, 50);
        const route = simA.meshGraph.getShortestPath(dA.peerIDHex, dC.peerIDHex);
        expect(route).toEqual([dA.peerIDHex, dB.peerIDHex, dC.peerIDHex]);

        // Verify FragmentManager produces <= 512 B v2 routed fragments inheriting route=[B]
        const bigPayload = new Uint8Array(2_000);
        for (let i = 0; i < bigPayload.length; i++) {
            bigPayload[i] = i & 0xff;
        }
        const fm = new FragmentManager();
        const samplePkt = createPacket(
            MessageType.FILE_TRANSFER,
            dA.peerID,
            bigPayload,
            7,
            dC.peerID,
            engine.simTimeMs
        );
        samplePkt.version = 2;
        samplePkt.route = [dB.peerID];
        const frags = fm.createFragments(samplePkt, engine.rng);
        expect(frags.length).toBeGreaterThanOrEqual(5);
        for (const f of frags) {
            expect(f.version).toBe(2);
            expect(f.route?.length).toBe(1);
            const enc = BinaryProtocol.encode(f, { padding: false });
            expect(enc).not.toBeNull();
            expect(enc!.length).toBeLessThanOrEqual(512);
        }

        // Send 2 KiB file end-to-end from A to C through B
        const filePacketId = simA.sendFile(bigPayload, dC.peerIDHex);
        engine.runFor(3_000, 50);

        const snap = engine.telemetry.getSnapshot(engine.simTimeMs);
        expect(snap.originatedByKind.file).toBe(1);
        expect(snap.deliveryRatio.file).toBe(1);
        expect(snap.sourceRouteOriginated).toBeGreaterThanOrEqual(1);
        expect(snap.drops.ttl_expired).toBe(0);
        // C received it without holding leftover incomplete assemblies
        expect(simC.fragmentManager.getActiveAssemblyCount()).toBe(0);
        expect(filePacketId.length).toBe(32);

        // Verify incomplete fragment timeout after 30 s
        const partial = frags[0];
        expect(fm.handleFragment(partial, 1_000)).toBeNull();
        expect(fm.getActiveAssemblyCount()).toBe(1);
        expect(fm.cleanupExpired(32_000)).toBe(1);
        expect(fm.getActiveAssemblyCount()).toBe(0);
    });
});
