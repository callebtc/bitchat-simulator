import { SimulationEngine } from './SimulationEngine';
import { BitchatDevice } from './BitchatDevice';
import { BitchatPerson, MovementMode } from './BitchatPerson';
import { BitchatAppSimulator } from './AppLayer/BitchatAppSimulator';

let nextSpawnSeq = 1;

export function setupDemo(engine: SimulationEngine, count: number = 5): void {
    engine.reset();
    nextSpawnSeq = 1;

    for (let i = 0; i < count; i++) {
        const d = BitchatDevice.createRandom(engine.rng);
        d.nickname = `User-${d.peerIDHex.substring(0, 4)}`;

        const sim = new BitchatAppSimulator(d);
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
    }
}

export interface AddNodeOptions {
    center?: { x: number; y: number };
    initialMode?: MovementMode;
}

export function addRandomNode(engine: SimulationEngine, options?: AddNodeOptions): BitchatPerson {
    const d = BitchatDevice.createRandom(engine.rng);
    d.nickname = `User-${d.peerIDHex.substring(0, 4)}`;
    const sim = new BitchatAppSimulator(d);
    d.setAppSimulator(sim);

    const cx = options?.center?.x ?? 0;
    const cy = options?.center?.y ?? 0;

    const id = `p-${Math.floor(engine.simTimeMs)}-${nextSpawnSeq++}`;
    const p = new BitchatPerson(
        id,
        {
            x: cx + (engine.rng.next() - 0.5) * 100,
            y: cy + (engine.rng.next() - 0.5) * 100,
        },
        d,
        engine.rng.fork(`person:${id}`)
    );

    engine.addPerson(p);

    if (options?.initialMode) {
        p.setMode(options.initialMode);
    }
    return p;
}
