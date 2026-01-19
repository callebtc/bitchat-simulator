import React, { createContext, useContext } from 'react';
import { usePersistedState } from '../../utils/usePersistedState';

interface VisualizationContextType {
    showAnnouncePackets: boolean;
    setShowAnnouncePackets: (show: boolean) => void;
    highlightOwnMesh: boolean;
    setHighlightOwnMesh: (show: boolean) => void;
}

const VisualizationContext = createContext<VisualizationContextType>({
    showAnnouncePackets: true,
    setShowAnnouncePackets: () => {},
    highlightOwnMesh: true,
    setHighlightOwnMesh: () => {},
});

export const VisualizationProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    // Persist this setting so it remembers user preference
    const [showAnnouncePackets, setShowAnnouncePackets] = usePersistedState('viz_show_announce', true);
    const [highlightOwnMesh, setHighlightOwnMesh] = usePersistedState('viz_highlight_own_mesh', true);

    return (
        <VisualizationContext.Provider value={{ 
            showAnnouncePackets, 
            setShowAnnouncePackets,
            highlightOwnMesh,
            setHighlightOwnMesh
        }}>
            {children}
        </VisualizationContext.Provider>
    );
};

export const useVisualization = () => useContext(VisualizationContext);
