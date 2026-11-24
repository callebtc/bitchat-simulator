import { describe, it, expect } from 'vitest';
import { SimulationEngine } from '../../SimulationEngine';
import { BitchatPerson } from '../../BitchatPerson';
import { BitchatDevice } from '../../BitchatDevice';
import { BitchatAppSimulator } from '../BitchatAppSimulator';
import { BitchatConnectionBLE } from '../../BitchatConnectionBLE';
import {
    ANDROID_DEFAULT_POLICY,
    IOS_POLICY,
    createMeshPolicy,
    evaluateRelayDecision,
    iosSubsetSize,
    selectFanoutLinks,
} from '../MeshPolicy';
import {
    MessageType,
    SpecialRecipients,
    createPacket,
    hexToBytes,
} from '../../../protocol/BitchatPacket';
import { SeededRandom } from '../../SeededRandom';
import { SecurityManager } from '../SecurityManager';
import { MeshGraph } from '../MeshGraph';

describe('Phase 2: Android-Faithful Mesh Core & iOS Policy Preset', () => {
    it('enforces Android TTL=0 relay emission (8 hops) vs iOS TTL<=1 stop (7 hops)', () => {
        const rng = new SeededRandom(1);
        const pktTtl1 = createPacket(
            MessageType.MESSAGE,
            new Uint8Array(8).fill(1),
            new Uint8Array([65]),
            1,
            SpecialRecipients.BROADCAST,
            1000
        );

        const androidDec = evaluateRelayDecision(
            pktTtl1,
            { networkSize: 5, degree: 3, senderIsSelf: false, recipientIsSelf: false },
            ANDROID_DEFAULT_POLICY,
            rng
        );
        expect(androidDec.shouldRelay).toBe(true);
        expect(androidDec.newTtl).toBe(0);

        const androidAtZero = evaluateRelayDecision(
            { ...pktTtl1, ttl: 0 },
            { networkSize: 5, degree: 3, senderIsSelf: false, recipientIsSelf: false },
            ANDROID_DEFAULT_POLICY,
            rng
        );
        expect(androidAtZero.shouldRelay).toBe(false);
        expect(androidAtZero.dropReason).toBe('ttl_expired');

        const iosDec = evaluateRelayDecision(
            pktTtl1,
            { networkSize: 5, degree: 3, senderIsSelf: false, recipientIsSelf: false },
            IOS_POLICY,
            rng
        );
        expect(iosDec.shouldRelay).toBe(false);
        expect(iosDec.dropReason).toBe('ttl_expired');
    });

    it('applies Android probabilistic relay for low TTL in large networks', () => {
        const rng = new SeededRandom(42);
        const lowTtlPkt = createPacket(
            MessageType.MESSAGE,
            new Uint8Array(8).fill(1),
            new Uint8Array([65]),
            3, // decrements to 2 (< 4)
            SpecialRecipients.BROADCAST,
            1000
        );

        let relayed = 0;
        const trials = 500;
        for (let i = 0; i < trials; i++) {
            const dec = evaluateRelayDecision(
                lowTtlPkt,
                { networkSize: 150, degree: 6, senderIsSelf: false, recipientIsSelf: false },
                ANDROID_DEFAULT_POLICY,
                rng
            );
            if (dec.shouldRelay) relayed++;
        }
        // Expected probability ~0.40 for networkSize > 100
        expect(relayed / trials).toBeGreaterThan(0.3);
        expect(relayed / trials).toBeLessThan(0.5);
    });

    it('applies iOS degree-based TTL clamping, jitter, and ~log2 broadcast fanout subsetting', () => {
        const rng = new SeededRandom(9);
        const pkt = createPacket(
            MessageType.MESSAGE,
            new Uint8Array(8).fill(1),
            new Uint8Array([65]),
            7,
            SpecialRecipients.BROADCAST,
            1000
        );

        const denseDec = evaluateRelayDecision(
            pkt,
            { networkSize: 20, degree: 8, senderIsSelf: false, recipientIsSelf: false },
            IOS_POLICY,
            rng
        );
        expect(denseDec.shouldRelay).toBe(true);
        expect(denseDec.newTtl).toBe(4); // clamped to 5, then -1 => 4
        expect(denseDec.delayMs).toBeGreaterThanOrEqual(80);
        expect(denseDec.delayMs).toBeLessThanOrEqual(180);

        expect(iosSubsetSize(8)).toBe(4); // 1 + floor(log2(7)) = 4

        const hub = BitchatDevice.createRandom(rng);
        const links: BitchatConnectionBLE[] = [];
        for (let i = 0; i < 8; i++) {
            const peer = BitchatDevice.createRandom(rng);
            links.push(new BitchatConnectionBLE(hub, peer, hub, rng));
        }

        const broadcastSelected = selectFanoutLinks({
            ownerPeerId: hub.peerIDHex,
            connections: links,
            linkPeerBindings: new Map(),
            packetType: MessageType.MESSAGE,
            isDirected: false,
            packetId: 'pkt-123',
            policy: IOS_POLICY,
        });
        expect(broadcastSelected.length).toBe(4);

        // Announces always get full fanout even on iOS
        const announceSelected = selectFanoutLinks({
            ownerPeerId: hub.peerIDHex,
            connections: links,
            linkPeerBindings: new Map(),
            packetType: MessageType.ANNOUNCE,
            isDirected: false,
            packetId: 'pkt-123',
            policy: IOS_POLICY,
        });
        expect(announceSelected.length).toBe(8);
    });

    it('gates MESSAGE acceptance/relay until verified ANNOUNCE is received (Android SecurityManager)', () => {
        const engine = new SimulationEngine({ seed: 101 });
        const dA = BitchatDevice.createRandom(engine.rng);
        const dB = BitchatDevice.createRandom(engine.rng);
        const simA = new BitchatAppSimulator(dA, 'android');
        const simB = new BitchatAppSimulator(dB, 'android');
        simA.isAnnouncing = false;
        simB.isAnnouncing = false;
        dA.setAppSimulator(simA);
        dB.setAppSimulator(simB);

        const pA = new BitchatPerson('A', { x: 0, y: 0 }, dA);
        const pB = new BitchatPerson('B', { x: 10, y: 0 }, dB);
        dA.alwaysScan = true;
        engine.addPerson(pA);
        engine.addPerson(pB);

        engine.runFor(650, 50);
        expect(engine.getAllConnections().length).toBeGreaterThanOrEqual(1);
        expect(dA.connectionManager.getConnectedPeers()).toContain(dB);

        // Send MESSAGE before ANNOUNCE -> B drops as unknown_key
        simA.sendMessage('hello before announce');
        engine.runFor(600, 50);
        expect(simB.messages.length).toBe(0);
        expect(engine.telemetry.getSnapshot(engine.simTimeMs).drops.unknown_key).toBeGreaterThanOrEqual(1);

        // Now A announces -> B learns A's signing key
        simA.sendAnnounce(engine.simTimeMs);
        engine.runFor(600, 50);
        expect(simB.peerManager.getPeer(dA.peerIDHex)).toBeDefined();

        // Subsequent MESSAGE succeeds
        simA.sendMessage('hello after announce');
        engine.runFor(600, 50);
        expect(simB.messages.length).toBe(1);
        expect(simB.messages[0].text).toBe('hello after announce');
    });

    it('enforces 10s disconnect grace eviction and cascades removal to MeshGraph', () => {
        const engine = new SimulationEngine({ seed: 202 });
        const dA = BitchatDevice.createRandom(engine.rng);
        const dB = BitchatDevice.createRandom(engine.rng);
        const simA = new BitchatAppSimulator(dA, 'android');
        const simB = new BitchatAppSimulator(dB, 'android');
        dA.setAppSimulator(simA);
        dB.setAppSimulator(simB);
        dA.alwaysScan = true;

        const pA = new BitchatPerson('A', { x: 0, y: 0 }, dA);
        const pB = new BitchatPerson('B', { x: 10, y: 0 }, dB);
        engine.addPerson(pA);
        engine.addPerson(pB);

        // Connect + immediate announce on connect (+200ms / +1200ms + 400ms latency)
        engine.runFor(2500, 50);
        expect(simA.peerManager.getPeer(dB.peerIDHex)).toBeDefined();
        expect(simB.peerManager.getPeer(dA.peerIDHex)).toBeDefined();

        // Move B far away to break connection
        pB.position.x = 500;
        engine.runFor(500, 50);
        expect(engine.getAllConnections().length).toBe(0);
        // Still present during 10s grace window
        expect(simA.peerManager.getPeer(dB.peerIDHex)).toBeDefined();

        // Advance past 10s disconnect grace -> peer removed from PeerManager & MeshGraph
        engine.runFor(10_500, 50);
        expect(simA.peerManager.getPeer(dB.peerIDHex)).toBeUndefined();
        expect(simA.meshGraph.hasNeighbor(dB.peerIDHex, dA.peerIDHex)).toBe(false);
    });

    it('cancels pending iOS jittered relay when duplicate arrives first', () => {
        const engine = new SimulationEngine({ seed: 303 });
        const dA = BitchatDevice.createRandom(engine.rng);
        const dB = BitchatDevice.createRandom(engine.rng);
        const dC = BitchatDevice.createRandom(engine.rng);
        const dD = BitchatDevice.createRandom(engine.rng);

        const iosCustom = createMeshPolicy('ios', {
            requireVerifiedAnnounceBeforeRelay: false,
            useFanoutSubsetting: false,
        });
        const simC = new BitchatAppSimulator(dC, iosCustom);
        simC.isAnnouncing = false;
        dC.setAppSimulator(simC);

        // Give C degree 4 so its iOS jitter window is 60-150ms
        const people = [
            new BitchatPerson('A', { x: 0, y: 0 }, dA),
            new BitchatPerson('B', { x: 10, y: 0 }, dB),
            new BitchatPerson('C', { x: 5, y: 5 }, dC),
            new BitchatPerson('D', { x: 15, y: 5 }, dD),
        ];
        people.forEach(p => {
            p.device.alwaysScan = true;
            engine.addPerson(p);
        });

        engine.runFor(500, 50);

        const pkt = createPacket(
            MessageType.MESSAGE,
            dA.peerID,
            new TextEncoder().encode('duplicate cancels jittered relay'),
            7,
            SpecialRecipients.BROADCAST,
            engine.simTimeMs
        );
        // First copy arrives at C from A -> C schedules a 60-150ms jittered relay
        dC.receivePacket(pkt, dA);
        // 20ms later (inside jitter window), a duplicate arrives at C from B -> cancels C's scheduled relay!
        engine.scheduler.scheduleIn(20, () => {
            dC.receivePacket({ ...pkt, ttl: 6 }, dB);
        });
        engine.runFor(500, 50);

        expect(engine.telemetry.getSnapshot(engine.simTimeMs).drops.cancelled_relay).toBe(1);
    });

    it('drops source-routed packets containing duplicate hops and honors MeshGraph timestamp order', () => {
        const graph = new MeshGraph();
        expect(graph.updateFromAnnouncement('A', ['B'], 200n)).toBe(true);
        // Older timestamp ignored
        expect(graph.updateFromAnnouncement('A', ['C'], 100n)).toBe(false);
        expect(graph.hasNeighbor('A', 'B')).toBe(true);
        expect(graph.hasNeighbor('A', 'C')).toBe(false);

        // Duplicate hop rejection
        const engine = new SimulationEngine({ seed: 404 });
        const dA = BitchatDevice.createRandom(engine.rng);
        const dB = BitchatDevice.createRandom(engine.rng);
        const simB = new BitchatAppSimulator(
            dB,
            createMeshPolicy('android', { requireVerifiedAnnounceBeforeRelay: false })
        );
        dB.setAppSimulator(simB);
        engine.addPerson(new BitchatPerson('B', { x: 0, y: 0 }, dB));

        const loopPacket = createPacket(
            MessageType.MESSAGE,
            dA.peerID,
            new Uint8Array([1, 2]),
            7,
            hexToBytes('ffffffffffffffff', 8),
            1000
        );
        loopPacket.version = 2;
        loopPacket.route = [dB.peerID, dB.peerID]; // Duplicate hop!
        loopPacket.signature = SecurityManager.signPacket(loopPacket, dA.signingPublicKey);

        dB.receivePacket(loopPacket, dA);
        expect(engine.telemetry.getSnapshot(engine.simTimeMs).drops.duplicate_hop).toBe(1);
    });
});
