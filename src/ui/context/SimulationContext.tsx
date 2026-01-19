import React, { createContext, useContext } from 'react';
import { SimulationEngine } from '../../simulation/SimulationEngine';

const engine = new SimulationEngine();

const SimulationContext = createContext<SimulationEngine>(engine);

export const SimulationProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
    return (
        <SimulationContext.Provider value={engine}>
            {children}
        </SimulationContext.Provider>
    );
};

export const useSimulation = () => useContext(SimulationContext);

