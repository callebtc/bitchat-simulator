import { BitchatDevice } from './BitchatDevice';
import { Point, Vector2 } from './types';

export class BitchatPerson {
    id: string;
    position: Point;
    velocity: Vector2;
    device: BitchatDevice;

    constructor(id: string, position: Point, device: BitchatDevice) {
        this.id = id;
        this.position = position;
        this.velocity = { x: 0, y: 0 };
        this.device = device;
        this.device.position = this.position; // Link position
    }

    update(dt: number) {
        this.position.x += this.velocity.x * dt;
        this.position.y += this.velocity.y * dt;
    }

    setVelocity(v: Vector2) {
        this.velocity = v;
    }
}
