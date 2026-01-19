import React, { createContext, useContext, useState } from 'react';

interface SelectionContextType {
    selectedId: string | null;
    setSelectedId: (id: string | null) => void;
}

const SelectionContext = createContext<SelectionContextType>({
    selectedId: null,
    setSelectedId: () => {}
});

export const SelectionProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    return (
        <SelectionContext.Provider value={{ selectedId, setSelectedId }}>
            {children}
        </SelectionContext.Provider>
    );
};

export const useSelection = () => useContext(SelectionContext);
