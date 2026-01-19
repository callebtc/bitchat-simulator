import { BitchatDevice } from './BitchatDevice';
import { Point, Vector2 } from './types';
import { LogManager } from './LogManager';
import { EnvironmentManager } from './environment';

export enum MovementMode {
    STILL = 'STILL',
    RANDOM_WALK = 'RANDOM_WALK',
    TARGET = 'TARGET'
}

export class BitchatPerson {
    id: string;
    position: Point;
    velocity: Vector2;
    device: BitchatDevice;
    logger?: LogManager;
    
    /** Environment reference for collision detection (set by SimulationEngine) */
    environment?: EnvironmentManager;
    
    // Movement
    mode: MovementMode = MovementMode.STILL;
    target: Point | null = null;
    
    // Random Walk Params
    private wanderAngle: number = 0;
    private readonly MAX_SPEED = 20;
    private readonly WANDER_STRENGTH = 0.5; // rad/s change

    constructor(id: string, position: Point, device: BitchatDevice) {
        this.id = id;
        this.position = position;
        this.velocity = { x: 0, y: 0 };
        this.device = device;
        this.device.position = this.position; // Link position
    }

    setLogger(logger: LogManager) {
        this.logger = logger;
        this.device.setLogger(logger);
    }
    
    setMode(mode: MovementMode) {
        this.mode = mode;
        if (mode === MovementMode.STILL) {
            this.velocity = {x: 0, y: 0};
        }
        if (mode === MovementMode.RANDOM_WALK) {
            // Kickstart
             this.velocity = { 
                 x: (Math.random() - 0.5) * this.MAX_SPEED, 
                 y: (Math.random() - 0.5) * this.MAX_SPEED 
             };
        }
    }
    
    setTarget(p: Point) {
        this.target = p;
        this.setMode(MovementMode.TARGET);
    }

    update(dt: number) {
        if (this.mode === MovementMode.STILL) {
            this.velocity = {x:0, y:0};
        }
        else if (this.mode === MovementMode.RANDOM_WALK) {
            this.updateRandomWalk(dt);
        } 
        else if (this.mode === MovementMode.TARGET && this.target) {
            this.updateTargetSeek(dt);
        }

        // Calculate proposed new position
        const newX = this.position.x + this.velocity.x * dt;
        const newY = this.position.y + this.velocity.y * dt;

        // Apply collision detection if environment exists and has buildings
        if (this.environment && this.environment.getBuildingCount() > 0) {
            const from = { x: this.position.x, y: this.position.y };
            const to = { x: newX, y: newY };
            
            const result = this.environment.resolveMovement(from, to);
            
            this.position.x = result.position.x;
            this.position.y = result.position.y;
            
            // If blocked while seeking target, adjust wander angle for random walk
            if (result.blocked && this.mode === MovementMode.RANDOM_WALK) {
                // Turn away from wall
                this.wanderAngle += Math.PI * 0.5 + Math.random() * Math.PI;
            }
        } else {
            // No collision detection, move freely
            this.position.x = newX;
            this.position.y = newY;
        }
    }
    
    private updateRandomWalk(_dt: number) {
        // Simple wander: Perturb velocity vector
        // Or steer angle
        this.wanderAngle += (Math.random() - 0.5) * this.WANDER_STRENGTH;
        
        // Desired velocity
        const speed = this.MAX_SPEED * 0.5; // Half speed for wandering
        const vx = Math.cos(this.wanderAngle) * speed;
        const vy = Math.sin(this.wanderAngle) * speed;
        
        // Lerp towards desired
        const lerpFactor = 0.1;
        this.velocity.x += (vx - this.velocity.x) * lerpFactor;
        this.velocity.y += (vy - this.velocity.y) * lerpFactor;
        
        // Bounds check (soft bounce)
        if (this.position.x > 500 && this.velocity.x > 0) this.velocity.x *= -1;
        if (this.position.x < -500 && this.velocity.x < 0) this.velocity.x *= -1;
        if (this.position.y > 500 && this.velocity.y > 0) this.velocity.y *= -1;
        if (this.position.y < -500 && this.velocity.y < 0) this.velocity.y *= -1;
    }
    
    private updateTargetSeek(_dt: number) {
        if (!this.target) return;
        
        const dx = this.target.x - this.position.x;
        const dy = this.target.y - this.position.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        
        if (dist < 1) {
            // Arrived
            this.velocity = {x: 0, y: 0};
            this.mode = MovementMode.STILL;
            this.target = null;
            return;
        }
        
        const speed = Math.min(this.MAX_SPEED, dist * 2); // Slow down arrival
        this.velocity.x = (dx / dist) * speed;
        this.velocity.y = (dy / dist) * speed;
    }

    setVelocity(v: Vector2) {
        this.velocity = v;
        // If manually setting velocity, maybe switch to STILL or custom?
        // For drag, we set velocity to 0.
    }
}
