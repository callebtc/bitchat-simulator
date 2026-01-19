import React, { useEffect, useState } from 'react';
import { useSelection } from '../context/SelectionContext';
import { useSimulation } from '../context/SimulationContext';
import { BitchatAppSimulator } from '../../simulation/AppLayer/BitchatAppSimulator';

export const InspectorPanel: React.FC = () => {
    const { selectedId } = useSelection();
    const engine = useSimulation();
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        if (!selectedId) return;
        const interval = setInterval(() => forceUpdate(n => n + 1), 200); // 5fps update
        return () => clearInterval(interval);
    }, [selectedId]);

    if (!selectedId) {
        return (
            <div className="absolute top-4 right-4 w-64 bg-black/80 text-white p-4 rounded backdrop-blur-sm border border-gray-700">
                <p className="opacity-50 italic">Select a node to inspect</p>
            </div>
        );
    }

    const person = engine.getPerson(selectedId);
    if (!person) return null;

    const device = person.device;
    const conns = device.connectionManager.getConnectedPeers();
    const sim = device.appSimulator as BitchatAppSimulator | undefined;
    const knownPeers = sim?.peerManager.getAllPeers() || [];

    return (
        <div className="absolute top-4 right-4 w-80 bg-black/90 text-white p-4 rounded backdrop-blur-md border border-gray-700 max-h-[90vh] overflow-y-auto shadow-xl font-mono text-sm">
            <h2 className="text-lg font-bold text-cyan-400 mb-2">{device.nickname}</h2>
            <div className="mb-4 space-y-1">
                <div className="flex justify-between">
                    <span className="opacity-60">ID:</span>
                    <span>{device.peerIDHex.substring(0,8)}...</span>
                </div>
                <div className="flex justify-between">
                    <span className="opacity-60">Pos:</span>
                    <span>{person.position.x.toFixed(0)}, {person.position.y.toFixed(0)}</span>
                </div>
            </div>

            <div className="mb-4 border-t border-gray-700 pt-2">
                <h3 className="font-bold text-green-400 mb-1">Active Connections ({conns.length})</h3>
                <ul className="space-y-1 pl-2">
                    {conns.map(p => (
                        <li key={p.peerIDHex} className="flex justify-between text-xs">
                            <span>{p.nickname}</span>
                            <span className="opacity-50">{p.peerIDHex.substring(0,6)}</span>
                        </li>
                    ))}
                    {conns.length === 0 && <li className="opacity-40 italic">No physical connections</li>}
                </ul>
            </div>

            <div className="mb-4 border-t border-gray-700 pt-2">
                <h3 className="font-bold text-yellow-400 mb-1">Peer Table ({knownPeers.length})</h3>
                <ul className="space-y-2 pl-2">
                    {knownPeers.map(p => (
                        <li key={p.id} className="text-xs">
                            <div className="flex justify-between">
                                <span className={p.isDirect ? 'text-green-300' : 'text-orange-300'}>
                                    {p.nickname} {p.isDirect ? '(Dir)' : '(Rtd)'}
                                </span>
                                <span>{((Date.now() - p.lastSeen)/1000).toFixed(0)}s ago</span>
                            </div>
                            <div className="opacity-50 text-[10px]">{p.id.substring(0,12)}...</div>
                        </li>
                    ))}
                    {knownPeers.length === 0 && <li className="opacity-40 italic">No peers discovered</li>}
                </ul>
            </div>
            
            {!sim && <div className="text-red-500 italic">No App Simulator Attached</div>}
        </div>
    );
};
