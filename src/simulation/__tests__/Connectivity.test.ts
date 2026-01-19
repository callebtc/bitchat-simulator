import { describe, it, expect } from 'vitest';
import { SimulationEngine } from '../SimulationEngine';
import { BitchatPerson } from '../BitchatPerson';
import { BitchatDevice } from '../BitchatDevice';

describe('SimulationEngine - Connectivity', () => {
    it('should form connections when people are close', () => {
        const engine = new SimulationEngine();
        
        const p1 = new BitchatPerson('p1', { x: 0, y: 0 }, BitchatDevice.createRandom());
        const p2 = new BitchatPerson('p2', { x: 50, y: 0 }, BitchatDevice.createRandom()); // dist 50 < 100
        
        engine.addPerson(p1);
        engine.addPerson(p2);
        
        let formed = false;
        engine.events.on('connection_formed', () => { formed = true; });
        
        engine.step(0.1);
        
        expect(formed).toBe(true);
        // Check internal state via ConnectionManager
        expect(p1.device.connectionManager.getConnectedPeers()).toContain(p2.device);
        expect(p2.device.connectionManager.getConnectedPeers()).toContain(p1.device);
    });

    it('should break connections when people move apart', () => {
        const engine = new SimulationEngine();
        
        const p1 = new BitchatPerson('p1', { x: 0, y: 0 }, BitchatDevice.createRandom());
        const p2 = new BitchatPerson('p2', { x: 50, y: 0 }, BitchatDevice.createRandom()); 
        
        engine.addPerson(p1);
        engine.addPerson(p2);
        
        // Step to form connection
        engine.step(0.1);
        expect(p1.device.connectionManager.getConnectedPeers().length).toBe(1);
        
        // Move p2 far away
        p2.position.x = 200; // dist 200 > 110
        
        let broken = false;
        engine.events.on('connection_broken', () => { broken = true; });
        
        engine.step(0.1);
        
        expect(broken).toBe(true);
        expect(p1.device.connectionManager.getConnectedPeers().length).toBe(0);
    });
});
