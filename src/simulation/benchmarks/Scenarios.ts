import { SimulationEngine } from '../SimulationEngine';
import { BitchatPerson, MovementMode } from '../BitchatPerson';
import { BitchatDevice, PowerMode } from '../BitchatDevice';
import { BitchatAppSimulator } from '../AppLayer/BitchatAppSimulator';
import { MeshPolicyPreset } from '../AppLayer/MeshPolicy';
import { TelemetrySnapshot } from '../TelemetryCollector';

/**
 * Deterministic benchmark scenarios covering all 5 core BitChat mesh workloads:
 * 1. public_chat_dense: Dense crowd public broadcast floods
 * 2. private_dm_noise: Multi-hop Noise XX DMs + source routing + DELIVERED ACKs
 * 3. partition_healing_gossip: Two clusters bridged by mobile couriers using GCS sync
 * 4. fragmented_media: >512 B FILE_TRANSFER payloads across BLE vs Wi-Fi Aware
 * 5. voice_ptt_burst: Live ~15 pkt/s push-to-talk VOICE_FRAME bursts
 */

export type WorkloadKind =
    | 'public_chat_dense'
    | 'private_dm_noise'
    | 'partition_healing_gossip'
    | 'fragmented_media'
    | 'voice_ptt_burst';

export type FleetProfile = 'android' | 'ios' | 'mixed_50_50';

export interface BenchmarkConfig {
    name: string;
    workload: WorkloadKind;
    fleetProfile: FleetProfile;
    /** Fraction of nodes with Wi-Fi Aware enabled (0.0 to 1.0). */
    wifiAwareRatio: number;
    nodeCount: number;
    areaSizeMeters: number;
    durationMs: number;
    warmupMs: number;
    seed: number;
    powerMode?: PowerMode;
}

export interface BenchmarkResult {
    config: BenchmarkConfig;
    snapshot: TelemetrySnapshot;
    activeBleLinks: number;
    activeWifiAwareLinks: number;
    bridgedPackets: number;
    deliveredDmAcks: number;
    wallDurationMs: number;
}

function selectNodePreset(profile: FleetProfile, index: number): MeshPolicyPreset {
    if (profile === 'android') return 'android';
    if (profile === 'ios') return 'ios';
    return index % 2 === 0 ? 'android' : 'ios';
}

export function runScenario(config: BenchmarkConfig): BenchmarkResult {
    const startWall = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const engine = new SimulationEngine({ seed: config.seed });
    const sims: BitchatAppSimulator[] = [];
    const people: BitchatPerson[] = [];

    const wifiAwareCount = Math.round(config.nodeCount * config.wifiAwareRatio);

    const spawnNode = (
        id: string,
        x: number,
        y: number,
        index: number,
        mode: MovementMode = MovementMode.STILL
    ): { person: BitchatPerson; sim: BitchatAppSimulator } => {
        const dev = BitchatDevice.createRandom(engine.rng);
        dev.nickname = id;
        dev.powerMode = config.powerMode ?? PowerMode.PERFORMANCE;
        dev.alwaysScan = true;
        dev.wifiAwareEnabled = index < wifiAwareCount;

        const preset = selectNodePreset(config.fleetProfile, index);
        const sim = new BitchatAppSimulator(dev, preset);
        dev.setAppSimulator(sim);

        const person = new BitchatPerson(id, { x, y }, dev);
        person.mode = mode;
        engine.addPerson(person);
        people.push(person);
        sims.push(sim);
        return { person, sim };
    };

    // Topology placement tailored per workload
    if (config.workload === 'partition_healing_gossip') {
        const half = Math.max(2, Math.floor((config.nodeCount - 1) / 2));
        for (let i = 0; i < half; i++) {
            const x = engine.rng.nextRange(0, 35);
            const y = engine.rng.nextRange(0, 35);
            spawnNode(`A-${i}`, x, y, i);
        }
        for (let i = 0; i < config.nodeCount - half - 1; i++) {
            const x = 400 + engine.rng.nextRange(0, 35);
            const y = engine.rng.nextRange(0, 35);
            spawnNode(`B-${i}`, x, y, half + i);
        }
        // Courier starts in Cluster A
        spawnNode('Courier', 18, 18, config.nodeCount - 1);
    } else if (config.workload === 'fragmented_media' || config.workload === 'private_dm_noise') {
        // Structured multi-hop grid so source routes and multi-hop paths form reliably
        const cols = Math.max(2, Math.ceil(Math.sqrt(config.nodeCount)));
        const spacing = 35;
        for (let i = 0; i < config.nodeCount; i++) {
            const row = Math.floor(i / cols);
            const col = i % cols;
            const jitterX = engine.rng.nextRange(-4, 4);
            const jitterY = engine.rng.nextRange(-4, 4);
            spawnNode(`N-${i}`, col * spacing + jitterX, row * spacing + jitterY, i);
        }
    } else {
        // Dense random crowd within areaSizeMeters x areaSizeMeters
        const halfArea = config.areaSizeMeters / 2;
        for (let i = 0; i < config.nodeCount; i++) {
            const x = engine.rng.nextRange(-halfArea, halfArea);
            const y = engine.rng.nextRange(-halfArea, halfArea);
            spawnNode(`U-${i}`, x, y, i);
        }
    }

    // Warmup: allow BLE / Wi-Fi Aware handshakes & topology announces to converge
    engine.runFor(config.warmupMs, 50);

    // Execute workload traffic
    const remainingMs = Math.max(500, config.durationMs);

    if (config.workload === 'public_chat_dense') {
        const messageCount = 12;
        const intervalMs = Math.max(200, Math.floor((remainingMs * 0.7) / messageCount));
        for (let m = 0; m < messageCount; m++) {
            const sender = sims[m % sims.length];
            sender.sendMessage(`public-broadcast-${m}`);
            engine.runFor(intervalMs, 50);
        }
        // Drain tail
        engine.runFor(Math.max(1_000, remainingMs - messageCount * intervalMs), 50);
    } else if (config.workload === 'private_dm_noise') {
        const pairCount = Math.min(8, Math.floor(sims.length / 2));
        for (let p = 0; p < pairCount; p++) {
            const sender = sims[p];
            const receiver = sims[sims.length - 1 - p];
            if (sender !== receiver) {
                sender.sendPrivateMessage(`dm-secret-${p}`, receiver.device.peerIDHex);
            }
            engine.runFor(150, 50);
        }
        engine.runFor(remainingMs, 50);
    } else if (config.workload === 'partition_healing_gossip') {
        // Cluster A emits 4 messages while partitioned from Cluster B
        const senderA = sims[0];
        for (let m = 0; m < 4; m++) {
            senderA.sendMessage(`cluster-A-msg-${m}`);
            engine.runFor(250, 50);
        }
        // Move Courier from Cluster A to Cluster B
        const courier = people[people.length - 1];
        courier.position.x = 418;
        courier.position.y = 18;
        engine.runFor(remainingMs, 50);
    } else if (config.workload === 'fragmented_media') {
        const fileSizeBytes = 2_048;
        const payload = new Uint8Array(fileSizeBytes);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        const transferCount = Math.min(3, Math.floor(sims.length / 2));
        for (let t = 0; t < transferCount; t++) {
            const sender = sims[t];
            const receiver = sims[sims.length - 1 - t];
            sender.sendFile(payload, receiver.device.peerIDHex);
            engine.runFor(500, 50);
        }
        engine.runFor(remainingMs, 50);
    } else if (config.workload === 'voice_ptt_burst') {
        // 15 packets/second (~66 ms cadence), 120 B Opus-like voice frame, 2 s PTT burst
        const voiceFrame = new Uint8Array(120);
        for (let i = 0; i < voiceFrame.length; i++) voiceFrame[i] = (i * 7) & 0xff;
        const speaker = sims[0];
        const totalFrames = 24;
        for (let f = 0; f < totalFrames; f++) {
            speaker.sendVoiceFrame(voiceFrame);
            engine.runFor(67, 50);
        }
        engine.runFor(Math.max(1_000, remainingMs - totalFrames * 67), 50);
    }

    const activeConns = engine.getAllConnections();
    const activeBleLinks = activeConns.filter(c => c.transportType === 'BLE').length;
    const activeWifiAwareLinks = activeConns.filter(c => c.transportType === 'WIFI_AWARE').length;
    const bridgedPackets = sims.reduce((acc, s) => acc + s.transportBridge.bridgedCount, 0);
    const deliveredDmAcks = sims.reduce((acc, s) => acc + s.deliveredMessageIds.size, 0);
    const endWall = typeof performance !== 'undefined' ? performance.now() : Date.now();

    return {
        config,
        snapshot: engine.telemetry.getSnapshot(engine.simTimeMs),
        activeBleLinks,
        activeWifiAwareLinks,
        bridgedPackets,
        deliveredDmAcks,
        wallDurationMs: Math.round(endWall - startWall),
    };
}
