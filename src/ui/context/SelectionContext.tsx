import React, { createContext, useContext, useState } from 'react';

export type SelectionType = 'node' | 'connection';

interface SelectionContextType {
    selectedId: string | null;
    selectionType: SelectionType | null;
    isDragging: boolean;
    select: (id: string | null, type: SelectionType | null) => void;
    setDragging: (dragging: boolean) => void;
}

const SelectionContext = createContext<SelectionContextType>({
    selectedId: null,
    selectionType: null,
    isDragging: false,
    select: () => {},
    setDragging: () => {}
});

export const SelectionProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectionType, setSelectionType] = useState<SelectionType | null>(null);
    const [isDragging, setDragging] = useState(false);
    
    const select = (id: string | null, type: SelectionType | null) => {
        setSelectedId(id);
        setSelectionType(type);
    };

    return (
        <SelectionContext.Provider value={{ selectedId, selectionType, isDragging, select, setDragging }}>
            {children}
        </SelectionContext.Provider>
    );
};

export const useSelection = () => useContext(SelectionContext);
