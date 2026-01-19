# Bitchat Simulator Web App SPECIFICATIONS

## Agent Master Prompt

You are building a **Bitchat simulator web application from scratch**, written in **TypeScript**, with a strong emphasis on **correct protocol modeling, deterministic simulation, and a modern analytics-grade UI**.

This is not a toy app. Treat it like a professional simulation and analysis tool.

---

## 0. Required Pre-Analysis (Mandatory)

Before writing any code:

1. Analyze the Android codebase at:

   ```
   ~/git/bitchat-android/
   ```
2. Start by reading:

   ```
   ~/git/bitchat-android/AGENTS.md
   ```
3. Build a complete mental model of:

   * The Bitchat protocol
   * Packet lifecycle and routing rules
   * Peer discovery and gossip mechanics
   * TTL behavior and relay semantics

You must internalize these concepts before implementing the simulator.

---

## 1. Bitchat Protocol Knowledge You Must Model

### Packets

* Enumerate and understand all **BitchatPacket types**
* Every packet starts with **TTL = 7**
* TTL is decremented on every relay hop
* Packets are dropped when TTL reaches 0

### Peers

* Every user is represented as a **peer**
* Each peer has a globally unique **peerID**
* There is no central authority

### Flooding and Relaying

* All peers relay packets
* Broadcast packets are flood-filled to all active connections
* Routing is decentralized and opportunistic

### ANNOUNCE and Gossip

* Peers send **ANNOUNCE packets**
* ANNOUNCE includes gossip data
* Gossip contains:

  * The peer’s directly connected neighbor peerIDs
* Peers use ANNOUNCE packets to:

  * Discover the network
  * Track reachable peers
  * Identify routed peers vs directly connected peers
  * Evict stale peers

---

## 2. High-Level Simulator Goals

You are building a **deterministic simulation of a dynamic peer-to-peer Bluetooth mesh network** with full visual introspection.

The simulator must:

* Support many moving peers
* Dynamically form and break connections
* Correctly simulate packet routing, flooding, and TTL
* Provide deep visual and UI inspection tools
* Be extensible to new transports beyond Bluetooth

---

## 3. Technology Stack (Required)

### Coding Standards
*   **Max 300 lines per file**: Enforce strict file length limits.
*   **One Component Per File**: React components must be in their own files.
*   **Linting**: Add these rules to ESLint configuration.

### Core Framework

* **React + TypeScript**
* Built with **Vite**

### Rendering

* **three.js**
* **@react-three/fiber**
* Use an **orthographic camera** initially to simulate 2D
* Design so it can evolve into 3D later with minimal refactoring

### UI Layer

* DOM-based HUD overlay
* Tailwind CSS for dense, modern styling
* Radix UI primitives for sliders, panels, popovers, dialogs
* Framer Motion for microanimations and smooth transitions

### Simulation Architecture

* Deterministic **fixed-timestep simulation loop**
* Rendering decoupled from simulation ticks
* Architecture must support moving the simulation into a **Web Worker** later

### Eventing

* Implement a **typed event bus** from the beginning
* Use it for:

  * Packet sent / received
  * Connection created / destroyed
  * ANNOUNCE received
  * Peer discovered / evicted
* Do not use the bus for everything. Core logic should still use direct method calls.

---

## 4. Core Simulation Model

### 4.1 BitchatPerson

Represents a human moving through space.

Properties:

* Position: Vector3 (x, y, z)

  * z is always 0 for now
* Velocity: Vector3
* Movement:

  * Straight-line motion only
  * Supports moving toward a target at a given velocity
  * "Random Walk" mode: Person randomly moves around the 2D space to simulate crowd behavior.
  * Future obstacle avoidance is planned but not implemented yet

Capabilities:

* Carries one or more **BitchatDevice** instances

---

### 4.2 BitchatDevice

Represents a physical device carried by a person.

Responsibilities:

* Belongs to a BitchatPerson
* Manages physical connections
* Owns and runs a **BitchatAppSimulator**
* Acts as the bridge between:

  * Physical connections
  * Application-level protocol logic

---

### 4.3 BitchatConnection (Superclass)

Represents a physical link between two devices.

Properties:

* Shared object between exactly two BitchatDevice instances
* Bidirectional read/write channel
* Link state:

  * Active
  * Inactive

Responsibilities:

* Transmit **BitchatPacket** objects
* Enforce link availability
* Be transport-agnostic

---

### 4.4 BitchatConnectionBLE

Bluetooth Low Energy implementation.

Rules:

* Exactly two roles:

  * One GATT server
  * One GATT client
* Max Connections: **8 per device** (combined server + client).
* A server may exist in a pending state
* A client may scan and attach to a pending server

Behavior:

* Scanning is simulated via spatial distance
* **Scanning Interval**: Every 10 seconds.
* Devices within a predefined radius can discover servers
* Connect logic: Scan all available GATT servers nearby and decide to connect to one.
* Once a client attaches:

  * The connection becomes active
  * Both devices can exchange packets

Provide:

* Helper methods for:

  * Scanning for reachable servers
  * Establishing connections
* Distance-based reachability logic

---

## 5. BitchatAppSimulator

This is a **software-only model of the real Bitchat app**.

Runs inside a BitchatDevice.

Responsibilities:

* Create and register BitchatConnections
* Maintain peer state:

  * Direct peers
  * Routed peers
  * Latest ANNOUNCE per peer
* Evict stale peers
* Execute routing logic

Routing rules:

* Incoming packets decrement TTL
* If TTL > 0:

  * Relay to all connections
* Source-based routing exception:

  * If a route is present
  * Only relay if this peer is part of the route

---

## 6. BitchatPacket Model

Simplified version of the Android packet.

Fields:

* type: enum

  * ANNOUNCE
  * MESSAGE
* senderID: string
* recipientID: string | optional
* route: string[] | optional
* payload: JSON serialized string | optional

Payload semantics:

* ANNOUNCE payload includes:

  * neighbors: string[] of directly connected peerIDs
* MESSAGE payload is application defined

---

## 7. Simulation Loop

You must implement:

* A fixed-timestep simulation loop
* All device logic runs on simulation ticks
* Rendering runs independently via requestAnimationFrame

Design so that:

* The simulation can later move into a Web Worker
* UI communicates via commands
* Simulation emits events and state snapshots

---

## 8. Simulator Web App UI

### Scene

* 2D plane rendered via three.js
* Each BitchatPerson rendered as a node
* Connections rendered as edges
* Updates dynamically as positions and connections change

### Interaction

* Spawn and remove persons
* Drag persons to move them
* Devices start running immediately on spawn
* Connections form and break automatically

### HUD

* Hovering an object:

  * Highlights it
  * Shows a floating, semi-transparent info panel
* Clicking an object:

  * Opens a side inspector panel
  * Shows full state and editable parameters
* Panels are manually closable

### UI Quality Bar

* Highly performant WebGL
* Smooth camera pan, zoom, and transitions
* Dense, information-rich UI
* Modern analytics and simulation software aesthetics
* Microanimations everywhere
* Designed as award-level analyst tooling

---

## 9. Execution Order for the Agent

You should proceed in this order:

1. Protocol understanding and notes
2. Core data models and interfaces
3. Deterministic simulation loop
4. BitchatAppSimulator logic
5. BLE connection mechanics
6. Event bus
7. Rendering layer
8. HUD and inspector UI
9. Performance and architectural cleanup

---

## 10. Final Instruction

You are expected to:

* Make reasonable architectural decisions
* Keep components decoupled
* Favor clarity, determinism, and extensibility
* Write clean, idiomatic TypeScript
* Think like a senior engineer building professional simulation software

Do not rush to UI polish before the simulation core is correct.


