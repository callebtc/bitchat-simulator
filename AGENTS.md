# Agent Guidelines for Bitchat Simulator

This document provides context and rules for AI agents operating in this codebase.

## 1. Environment & Commands

- **Runtime**: Node.js, TypeScript 5.x
- **Frameworks**: React 18, Vite, Vitest, Tailwind CSS, Three.js (@react-three/fiber)
- **Package Manager**: npm

### Key Commands
- **Build**: `npm run build` (runs `tsc && vite build`)
- **Lint**: `npm run lint` (runs `eslint . --ext ts,tsx`)
- **Test All**: `npm run test` (runs `vitest`)
- **Test Single File**: `npx vitest run path/to/file.test.ts`
- **Type Check**: `npx tsc --noEmit`

## 2. Code Style & Conventions

### Formatting
- **Indentation**: The codebase has mixed indentation.
  - Core logic / Simulation files (`src/simulation`, `src/protocol`): **4 spaces**.
  - React components (`src/ui`): **Mostly 4 spaces**, but some files (e.g., `App.tsx`) use 2 spaces.
  - **Rule**: Inspect the file you are editing and match its existing indentation. New files should default to **4 spaces**.
- **Quotes**: Single quotes `'` preferred, but respect existing file usage.
- **Semicolons**: Always use semicolons.

### Naming
- **Files**: PascalCase for React components (`PersonNode.tsx`) and Classes (`SimulationEngine.ts`). CamelCase for utils if applicable.
- **Components/Classes**: PascalCase (`SimulationEngine`, `PersonNode`).
- **Variables/Functions**: camelCase (`isRunning`, `addPerson`).
- **Constants**: UPPER_SNAKE_CASE (`CONNECT_RADIUS`, `HEADER_SIZE_V1`).

### TypeScript
- **Strict Mode**: Enabled. No implicit `any`.
- **Interfaces**: Use `interface` for Props and public API definitions.
- **Nullability**: Handle `null` and `undefined` explicitly. Use optional chaining (`?.`) and nullish coalescing (`??`).
- **Non-null Assertion**: Avoid `!` in production code; acceptable in tests if existence is guaranteed by setup.

## 3. Architecture & Patterns

### Simulation vs UI Separation
This project strictly separates the "Simulation Engine" from the "UI/View".
- **Simulation Layer** (`src/simulation/`):
  - Class-based (`SimulationEngine`, `BitchatPerson`).
  - Manages state, physics, networking logic, and game loop.
  - **Independent of React**. Does not import React or Three.js (except for types if needed).
  - Uses `EventBus` (`src/events/`) to notify the UI of changes.
  - `SimulationEngine` runs its own `requestAnimationFrame` loop.

- **UI Layer** (`src/ui/`):
  - React + React Three Fiber (R3F).
  - Consumes simulation state via Context (`SimulationContext`).
  - **Synchronization**:
    - **React State**: Used for UI overlays (HUD).
    - **R3F `useFrame`**: Used to sync 3D object positions with simulation objects every frame (e.g., `PersonNode.tsx`).
    - **Events**: Subscribes to `EventBus` for one-off events (e.g., connection formed/broken).

### Protocol (`src/protocol/`)
- Handles binary encoding/decoding (`BinaryProtocol.ts`).
- Uses `DataView` for low-level byte manipulation.
- **Testing**: Heavy reliance on unit tests in `__tests__` directories. Always add tests when modifying protocol logic.

## 4. Testing Guidelines
- **Framework**: Vitest.
- **Location**: `__tests__` folders co-located with source modules (e.g., `src/protocol/__tests__/`).
- **Style**: `describe`, `it`, `expect` pattern.
- **Requirement**: When modifying logic (especially Protocol or Simulation), run existing tests to ensure no regressions. Write new tests for new logic.

## 5. Common Pitfalls
- **Don't** put simulation logic inside React components. Components should only *render* the simulation state.
- **Don't** use React state (`useState`) for high-frequency updates (like 60fps position changes). Use `useFrame` and direct ref manipulation.
- **Do** check `package.json` for available libraries before adding new ones.

## 6. Git & Commits
- Commit messages should be concise and descriptive (e.g., "fix: handle disconnect event correctly").
- Create small, focused commits.
