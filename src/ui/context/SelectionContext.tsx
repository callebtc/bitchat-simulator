import React, { createContext, useContext, useState, useRef, useCallback, useMemo } from 'react';

export type SelectionType = 'node' | 'connection';

export interface CameraFocusRequest {
    /** Simulation-space target (meters). */
    x: number;
    y: number;
    /** Desired camera distance from target (meters); keeps current distance when omitted. */
    distance?: number;
    nonce: number;
}

interface SelectionContextType {
    selectedId: string | null;
    selectionType: SelectionType | null;
    chatRecipientId: string | null;
    /** Explicit crosshair mode when user clicked the "To:" field to pick a DM target on the map. */
    isPickingRecipient: boolean;
    isDragging: boolean;
    highlightedId: string | null;
    /** One-shot camera focus request (e.g., frame active DM sender & recipient pair). */
    focusRequest: CameraFocusRequest | null;
    /** Live mutable camera center ref (updated in useFrame with ZERO React re-renders). */
    viewCenterRef: React.MutableRefObject<{ x: number; y: number }>;
    /** Convenience getter returning the current camera center. */
    viewCenter: { x: number; y: number };
    select: (id: string | null, type: SelectionType | null) => void;
    /** Atomically select a sender person ID and a DM recipient peerIDHex. */
    selectChatPair: (senderPersonId: string, recipientPeerHex: string | null) => void;
    setChatRecipientId: (id: string | null) => void;
    setPickingRecipient: (picking: boolean) => void;
    setDragging: (dragging: boolean) => void;
    setHighlightedId: (id: string | null) => void;
    setViewCenter: (pos: { x: number; y: number }) => void;
    requestCameraFocus: (x: number, y: number, distance?: number) => void;
}

const defaultViewCenterRef = { current: { x: 0, y: 0 } };

const SelectionContext = createContext<SelectionContextType>({
    selectedId: null,
    selectionType: null,
    chatRecipientId: null,
    isPickingRecipient: false,
    isDragging: false,
    highlightedId: null,
    focusRequest: null,
    viewCenterRef: defaultViewCenterRef,
    viewCenter: { x: 0, y: 0 },
    select: () => {},
    selectChatPair: () => {},
    setChatRecipientId: () => {},
    setPickingRecipient: () => {},
    setDragging: () => {},
    setHighlightedId: () => {},
    setViewCenter: () => {},
    requestCameraFocus: () => {},
});

export const SelectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectionType, setSelectionType] = useState<SelectionType | null>(null);
    const [chatRecipientId, setChatRecipientIdState] = useState<string | null>(null);
    const [isPickingRecipient, setPickingRecipient] = useState(false);
    const [isDragging, setDragging] = useState(false);
    const [highlightedId, setHighlightedId] = useState<string | null>(null);
    const [focusRequest, setFocusRequest] = useState<CameraFocusRequest | null>(null);
    const viewCenterRef = useRef({ x: 0, y: 0 });
    const focusNonceRef = useRef(0);

    const select = useCallback((id: string | null, type: SelectionType | null) => {
        setSelectedId(id);
        setSelectionType(type);
        setPickingRecipient(false);
        if (!id || type !== 'node') {
            setChatRecipientIdState(null);
        }
    }, []);

    const selectChatPair = useCallback((senderPersonId: string, recipientPeerHex: string | null) => {
        setSelectedId(senderPersonId);
        setSelectionType('node');
        setChatRecipientIdState(recipientPeerHex);
        setPickingRecipient(false);
    }, []);

    const setChatRecipientId = useCallback((id: string | null) => {
        setChatRecipientIdState(id);
        if (id !== null) {
            setPickingRecipient(false);
        }
    }, []);

    const setViewCenter = useCallback((pos: { x: number; y: number }) => {
        viewCenterRef.current.x = pos.x;
        viewCenterRef.current.y = pos.y;
    }, []);

    const requestCameraFocus = useCallback((x: number, y: number, distance?: number) => {
        focusNonceRef.current += 1;
        setFocusRequest({ x, y, distance, nonce: focusNonceRef.current });
    }, []);

    const value = useMemo<SelectionContextType>(
        () => ({
            selectedId,
            selectionType,
            chatRecipientId,
            isPickingRecipient,
            isDragging,
            highlightedId,
            focusRequest,
            viewCenterRef,
            get viewCenter() {
                return viewCenterRef.current;
            },
            select,
            selectChatPair,
            setChatRecipientId,
            setPickingRecipient,
            setDragging,
            setHighlightedId,
            setViewCenter,
            requestCameraFocus,
        }),
        [
            selectedId,
            selectionType,
            chatRecipientId,
            isPickingRecipient,
            isDragging,
            highlightedId,
            focusRequest,
            select,
            selectChatPair,
            setChatRecipientId,
            setViewCenter,
            requestCameraFocus,
        ]
    );

    return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};

export const useSelection = () => useContext(SelectionContext);
