import { useEffect } from 'react';
import { SimulationProvider, useSimulation } from './context/SimulationContext';
import { SelectionProvider } from './context/SelectionContext';
import { Scene } from './scene/Scene';
import { InspectorPanel } from './hud/InspectorPanel';
import { MainControlPanel } from './hud/MainControlPanel';
import { BottomPanel } from './hud/BottomPanel';

import { setupDemo } from '../simulation/DemoSetup';

import { LayoutProvider, useLayout } from './context/LayoutContext';

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
    const { bottomPanelHeight } = useLayout();
    
    return (
        <SelectionProvider>
            <SimulationController />
            <Scene bottomPanelHeight={bottomPanelHeight} />
            <MainControlPanel />
            <InspectorPanel />
            <BottomPanel />
        </SelectionProvider>
    );
};

function App() {
  return (
    <LayoutProvider>
        <SimulationProvider>
            <LayoutContent />
        </SimulationProvider>
    </LayoutProvider>
  );
}

export default App;
