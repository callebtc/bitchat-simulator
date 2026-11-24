import { BitchatPerson } from './BitchatPerson';

const CELL_SIZE = 100; // Matches typical BLE radio discovery cell

export class SpatialManager {
    private persons: Map<string, BitchatPerson> = new Map();
    private personCells: Map<string, string> = new Map();
    private grid: Map<string, Set<string>> = new Map();

    addPerson(person: BitchatPerson): void {
        this.persons.set(person.id, person);
        this.updatePerson(person);
    }

    removePerson(id: string): void {
        const oldCell = this.personCells.get(id);
        if (oldCell) {
            this.removeFromCell(oldCell, id);
            this.personCells.delete(id);
        }
        this.persons.delete(id);
    }

    updatePerson(person: BitchatPerson): void {
        const newKey = this.getCellKey(person.position.x, person.position.y);
        const oldKey = this.personCells.get(person.id);
        if (oldKey === newKey) return;

        if (oldKey) {
            this.removeFromCell(oldKey, person.id);
        }
        let cell = this.grid.get(newKey);
        if (!cell) {
            cell = new Set();
            this.grid.set(newKey, cell);
        }
        cell.add(person.id);
        this.personCells.set(person.id, newKey);
    }

    /**
     * Update grid positions for all persons.
     */
    updateAll(): void {
        for (const person of this.persons.values()) {
            this.updatePerson(person);
        }
    }

    getNeighbors(person: BitchatPerson, radius: number): BitchatPerson[] {
        return this.getNeighborsAt(person.position.x, person.position.y, radius, person.id);
    }

    getNeighborsAt(
        x: number,
        y: number,
        radius: number,
        excludePersonId?: string
    ): BitchatPerson[] {
        const neighbors: BitchatPerson[] = [];
        const rSq = radius * radius;
        const cellRange = Math.max(1, Math.ceil(radius / CELL_SIZE));

        const cx = Math.floor(x / CELL_SIZE);
        const cy = Math.floor(y / CELL_SIZE);

        for (let gx = cx - cellRange; gx <= cx + cellRange; gx++) {
            for (let gy = cy - cellRange; gy <= cy + cellRange; gy++) {
                const cell = this.grid.get(`${gx},${gy}`);
                if (!cell) continue;

                for (const otherId of cell) {
                    if (otherId === excludePersonId) continue;

                    const other = this.persons.get(otherId);
                    if (!other) continue;

                    const dx = other.position.x - x;
                    const dy = other.position.y - y;
                    const distSq = dx * dx + dy * dy;

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

    private removeFromCell(key: string, id: string): void {
        const cell = this.grid.get(key);
        if (cell) {
            cell.delete(id);
            if (cell.size === 0) {
                this.grid.delete(key);
            }
        }
    }
}
