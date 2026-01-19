import { useEffect } from 'react';
import { SimulationProvider, useSimulation } from './context/SimulationContext';
import { SelectionProvider } from './context/SelectionContext';
import { Scene } from './scene/Scene';
import { InspectorPanel } from './hud/InspectorPanel';
import { MainControlPanel } from './hud/MainControlPanel';
import { BottomPanel } from './hud/BottomPanel';

import { setupDemo } from '../simulation/DemoSetup';

const SimulationController = () => {
    const engine = useSimulation();
    
    useEffect(() => {
        setupDemo(engine, 5); // Auto init
        engine.start();
        return () => engine.stop();
    }, [engine]);
    
    return null;
};

// ... (previous imports)

function App() {
  return (
    <SimulationProvider>
        <SelectionProvider>
            <SimulationController />
            <Scene />
            <MainControlPanel />
            <InspectorPanel />
            <BottomPanel />
        </SelectionProvider>
    </SimulationProvider>
  );
}

export default App;
