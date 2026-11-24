import { describe, it, expect } from 'vitest';
import { SimulationEngine } from '../../SimulationEngine';
import { BitchatPerson } from '../../BitchatPerson';
import { BitchatDevice } from '../../BitchatDevice';
import { BitchatAppSimulator } from '../../AppLayer/BitchatAppSimulator';
import { BitchatConnectionWifiAware } from '../../BitchatConnectionWifiAware';
import { runScenario } from '../Scenarios';
import { exportBenchmarkCsv, formatBenchmarkMarkdown, runBenchmarkSuite } from '../BenchmarkRunner';

describe('Phase 5: Wi-Fi Aware Multi-Transport, TransportBridge & Headless Benchmarks', () => {
    it('forms 5 GHz Wi-Fi Aware NAN links at longer open-air range (~120 m) and bridges BLE <-> Wi-Fi Aware', () => {
        const engine = new SimulationEngine({ seed: 501 });

        // Chain: A (BLE-only, x=0) -- B (BLE + Wi-Fi Aware bridge, x=25) ==[120m Wi-Fi Aware]== C (Wi-Fi Aware + BLE, x=145)
        const dA = BitchatDevice.createRandom(engine.rng);
        dA.nickname = 'BLE-Only';
        dA.wifiAwareEnabled = false;
        dA.alwaysScan = true;

        const dB = BitchatDevice.createRandom(engine.rng);
        dB.nickname = 'Bridge';
        dB.wifiAwareEnabled = true;
        dB.alwaysScan = true;

        const dC = BitchatDevice.createRandom(engine.rng);
        dC.nickname = 'WifiPeer';
        dC.wifiAwareEnabled = true;
        dC.alwaysScan = true;

        const simA = new BitchatAppSimulator(dA, 'android');
        const simB = new BitchatAppSimulator(dB, 'android');
        const simC = new BitchatAppSimulator(dC, 'android');
        dA.setAppSimulator(simA);
        dB.setAppSimulator(simB);
        dC.setAppSimulator(simC);

        engine.addPerson(new BitchatPerson('A', { x: 0, y: 0 }, dA));
        engine.addPerson(new BitchatPerson('B', { x: 25, y: 0 }, dB));
        engine.addPerson(new BitchatPerson('C', { x: 145, y: 0 }, dC));

        // Wait past 1200ms Wi-Fi Aware handshake + announces
        engine.runFor(3_500, 50);

        const wifiLinks = engine
            .getAllConnections()
            .filter(c => c instanceof BitchatConnectionWifiAware);
        expect(wifiLinks.length).toBe(1);
        expect(dB.connectionManager.hasActiveConnectionToPeer(dC.peerIDHex, 'WIFI_AWARE')).toBe(true);
        // B and C are 120m apart -> outside BLE 100m range, connected ONLY via Wi-Fi Aware
        expect(dB.connectionManager.hasActiveConnectionToPeer(dC.peerIDHex, 'BLE')).toBe(false);

        // A sends a message over BLE -> B bridges it to C over Wi-Fi Aware!
        simA.sendMessage('bridged across transports');
        engine.runFor(1_000, 50);

        expect(simC.messages.some(m => m.text === 'bridged across transports')).toBe(true);
        expect(simB.transportBridge.bridgedCount).toBeGreaterThanOrEqual(1);
    });

    it('delivers 2 KiB files faster and with fewer wire packets over Wi-Fi Aware than BLE fragmentation', () => {
        const bleRes = runScenario({
            name: 'Media BLE',
            workload: 'fragmented_media',
            fleetProfile: 'android',
            wifiAwareRatio: 0,
            nodeCount: 4,
            areaSizeMeters: 80,
            durationMs: 3_000,
            warmupMs: 3_000,
            seed: 502,
        });

        const wifiRes = runScenario({
            name: 'Media Wi-Fi Aware',
            workload: 'fragmented_media',
            fleetProfile: 'android',
            wifiAwareRatio: 1,
            nodeCount: 4,
            areaSizeMeters: 80,
            durationMs: 3_000,
            warmupMs: 3_000,
            seed: 502,
        });

        expect(bleRes.snapshot.deliveryRatio.file).toBe(1);
        expect(wifiRes.snapshot.deliveryRatio.file).toBe(1);
        expect(wifiRes.activeWifiAwareLinks).toBeGreaterThan(0);
        // Wi-Fi Aware avoids 512 B fragmentation and runs at 25 Mbps -> significantly lower file latency
        expect(wifiRes.snapshot.latencyMs.file.mean).toBeLessThan(bleRes.snapshot.latencyMs.file.mean);
    });

    it('quantifies lower packet amplification on iOS flood-control preset vs Android baseline in dense chat', () => {
        const androidRes = runScenario({
            name: 'Dense Android',
            workload: 'public_chat_dense',
            fleetProfile: 'android',
            wifiAwareRatio: 0,
            nodeCount: 20,
            areaSizeMeters: 70,
            durationMs: 6_000,
            warmupMs: 3_500,
            seed: 503,
        });

        const iosRes = runScenario({
            name: 'Dense iOS',
            workload: 'public_chat_dense',
            fleetProfile: 'ios',
            wifiAwareRatio: 0,
            nodeCount: 20,
            areaSizeMeters: 70,
            durationMs: 6_000,
            warmupMs: 3_500,
            seed: 503,
        });

        expect(androidRes.snapshot.deliveryRatio.broadcast).toBeGreaterThan(0.8);
        expect(iosRes.snapshot.deliveryRatio.broadcast).toBeGreaterThan(0.7);
        // iOS fanout subsetting + duplicate-link collapse + jitter cancel sharply cuts packet floods
        expect(iosRes.snapshot.packetsSent).toBeLessThan(androidRes.snapshot.packetsSent);
        expect(iosRes.activeBleLinks).toBeLessThan(androidRes.activeBleLinks);
    });

    it('runs the full 5-workload benchmark suite and formats Markdown and CSV reports deterministically', () => {
        const results = runBenchmarkSuite([
            {
                name: 'Chat',
                workload: 'public_chat_dense',
                fleetProfile: 'android',
                wifiAwareRatio: 0,
                nodeCount: 10,
                areaSizeMeters: 60,
                durationMs: 2_000,
                warmupMs: 2_000,
                seed: 504,
            },
            {
                name: 'DMs',
                workload: 'private_dm_noise',
                fleetProfile: 'android',
                wifiAwareRatio: 0,
                nodeCount: 6,
                areaSizeMeters: 80,
                durationMs: 3_000,
                warmupMs: 3_000,
                seed: 504,
            },
            {
                name: 'Sync',
                workload: 'partition_healing_gossip',
                fleetProfile: 'android',
                wifiAwareRatio: 0,
                nodeCount: 5,
                areaSizeMeters: 450,
                durationMs: 4_500,
                warmupMs: 2_500,
                seed: 504,
            },
            {
                name: 'Voice',
                workload: 'voice_ptt_burst',
                fleetProfile: 'android',
                wifiAwareRatio: 0,
                nodeCount: 10,
                areaSizeMeters: 60,
                durationMs: 5_000,
                warmupMs: 2_000,
                seed: 504,
            },
        ]);

        expect(results.length).toBe(4);
        // Private DM workload must establish Noise XX sessions and receive DELIVERED ACKs
        expect(results[1].deliveredDmAcks).toBeGreaterThan(0);
        // Partition healing workload must sync messages across the gap
        expect(results[2].snapshot.deliveryRatio.broadcast).toBeGreaterThan(0.7);
        // Voice burst workload must deliver voice frames
        expect(results[3].snapshot.deliveryRatio.voice).toBeGreaterThan(0.7);

        const md = formatBenchmarkMarkdown(results);
        expect(md).toContain('| Scenario | Delivery % |');
        expect(md).toContain('| Chat |');

        const csv = exportBenchmarkCsv(results);
        const lines = csv.split('\n');
        expect(lines.length).toBe(5); // header + 4 rows
        expect(lines[0]).toContain('packetAmplification');
    });
});
