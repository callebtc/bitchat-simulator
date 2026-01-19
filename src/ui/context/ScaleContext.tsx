import React, { createContext, useContext, useState } from 'react';

interface ScaleData {
    width: number;
    label: string;
}

interface ScaleContextType {
    scaleData: ScaleData;
    setScaleData: (data: ScaleData) => void;
}

const ScaleContext = createContext<ScaleContextType>({
    scaleData: { width: 0, label: '' },
    setScaleData: () => {}
});

export const ScaleProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    const [scaleData, setScaleData] = useState<ScaleData>({ width: 0, label: '' });

    return (
        <ScaleContext.Provider value={{ scaleData, setScaleData }}>
            {children}
        </ScaleContext.Provider>
    );
};

export const useScale = () => useContext(ScaleContext);
