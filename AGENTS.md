# Agent Guidelines for Bitchat Simulator

This document provides architecture context, protocol references, fidelity targets, and engineering conventions for AI agents working on **Bitchat Simulator**.

## 1. Project Purpose & Scope

**Bitchat Simulator** is a deterministic, physics-grounded simulator of the **BitChat** decentralized mesh messaging protocol. Its purpose is to model simulated devices carried by moving people in realistic environments (e.g., urban areas built from OpenStreetMap geometry) so developers can measure and optimize:

- **Throughput & airtime efficiency** (goodput, packet amplification, duplicate suppression, MTU/fragmentation overhead, channel congestion)
- **Delivery reliability & latency** (broadcast reach, direct-message delivery ratio, p50/p95/p99 end-to-end delay across hops and churn)
- **Topology, routing & resilience** (peer discovery lag, bidirectional mesh graph accuracy, source-routing hit/fallback rates, partition healing, store-and-forward / gossip sync recovery)
- **Transport trade-offs** in large, dense **Bluetooth Low Energy (BLE)**, **Wi-Fi Aware**, and future local mesh transports

Visual 3D/2D inspection is a diagnostic lens over this engine, not the goal by itself. Protocol accuracy, deterministic timing, physical realism, and measurable telemetry take priority over UI polish.

## 2. Canonical BitChat Protocol References

Always treat the public upstream BitChat repositories as the source of truth for wire formats, relay policies, sync, and transport mechanics:

- **BitChat (iOS / macOS — Swift)**: https://github.com/permissionlesstech/bitchat (also mirrored at https://github.com/jackjackbits/bitchat)
  - Protocol overview & v2.0 design: `WHITEPAPER.md`
  - Source routing (v2 packet format): `SOURCE_ROUTING.md`
  - Wire codec & message types: `localPackages/BitFoundation/Sources/BitFoundation/BinaryProtocol.swift`, `MessageType.swift`
  - Flood control & fanout subsetting: `bitchat/Services/RelayController.swift`, `bitchat/Services/BLE/BLEFanoutSelector.swift`
  - Source-route origination & forwarding: `bitchat/Services/BLE/BLESourceRouteOriginationPolicy.swift`, `bitchat/Services/BLE/BLERouteForwardingPolicy.swift`
  - Transport knobs & budgets: `bitchat/Services/TransportConfig.swift`
  - Layered BLE stack architecture: `docs/BLE-ARCHITECTURE-V3.md`
  - Gossip sync & courier store-and-forward: `bitchat/Sync/GossipSyncManager.swift`, `bitchat/Services/Courier/CourierStore.swift`
- **BitChat Android (Kotlin)**: https://github.com/permissionlesstech/bitchat-android
  - Wire codec & packet definitions: `app/src/main/java/com/bitchat/android/protocol/BinaryProtocol.kt`
  - Relay manager & adaptive probability: `app/src/main/java/com/bitchat/android/mesh/PacketRelayManager.kt`
  - Announcement neighbor gossip TLV (`0x04`) & capabilities (`0x05`): `docs/ANNOUNCEMENT_GOSSIP.md`
  - Source routing & gossip sync specs: `docs/SOURCE_ROUTING.md`, `docs/sync.md`
  - Wi-Fi Aware multi-transport mesh: `app/src/main/java/com/bitchat/android/wifi-aware/WifiAwareMeshService.kt`
  - Large-mesh scaling bottlenecks: `docs/PERFORMANCE_BOTTLENECKS.md`

When adding or revising simulated protocol behavior, cite the corresponding upstream spec/module in code comments or tests and keep wire semantics aligned across both Apple and Android clients.

## 3. Environment & Commands

- **Stack**: TypeScript 5 (strict mode), React 18, Vite 4, Vitest, Tailwind CSS, Three.js (`@react-three/fiber`, `@react-three/drei`)
- **Package Manager**: `npm` (Node.js 18+)

### Key Commands
- **Install dependencies**: `npm install`
- **Type Check**: `npx tsc --noEmit` (run before finishing any task)
- **Build**: `npm run build` (runs `tsc && vite build`; matches GitHub Pages CI workflow)
- **Test All (single run)**: `npx vitest run` (`npm run test` starts Vitest in watch mode)
- **Test Single File**: `npx vitest run src/path/to/file.test.ts`
- **Dev Server**: `npm run dev`
- **Lint note**: `package.json` defines `npm run lint`, but `eslint` and an ESLint config are not currently installed in `devDependencies`. Verify with `npx tsc --noEmit`, `npx vitest run`, and `npm run build`.

## 4. Codebase Architecture

### Strict Layer Boundary (Most Important Rule)
1. **`src/protocol/` and `src/simulation/` MUST NOT import React, Three.js, DOM/UI code, or browser-only APIs where avoidable.** The simulation core must remain runnable headlessly in Vitest / Node / Web Workers. (Note: `OSMFetcher.ts` and `PathFinder.ts` currently guard or use `localStorage` for optional caching; keep new simulation modules storage- and DOM-free.)
2. **`src/ui/` is reactive and observational.** UI components call methods on `SimulationEngine` and subscribe to `EventBus` / `LogManager`, never driving core protocol or physics logic themselves.

### Directory Map

- **`src/protocol/` — Binary Wire Format**
  - `BitchatPacket.ts`: `MessageType` enum, `SpecialRecipients.BROADCAST`, `BitchatPacket` interface, `createPacket()`, `calculatePacketHash()` (FNV-1a).
  - `BinaryProtocol.ts`: Big-endian `DataView` encoder/decoder for v1 (14-byte header, 2-byte payload length) and v2 (16-byte header, 4-byte payload length, `HAS_ROUTE` `0x08` hop list).
  - `TLV.ts`: TLV codec for `ANNOUNCE` payloads (`NICKNAME = 0x01`, `DIRECT_NEIGHBORS = 0x04`).
  - `__tests__/`: Exact round-trip binary encoding/decoding tests.

- **`src/simulation/` — Core Simulation Engine**
  - `SimulationEngine.ts`: Fixed-timestep loop (`FIXED_TIME_STEP = 0.05s`), owns `SpatialManager`, `EnvironmentManager`, `PathFinder`, `LogManager`, `EventBus`, active `globalConnections`, and `pendingConnections` (100 ms stability check before link finalization).
  - `BitchatPerson.ts`: Physical agent carrying a `BitchatDevice`. Implements 2D kinematics, movement modes (`STILL`, `RANDOM_WALK`, `TARGET`, `BUSY`, `MANUAL`), visibility-graph waypoint following, wall-slide collision resolution, and stuck recovery.
  - `BitchatDevice.ts`: Radio-bearing device with 8-byte `peerID`, `nickname`, `ConnectionManager`, `appSimulator`, `PowerMode` scan intervals (`ECO` 60 s / `NORMAL` 30 s / `PERFORMANCE` 10 s with ±20% jitter), `bluetoothStrength` (0–100, baseline 50), and `ConnectionSettings` (`maxClients`, `maxServers`, `maxTotal`, default 8).
  - `ConnectionManager.ts`: Per-device link table enforcing client/server/total limits (oldest-first eviction), `broadcast(packet, exclude)` (split horizon), and `sendTo(peerIDHex, packet)`.
  - `BitchatConnection.ts`: Transport-agnostic abstract bidirectional link with latency queue (`packetQueue`) and packet counters. Subclass this to add new transports (e.g., Wi-Fi Aware).
  - `BitchatConnectionBLE.ts`: BLE RF link model — log-distance path loss (`AT_1M = -40 dBm`, exponent `2.5`), building wall/material attenuation, device gain `10 * log10(strength / 50)` per endpoint, sinusoidal fading noise, exponential smoothing, and disconnect threshold (`-85 dBm`).
  - `SpatialManager.ts`: Uniform spatial hash grid (`CELL_SIZE = 100 m`) for fast neighbor queries.
  - `LogManager.ts`: Bounded ring buffer (2,000 entries) with subscription API for simulation logs.
  - `DemoSetup.ts`: Helpers (`setupDemo`, `addRandomNode`) for spawning demo populations.
  - `AppLayer/`:
    - `BitchatAppSimulator.ts`: Software model of the BitChat app. Handles periodic `ANNOUNCE` gossip (5 s ±20%), FNV-1a deduplication (`seenPackets`, cap 1,000), `MeshGraph` updates, v2 source-routed unicast with flood fallback, and split-horizon flood relaying.
    - `MeshGraph.ts`: Tracks announced neighbor lists per peer; computes shortest paths (BFS) strictly over **bidirectionally confirmed edges** (`A` announces `B` AND `B` announces `A`).
    - `PeerManager.ts`: Tracks discovered peers (`id`, `nickname`, `lastSeen`, `isDirect`, `hops`).
  - `environment/`:
    - `types.ts`: GeoJSON types, `ATTENUATION_CONFIG` (`WALL_LOSS = 15 dB`, `BUILDING_DENSE_DB_M = 4.0 dB/m`, `BUILDING_INTERNAL_DB_M = 0.5 dB/m`), local Mercator projections.
    - `EnvironmentManager.ts`: Loads GeoJSON polygons into local meter coordinates, AABB-filtered building queries, point-in-polygon checks, and iterative wall-slide collision (`resolveMovement`).
    - `LineOfSight.ts`: Ray-polygon intersection, wall/interior attenuation breakdown, clearance checks, and outward edge normals.
    - `OSMFetcher.ts`: Multi-mirror Overpass API fetcher (per-mirror timeout + failover) for OSM buildings plus render-only roads / parks / water, tagged via `properties.kind`, with `localStorage` caching.
    - `BuildingHeights.ts`: Roof heights from OSM `height` / `building:levels` tags with deterministic whole-storey estimates as fallback (`Building.height`, `heightSource`). Heights are currently visual; RF attenuation is still 2D.
    - Building data split: `getBuildings()` = footprint outlines (physics, RF, pathfinding; multipolygon courtyards in `holes` are currently treated as solid); `getRenderVolumes()` = what is drawn in 3D (`building:part`s replace their outline, hidden nested volumes are dropped and taller ones start at the container roof) so no two faces are ever coplanar.
    - `Terrain.ts`: Headless `Heightfield` (bilinear `sample`, `minUnder`), Terrarium DEM decoding and slippy-tile math. Tiles are fetched in `ui/context/TerrainContext.tsx`; elevation is render-only (people, links, buildings and the baked street map drape on it).
    - `PathFinder.ts`: Visibility graph over inflated building polygons (`2.5 m` padding, `150 m` max edge), chunked async construction, A* pathfinding, and `localStorage` caching.

- **`src/events/EventBus.ts`** — Pub/sub bridge (`person_added`, `person_removed`, `connection_formed`, `connection_broken`, `packet_transmitted`, `tick`, `reset`, `environment_loaded`).
- **`src/ui/`** — React + React Three Fiber 3D visualization and HUD:
  - `context/`: `TerrainContext` (DEM heightfield; use `heightAt` / `fieldRef` for any per-frame z), `SimulationContext` (dev builds expose `window.__bitchat.engine`), `SelectionContext` (selection, DM pair, `requestCameraFocus(x, y, distance)`), `CameraContext` (`free` / `follow` / `chase` / `fpv` modes + per-frame `telemetryRef`), `VisualizationContext` (time of day, building style, graphics quality, layer toggles), `LayoutContext`.
  - `scene/` — perspective 3D world. **Coordinate rule:** everything simulation-derived renders inside the `sim-root` group rotated by `SIM_ROOT_ROTATION` (`coords.ts`), so layers author geometry in simulation meters (x east, y north, z up) while sky / lights / camera stay Y-up. Use `simToWorld()` when converting outside that group.
    - `world/`: `Atmosphere` (solar model in `sun.ts`, camera-following shadow frustum, stars), `SkyDome` (analytic sky + PMREM image-based lighting baked from it), `Ground`, `TerrainSurface` (DEM-displaced mesh textured by `mapTexture.ts`, which bakes roads, curbs, lane markings, parks, plazas and water), `CityLayer` (`cityGeometry.ts` merges extruded OSM footprints into one draw call with plinths sunk into slopes; `buildingMaterial.ts` adds procedural windows lit at night), `StreetLamps`.
    - `actors/`: `PeopleLayer` (instanced walking figures with gait locked to ground speed, phones, halos, LOD + frustum culling, screen-space markers in `markerMaterial.ts` with an occluded "ghost" pass), `SelectionBeacons`.
    - `network/`: `NetworkLayer` (BLE / Wi-Fi Aware link arcs from `linkArc.ts`, packets in flight, radio ripples sized to the nominal BLE range).
    - `camera/CameraRig.tsx` (OrbitControls with zoom-to-cursor, WASD/QE/RF, fly-to, follow/chase/first-person), `interaction/PointerController.tsx` (screen-space picking, 2-click DM targeting, drag-to-carry, right-click walk target), `effects/PostProcessing.tsx` (MSAA HDR → NaN sanitize → bloom → output).
    - `PathVisualizer`, `RouteVisualizer`, `ProbeVisualizer`: route/probe overlays (sim-root space).
  - `overlays/`: DOM overlays pinned to 3D points via `ScreenAnchors` (`PeerLabels`, `ChatBubbles`); one projector writes transforms per frame.
  - `hud/`: `primitives.tsx` (shared glass panel, section, segmented, switch, stat, button styles — use these for any new HUD UI), `MainControlPanel` (left rail: status, KPIs, View · Layers · Population · Location · Telemetry), `ViewSection` (compass/scale, camera modes, time of day, building style, quality; `ViewShortcuts` keys 1–4 / H / Esc), `EnvironmentSection` (place search, presets, radius, terrain, OSM stats), `InspectorPanel` (right rail), `DevicePhone` (dockable handset running the selected/followed device's BitChat app), `BottomPanel` (floating console: `LogView` + `ChatPanel`), `PerformanceStats` (`usePerformance` hook).
- **`src/utils/`** — `colorUtils.ts`, `usePersistedState.ts`.

## 5. Current Implementation vs. Real BitChat (Known Gaps & Roadmap)

Agents working to improve simulation truthfulness should be aware of the current gaps and bugs between this codebase and production BitChat:

### Determinism & Clock Hygiene (High Priority)
- **Wall-clock leakage**: `SimulationEngine.step(dt, nowOverride)` takes simulated time, but `BitchatConnectionBLE.send()` stamps `deliverAt` using `performance.now()`, while `createPacket()`, `PeerManager`, and `BitchatAppSimulator` use `Date.now()`. All simulation logic must migrate to a single monotonic **simulation clock** (`simTimeMs`) passed down from `SimulationEngine`.
- **RSSI noise phase bug**: `BitchatConnectionBLE.updateRSSI(now)` increments `noisePhase` by absolute `now` instead of elapsed `dt`.
- **Unseeded randomness**: `Math.random()` and `crypto.getRandomValues()` are used directly; reproducible benchmark runs require an injectable seeded PRNG.

### Physical, RF & Transport Layer Fidelity
- **No airtime, bandwidth, MTU, or congestion model**: `BitchatConnectionBLE` applies a flat `400 ms` latency regardless of encoded byte size, link count, BLE connection interval, shared 2.4 GHz radio contention, GATT write/notification queue backpressure, or fragment pacing (real BitChat BLE uses ~469 B fragments paced 25–30 ms apart, max 2 concurrent transfers, 512 B MTU).
- **No probabilistic packet loss**: Packets never fail in transit above `-85 dBm`; realistic RF simulation should model SNR/RSSI-dependent PER (packet error rate) and dense-crowd interference.
- **BLE link scheduling & dual-role asymmetry**: Real BitChat caps central links (e.g., 6 on Apple), duty-cycles scanning (`5 s on / 10 s off`, `3 s on / 15 s off` when dense), uses adaptive RSSI thresholds (`-85 dBm` connected vs. `-95..-100 dBm` isolated), applies weak-link cooldowns, and collapses duplicate dual-role links per peer.
- **Wire encoding bypassed on links**: `BitchatConnectionBLE.send()` passes in-memory `BitchatPacket` objects rather than measuring or framing `BinaryProtocol.encode()` byte lengths (and padding/compression are not yet active).
- **Multi-transport extensibility**: Only `BitchatConnectionBLE` is implemented; adding **Wi-Fi Aware** (higher throughput, TCP/IPv6 NAN sockets, discovery/attach lifecycle, and BLE ↔ Wi-Fi Aware bridging) should build on `BitchatConnection` and a per-device multi-transport router.

### Protocol & Mesh Logic Fidelity
- **Flood control & relay policy**: Simulator currently relays immediately with zero jitter, full fanout, and no degree-aware TTL clamping. Real BitChat implements:
  - Degree-based TTL clamping (dense graphs `>= 6` links clamp broadcast TTL to `5`; thin chains `<= 2` relay at full incoming depth).
  - Randomized relay jitter (`10–220 ms` scaled by degree; `10–60 ms` for directed/handshake; `8–25 ms` for fragments/voice) **with scheduled-relay cancellation** when a duplicate arrives before transmission.
  - Deterministic fanout subsetting (`~log2(degree)` links seeded by message ID) for broadcasts (full fanout for announces, fragments, and sync).
  - Adaptive probabilistic relaying on Android for low-TTL packets in large networks.
- **Presence & topology freshness**: Simulator announces every 5 s with unbounded neighbor lists and never evicts stale peers (`PeerManager`) or stale `MeshGraph` edges. Real BitChat backs off announces (`4 s` isolated → `15–30 s` connected, jittered), caps TLV `0x04` at **10 neighbors**, expires unreachable peers after `45–60 s`, and enforces timestamp ordering / `60 s` topology freshness.
- **Source routing safeguards**: Real BitChat caps originated routes at **4 intermediate hops**, rejects routes containing duplicate hops, monitors confirmation windows (`10 s`), and suppresses failing routes (`60 s`) before retrying.
- **Unmodeled protocol subsystems**:
  - **Fragmentation & reassembly** (`FRAGMENT = 0x20`, route inheritance on v2 fragments, 128 concurrent assemblies, 30 s timeout, targeted fragment resync).
  - **Gossip history sync** (`REQUEST_SYNC = 0x21`, strictly link-local / never relayed, ~400 B GCS filters at 1% FPR, 15 s cadence, 6 h public retention, 20 ms paced responses).
  - **Store-and-forward / couriers & sender outbox** (`COURIER_ENVELOPE = 0x04`, spray-and-wait copy budget of 4, trust-tier quotas, outbox retry caps).
  - **Additional message types & framing overhead**: `LEAVE (0x03)`, `NOISE_HANDSHAKE (0x10)` & `NOISE_ENCRYPTED (0x11)` (including 256/512/1024/2048 B padding buckets and handshake RTT), `FILE_TRANSFER (0x22)`, `BOARD_POST (0x23)`, `PREKEY_BUNDLE (0x24)`, `GROUP_MESSAGE (0x25)`, `PING (0x26)` / `PONG (0x27)`, `VOICE_FRAME (0x29)`, and payload compression (`IS_COMPRESSED = 0x04`).

### Telemetry & Benchmarking
- Metrics currently live only in React UI state (`MainControlPanel` packet counts). Measurement of **delivery ratio, end-to-end latency percentiles, goodput vs. relay/duplicate overhead, airtime utilization, source-route hit rate, and convergence time** belongs inside `src/simulation/` so both the UI and headless batch scenarios consume the same authoritative metrics.

## 6. Coding Style & Conventions

- **Formatting**: 4-space indentation, single quotes `'`, always use semicolons `;`, ES5 trailing commas. Respect existing file style.
- **Imports**: Group in order separated by a blank line: (1) External libraries, (2) Internal modules, (3) Styles/assets.
- **Naming**:
  - Files: `PascalCase` for classes and React components (`SimulationEngine.ts`, `PersonNode.tsx`); `camelCase` for utility modules (`colorUtils.ts`).
  - Symbols: `PascalCase` for classes/interfaces/enums/types; `camelCase` for variables/functions/methods; `UPPER_SNAKE_CASE` for constants; `is`/`has`/`should` prefixes for booleans.
- **TypeScript**:
  - `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`.
  - Avoid `any` and non-null assertions `!` in production code (use explicit interfaces, optional chaining `?.`, and narrowing).
  - Define explicit return types on exported functions and public methods.
- **React & Three.js Performance**:
  - Keep 60 FPS position/visual updates in refs + `useFrame`, never in React state.
  - Always unsubscribe `EventBus` and `LogManager` listeners in `useEffect` cleanup functions.
  - Keep React components focused (prefer one component per file for new UI code).
- **Logging & Error Handling**:
  - Use `LogManager` (`logManager.log(level, category, message, entityId, details)`) rather than `console.log` inside simulation loops.
  - Guard protocol decoding and external fetches (`OSMFetcher`) to fail gracefully without crashing the simulation loop.

## 7. Testing & Verification

- **Framework**: Vitest (`describe` -> `it` -> `expect`).
- **Required Coverage**:
  - Any change to `src/protocol/` requires unit tests in `src/protocol/__tests__/` verifying exact byte layout and edge cases against the upstream BitChat wire spec.
  - Any change to `src/simulation/` (RF model, connection lifecycle, relay/routing logic, environment physics, metrics) requires deterministic unit tests using manual `engine.step(dt, simTime)` stepping without wall-clock sleeps.
- **Before Finishing a Task**: Run `npx tsc --noEmit && npx vitest run` (and `npm run build` for larger or UI-affecting changes).

## 8. Git & Privacy Hygiene

- **Commits**: Small, atomic commits using Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
- **No Local Paths or Personal Data**: Never commit local filesystem paths, usernames, real personal coordinates, or production logs in code, docs, tests, or fixtures. Use synthetic coordinates/identities in tests and public GitHub URLs when referencing upstream BitChat repositories.
