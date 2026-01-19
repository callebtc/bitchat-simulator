import React, { createContext, useContext } from 'react';
import { usePersistedState } from '../../utils/usePersistedState';

interface VisualizationContextType {
    showAnnouncePackets: boolean;
    setShowAnnouncePackets: (show: boolean) => void;
}

const VisualizationContext = createContext<VisualizationContextType>({
    showAnnouncePackets: true,
    setShowAnnouncePackets: () => {},
});

export const VisualizationProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    // Persist this setting so it remembers user preference
    const [showAnnouncePackets, setShowAnnouncePackets] = usePersistedState('viz_show_announce', true);

    return (
        <VisualizationContext.Provider value={{ 
            showAnnouncePackets, 
            setShowAnnouncePackets 
        }}>
            {children}
        </VisualizationContext.Provider>
    );
};

export const useVisualization = () => useContext(VisualizationContext);
