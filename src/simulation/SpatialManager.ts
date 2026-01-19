import { BitchatPerson } from './BitchatPerson';

export class SpatialManager {
    private persons: BitchatPerson[] = [];

    addPerson(person: BitchatPerson) {
        this.persons.push(person);
    }

    removePerson(id: string) {
        this.persons = this.persons.filter(p => p.id !== id);
    }

    getNeighbors(person: BitchatPerson, radius: number): BitchatPerson[] {
        const neighbors: BitchatPerson[] = [];
        const rSq = radius * radius;

        for (const other of this.persons) {
            if (other === person) continue;

            const dx = other.position.x - person.position.x;
            const dy = other.position.y - person.position.y;
            const distSq = dx*dx + dy*dy;

            if (distSq <= rSq) {
                neighbors.push(other);
            }
        }
        return neighbors;
    }

    getAll(): BitchatPerson[] {
        return this.persons;
    }
}
