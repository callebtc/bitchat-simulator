import React from 'react';
import { useSimulation } from '../context/SimulationContext';
import { addRandomNode, setupDemo } from '../../simulation/DemoSetup';

export const MainControlPanel: React.FC = () => {
    const engine = useSimulation();

    return (
        <div className="absolute top-4 left-4 w-64 bg-black/90 text-white p-4 rounded backdrop-blur-md border border-gray-700 shadow-xl pointer-events-auto">
            <h1 className="text-xl font-bold text-white mb-1">Bitchat Simulator</h1>
            <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                <p className="text-xs opacity-60 font-mono">Simulation: Running</p>
            </div>
            
            <div className="flex gap-2">
                <button 
                    className="flex-1 bg-cyan-700 hover:bg-cyan-600 text-white px-3 py-1.5 rounded text-xs font-mono transition-colors border border-cyan-600/50"
                    onClick={() => addRandomNode(engine)}
                >
                    + ADD NODE
                </button>
                <button 
                    className="flex-1 bg-red-900/50 hover:bg-red-800 text-white px-3 py-1.5 rounded text-xs font-mono transition-colors border border-red-700/50"
                    onClick={() => setupDemo(engine, 5)}
                >
                    RESET (5)
                </button>
            </div>
        </div>
    );
};
