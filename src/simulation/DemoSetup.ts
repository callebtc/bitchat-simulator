import { SimulationEngine } from './SimulationEngine';
import { BitchatDevice } from './BitchatDevice';
import { BitchatPerson, MovementMode } from './BitchatPerson';
import { BitchatAppSimulator } from './AppLayer/BitchatAppSimulator';

export function setupDemo(engine: SimulationEngine, count: number = 5) {
    engine.reset();
    
    for(let i=0; i<count; i++) {
        const d = BitchatDevice.createRandom();
        d.nickname = `User-${d.peerIDHex.substring(0,4)}`;
        
        // Attach Simulator
        const sim = new BitchatAppSimulator(d);
        d.setAppSimulator(sim);
        
        const p = new BitchatPerson(`p-${Date.now()}-${i}`, {
            x: (Math.random() - 0.5) * 200, 
            y: (Math.random() - 0.5) * 200
        }, d);
        
        engine.addPerson(p);
    }
}

export interface AddNodeOptions {
    center?: { x: number, y: number };
    initialMode?: MovementMode;
}

export function addRandomNode(engine: SimulationEngine, options?: AddNodeOptions) {
    const d = BitchatDevice.createRandom();
    d.nickname = `User-${d.peerIDHex.substring(0,4)}`;
    const sim = new BitchatAppSimulator(d);
    d.setAppSimulator(sim);
    
    const cx = options?.center?.x ?? 0;
    const cy = options?.center?.y ?? 0;
    
    const p = new BitchatPerson(`p-${Date.now()}`, {
        x: cx + (Math.random() - 0.5) * 100, 
        y: cy + (Math.random() - 0.5) * 100
    }, d);
    
    engine.addPerson(p);
    
    // Set initial movement mode if specified
    if (options?.initialMode) {
        p.setMode(options.initialMode);
    }
}
