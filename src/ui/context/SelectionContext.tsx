import React, { createContext, useContext, useState } from 'react';

export type SelectionType = 'node' | 'connection';

interface SelectionContextType {
    selectedId: string | null;
    selectionType: SelectionType | null;
    chatRecipientId: string | null;
    isDragging: boolean;
    highlightedId: string | null;
    viewCenter: { x: number, y: number };
    select: (id: string | null, type: SelectionType | null) => void;
    setChatRecipientId: (id: string | null) => void;
    setDragging: (dragging: boolean) => void;
    setHighlightedId: (id: string | null) => void;
    setViewCenter: (pos: { x: number, y: number }) => void;
}

const SelectionContext = createContext<SelectionContextType>({
    selectedId: null,
    selectionType: null,
    chatRecipientId: null,
    isDragging: false,
    highlightedId: null,
    viewCenter: { x: 0, y: 0 },
    select: () => {},
    setChatRecipientId: () => {},
    setDragging: () => {},
    setHighlightedId: () => {},
    setViewCenter: () => {}
});

export const SelectionProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectionType, setSelectionType] = useState<SelectionType | null>(null);
    const [chatRecipientId, setChatRecipientId] = useState<string | null>(null);
    const [isDragging, setDragging] = useState(false);
    const [highlightedId, setHighlightedId] = useState<string | null>(null);
    const [viewCenter, setViewCenter] = useState({ x: 0, y: 0 });
    
    const select = (id: string | null, type: SelectionType | null) => {
        setSelectedId(id);
        setSelectionType(type);
        if (!id) setChatRecipientId(null); // Clear DM target on deselect
    };

    return (
        <SelectionContext.Provider value={{ 
            selectedId, selectionType, chatRecipientId, isDragging, highlightedId, viewCenter,
            select, setChatRecipientId, setDragging, setHighlightedId, setViewCenter 
        }}>
            {children}
        </SelectionContext.Provider>
    );
};

export const useSelection = () => useContext(SelectionContext);
