import React, { createContext, useContext, useMemo } from 'react';

import { usePersistedState } from '../../utils/usePersistedState';

/** How building volumes are drawn. `glass` and `blueprint` keep indoor devices visible. */
export type BuildingStyle = 'solid' | 'glass' | 'blueprint';
/** `high` enables shadows + bloom; `balanced` keeps bloom; `fast` disables both. */
export type GraphicsQuality = 'high' | 'balanced' | 'fast';

interface VisualizationContextType {
    showAnnouncePackets: boolean;
    setShowAnnouncePackets: (show: boolean) => void;
    highlightOwnMesh: boolean;
    setHighlightOwnMesh: (show: boolean) => void;
    /** Local solar time in hours [0, 24). Drives sun, sky, fog, and lit windows. */
    timeOfDay: number;
    setTimeOfDay: (hours: number) => void;
    buildingStyle: BuildingStyle;
    setBuildingStyle: (style: BuildingStyle) => void;
    graphicsQuality: GraphicsQuality;
    setGraphicsQuality: (q: GraphicsQuality) => void;
    showLinks: boolean;
    setShowLinks: (show: boolean) => void;
    showLabels: boolean;
    setShowLabels: (show: boolean) => void;
    showChatBubbles: boolean;
    setShowChatBubbles: (show: boolean) => void;
    showRadioPulses: boolean;
    setShowRadioPulses: (show: boolean) => void;
}

const noop = () => {};

const VisualizationContext = createContext<VisualizationContextType>({
    showAnnouncePackets: true,
    setShowAnnouncePackets: noop,
    highlightOwnMesh: true,
    setHighlightOwnMesh: noop,
    timeOfDay: 19.5,
    setTimeOfDay: noop,
    buildingStyle: 'solid',
    setBuildingStyle: noop,
    graphicsQuality: 'high',
    setGraphicsQuality: noop,
    showLinks: true,
    setShowLinks: noop,
    showLabels: true,
    setShowLabels: noop,
    showChatBubbles: true,
    setShowChatBubbles: noop,
    showRadioPulses: true,
    setShowRadioPulses: noop,
});

export const VisualizationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [showAnnouncePackets, setShowAnnouncePackets] = usePersistedState('viz_show_announce', true);
    const [highlightOwnMesh, setHighlightOwnMesh] = usePersistedState('viz_highlight_own_mesh', true);
    const [timeOfDay, setTimeOfDay] = usePersistedState('viz_time_of_day', 19.5);
    const [buildingStyle, setBuildingStyle] = usePersistedState<BuildingStyle>('viz_building_style', 'solid');
    const [graphicsQuality, setGraphicsQuality] = usePersistedState<GraphicsQuality>('viz_quality', 'high');
    const [showLinks, setShowLinks] = usePersistedState('viz_show_links', true);
    const [showLabels, setShowLabels] = usePersistedState('viz_show_labels', true);
    const [showChatBubbles, setShowChatBubbles] = usePersistedState('viz_chat_bubbles', true);
    const [showRadioPulses, setShowRadioPulses] = usePersistedState('viz_radio_pulses', true);

    const value = useMemo<VisualizationContextType>(
        () => ({
            showAnnouncePackets,
            setShowAnnouncePackets,
            highlightOwnMesh,
            setHighlightOwnMesh,
            timeOfDay,
            setTimeOfDay,
            buildingStyle,
            setBuildingStyle,
            graphicsQuality,
            setGraphicsQuality,
            showLinks,
            setShowLinks,
            showLabels,
            setShowLabels,
            showChatBubbles,
            setShowChatBubbles,
            showRadioPulses,
            setShowRadioPulses,
        }),
        [
            showAnnouncePackets,
            setShowAnnouncePackets,
            highlightOwnMesh,
            setHighlightOwnMesh,
            timeOfDay,
            setTimeOfDay,
            buildingStyle,
            setBuildingStyle,
            graphicsQuality,
            setGraphicsQuality,
            showLinks,
            setShowLinks,
            showLabels,
            setShowLabels,
            showChatBubbles,
            setShowChatBubbles,
            showRadioPulses,
            setShowRadioPulses,
        ]
    );

    return <VisualizationContext.Provider value={value}>{children}</VisualizationContext.Provider>;
};

export const useVisualization = (): VisualizationContextType => useContext(VisualizationContext);
