import React, { createContext, useContext, useMemo, useState } from 'react';

import { usePersistedState } from '../../utils/usePersistedState';

interface LayoutContextType {
    bottomPanelHeight: number;
    setBottomPanelHeight: (h: number) => void;
    /** Whether the simulated phone is expanded (false = docked as a small tab). */
    phoneOpen: boolean;
    setPhoneOpen: (open: boolean) => void;
}

const LayoutContext = createContext<LayoutContextType>({
    bottomPanelHeight: 36,
    setBottomPanelHeight: () => {},
    phoneOpen: true,
    setPhoneOpen: () => {},
});

export const LayoutProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [bottomPanelHeight, setBottomPanelHeight] = useState(36);
    const [phoneOpen, setPhoneOpen] = usePersistedState('phone_open', true);
    const value = useMemo(
        () => ({ bottomPanelHeight, setBottomPanelHeight, phoneOpen, setPhoneOpen }),
        [bottomPanelHeight, phoneOpen, setPhoneOpen]
    );
    return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
};

export const useLayout = (): LayoutContextType => useContext(LayoutContext);
