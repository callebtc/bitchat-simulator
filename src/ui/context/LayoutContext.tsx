import React, { createContext, useContext, useState } from 'react';

interface LayoutContextType {
    bottomPanelHeight: number;
    setBottomPanelHeight: (h: number) => void;
}

const LayoutContext = createContext<LayoutContextType>({
    bottomPanelHeight: 32, // Default h-8 (32px)
    setBottomPanelHeight: () => {}
});

export const LayoutProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    const [bottomPanelHeight, setBottomPanelHeight] = useState(32);

    return (
        <LayoutContext.Provider value={{ bottomPanelHeight, setBottomPanelHeight }}>
            {children}
        </LayoutContext.Provider>
    );
};

export const useLayout = () => useContext(LayoutContext);
