import { SimulationEngine } from './SimulationEngine';
import { BitchatDevice } from './BitchatDevice';
import { BitchatPerson } from './BitchatPerson';
import { BitchatAppSimulator } from './AppLayer/BitchatAppSimulator';

export function setupDemo(engine: SimulationEngine, count: number = 5) {
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
        
        p.setVelocity({
            x: (Math.random() - 0.5) * 10,
            y: (Math.random() - 0.5) * 10
        });
        
        engine.addPerson(p);
    }
}

export function addRandomNode(engine: SimulationEngine) {
    const d = BitchatDevice.createRandom();
    d.nickname = `User-${d.peerIDHex.substring(0,4)}`;
    const sim = new BitchatAppSimulator(d);
    d.setAppSimulator(sim);
    
    const p = new BitchatPerson(`p-${Date.now()}`, {
        x: (Math.random() - 0.5) * 100, 
        y: (Math.random() - 0.5) * 100
    }, d);
     p.setVelocity({
        x: (Math.random() - 0.5) * 10,
        y: (Math.random() - 0.5) * 10
    });
    
    engine.addPerson(p);
}
