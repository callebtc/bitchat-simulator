import { describe, it, expect } from 'vitest';
import { SimulationEngine } from '../SimulationEngine';
import { BitchatPerson } from '../BitchatPerson';
import { BitchatDevice } from '../BitchatDevice';

describe('SimulationEngine', () => {
    it('should update person positions', () => {
        const engine = new SimulationEngine();
        const device = BitchatDevice.createRandom();
        const person = new BitchatPerson('p1', { x: 0, y: 0 }, device);
        person.setVelocity({ x: 10, y: 0 }); // 10 units/sec along X

        engine.addPerson(person);
        
        // Step 1 second
        engine.step(1.0);
        
        expect(person.position.x).toBe(10);
        expect(person.position.y).toBe(0);
    });

    it('should detect neighbors via SpatialManager', () => {
        const engine = new SimulationEngine();
        
        const p1 = new BitchatPerson('p1', { x: 0, y: 0 }, BitchatDevice.createRandom());
        const p2 = new BitchatPerson('p2', { x: 5, y: 0 }, BitchatDevice.createRandom()); // dist 5
        const p3 = new BitchatPerson('p3', { x: 20, y: 0 }, BitchatDevice.createRandom()); // dist 20

        engine.addPerson(p1);
        engine.addPerson(p2);
        engine.addPerson(p3);

        const neighbors = engine.spatial.getNeighbors(p1, 10); // Radius 10
        
        expect(neighbors).toContain(p2);
        expect(neighbors).not.toContain(p3);
        expect(neighbors.length).toBe(1);
    });
    
    it('should emit events on adding/removing people', () => {
        const engine = new SimulationEngine();
        let addedId = '';
        
        engine.events.on('person_added', (p: any) => {
            addedId = p.id;
        });

        const p1 = new BitchatPerson('p1', { x: 0, y: 0 }, BitchatDevice.createRandom());
        engine.addPerson(p1);
        
        expect(addedId).toBe('p1');
    });
});
