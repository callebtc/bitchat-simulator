import { BitchatPerson } from './BitchatPerson';

const CELL_SIZE = 100; // Matches CONNECT_RADIUS roughly

export class SpatialManager {
    private persons: Map<string, BitchatPerson> = new Map();
    private grid: Map<string, Set<string>> = new Map();

    addPerson(person: BitchatPerson) {
        this.persons.set(person.id, person);
        this.updatePerson(person);
    }

    removePerson(id: string) {
        const person = this.persons.get(id);
        if (person) {
            const cellKey = this.getCellKey(person.position.x, person.position.y);
            this.removeFromCell(cellKey, id);
            this.persons.delete(id);
        }
    }

    updatePerson(_person: BitchatPerson) {
        // Just always update for now, or track last position to optimize
        // For simplicity in this step, we'll just recalculate cell
        // Ideally we store lastCellKey on person or here to avoid Set operations if not moved
        
        // Brute force update: remove from all cells (slow) or better:
        // We can't easily know old cell without storage.
        // Let's assume this is called every frame? No, SimulationEngine calls updateConnectivity which calls getNeighbors.
        // We need an explicit updateSpatial() method called in loop.
    }
    
    /**
     * Called every frame to update grid positions
     */
    updateAll() {
        this.grid.clear();
        for (const person of this.persons.values()) {
            const key = this.getCellKey(person.position.x, person.position.y);
            if (!this.grid.has(key)) {
                this.grid.set(key, new Set());
            }
            this.grid.get(key)!.add(person.id);
        }
    }

    getNeighbors(person: BitchatPerson, radius: number): BitchatPerson[] {
        const neighbors: BitchatPerson[] = [];
        const rSq = radius * radius;
        
        const cx = Math.floor(person.position.x / CELL_SIZE);
        const cy = Math.floor(person.position.y / CELL_SIZE);
        
        // Check 3x3 grid
        for (let x = cx - 1; x <= cx + 1; x++) {
            for (let y = cy - 1; y <= cy + 1; y++) {
                const key = `${x},${y}`;
                const cell = this.grid.get(key);
                if (!cell) continue;
                
                for (const otherId of cell) {
                    if (otherId === person.id) continue;
                    
                    const other = this.persons.get(otherId);
                    if (!other) continue;

                    const dx = other.position.x - person.position.x;
                    const dy = other.position.y - person.position.y;
                    const distSq = dx*dx + dy*dy;

                    if (distSq <= rSq) {
                        neighbors.push(other);
                    }
                }
            }
        }
        return neighbors;
    }

    getAll(): BitchatPerson[] {
        return Array.from(this.persons.values());
    }
    
    private getCellKey(x: number, y: number): string {
        return `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}`;
    }
    
    private removeFromCell(key: string, id: string) {
        const cell = this.grid.get(key);
        if (cell) {
            cell.delete(id);
            if (cell.size === 0) {
                this.grid.delete(key);
            }
        }
    }
}
