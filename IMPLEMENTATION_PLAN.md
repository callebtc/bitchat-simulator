# Bitchat Simulator Implementation Plan

This plan details the step-by-step implementation of the Bitchat Simulator Web App. It is derived from `SPEC_PROMPT.md` and a verified analysis of the `bitchat-android` codebase.

## 0. Protocol Specification (Verified against Android Source)

The simulator must implement a **wire-compatible subset** of the Bitchat Android protocol to ensure realism.

### Source Files
Refer to these files in `~/git/bitchat-android/` for the ground truth:
*   `app/src/main/java/com/bitchat/android/protocol/BinaryProtocol.kt`: Packet structure and serialization.
*   `app/src/main/java/com/bitchat/android/model/IdentityAnnouncement.kt`: ANNOUNCE payload structure.
*   `app/src/main/java/com/bitchat/android/services/meshgraph/GossipTLV.kt`: Neighbor list encoding.

### Packet Structure (BinaryProtocol V1)
*   **Fixed Header**: 14 bytes (Note: Android constant says 13, but fields sum to 14. Use calculated size).
    *   `Version` (1 byte): 0x01
    *   `Type` (1 byte): `ANNOUNCE` (0x01), `MESSAGE` (0x02)
    *   `TTL` (1 byte): Starts at 7.
    *   `Timestamp` (8 bytes): Big-endian UInt64.
    *   `Flags` (1 byte): `HAS_RECIPIENT` (0x01), `HAS_SIGNATURE` (0x02), `IS_COMPRESSED` (0x04).
    *   `PayloadLength` (2 bytes): Big-endian UInt16.
*   **Variable Fields**:
    *   `SenderID` (8 bytes): Fixed.
    *   `RecipientID` (8 bytes): Present if `HAS_RECIPIENT` flag is set.
    *   `Payload` (Variable): `PayloadLength` bytes.
    *   `Signature` (64 bytes): Present if `HAS_SIGNATURE` flag is set. (Zero-filled for Sim).

### ANNOUNCE Payload (TLV Encoded)
Concatenation of TLV items (`Type` 1 byte, `Length` 1 byte, `Value`).
1.  **Nickname** (Type 0x01): UTF-8 string.
2.  **Neighbors** (Type 0x04): See `GossipTLV`. List of 8-byte peerIDs.

---

## Phase 1: Project Setup & Protocol Implementation

**Goal**: Initialize the repo and implement the `BinaryProtocol` and `BitchatPacket` classes with unit tests verifying byte-level correctness.

### Implementation
1.  **Scaffold**: Vite + React + TypeScript + Tailwind + Vitest.
2.  **Linting Rules**:
    *   Install ESLint.
    *   **Rule**: Max 300 lines per file.
    *   **Rule**: Max 1 React Component per file.
3.  **Protocol Layer**:
    *   Create `src/protocol/BinaryProtocol.ts`.
    *   Create `src/protocol/BitchatPacket.ts` (using `Uint8Array` for payload).
    *   Create `src/protocol/TLV.ts` for `IdentityAnnouncement` and `GossipTLV`.
4.  **Verification**:
    *   Write a test that encodes a packet in TS and compares it against a "known good" hex string (you may need to generate one based on the Android logic manual trace).
    *   **CRITICAL**: Verify the header size calculation (14 bytes vs 13 bytes issue).

### Todo List
*   [ ] Initialize project: `npm create vite@latest . -- --template react-ts`
*   [ ] Install dependencies: `npm install -D tailwindcss postcss autoprefixer vitest eslint eslint-plugin-react`
*   [ ] Configure ESLint with custom rules (max-lines, one-component).
*   [ ] Configure Tailwind & Vitest.
*   [ ] Implement `src/protocol/BitchatPacket.ts` (Class with fields).
*   [ ] Implement `src/protocol/BinaryProtocol.ts` (encode/decode).
*   [ ] Implement `src/protocol/TLV.ts` (Identity & Gossip encoders).
*   [ ] **TEST**: Verify `encode(packet)` output length equals `14 + 8 + payload.length`.
*   [ ] **TEST**: Round-trip encode/decode preserves all fields.

---

## Phase 2: Core Simulation Engine (Headless)

**Goal**: Build the deterministic simulation loop and data models. **MUST be decoupled from UI**.

### Architecture
*   **No DOM/React dependencies** in `src/simulation/`.
*   Designed to run in a Web Worker (though initially runs in main thread).
*   Uses a `FixedTimestepLoop`.

### Implementation
1.  **SimulationEngine**: Manages the loop, list of `BitchatPerson`, and global time.
2.  **BitchatPerson**:
    *   Properties: Position, Velocity, ID, `BitchatDevice`.
    *   **Logic**: `update(dt)` handles movement.
    *   **Feature**: "Random Walk" switch. If enabled, person picks random target within bounds and moves there, then repeats.
3.  **BitchatDevice**: The "Hardware" model. Owns the `BitchatAppSimulator`.
4.  **SpatialManager**: Naive O(N^2) or simple grid to detect neighbors within `CONNECTION_RADIUS`.
5.  **EventBus**: Typed emitter for `PACKET_SENT`, `CONNECTION_CHANGE`, etc.

### Todo List
*   [ ] Create `src/simulation/SimulationEngine.ts`.
*   [ ] Create `src/simulation/BitchatPerson.ts` (Include Random Walk logic).
*   [ ] Create `src/simulation/BitchatDevice.ts`.
*   [ ] Implement `SpatialManager.ts` (distance checks).
*   [ ] Implement `src/events/EventBus.ts` (Typed events).
*   [ ] **TEST**: Two persons moving within range trigger a "Proximity" event.
*   [ ] **TEST**: Person with "Random Walk" changes position over time.

---

## Phase 3: Transport Layer (BLE Simulation)

**Goal**: Model the physical connection establishment and packet transfer with constraints.

### Implementation
1.  **BitchatConnection**: Abstract base class.
2.  **BitchatConnectionBLE**:
    *   State: `CONNECTING`, `CONNECTED`, `DISCONNECTED`.
    *   **Constraints**: Max **8** total connections per device (Server + Client).
    *   **Scanning**:
        *   Occurs every **10 seconds**.
        *   Scans `SpatialManager` for neighbors.
        *   If `count(connections) < 8`: Connect to a random nearby neighbor not already connected.
    *   **Latency**: (Optional) Keep synchronous for now.

### Todo List
*   [ ] Create `src/simulation/connections/BitchatConnection.ts`.
*   [ ] Create `src/simulation/connections/BitchatConnectionBLE.ts`.
*   [ ] Update `BitchatDevice` to manage connections and enforce the limit of 8.
*   [ ] Implement `scanAndConnect()` logic (10s timer, neighbor check).
*   [ ] **TEST**: Verify device does not exceed 8 connections even if 20 neighbors are close.

---

## Phase 4: Application Layer & Routing Logic

**Goal**: The "Brain". Handling Packets, TTL, and Gossip.

### Implementation
1.  **BitchatAppSimulator**:
    *   Maintains `PeerTable` (Map<PeerID, PeerInfo>).
    *   `handlePacket(packet: BitchatPacket, incomingConnection)`:
        *   Decrement TTL. Drop if 0.
        *   If `ANNOUNCE`: Parse TLV, update PeerTable (Direct neighbors vs Routed).
        *   If `MESSAGE`: Deliver if `RecipientID` matches MyID.
        *   **Relay Logic**: Flood to all *other* connections if TTL > 0 and not seen recently (De-duplication cache needed).
2.  **De-duplication**: `PacketCache` (Set of packet hashes) to prevent infinite loops.

### Todo List
*   [ ] Create `src/simulation/BitchatAppSimulator.ts`.
*   [ ] Implement `PeerTable.ts`.
*   [ ] Implement `handlePacket` with TTL decrement and De-duplication.
*   [ ] Implement `sendAnnounce()`: Broadcasts ANNOUNCE with current neighbors.
*   [ ] **TEST**: 3-Node Chain (A-B-C). A sends to C. B relays. C receives with TTL=6.
*   [ ] **TEST**: Loop (A-B-A). A sends. B relays to A. A drops (De-dup or Source check).

---

## Phase 5: Visualization (React + Three.js)

**Goal**: Render the simulation state.

### Implementation
1.  **Tech**: `@react-three/fiber`, `@react-three/drei`.
2.  **Scene**:
    *   `OrthographicCamera` (Top-down 2D view).
    *   `PersonNode`: Circle with distinct color/avatar.
    *   `ConnectionEdge`: Line. Color=Signal Strength or State.
3.  **State Sync**:
    *   Use `useFrame` to pull positions from `SimulationEngine`.
    *   Do NOT put Simulation state in React State (performance killer). Use Refs or direct access.

### Todo List
*   [ ] Install Three.js deps.
*   [ ] Create `src/ui/scene/Scene.tsx`.
*   [ ] Implement `PersonNode` and `ConnectionEdge` components.
*   [ ] Integrate `SimulationEngine` into a React Context/Hook (`useSimulation`).
*   [ ] **VERIFY**: Smooth 60FPS rendering with 50 nodes.

---

## Phase 6: HUD & Introspection UI

**Goal**: "Analytics-Grade" Inspection.

### Implementation
1.  **Selection System**: Click node -> `selectedPersonId`.
2.  **Inspector Panel** (Radix UI):
    *   Shows: ID, Neighbors, Packet Queue Depth, Peer Table.
    *   Actions: "Send Test Message", "Disconnect", "Toggle Random Walk".
3.  **Global Stats**: Total Packets, Total Peers, Network Diameter.
4.  **Styling**: Dark mode, Monospace fonts (JetBrains Mono), tight spacing.

### Todo List
*   [ ] Install Radix UI & Framer Motion.
*   [ ] Create `InspectorPanel.tsx`.
*   [ ] Implement "Click to Select" in 3D scene.
*   [ ] **TEST**: Selecting a node shows its specific internal PeerTable.

---

## Phase 7: Polish & Optimization

*   [ ] **Microanimations**: Hover effects, Packet transmission animations (little dots moving along edges).
*   [ ] **Performance**: Spatial Index optimization (Quadtree) if N > 100.
*   [ ] **Web Worker**: Move `SimulationEngine` to a worker thread (if time permits).

## Execution Notes
*   **Strict Typing**: Use strict TypeScript configuration.
*   **No Magic Numbers**: Define constants for TTL, Header Sizes, etc.
*   **Commit Often**: Commit after each Phase or major component.
