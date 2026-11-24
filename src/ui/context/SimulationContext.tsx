import React, { createContext, useContext } from 'react';
import { SimulationEngine } from '../../simulation/SimulationEngine';

const engine = new SimulationEngine();

// Dev-only handle for scripting scenarios from the browser console.
if (import.meta.env.DEV) {
    (window as unknown as { __bitchat?: { engine: SimulationEngine } }).__bitchat = { engine };
}

const SimulationContext = createContext<SimulationEngine>(engine);

export const SimulationProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    return (
        <SimulationContext.Provider value={engine}>
            {children}
        </SimulationContext.Provider>
    );
};

export const useSimulation = () => useContext(SimulationContext);

