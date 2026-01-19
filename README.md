# Bitchat Simulator

A web-based simulator for the Bitchat mesh network protocol.

## Features

- **Protocol Simulation**: Implements `BinaryProtocol` and `TLV` encoding compatible with Bitchat Android/iOS.
- **Mesh Logic**: Simulates device discovery, connection forming (BLE proximity), flooding, and gossip.
- **Visualization**: Interactive 2D visualization using React and Three.js.
- **Inspection**: Click nodes to inspect their routing tables, connections, and logs.

## Getting Started

1.  Install dependencies:
    ```bash
    npm install
    ```

2.  Run the simulator:
    ```bash
    npm run dev
    ```

3.  Open your browser at `http://localhost:5173`.

## Controls

- **Add Node**: Spawns a new node with random velocity.
- **Reset / Init**: Resets the simulation with 5 nodes.
- **Click Node**: Inspect node details (Peers, Connections).
- **Drag Node**: Move nodes to break/form connections dynamically.

## Architecture

- `src/protocol`: Binary packet encoding/decoding.
- `src/simulation`: Core physics and connection logic (`SimulationEngine`).
- `src/simulation/AppLayer`: Application logic (`BitchatAppSimulator`, `PeerManager`).
- `src/ui`: React + Three.js components.
