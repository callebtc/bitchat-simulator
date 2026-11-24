import { SimulationEngine } from './SimulationEngine';
import { BitchatDevice } from './BitchatDevice';
import { BitchatPerson, MovementMode } from './BitchatPerson';
import { BitchatAppSimulator } from './AppLayer/BitchatAppSimulator';
import { MeshPolicyPreset } from './AppLayer/MeshPolicy';

let nextSpawnSeq = 1;

export interface AddNodeOptions {
    center?: { x: number; y: number };
    spread?: number;
    preferOutdoors?: boolean;
    initialMode?: MovementMode;
    policyPreset?: MeshPolicyPreset;
    wifiAwareEnabled?: boolean;
}

export function setupDemo(
    engine: SimulationEngine,
    count: number = 5,
    options?: Pick<AddNodeOptions, 'policyPreset' | 'wifiAwareEnabled' | 'initialMode'>
): void {
    engine.reset();
    nextSpawnSeq = 1;

    for (let i = 0; i < count; i++) {
        const d = BitchatDevice.createRandom(engine.rng);
        d.nickname = `User-${d.peerIDHex.substring(0, 4)}`;
        d.wifiAwareEnabled = options?.wifiAwareEnabled ?? false;

        const sim = new BitchatAppSimulator(d, options?.policyPreset ?? 'android');
        d.setAppSimulator(sim);

        const p = new BitchatPerson(
            `p-${i}`,
            {
                x: (engine.rng.next() - 0.5) * 200,
                y: (engine.rng.next() - 0.5) * 200,
            },
            d,
            engine.rng.fork(`person:p-${i}`)
        );

        engine.addPerson(p);
        if (options?.initialMode) p.setMode(options.initialMode);
    }
}

export function addRandomNode(engine: SimulationEngine, options?: AddNodeOptions): BitchatPerson {
    const d = BitchatDevice.createRandom(engine.rng);
    d.nickname = `User-${d.peerIDHex.substring(0, 4)}`;
    d.wifiAwareEnabled = options?.wifiAwareEnabled ?? false;
    const sim = new BitchatAppSimulator(d, options?.policyPreset ?? 'android');
    d.setAppSimulator(sim);

    const cx = options?.center?.x ?? 0;
    const cy = options?.center?.y ?? 0;
    const envBounds = engine.environment.getBounds();
    const spread = options?.spread ?? (envBounds ? 280 : 100);

    let x = cx + (engine.rng.next() - 0.5) * spread;
    let y = cy + (engine.rng.next() - 0.5) * spread;

    // When spawning into a city map, prefer outdoor street plazas if possible
    if (options?.preferOutdoors && engine.environment.getBuildingCount() > 0) {
        const lb = envBounds?.localBounds;
        for (let attempt = 0; attempt < 15; attempt++) {
            const tx = lb
                ? lb.minX + engine.rng.next() * (lb.maxX - lb.minX)
                : cx + (engine.rng.next() - 0.5) * spread;
            const ty = lb
                ? lb.minY + engine.rng.next() * (lb.maxY - lb.minY)
                : cy + (engine.rng.next() - 0.5) * spread;
            if (!engine.environment.isInsideBuilding({ x: tx, y: ty })) {
                x = tx;
                y = ty;
                break;
            }
        }
    }

    const id = `p-${Math.floor(engine.simTimeMs)}-${nextSpawnSeq++}`;
    const p = new BitchatPerson(
        id,
        { x, y },
        d,
        engine.rng.fork(`person:${id}`)
    );

    engine.addPerson(p);

    if (options?.initialMode) {
        p.setMode(options.initialMode);
    }
    return p;
}
