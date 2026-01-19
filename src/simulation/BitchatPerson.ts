import { BitchatDevice } from './BitchatDevice';
import { Point, Vector2 } from './types';
import { LogManager } from './LogManager';
import { EnvironmentManager, PathFinder, PathResult } from './environment';

export enum MovementMode {
    STILL = 'STILL',
    RANDOM_WALK = 'RANDOM_WALK',
    TARGET = 'TARGET'
}

/** Callback for when a path is calculated */
export type PathCalculatedCallback = (path: Point[], target: Point) => void;

export class BitchatPerson {
    id: string;
    position: Point;
    velocity: Vector2;
    device: BitchatDevice;
    logger?: LogManager;
    
    /** Environment reference for collision detection (set by SimulationEngine) */
    environment?: EnvironmentManager;
    
    /** PathFinder reference (set by SimulationEngine) */
    pathFinder?: PathFinder;
    
    // Movement
    mode: MovementMode = MovementMode.STILL;
    target: Point | null = null;
    
    /** Current path waypoints */
    path: Point[] | null = null;
    /** Index of current waypoint being navigated to */
    currentWaypointIndex: number = 0;
    
    /** Callback when path is calculated (for UI animation) */
    onPathCalculated?: PathCalculatedCallback;
    
    // Random Walk Params
    private wanderAngle: number = 0;
    private readonly MAX_SPEED = 20;
    private readonly WANDER_STRENGTH = 0.5; // rad/s change
    /** Distance threshold to consider waypoint reached */
    private readonly WAYPOINT_THRESHOLD = 2;

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
        this.path = null;
        this.currentWaypointIndex = 0;
        
        // Calculate path if we have environment with buildings
        if (this.pathFinder && this.environment && this.environment.getBuildingCount() > 0) {
            const result: PathResult = this.pathFinder.findPath(
                { x: this.position.x, y: this.position.y },
                { x: p.x, y: p.y }
            );
            
            if (result.found && result.waypoints.length > 1) {
                // Convert Point2D to Point (they're compatible)
                this.path = result.waypoints.map(wp => ({ x: wp.x, y: wp.y }));
                // Start from waypoint 1 (waypoint 0 is our current position)
                this.currentWaypointIndex = 1;
                
                // Notify UI for animation
                if (this.onPathCalculated) {
                    this.onPathCalculated(this.path, p);
                }
            }
        }
        
        this.setMode(MovementMode.TARGET);
    }
    
    /**
     * Get remaining path waypoints (for visualization).
     */
    getRemainingPath(): Point[] | null {
        if (!this.path || this.currentWaypointIndex >= this.path.length) {
            return null;
        }
        // Return current position plus remaining waypoints
        return [
            { x: this.position.x, y: this.position.y },
            ...this.path.slice(this.currentWaypointIndex)
        ];
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
        
        // Determine current navigation target (next waypoint or final target)
        let navTarget: Point;
        
        if (this.path && this.currentWaypointIndex < this.path.length) {
            navTarget = this.path[this.currentWaypointIndex];
        } else {
            navTarget = this.target;
        }
        
        const dx = navTarget.x - this.position.x;
        const dy = navTarget.y - this.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Check if we've reached the current waypoint
        if (dist < this.WAYPOINT_THRESHOLD) {
            if (this.path && this.currentWaypointIndex < this.path.length - 1) {
                // Move to next waypoint
                this.currentWaypointIndex++;
                return; // Will navigate to next waypoint on next update
            } else {
                // Check if we've reached final target
                const dxFinal = this.target.x - this.position.x;
                const dyFinal = this.target.y - this.position.y;
                const distFinal = Math.sqrt(dxFinal * dxFinal + dyFinal * dyFinal);
                
                if (distFinal < 1) {
                    // Arrived at final destination
                    this.velocity = { x: 0, y: 0 };
                    this.mode = MovementMode.STILL;
                    this.target = null;
                    this.path = null;
                    this.currentWaypointIndex = 0;
                    return;
                }
            }
        }
        
        // Calculate speed (slow down on arrival)
        const distToFinal = this.target ? 
            Math.sqrt(
                (this.target.x - this.position.x) ** 2 + 
                (this.target.y - this.position.y) ** 2
            ) : dist;
        
        const speed = Math.min(this.MAX_SPEED, distToFinal * 2);
        this.velocity.x = (dx / dist) * speed;
        this.velocity.y = (dy / dist) * speed;
    }

    setVelocity(v: Vector2) {
        this.velocity = v;
        // If manually setting velocity, maybe switch to STILL or custom?
        // For drag, we set velocity to 0.
    }
}
