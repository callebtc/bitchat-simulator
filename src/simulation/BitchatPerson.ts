import { BitchatDevice } from './BitchatDevice';
import { Point, Vector2 } from './types';
import { LogManager } from './LogManager';
import { EnvironmentManager, PathFinder, PathResult } from './environment';

export enum MovementMode {
    STILL = 'STILL',
    RANDOM_WALK = 'RANDOM_WALK',
    TARGET = 'TARGET',
    BUSY = 'BUSY',
    MANUAL = 'MANUAL'
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
    private maxSpeed: number; // Randomized per person
    private readonly WANDER_STRENGTH = 0.5; // rad/s change
    /** Distance threshold to consider waypoint reached */
    private readonly WAYPOINT_THRESHOLD = 2;
    
    // Stuck detection & recovery
    private stuckTimer: number = 0;
    private recoveryDuration: number = 1;  // starts at 1s, doubles each attempt
    private isRecovering: boolean = false;
    private savedTarget: Point | null = null;
    private unstuckTimer: number = 0;
    
    private readonly STUCK_SPEED_THRESHOLD = 0.5;
    private readonly STUCK_TIME_THRESHOLD = 0.5;  // 0.5s to detect stuck
    private readonly UNSTUCK_TIME_THRESHOLD = 1;  // 1s of movement to confirm unstuck
    private readonly MAX_RECOVERY_DURATION = 10;  // max 10s random walk
    
    // Busy mode state
    /** ID of the building the agent started busy mode in (null if outdoors) */
    private busyBuildingId: string | null = null;
    /** Stuck detection timer for busy mode */
    private busyStuckTimer: number = 0;
    private readonly BUSY_STUCK_TIME_THRESHOLD = 1.5;  // 1.5s stuck = pick new target
    /** Last recorded position for stuck detection */
    private busyLastPosition: Point = { x: 0, y: 0 };
    /** Minimum distance to travel to not be considered stuck */
    private readonly BUSY_MIN_PROGRESS = 1.0;  // Must move at least 1 meter

    constructor(id: string, position: Point, device: BitchatDevice) {
        this.id = id;
        this.position = position;
        this.velocity = { x: 0, y: 0 };
        this.device = device;
        this.device.position = this.position; // Link position
        
        // Randomize max speed between 1.0 and 3.0 m/s (average 2.0)
        // Previous static default was 1.5
        this.maxSpeed = 1.0 + Math.random() * 2.0; 
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
                 x: (Math.random() - 0.5) * this.maxSpeed, 
                 y: (Math.random() - 0.5) * this.maxSpeed 
             };
        }
        if (mode === MovementMode.BUSY) {
            this.initBusyMode();
        }
    }
    
    /**
     * Initialize busy mode - determine if indoors/outdoors and pick first target.
     */
    private initBusyMode(): void {
        this.busyStuckTimer = 0;
        this.busyLastPosition = { x: this.position.x, y: this.position.y };
        
        // Determine if we're inside or outside a building
        if (this.environment) {
            const building = this.environment.isInsideBuilding({ 
                x: this.position.x, 
                y: this.position.y 
            });
            this.busyBuildingId = building ? building.id : null;
        } else {
            this.busyBuildingId = null;
        }
        
        // Pick first random target
        this.pickBusyTarget();
    }
    
    /**
     * Pick a new random target for busy mode.
     * Respects the indoor/outdoor constraint.
     */
    private pickBusyTarget(): void {
        const newTarget = this.generateRandomBusyTarget();
        if (newTarget) {
            // Use setTarget to calculate path
            this.target = newTarget;
            this.path = null;
            this.currentWaypointIndex = 0;
            
            // Calculate path if we have environment with buildings
            if (this.pathFinder && this.environment && this.environment.getBuildingCount() > 0) {
                const result: PathResult = this.pathFinder.findPath(
                    { x: this.position.x, y: this.position.y },
                    { x: newTarget.x, y: newTarget.y }
                );
                
                if (result.found && result.waypoints.length > 1) {
                    this.path = result.waypoints.map(wp => ({ x: wp.x, y: wp.y }));
                    this.currentWaypointIndex = 1;
                    
                    if (this.onPathCalculated) {
                        this.onPathCalculated(this.path, newTarget);
                    }
                }
            }
            
            // Reset stuck detection
            this.busyStuckTimer = 0;
            this.busyLastPosition = { x: this.position.x, y: this.position.y };
        }
    }
    
    /**
     * Generate a random valid target for busy mode.
     * If indoors, target must be inside the SAME building.
     * If outdoors, target must be outside all buildings.
     */
    private generateRandomBusyTarget(): Point | null {
        if (!this.environment) {
            // No environment, use default bounds
            return {
                x: (Math.random() - 0.5) * 800,
                y: (Math.random() - 0.5) * 800
            };
        }

        const maxAttempts = 50;

        // CASE 1: Indoors - limit search to the specific building bounds
        if (this.busyBuildingId) {
            const building = this.environment.getBuildings().find(b => b.id === this.busyBuildingId);
            if (!building) {
                // Building disappeared? Fallback to outdoors
                this.busyBuildingId = null;
                return this.generateRandomBusyTarget();
            }

            const { minX, maxX, minY, maxY } = building.bounds;
            
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                // Generate random point within building bounds
                const x = minX + Math.random() * (maxX - minX);
                const y = minY + Math.random() * (maxY - minY);
                const candidate = { x, y };

                // Verify it's actually inside this specific building
                // (Bounding box includes empty corners)
                const containerBuilding = this.environment.isInsideBuilding(candidate);
                if (containerBuilding && containerBuilding.id === this.busyBuildingId) {
                    return candidate;
                }
            }
            
            // If failed to find point in building, stay where we are (safest)
            return { x: this.position.x, y: this.position.y };
        }

        // CASE 2: Outdoors - search global bounds but exclude buildings
        const bounds = this.environment.getBounds();
        
        // If no bounds (no map loaded), use default area
        const minX = bounds ? bounds.localBounds.minX : -400;
        const maxX = bounds ? bounds.localBounds.maxX : 400;
        const minY = bounds ? bounds.localBounds.minY : -400;
        const maxY = bounds ? bounds.localBounds.maxY : 400;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const x = minX + Math.random() * (maxX - minX);
            const y = minY + Math.random() * (maxY - minY);
            const candidate = { x, y };
            
            // Check if it's outside ALL buildings
            const insideBuilding = this.environment.isInsideBuilding(candidate);
            if (!insideBuilding) {
                return candidate;
            }
        }
        
        // Couldn't find valid target, just return a point outside buildings nearby
        return {
            x: this.position.x + (Math.random() - 0.5) * 100,
            y: this.position.y + (Math.random() - 0.5) * 100
        };
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
        // Handle stuck recovery mode
        if (this.isRecovering) {
            this.updateRecovery(dt);
            return;
        }
        
        if (this.mode === MovementMode.STILL) {
            this.velocity = {x:0, y:0};
        }
        else if (this.mode === MovementMode.RANDOM_WALK) {
            this.updateRandomWalk(dt);
        } 
        else if (this.mode === MovementMode.TARGET && this.target) {
            this.updateTargetSeek(dt);
            
            // Check for stuck condition
            const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
            if (speed < this.STUCK_SPEED_THRESHOLD) {
                this.stuckTimer += dt;
                if (this.stuckTimer > this.STUCK_TIME_THRESHOLD) {
                    // Start recovery: switch to random walk
                    this.startStuckRecovery();
                    return;
                }
            } else {
                this.stuckTimer = 0;
            }
        }
        else if (this.mode === MovementMode.BUSY) {
            this.updateBusyNavigation(dt);
            
            // Check for stuck condition - pick new target if stuck
            this.checkBusyStuck(dt);
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
    
    /**
     * Start stuck recovery mode: save target and switch to random walk.
     */
    private startStuckRecovery(): void {
        this.savedTarget = this.target;
        this.isRecovering = true;
        this.unstuckTimer = 0;
        this.stuckTimer = 0;
        
        // Switch to random walk
        this.mode = MovementMode.RANDOM_WALK;
        this.wanderAngle = Math.random() * Math.PI * 2;
        this.velocity = { 
            x: Math.cos(this.wanderAngle) * this.maxSpeed * 0.5, 
            y: Math.sin(this.wanderAngle) * this.maxSpeed * 0.5 
        };
    }
    
    /**
     * Update during stuck recovery mode.
     */
    private updateRecovery(dt: number): void {
        // Do random walk movement
        this.updateRandomWalk(dt);
        
        // Calculate proposed new position
        const newX = this.position.x + this.velocity.x * dt;
        const newY = this.position.y + this.velocity.y * dt;

        // Apply collision detection
        if (this.environment && this.environment.getBuildingCount() > 0) {
            const from = { x: this.position.x, y: this.position.y };
            const to = { x: newX, y: newY };
            
            const result = this.environment.resolveMovement(from, to);
            
            this.position.x = result.position.x;
            this.position.y = result.position.y;
            
            if (result.blocked) {
                this.wanderAngle += Math.PI * 0.5 + Math.random() * Math.PI;
            }
        } else {
            this.position.x = newX;
            this.position.y = newY;
        }
        
        // Check if we're moving well (unstuck)
        const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.y ** 2);
        if (speed > this.STUCK_SPEED_THRESHOLD * 2) {
            this.unstuckTimer += dt;
            
            if (this.unstuckTimer > this.UNSTUCK_TIME_THRESHOLD) {
                // Successfully unstuck - return to target
                this.endStuckRecovery(true);
            }
        } else {
            // Still stuck, keep trying
            this.unstuckTimer = 0;
        }
        
        // Check if recovery duration exceeded
        this.stuckTimer += dt;
        if (this.stuckTimer > this.recoveryDuration) {
            // Recovery duration exceeded, try returning to target anyway
            // but increase recovery duration for next time
            this.recoveryDuration = Math.min(this.recoveryDuration * 2, this.MAX_RECOVERY_DURATION);
            this.endStuckRecovery(false);
        }
    }
    
    /**
     * End stuck recovery and return to target seeking.
     */
    private endStuckRecovery(success: boolean): void {
        this.isRecovering = false;
        this.stuckTimer = 0;
        this.unstuckTimer = 0;
        
        if (success) {
            // Reset recovery duration on success
            this.recoveryDuration = 1;
        }
        
        // Restore target and recalculate path from new position
        if (this.savedTarget) {
            this.target = this.savedTarget;
            this.savedTarget = null;
            
            // Recalculate path from new position
            if (this.pathFinder && this.environment && this.environment.getBuildingCount() > 0) {
                const result: PathResult = this.pathFinder.findPath(
                    { x: this.position.x, y: this.position.y },
                    { x: this.target.x, y: this.target.y }
                );
                
                if (result.found && result.waypoints.length > 1) {
                    this.path = result.waypoints.map(wp => ({ x: wp.x, y: wp.y }));
                    this.currentWaypointIndex = 1;
                } else {
                    this.path = null;
                    this.currentWaypointIndex = 0;
                }
            } else {
                this.path = null;
                this.currentWaypointIndex = 0;
            }
            
            this.mode = MovementMode.TARGET;
        } else {
            // No saved target, just stop
            this.mode = MovementMode.STILL;
            this.velocity = { x: 0, y: 0 };
        }
    }
    
    private updateRandomWalk(_dt: number) {
        // Simple wander: Perturb velocity vector
        // Or steer angle
        this.wanderAngle += (Math.random() - 0.5) * this.WANDER_STRENGTH;
        
        // Desired velocity
        const speed = this.maxSpeed * 0.5; // Half speed for wandering
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
        
        const speed = Math.min(this.maxSpeed, distToFinal * 2);
        this.velocity.x = (dx / dist) * speed;
        this.velocity.y = (dy / dist) * speed;
    }
    
    /**
     * Update busy mode navigation - sets velocity towards target.
     * Returns true if we need to skip the main movement update (picking new target).
     */
    private updateBusyNavigation(_dt: number): void {
        // If no target, pick one
        if (!this.target) {
            this.pickBusyTarget();
            if (!this.target) {
                // Couldn't find target, stop
                this.velocity = { x: 0, y: 0 };
                return;
            }
        }
        
        // Navigate towards target (similar to TARGET mode but without switching to STILL)
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
                this.busyStuckTimer = 0;  // Reset stuck timer on progress
                return;
            } else {
                // Check if we've reached final target
                const dxFinal = this.target.x - this.position.x;
                const dyFinal = this.target.y - this.position.y;
                const distFinal = Math.sqrt(dxFinal * dxFinal + dyFinal * dyFinal);
                
                if (distFinal < this.WAYPOINT_THRESHOLD) {
                    // Arrived at destination - pick a new target
                    this.target = null;
                    this.path = null;
                    this.currentWaypointIndex = 0;
                    this.busyStuckTimer = 0;
                    this.pickBusyTarget();
                    return;
                }
            }
        }
        
        // Calculate velocity towards target
        if (dist > 0.01) {
            const distToFinal = this.target ? 
                Math.sqrt(
                    (this.target.x - this.position.x) ** 2 + 
                    (this.target.y - this.position.y) ** 2
                ) : dist;
            
            const speed = Math.min(this.maxSpeed, Math.max(distToFinal * 2, this.maxSpeed * 0.5));
            this.velocity.x = (dx / dist) * speed;
            this.velocity.y = (dy / dist) * speed;
        }
    }
    
    /**
     * Check if busy mode agent is stuck and pick new target if needed.
     * Stuck = hasn't moved enough distance over time threshold.
     */
    private checkBusyStuck(dt: number): void {
        this.busyStuckTimer += dt;
        
        // Check progress periodically
        if (this.busyStuckTimer >= this.BUSY_STUCK_TIME_THRESHOLD) {
            // Calculate actual distance traveled since last check
            const dx = this.position.x - this.busyLastPosition.x;
            const dy = this.position.y - this.busyLastPosition.y;
            const distanceTraveled = Math.sqrt(dx * dx + dy * dy);
            
            if (distanceTraveled < this.BUSY_MIN_PROGRESS) {
                // Stuck! Pick a new target
                this.target = null;
                this.path = null;
                this.currentWaypointIndex = 0;
                this.pickBusyTarget();
            }
            
            // Reset timer and record new position
            this.busyStuckTimer = 0;
            this.busyLastPosition = { x: this.position.x, y: this.position.y };
        }
    }

    setVelocity(v: Vector2) {
        this.velocity = v;
        this.mode = MovementMode.MANUAL;
    }
}
