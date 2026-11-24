import { describe, it, expect } from 'vitest';
import { GCSFilter } from '../../../protocol/GCSFilter';
import { RequestSyncPacket } from '../../../protocol/RequestSyncPacket';
import { BinaryProtocol } from '../../../protocol/BinaryProtocol';
import {
    MessageType,
    createPacket,
    hexToBytes,
} from '../../../protocol/BitchatPacket';
import { SimulationEngine } from '../../SimulationEngine';
import { BitchatPerson } from '../../BitchatPerson';
import { BitchatDevice } from '../../BitchatDevice';
import { BitchatAppSimulator } from '../BitchatAppSimulator';
import {
    NOISE_HANDSHAKE_SIZES,
    NoisePayloadType,
    NoiseSessionManager,
} from '../NoiseSessionManager';
import { SeededRandom } from '../../SeededRandom';

describe('Phase 4: Gossip Sync (GCS) & Symbolic Noise XX + MessageRouter Outbox', () => {
    it('encodes/decodes GCSFilter & RequestSyncPacket within 400 B with 0% false negatives and ~1% FPR', () => {
        const rng = new SeededRandom(401);
        expect(GCSFilter.deriveP(0.01)).toBe(7);
        expect(GCSFilter.estimateMaxElements(400, 7)).toBeGreaterThanOrEqual(300);

        const members: Uint8Array[] = [];
        for (let i = 0; i < 200; i++) {
            members.push(rng.nextBytes(16));
        }

        const gcs = GCSFilter.buildFilter(members, 400, 0.01);
        expect(gcs.data.length).toBeLessThanOrEqual(400);

        const wire = RequestSyncPacket.encode(gcs);
        const decoded = RequestSyncPacket.decode(wire);
        expect(decoded).not.toBeNull();
        expect(decoded!.p).toBe(gcs.p);
        expect(decoded!.m).toBe(gcs.m);

        const sortedSet = GCSFilter.decodeToSortedSet(decoded!.p, decoded!.m, decoded!.data);
        for (const id of members) {
            expect(GCSFilter.contains(sortedSet, decoded!.p, decoded!.m, id)).toBe(true);
        }

        let falsePositives = 0;
        const trials = 1_000;
        for (let i = 0; i < trials; i++) {
            const probe = rng.nextBytes(16);
            if (GCSFilter.contains(sortedSet, decoded!.p, decoded!.m, probe)) {
                falsePositives++;
            }
        }
        // Target FPR is 1% (allow statistical headroom up to 3%)
        expect(falsePositives / trials).toBeLessThan(0.03);
    });

    it('heals a network partition via dependency-closed GCS gossip sync (announces before messages)', () => {
        const engine = new SimulationEngine({ seed: 402 });

        const dAlice = BitchatDevice.createRandom(engine.rng);
        dAlice.nickname = 'Alice';
        const dCourier = BitchatDevice.createRandom(engine.rng);
        dCourier.nickname = 'Courier';
        const dBob = BitchatDevice.createRandom(engine.rng);
        dBob.nickname = 'Bob';

        const simAlice = new BitchatAppSimulator(dAlice, 'android');
        const simCourier = new BitchatAppSimulator(dCourier, 'android');
        const simBob = new BitchatAppSimulator(dBob, 'android');
        dAlice.setAppSimulator(simAlice);
        dCourier.setAppSimulator(simCourier);
        dBob.setAppSimulator(simBob);

        dAlice.alwaysScan = true;
        dCourier.alwaysScan = true;
        dBob.alwaysScan = true;

        const pAlice = new BitchatPerson('alice', { x: 0, y: 0 }, dAlice);
        const pCourier = new BitchatPerson('courier', { x: 10, y: 0 }, dCourier);
        const pBob = new BitchatPerson('bob', { x: 500, y: 0 }, dBob);

        engine.addPerson(pAlice);
        engine.addPerson(pCourier);
        engine.addPerson(pBob);

        // Phase A: Alice and Courier connect and exchange announces
        engine.runFor(2_500, 50);
        expect(simCourier.peerManager.getPeer(dAlice.peerIDHex)).toBeDefined();
        expect(simBob.peerManager.getPeer(dAlice.peerIDHex)).toBeUndefined();

        // Alice broadcasts 3 public messages while Bob is partitioned 500 m away
        simAlice.sendMessage('partition-msg-1');
        engine.runFor(200, 50);
        simAlice.sendMessage('partition-msg-2');
        engine.runFor(200, 50);
        simAlice.sendMessage('partition-msg-3');
        engine.runFor(500, 50);

        expect(simCourier.messages.filter(m => !m.isOutgoing).length).toBe(3);
        expect(simBob.messages.length).toBe(0);

        // Phase B: Courier physically carries cached history over to Bob
        pCourier.position.x = 490;
        engine.runFor(4_500, 50);

        // Bob must have learned Alice's signing key via synced ANNOUNCE and received all 3 messages
        expect(simBob.peerManager.getPeer(dAlice.peerIDHex)).toBeDefined();
        const bobTexts = simBob.messages.filter(m => !m.isOutgoing).map(m => m.text);
        expect(bobTexts).toEqual(['partition-msg-1', 'partition-msg-2', 'partition-msg-3']);
    });

    it('runs 3-step Noise XX handshake, flushes MessageRouter outbox, and delivers automatic DELIVERED ACK across multi-hop', () => {
        const engine = new SimulationEngine({ seed: 403 });

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

        // Multi-hop chain: A(0) -- B(45) -- C(90) (A-C = 90m < -88 dBm, strictly 2 hops)
        engine.addPerson(new BitchatPerson('A', { x: 0, y: 0 }, dA));
        engine.addPerson(new BitchatPerson('B', { x: 45, y: 0 }, dB));
        engine.addPerson(new BitchatPerson('C', { x: 90, y: 0 }, dC));

        // Establish links & topology
        engine.runFor(3_500, 50);
        expect(simA.meshGraph.getShortestPath(dA.peerIDHex, dC.peerIDHex)).toEqual([
            dA.peerIDHex,
            dB.peerIDHex,
            dC.peerIDHex,
        ]);

        // Send private DM from A to C before Noise session exists -> queued in outbox + triggers Noise XX
        const dmId = simA.sendMessage('top secret over noise xx', dC.peerIDHex);
        expect(simA.noiseManager.hasEstablishedSession(dC.peerIDHex)).toBe(false);
        expect(simA.messageRouter.getOutboxCount(dC.peerIDHex)).toBe(1);

        // Advance simulation: msg1 (A->B->C) -> msg2 (C->B->A) -> msg3 (A->B->C) -> flush DM -> DELIVERED ACK
        engine.runFor(2_500, 50);

        expect(simA.noiseManager.hasEstablishedSession(dC.peerIDHex)).toBe(true);
        expect(simC.noiseManager.hasEstablishedSession(dA.peerIDHex)).toBe(true);
        expect(simA.messageRouter.getOutboxCount(dC.peerIDHex)).toBe(0);

        const receivedAtC = simC.messages.filter(m => !m.isOutgoing);
        expect(receivedAtC.length).toBe(1);
        expect(receivedAtC[0].text).toBe('top secret over noise xx');
        expect(receivedAtC[0].id).toBe(dmId);

        // Automatic DELIVERED ACK must have reached A
        expect(simA.deliveredMessageIds.has(dmId)).toBe(true);

        const snap = engine.telemetry.getSnapshot(engine.simTimeMs);
        expect(snap.originatedByKind.dm).toBe(1);
        expect(snap.deliveryRatio.dm).toBe(1);
    });

    it('retries Noise XX handshake via MessageRouter backoff and flushes DM once peer reconnects', () => {
        const engine = new SimulationEngine({ seed: 404 });

        const dA = BitchatDevice.createRandom(engine.rng);
        const dB = BitchatDevice.createRandom(engine.rng);
        const simA = new BitchatAppSimulator(dA, 'android');
        const simB = new BitchatAppSimulator(dB, 'android');
        dA.setAppSimulator(simA);
        dB.setAppSimulator(simB);
        dA.alwaysScan = true;
        dB.alwaysScan = true;

        const pA = new BitchatPerson('A', { x: 0, y: 0 }, dA);
        const pB = new BitchatPerson('B', { x: 400, y: 0 }, dB);
        engine.addPerson(pA);
        engine.addPerson(pB);

        // Queue DM while B is out of range (400 m away)
        const dmId = simA.sendPrivateMessage('queued while offline', dB.peerIDHex);
        expect(simA.messageRouter.getOutboxCount(dB.peerIDHex)).toBe(1);

        // Wait 2 s -> still out of range, still queued
        engine.runFor(2_000, 50);
        expect(simB.messages.length).toBe(0);
        expect(simA.messageRouter.getOutboxCount(dB.peerIDHex)).toBe(1);

        // Move B into range; after connect + announce + 5 s handshake retry tick, DM delivers
        pB.position.x = 10;
        engine.runFor(7_500, 50);

        expect(simA.noiseManager.hasEstablishedSession(dB.peerIDHex)).toBe(true);
        expect(simA.messageRouter.getOutboxCount(dB.peerIDHex)).toBe(0);
        expect(simB.messages.some(m => m.text === 'queued while offline')).toBe(true);
        expect(simA.deliveredMessageIds.has(dmId)).toBe(true);
    });

    it('applies PKCS#7 256-byte wire padding buckets to NOISE_HANDSHAKE and NOISE_ENCRYPTED frames', () => {
        const sender = hexToBytes('0102030405060708', 8);
        const recipient = hexToBytes('0807060504030201', 8);

        const hsPkt = createPacket(
            MessageType.NOISE_HANDSHAKE,
            sender,
            new Uint8Array(NOISE_HANDSHAKE_SIZES.MSG1_BYTES),
            7,
            recipient,
            1000
        );
        const encHs = BinaryProtocol.encode(hsPkt);
        expect(encHs).not.toBeNull();
        expect(encHs!.length).toBe(256);

        const encPayload = NoiseSessionManager.encodeEncryptedPayload(
            NoisePayloadType.PRIVATE_MESSAGE,
            'dm-1',
            new TextEncoder().encode('short dm')
        );
        const dmPkt = createPacket(
            MessageType.NOISE_ENCRYPTED,
            sender,
            encPayload,
            7,
            recipient,
            1000
        );
        const encDm = BinaryProtocol.encode(dmPkt);
        expect(encDm).not.toBeNull();
        expect(encDm!.length).toBe(256);
    });
});
