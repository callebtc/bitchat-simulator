import { useEffect } from 'react';
import { SimulationProvider, useSimulation } from './context/SimulationContext';
import { SelectionProvider } from './context/SelectionContext';
import { Scene } from './scene/Scene';
import { InspectorPanel } from './hud/InspectorPanel';
import { MainControlPanel } from './hud/MainControlPanel';
import { BottomPanel } from './hud/BottomPanel';

import { setupDemo } from '../simulation/DemoSetup';

import { LayoutProvider } from './context/LayoutContext';
import { ScaleProvider } from './context/ScaleContext';
import { ScaleOverlay } from './hud/ScaleIndicator';

const SimulationController = () => {
    const engine = useSimulation();
    
    useEffect(() => {
        setupDemo(engine, 5); // Auto init
        engine.start();
        return () => engine.stop();
    }, [engine]);
    
    return null;
};

const LayoutContent = () => {
    return (
        <SelectionProvider>
            <SimulationController />
            <Scene />
            <MainControlPanel />
            <InspectorPanel />
            <BottomPanel />
            <ScaleOverlay />
        </SelectionProvider>
    );
};

function App() {
  return (
    <LayoutProvider>
        <ScaleProvider>
            <SimulationProvider>
                <LayoutContent />
            </SimulationProvider>
        </ScaleProvider>
    </LayoutProvider>
  );
}

export default App;
