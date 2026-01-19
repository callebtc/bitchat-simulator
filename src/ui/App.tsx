import { useEffect } from 'react';
import { SimulationProvider, useSimulation } from './context/SimulationContext';
import { SelectionProvider } from './context/SelectionContext';
import { Scene } from './scene/Scene';
import { InspectorPanel } from './hud/InspectorPanel';
import { MainControlPanel } from './hud/MainControlPanel';

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

import { LogPanel } from './hud/LogPanel';

// ... (previous imports)

function App() {
  return (
    <SimulationProvider>
        <SelectionProvider>
            <SimulationController />
            <Scene />
            <MainControlPanel />
            <InspectorPanel />
            <LogPanel />
        </SelectionProvider>
    </SimulationProvider>
  );
}

export default App;
