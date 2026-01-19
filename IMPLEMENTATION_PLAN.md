# Implementation Plan - Animation & Interaction Updates

## 1. Packet "Knock" Animation
The user wants a visual "knock" animation whenever a node sends a packet.
*   **Idea**: A quick scale pulse (e.g., 1.0 -> 1.3 -> 1.0) on the `PersonNode` mesh when a `packet_transmitted` event originates from it.
*   **Mechanism**:
    *   `PersonNode.tsx` will listen to `engine.events`.
    *   On `packet_transmitted`: Check if `fromId === id`.
    *   If match: Trigger a spring animation (using `@react-spring/three` if available, or just a simple `useFrame` interpolation). Since I shouldn't assume libraries, I'll use `useFrame` with a transient state ref.

## 2. Interaction Plane Logic Update
The user wants:
*   **Left Click**: Select / Deselect.
*   **Right Click**: Move target (RTS style).
Currently, left clicking the background while selected triggers a move.

*   **Changes in `InteractionPlane.tsx`**:
    *   `handlePointerDown`:
        *   Check `e.button`.
        *   **Left (0)**: Always deselect (unless handled by dragging logic which stops propagation).
        *   **Right (2)**: If `selectedId` exists, set target.
*   **Changes in `PersonNode.tsx`**:
    *   `handlePointerDown`: Ensure it stops propagation so clicking a node doesn't trigger the background deselect. (Already does).

## Execution Steps
1.  **Modify `PersonNode.tsx`**: Add "Knock" animation logic.
2.  **Modify `InteractionPlane.tsx`**: Update click handling logic for Left vs Right click.

## Verification
*   **Knock**: When "Announcing" is ON, nodes should pulse every 5 seconds (or whenever they relay).
*   **Click**:
    *   Select Node -> Left Click Background -> Deselects.
    *   Select Node -> Right Click Background -> Node moves to target.
