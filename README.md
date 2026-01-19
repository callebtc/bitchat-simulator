# Bitchat Simulator

A high-fidelity 3D simulation environment for testing and visualizing the Bitchat mesh networking protocol. Grounded in real-world physics and geographic data.

## Overview

Bitchat Simulator provides a sandbox to observe the behavior of a decentralized, binary-packed mesh protocol in complex urban environments. It bridges the gap between theoretical network models and real-world deployment by simulating Bluetooth Low Energy (BLE) signal characteristics, material-aware signal attenuation, and autonomous agent navigation using OpenStreetMap data.

## Key Features

### Protocol & Mesh Networking
- **Custom Binary Protocol**: Implementation of a versioned binary format using `DataView` for efficient byte-level packing. Supports 64-bit addressing and bitmask-driven optional headers.
- **Flood Routing**: Robust mesh propagation with TTL decay, duplicate detection via FNV-1a hashing, and split-horizon logic.
- **BLE Signal Model**: Real-time RSSI calculation using log-distance path loss, incorporating configurable noise and temporal smoothing.
- **Material-Aware Attenuation**: Dynamic signal degradation as packets pass through building geometries, simulating real-world RF interference in urban canyons.

### Environment & Navigation
- **OSM Integration**: Real-world building data retrieval via Overpass API, converted into local Cartesian coordinates for simulation.
- **Visibility Graph Pathfinding**: High-performance A* navigation across inflated building polygons to ensure realistic agent movement with proper wall clearance.
- **Persistence Layer**: Intelligent caching of visibility graphs using geometry hashing to allow near-instant reload of complex urban maps.

### Simulation Architecture
- **Decoupled Engine**: A standalone Simulation Engine running a 60fps loop independent of React, managing physics, kinematics, and networking logic.
- **Event-Driven Pipeline**: Granular synchronization between the simulation core and the UI layer via a centralized `EventBus`.
- **R3F Rendering**: High-performance 3D visualization using React Three Fiber, with direct reference manipulation in the `useFrame` loop to ensure stable 60fps performance during high-frequency state updates.

## Technical Implementation

### Autonomous Agents
Agents in the simulator operate with a high degree of autonomy:
- **Slide Physics**: Velocity projection against building normals to prevent clipping and simulate natural wall-following behavior.
- **State Machines**: Integrated device states (Scanning, Advertising, Connected) that drive protocol-level interactions.

### Development Tooling
- **Real-time Inspector**: Deep-dive into individual agent states, including current neighbors, active connections, and packet buffers.
- **Protocol Terminal**: A low-level log manager to monitor mesh traffic and packet-level metadata.
- **Visual Debugging**: Toggles for visibility graphs, connection heatmaps, and pathfinding waypoints.

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm

### Installation
```bash
npm install
```

### Development
```bash
npm run dev
```

### Testing
The project maintains a rigorous test suite for protocol integrity and environment physics:
```bash
npm run test
```

## Architecture
- **`/src/simulation`**: Core logic, physics, and protocol implementation. (Independent of UI)
- **`/src/protocol`**: Binary encoding/decoding and packet structures.
- **`/src/ui`**: React, React Three Fiber, and HUD components.
- **`/src/events`**: Global event orchestration.

## License
MIT
