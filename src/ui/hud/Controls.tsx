import React from 'react';
import { useSimulation } from '../context/SimulationContext';
import { addRandomNode, setupDemo } from '../../simulation/DemoSetup';

export const Controls: React.FC = () => {
    const engine = useSimulation();

    return (
        <div className="absolute bottom-10 left-4 bg-black/80 p-2 rounded flex gap-2 backdrop-blur-sm border border-gray-700 pointer-events-auto">
            <button 
                className="bg-cyan-700 hover:bg-cyan-600 text-white px-3 py-1 rounded text-sm transition-colors"
                onClick={() => addRandomNode(engine)}
            >
                Add Node
            </button>
            <button 
                className="bg-green-700 hover:bg-green-600 text-white px-3 py-1 rounded text-sm transition-colors"
                onClick={() => setupDemo(engine, 5)}
            >
                Reset / Init (5)
            </button>
        </div>
    );
};
