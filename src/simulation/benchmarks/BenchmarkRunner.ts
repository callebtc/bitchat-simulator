import { BenchmarkConfig, BenchmarkResult, runScenario } from './Scenarios';

/**
 * Headless deterministic benchmark suite runner and report formatters
 * (Markdown tables and CSV) for comparing Android vs iOS vs Mixed vs Wi-Fi Aware fleets.
 */

export function getDefaultBenchmarkSuite(seed: number = 1337): BenchmarkConfig[] {
    return [
        {
            name: 'Dense Chat (Android BLE)',
            workload: 'public_chat_dense',
            fleetProfile: 'android',
            wifiAwareRatio: 0,
            nodeCount: 24,
            areaSizeMeters: 80,
            durationMs: 6_000,
            warmupMs: 2_500,
            seed,
        },
        {
            name: 'Dense Chat (iOS Flood-Control BLE)',
            workload: 'public_chat_dense',
            fleetProfile: 'ios',
            wifiAwareRatio: 0,
            nodeCount: 24,
            areaSizeMeters: 80,
            durationMs: 6_000,
            warmupMs: 2_500,
            seed,
        },
        {
            name: 'Dense Chat (Mixed 50/50 + Wi-Fi Aware)',
            workload: 'public_chat_dense',
            fleetProfile: 'mixed_50_50',
            wifiAwareRatio: 0.5,
            nodeCount: 24,
            areaSizeMeters: 80,
            durationMs: 6_000,
            warmupMs: 3_000,
            seed,
        },
        {
            name: 'Private DMs (Noise XX + Source Routing)',
            workload: 'private_dm_noise',
            fleetProfile: 'android',
            wifiAwareRatio: 0,
            nodeCount: 9,
            areaSizeMeters: 100,
            durationMs: 4_000,
            warmupMs: 3_500,
            seed,
        },
        {
            name: 'Partition Healing (GCS Gossip Sync)',
            workload: 'partition_healing_gossip',
            fleetProfile: 'android',
            wifiAwareRatio: 0,
            nodeCount: 7,
            areaSizeMeters: 450,
            durationMs: 5_000,
            warmupMs: 2_500,
            seed,
        },
        {
            name: 'Fragmented Media 2KiB (BLE)',
            workload: 'fragmented_media',
            fleetProfile: 'android',
            wifiAwareRatio: 0,
            nodeCount: 6,
            areaSizeMeters: 100,
            durationMs: 4_000,
            warmupMs: 3_500,
            seed,
        },
        {
            name: 'Fragmented Media 2KiB (Wi-Fi Aware)',
            workload: 'fragmented_media',
            fleetProfile: 'android',
            wifiAwareRatio: 1,
            nodeCount: 6,
            areaSizeMeters: 100,
            durationMs: 4_000,
            warmupMs: 3_500,
            seed,
        },
        {
            name: 'Live PTT Voice Burst (15 pkt/s)',
            workload: 'voice_ptt_burst',
            fleetProfile: 'android',
            wifiAwareRatio: 0,
            nodeCount: 16,
            areaSizeMeters: 70,
            durationMs: 3_000,
            warmupMs: 2_500,
            seed,
        },
    ];
}

export function runBenchmarkSuite(
    configs: BenchmarkConfig[] = getDefaultBenchmarkSuite()
): BenchmarkResult[] {
    return configs.map(cfg => runScenario(cfg));
}

function primaryDeliveryRatio(result: BenchmarkResult): number {
    const s = result.snapshot;
    switch (result.config.workload) {
        case 'public_chat_dense':
        case 'partition_healing_gossip':
            return s.deliveryRatio.broadcast;
        case 'private_dm_noise':
            return s.deliveryRatio.dm;
        case 'fragmented_media':
            return s.deliveryRatio.file;
        case 'voice_ptt_burst':
            return s.deliveryRatio.voice;
    }
}

export function formatBenchmarkMarkdown(results: BenchmarkResult[]): string {
    const header =
        '| Scenario | Delivery % | p50 (ms) | p95 (ms) | Pkts Sent | Pkt Amp | Byte Amp | BLE / WiFi Links |';
    const sep = '|---|---:|---:|---:|---:|---:|---:|---:|';
    const rows = results.map(r => {
        const s = r.snapshot;
        const delPct = (primaryDeliveryRatio(r) * 100).toFixed(1);
        const p50 = s.latencyMs.all.p50.toFixed(0);
        const p95 = s.latencyMs.all.p95.toFixed(0);
        return `| ${r.config.name} | ${delPct}% | ${p50} | ${p95} | ${s.packetsSent} | ${s.packetAmplification.toFixed(2)}x | ${s.byteAmplification.toFixed(2)}x | ${r.activeBleLinks} / ${r.activeWifiAwareLinks} |`;
    });
    return [header, sep, ...rows].join('\n');
}

export function exportBenchmarkCsv(results: BenchmarkResult[]): string {
    const headers = [
        'name',
        'workload',
        'fleetProfile',
        'wifiAwareRatio',
        'nodeCount',
        'deliveryRatio',
        'latencyP50Ms',
        'latencyP95Ms',
        'packetsSent',
        'wireBytesSent',
        'goodputBytesDelivered',
        'packetAmplification',
        'byteAmplification',
        'sourceRouteHitRate',
        'activeBleLinks',
        'activeWifiAwareLinks',
        'bridgedPackets',
        'deliveredDmAcks',
    ];
    const lines = [headers.join(',')];
    for (const r of results) {
        const s = r.snapshot;
        lines.push(
            [
                `"${r.config.name}"`,
                r.config.workload,
                r.config.fleetProfile,
                r.config.wifiAwareRatio,
                r.config.nodeCount,
                primaryDeliveryRatio(r).toFixed(4),
                s.latencyMs.all.p50.toFixed(2),
                s.latencyMs.all.p95.toFixed(2),
                s.packetsSent,
                s.wireBytesSent,
                s.goodputBytesDelivered,
                s.packetAmplification.toFixed(4),
                s.byteAmplification.toFixed(4),
                s.sourceRouteHitRate.toFixed(4),
                r.activeBleLinks,
                r.activeWifiAwareLinks,
                r.bridgedPackets,
                r.deliveredDmAcks,
            ].join(',')
        );
    }
    return lines.join('\n');
}
