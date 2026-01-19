import React, { createContext, useContext, useState } from 'react';

export type SelectionType = 'node' | 'connection';

interface SelectionContextType {
    selectedId: string | null;
    selectionType: SelectionType | null;
    chatRecipientId: string | null;
    isDragging: boolean;
    select: (id: string | null, type: SelectionType | null) => void;
    setChatRecipientId: (id: string | null) => void;
    setDragging: (dragging: boolean) => void;
}

const SelectionContext = createContext<SelectionContextType>({
    selectedId: null,
    selectionType: null,
    chatRecipientId: null,
    isDragging: false,
    select: () => {},
    setChatRecipientId: () => {},
    setDragging: () => {}
});

export const SelectionProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectionType, setSelectionType] = useState<SelectionType | null>(null);
    const [chatRecipientId, setChatRecipientId] = useState<string | null>(null);
    const [isDragging, setDragging] = useState(false);
    
    const select = (id: string | null, type: SelectionType | null) => {
        setSelectedId(id);
        setSelectionType(type);
        if (!id) setChatRecipientId(null); // Clear DM target on deselect
    };

    return (
        <SelectionContext.Provider value={{ selectedId, selectionType, chatRecipientId, isDragging, select, setChatRecipientId, setDragging }}>
            {children}
        </SelectionContext.Provider>
    );
};

export const useSelection = () => useContext(SelectionContext);
