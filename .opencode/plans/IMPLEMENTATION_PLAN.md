# Bitchat Simulator Implementation Plan

This plan details the step-by-step implementation of the Bitchat Simulator Web App. It is derived from `SPEC_PROMPT.md` and an analysis of the `bitchat-android` codebase, adapted for a simplified simulation environment as requested.

## 0. Protocol Specification (Simplified for Simulator)

The simulator will use a compatible subset of the Bitchat Android protocol.

### Packet Structure (BinaryProtocol)
*   **Header**: Version (1 byte), Type (1 byte), TTL (1 byte), Timestamp (8 bytes), Flags (1 byte), PayloadLength (2 or 4 bytes).
*   **Fields**: SenderID (8 bytes), RecipientID (8 bytes, optional), Payload (variable), Signature (64 bytes, optional - *Zeroed/Ignored for Sim*), Route (optional).
*   **Types**:
    *   `ANNOUNCE` (0x01)
    *   `MESSAGE` (0x02)
*   **TTL**: Starts at 7. Dropped at 0. Decremented on relay.

### ANNOUNCE Payload (TLV Encoded)
Concatenation of TLV items. **Note:** Cryptographic keys are excluded for this simulation phase.
1.  **Nickname** (Type 0x01): UTF-8 string.
2.  **Direct Neighbors** (Type 0x04): List of 8-byte peerIDs of directly connected neighbors (Gossip).

### Routing Logic
1.  **Flood**: If no specific route, flood to all active connections.
2.  **Source Routing**: If route exists and peer is in it, forward to next hop.
3.  **TTL**: Decrement on hop. Drop if 0.
4.  **Loop Prevention**: Don't relay if packet came from self or if addressed to self.

---

## Phase 1: Project Setup & Core Types

**Goal**: Initialize the repository and establish the core data structures and protocol definitions.

### Implementation
*   Initialize Vite + React + TypeScript project.
*   Configure Tailwind CSS.
*   Set up testing framework (Vitest).
*   Implement `BinaryProtocol` serialization/deserialization.
*   Implement `BitchatPacket` class/interface.
*   Implement `TLV` encoders for `IdentityAnnouncement` (Nickname only) and `GossipTLV`.

### Tests & Requirements
*   [ ] Project builds successfully.
*   [ ] `BinaryProtocol` tests pass: encode -> decode roundtrip matches.
*   [ ] `ANNOUNCE` payload generation creates correct TLV structure (0x01 for Nick, 0x04 for Neighbors).
*   [ ] `BitchatPacket` structure matches `BinaryProtocol.kt`.

### Todo List
*   [ ] Initialize project with `npm create vite@latest . -- --template react-ts`
*   [ ] Install `tailwindcss`, `postcss`, `autoprefixer`
*   [ ] Install `vitest`
*   [ ] Create `src/protocol/BitchatPacket.ts`
*   [ ] Create `src/protocol/BinaryProtocol.ts`
*   [ ] Create `src/protocol/TLV.ts` (Simplified IdentityAnnouncement + GossipTLV)
*   [ ] Write unit tests for protocol classes in `src/protocol/__tests__/`

---

## Phase 2: Core Simulation Model (No UI)

**Goal**: Build the simulation engine, including the "Physics" of people moving and the "Device" logic.

### Implementation
*   **Simulation Loop**: Fixed-timestep loop (e.g., 60 ticks/sec).
*   **BitchatPerson**: Position (x, y), Velocity, ID.
*   **BitchatDevice**: Owned by a person, holds state (peerID, nickname).
*   **Spatial Index**: Simple distance check to determine which devices are in range (simulating BLE).
*   **Event Bus**: Typed event emitter for simulation events.

### Tests & Requirements
*   [ ] Simulation loop runs and updates positions.
*   [ ] `BitchatPerson` moves according to velocity.
*   [ ] `BitchatDevice` is correctly associated with a Person.
*   [ ] "Proximity" detection works: devices within radius R are flagged as neighbors.

### Todo List
*   [ ] Create `src/simulation/SimulationEngine.ts` (Loop)
*   [ ] Create `src/simulation/BitchatPerson.ts`
*   [ ] Create `src/simulation/BitchatDevice.ts`
*   [ ] Create `src/simulation/SpatialManager.ts` (or similar for distance checks)
*   [ ] Create `src/events/EventBus.ts`
*   [ ] Write tests for movement and proximity logic

---

## Phase 3: Connections & Transport Layer

**Goal**: Simulate the physical/BLE link layer. Devices should automatically connect when close.

### Implementation
*   **BitchatConnection**: Abstract base class.
*   **BitchatConnectionBLE**: Concrete implementation.
    *   **Scanning**: Handled by the Simulation Engine checking distances.
    *   **Connection**: Formed when dist < threshold. Broken when dist > threshold.
    *   **Queue**: Output buffer for packets.
*   **Connection Manager**: Inside `BitchatDevice`, manages active connections.

### Tests & Requirements
*   [ ] Two devices moving close -> Connection formed event.
*   [ ] Two devices moving apart -> Connection broken event.
*   [ ] Connection object allows "sending" bytes (simulated latency optional).

### Todo List
*   [ ] Create `src/simulation/BitchatConnection.ts`
*   [ ] Create `src/simulation/BitchatConnectionBLE.ts`
*   [ ] Update `BitchatDevice` to manage connections.
*   [ ] Implement connection lifecycle logic in `SimulationEngine` (tick function checks distances).

---

## Phase 4: Application Layer & Routing

**Goal**: Implement the Bitchat protocol logic (Relaying, ANNOUNCE, Gossip).

### Implementation
*   **BitchatAppSimulator**: The "Brain" of the device.
*   **Packet Handling**:
    *   On receive: Decrement TTL. If > 0 and not for me, Queue for relay.
    *   Process ANNOUNCE: Update Peer Table (Direct vs Routed).
    *   Process Gossip: Update "Reachability" graph.
*   **Periodic ANNOUNCE**: Send ANNOUNCE every N seconds.
*   **Peer Table**: Map of PeerID -> { LastSeen, Hops, DirectConnection? }.

### Tests & Requirements
*   [ ] **Flooding Test**: A sends to B (connected), B sends to C (connected). C receives packet from A.
*   [ ] **TTL Test**: Packet dies after N hops.
*   [ ] **Gossip Test**: A receives ANNOUNCE from B, parses neighbors.
*   [ ] **Loop Prevention**: Device does not relay packet it sent.

### Todo List
*   [ ] Create `src/simulation/BitchatAppSimulator.ts`
*   [ ] Implement `handlePacket(packet)` logic.
*   [ ] Implement `sendAnnounce()` logic (construct payload with neighbors).
*   [ ] Implement `PeerTable` / `PeerManager` inside the simulator.
*   [ ] Wire up `BitchatDevice` to pass received data to `BitchatAppSimulator`.

---

## Phase 5: Visualization (Three.js + React)

**Goal**: Render the simulation state to the screen.

### Implementation
*   **React-Three-Fiber Setup**: Canvas, OrthographicCamera.
*   **Renderers**:
    *   `PersonNode`: Circle/Icon for person.
    *   `ConnectionEdge`: Line between connected persons. Color coded by state.
*   **Sync**: `useFrame` hook to interpolate positions from Simulation Engine (decoupling sim tick from render frame).

### Tests & Requirements
*   [ ] Nodes appear at correct positions.
*   [ ] Lines appear between connected nodes.
*   [ ] Movement is smooth.

### Todo List
*   [ ] Install `three`, `@types/three`, `@react-three/fiber`, `@react-three/drei`
*   [ ] Create `src/ui/scene/Scene.tsx`
*   [ ] Create `src/ui/scene/PersonNode.tsx`
*   [ ] Create `src/ui/scene/ConnectionEdge.tsx`
*   [ ] Create `src/ui/App.tsx` layout.

---

## Phase 6: HUD & Interaction

**Goal**: Add interactivity and inspection tools.

### Implementation
*   **Selection**: Click node to select.
*   **Inspector Panel**: Radix UI side panel showing selected device stats (Peers, Queue, Logs).
*   **Controls**: Add/Remove nodes buttons. Drag nodes (use-gesture).
*   **Visual Feed**: Log of recent events (Packet Sent, Connection Formed).

### Tests & Requirements
*   [ ] Clicking a node opens inspector.
*   [ ] Inspector shows correct, real-time data for that device.
*   [ ] Dragging a node updates its position in the Simulation Engine.

### Todo List
*   [ ] Install `radix-ui` primitives, `framer-motion`, `@use-gesture/react`
*   [ ] Create `src/ui/hud/InspectorPanel.tsx`
*   [ ] Create `src/ui/hud/Controls.tsx`
*   [ ] Implement drag logic in `PersonNode`.
*   [ ] Implement selection state in global store (or React context).

---

## Phase 7: Polish & Optimization

**Goal**: Ensure "analytics-grade" feel and performance.

### Implementation
*   **Microanimations**: Framer Motion for UI panels.
*   **Performance**: Optimize Three.js rendering.
*   **Refinement**: Tweak colors, fonts (JetBrains Mono or Inter), and spacing.

### Todo List
*   [ ] Review UI against "Cyberpunk/Analytics" aesthetic.
*   [ ] Profile performance with 50+ nodes.
*   [ ] Add tooltips/hover states.
