import { useEffect } from 'react';
import { SimulationProvider, useSimulation } from './context/SimulationContext';
import { SelectionProvider } from './context/SelectionContext';
import { Scene } from './scene/Scene';
import { InspectorPanel } from './hud/InspectorPanel';
import { Controls } from './hud/Controls';

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

import { Terminal } from './hud/Terminal';

// ... (previous imports)

function App() {
  return (
    <SimulationProvider>
        <SelectionProvider>
            <SimulationController />
            <Scene />
            <div className="absolute top-4 left-4 text-white pointer-events-none">
                <h1 className="text-xl font-bold">Bitchat Simulator</h1>
                <p className="text-sm opacity-70">Phase 6: Interactive</p>
            </div>
            <Controls />
            <InspectorPanel />
            <Terminal />
        </SelectionProvider>
    </SimulationProvider>
  );
}

export default App;
