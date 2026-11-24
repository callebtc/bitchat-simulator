import { BitchatPerson } from './BitchatPerson';

const CELL_SIZE = 50; // Finer 50 m cell cuts candidate checks 4x in dense crowds
const GRID_OFFSET = 32768;
const GRID_STRIDE = 65536;

function packCell(gx: number, gy: number): number {
    return (gx + GRID_OFFSET) * GRID_STRIDE + (gy + GRID_OFFSET);
}

/**
 * Zero-string-allocation 2D spatial hash grid for scaling neighbor discovery
 * to thousands of concurrent nodes.
 */
export class SpatialManager {
    private persons: Map<string, BitchatPerson> = new Map();
    private peopleList: BitchatPerson[] = [];
    private personIndex: Map<string, number> = new Map();
    private personCells: Map<string, number> = new Map();
    private grid: Map<number, BitchatPerson[]> = new Map();

    addPerson(person: BitchatPerson): void {
        if (this.persons.has(person.id)) return;
        this.persons.set(person.id, person);
        this.personIndex.set(person.id, this.peopleList.length);
        this.peopleList.push(person);
        this.updatePerson(person);
    }

    removePerson(id: string): void {
        const person = this.persons.get(id);
        if (!person) return;

        const oldCell = this.personCells.get(id);
        if (oldCell !== undefined) {
            this.removeFromCell(oldCell, person);
            this.personCells.delete(id);
        }

        // O(1) swap-pop from dense peopleList
        const idx = this.personIndex.get(id);
        if (idx !== undefined) {
            const last = this.peopleList[this.peopleList.length - 1];
            this.peopleList[idx] = last;
            this.personIndex.set(last.id, idx);
            this.peopleList.pop();
            this.personIndex.delete(id);
        }

        this.persons.delete(id);
    }

    updatePerson(person: BitchatPerson): void {
        const newKey = packCell(
            Math.floor(person.position.x / CELL_SIZE),
            Math.floor(person.position.y / CELL_SIZE)
        );
        const oldKey = this.personCells.get(person.id);
        if (oldKey === newKey) return;

        if (oldKey !== undefined) {
            this.removeFromCell(oldKey, person);
        }
        let cell = this.grid.get(newKey);
        if (!cell) {
            cell = [];
            this.grid.set(newKey, cell);
        }
        cell.push(person);
        this.personCells.set(person.id, newKey);
    }

    updateAll(): void {
        const list = this.peopleList;
        for (let i = 0; i < list.length; i++) {
            this.updatePerson(list[i]);
        }
    }

    getNeighbors(person: BitchatPerson, radius: number, maxResults?: number): BitchatPerson[] {
        return this.getNeighborsAt(person.position.x, person.position.y, radius, person.id, maxResults);
    }

    getNeighborsAt(
        x: number,
        y: number,
        radius: number,
        excludePersonId?: string,
        maxResults?: number
    ): BitchatPerson[] {
        const neighbors: BitchatPerson[] = [];
        const rSq = radius * radius;
        const cellRange = Math.max(1, Math.ceil(radius / CELL_SIZE));

        const cx = Math.floor(x / CELL_SIZE);
        const cy = Math.floor(y / CELL_SIZE);

        for (let gx = cx - cellRange; gx <= cx + cellRange; gx++) {
            for (let gy = cy - cellRange; gy <= cy + cellRange; gy++) {
                const cell = this.grid.get(packCell(gx, gy));
                if (!cell) continue;

                for (let i = 0; i < cell.length; i++) {
                    const other = cell[i];
                    if (other.id === excludePersonId) continue;

                    const dx = other.position.x - x;
                    const dy = other.position.y - y;
                    if (dx * dx + dy * dy <= rSq) {
                        neighbors.push(other);
                        if (maxResults !== undefined && neighbors.length >= maxResults) {
                            return neighbors;
                        }
                    }
                }
            }
        }
        return neighbors;
    }

    getAll(): BitchatPerson[] {
        return this.peopleList;
    }

    private removeFromCell(key: number, person: BitchatPerson): void {
        const cell = this.grid.get(key);
        if (!cell) return;
        const idx = cell.indexOf(person);
        if (idx !== -1) {
            const last = cell.length - 1;
            if (idx !== last) {
                cell[idx] = cell[last];
            }
            cell.pop();
            if (cell.length === 0) {
                this.grid.delete(key);
            }
        }
    }
}
