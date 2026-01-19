# Agent Guidelines for Bitchat Simulator

This document provides context, rules, and best practices for AI agents operating in this codebase.

## 1. Environment & Commands

- **Runtime**: Node.js, TypeScript 5.x
- **Frameworks**: React 18, Vite, Vitest, Tailwind CSS, Three.js (@react-three/fiber)
- **Package Manager**: npm

### Key Commands
- **Build**: `npm run build` (runs `tsc && vite build`) - Always run before finishing major tasks.
- **Lint**: `npm run lint` (runs `eslint . --ext ts,tsx`) - Must pass with 0 warnings.
- **Test All**: `npm run test` (runs `vitest`) - Run after logic changes.
- **Test Single File**: `npx vitest run src/path/to/file.test.ts`
- **Type Check**: `npx tsc --noEmit` - Ensure no type errors exist.
- **Dev Server**: `npm run dev` - Starts Vite server (usually not needed for agents).

## 2. Directory Structure

Understanding the project layout is crucial for navigation:

- `src/simulation/` - **Core Logic**. Standalone simulation engine.
    - `SimulationEngine.ts`: Main loop and state container.
    - `BitchatPerson.ts`: Represents an entity in the world.
    - `BitchatConnection.ts` & subclasses: Network connection logic.
    - `environment/`: Physics, pathfinding, and obstacles.
- `src/ui/` - **View Layer**. React + Three.js components.
    - `context/`: React Contexts (Simulation, Selection, Layout).
    - `scene/`: 3D World rendering (R3F components).
    - `hud/`: 2D UI overlays (Control panels, inspectors).
- `src/protocol/` - **Binary Protocol**.
    - `BinaryProtocol.ts`: Encoding/decoding logic.
    - `BitchatPacket.ts`: Packet definitions.
- `src/events/` - **Communication**.
    - `EventBus.ts`: Pub/sub system bridging Simulation and UI.
- `src/utils/` - Shared utilities.

## 3. Code Style & Conventions

### Formatting
- **Indentation**: Mixed. **Respect existing file style**.
    - Simulation/Protocol: **4 spaces**.
    - React/UI: Mostly **4 spaces**, check file first.
- **Quotes**: Single quotes `'` preferred.
- **Semicolons**: **Always** use semicolons.
- **Trailing Commas**: ES5 style (objects/arrays).

### Imports
Organize imports in groups, separated by a blank line:
1.  **External Libraries** (`react`, `three`, `vitest`)
2.  **Internal Modules** (`../simulation/Engine`, `./Component`)
3.  **Styles/Assets** (`./styles.css`)

### Naming
- **Files**:
    - React Components/Classes: `PascalCase` (e.g., `PersonNode.tsx`, `SimulationEngine.ts`)
    - Utilities/Functions: `camelCase` (e.g., `colorUtils.ts`)
- **Code Symbols**:
    - Classes/Interfaces/Types: `PascalCase`
    - Variables/Functions/Methods: `camelCase`
    - Constants: `UPPER_SNAKE_CASE` (e.g., `CONNECT_RADIUS`)
    - Boolean variables: Prefix with `is`, `has`, `should` (e.g., `isVisible`).

### TypeScript
- **Strict Mode**: ON. No implicit `any`.
- **Explicit Types**: Define return types for public methods/exported functions.
- **Interfaces vs Types**: Prefer `interface` for object definitions and Props.
- **Nullability**: Handle `null/undefined` explicitly. Use optional chaining `?.`.
- **Non-null Assertions**: Avoid `!`. Only use in tests if absolutely necessary.

## 4. Architecture & Design Patterns

### Simulation vs. UI Separation
This is the most critical architectural rule:
1.  **Simulation is Independent**: The `src/simulation` code **must not** import React, Three.js, or UI code. It runs on its own clock.
2.  **UI is Reactive**: The UI observes the simulation. It does not drive logic directly, but calls methods on `SimulationEngine`.

### State Management
- **Simulation State**: Mutable, managed by `SimulationEngine` and its children. Updated in the game loop.
- **UI State**:
    - **React State**: Use for low-frequency updates (selection, open panels).
    - **Refs + useFrame**: Use for high-frequency updates (60FPS object movement). **DO NOT** store positions in React state.
- **Bridge**: `EventBus` emits events (`person_added`, `packet_transmitted`) that the UI subscribes to.

### EventBus Usage
- Used for decoupling.
- Simulation emits events; UI subscribes in `useEffect`.
- Always clean up listeners in the `return` function of `useEffect`.

```typescript
useEffect(() => {
    const onTick = (data: any) => { /* update */ };
    engine.events.on('tick', onTick);
    return () => engine.events.off('tick', onTick);
}, [engine]);
```

### Protocol Layer
- All data transmission simulation uses `src/protocol`.
- Binary operations use `DataView`.
- **CRITICAL**: Any change to `BinaryProtocol.ts` or packet structures **requires** running and potentially updating unit tests in `src/protocol/__tests__`.

## 5. Testing Strategy

- **Unit Tests**: Required for `src/protocol`, `src/simulation`, and `src/utils`.
- **Framework**: Vitest.
- **Pattern**: `describe` -> `it` -> `expect`.
- **Mocking**: Use Vitest mocks for dependencies if isolating a complex class.
- **Coverage**: Aim for high coverage on Protocol logic (encoding/decoding must be exact).

## 6. Error Handling

- **Simulation**: Use `try/catch` blocks around critical loops (e.g., connection handling) to prevent one failure from crashing the entire engine.
- **Logging**: Use `LogManager` (available in `SimulationEngine`) instead of `console.log` for simulation events.
    - `logManager.log('ERROR', 'COMPONENT', 'Message', objectId)`
- **UI**: Fail gracefully. If a simulation object is missing, render nothing or a placeholder, don't crash the app.

## 7. Git & Workflow

- **Commits**: Small, atomic changes.
- **Messages**: Conventional Commits format.
    - `feat: add new packet type`
    - `fix: resolve collision bug`
    - `refactor: move pathfinding logic`
    - `docs: update agents.md`
- **Verification**: Run `npm run typecheck` and `npm run test` before declaring a task complete.
