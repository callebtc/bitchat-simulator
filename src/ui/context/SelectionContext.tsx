import React, { createContext, useContext, useState, useRef, useCallback, useMemo } from 'react';

export type SelectionType = 'node' | 'connection';

interface SelectionContextType {
    selectedId: string | null;
    selectionType: SelectionType | null;
    chatRecipientId: string | null;
    isDragging: boolean;
    highlightedId: string | null;
    /** Live mutable camera center ref (updated in useFrame with ZERO React re-renders). */
    viewCenterRef: React.MutableRefObject<{ x: number; y: number }>;
    /** Convenience getter returning the current camera center. */
    viewCenter: { x: number; y: number };
    select: (id: string | null, type: SelectionType | null) => void;
    setChatRecipientId: (id: string | null) => void;
    setDragging: (dragging: boolean) => void;
    setHighlightedId: (id: string | null) => void;
    setViewCenter: (pos: { x: number; y: number }) => void;
}

const defaultViewCenterRef = { current: { x: 0, y: 0 } };

const SelectionContext = createContext<SelectionContextType>({
    selectedId: null,
    selectionType: null,
    chatRecipientId: null,
    isDragging: false,
    highlightedId: null,
    viewCenterRef: defaultViewCenterRef,
    viewCenter: { x: 0, y: 0 },
    select: () => {},
    setChatRecipientId: () => {},
    setDragging: () => {},
    setHighlightedId: () => {},
    setViewCenter: () => {},
});

export const SelectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectionType, setSelectionType] = useState<SelectionType | null>(null);
    const [chatRecipientId, setChatRecipientId] = useState<string | null>(null);
    const [isDragging, setDragging] = useState(false);
    const [highlightedId, setHighlightedId] = useState<string | null>(null);
    const viewCenterRef = useRef({ x: 0, y: 0 });

    const select = useCallback((id: string | null, type: SelectionType | null) => {
        setSelectedId(id);
        setSelectionType(type);
        if (!id) setChatRecipientId(null);
    }, []);

    const setViewCenter = useCallback((pos: { x: number; y: number }) => {
        viewCenterRef.current.x = pos.x;
        viewCenterRef.current.y = pos.y;
    }, []);

    const value = useMemo<SelectionContextType>(
        () => ({
            selectedId,
            selectionType,
            chatRecipientId,
            isDragging,
            highlightedId,
            viewCenterRef,
            get viewCenter() {
                return viewCenterRef.current;
            },
            select,
            setChatRecipientId,
            setDragging,
            setHighlightedId,
            setViewCenter,
        }),
        [selectedId, selectionType, chatRecipientId, isDragging, highlightedId, select, setViewCenter]
    );

    return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};

export const useSelection = () => useContext(SelectionContext);
