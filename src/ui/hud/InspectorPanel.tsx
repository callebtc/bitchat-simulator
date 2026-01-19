import React, { useEffect, useState, useMemo } from 'react';
import { useSelection } from '../context/SelectionContext';
import { useSimulation } from '../context/SimulationContext';
import { BitchatAppSimulator } from '../../simulation/AppLayer/BitchatAppSimulator';
import { MovementMode } from '../../simulation/BitchatPerson';
import { getPeerColor } from '../../utils/colorUtils';
import { PowerMode } from '../../simulation/BitchatDevice';
import { useLayout } from '../context/LayoutContext';

export const InspectorPanel: React.FC = () => {
    const { selectedId, selectionType, select, setChatRecipientId } = useSelection();
    const { bottomPanelHeight } = useLayout();
    const engine = useSimulation();
    const [, forceUpdate] = useState(0);

    // Derived color
    const headerColor = useMemo(() => selectedId ? getPeerColor(selectedId) : 'white', [selectedId]);

    useEffect(() => {
        if (!selectedId) return;
        const interval = setInterval(() => forceUpdate(n => n + 1), 200); // 5fps update
        return () => clearInterval(interval);
    }, [selectedId]);

    if (!selectedId) {
        return (
            <div className="absolute top-4 right-4 w-64 bg-black/80 text-white p-4 rounded backdrop-blur-sm border border-gray-700 pointer-events-none">
                <p className="opacity-50 italic">Select a node or connection</p>
            </div>
        );
    }

    // Node Inspection
    if (selectionType === 'node') {
        const person = engine.getPerson(selectedId);
        if (!person) return null;

        const device = person.device;
        const conns = device.connectionManager.getConnectedPeers();
        const sim = device.appSimulator as BitchatAppSimulator | undefined;
        const knownPeers = sim?.peerManager.getAllPeers() || [];

        return (
            <div 
                className="absolute top-4 right-4 w-80 bg-black/90 text-white p-4 rounded backdrop-blur-md border border-gray-700 overflow-y-auto shadow-xl font-mono text-sm pointer-events-auto"
                style={{ maxHeight: `calc(100vh - ${bottomPanelHeight + 32}px)` }}
            >
                <button 
                    className="absolute top-2 right-2 text-gray-500 hover:text-white transition-colors"
                    onClick={() => select(null, null)}
                >
                    ✕
                </button>
                <h2 className="text-lg font-bold mb-2" style={{ color: headerColor }}>{device.nickname}</h2>
                <div className="mb-4 space-y-1">
                    <div className="flex justify-between">
                        <span className="opacity-60">ID:</span>
                        <span className="font-mono text-xs">{device.peerIDHex}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="opacity-60">Pos:</span>
                        <span>{person.position.x.toFixed(0)}, {person.position.y.toFixed(0)}</span>
                    </div>
                    <div className="flex justify-between items-center mt-2">
                         <span className="opacity-60">Movement:</span>
                         <select 
                            value={person.mode} 
                            onChange={(e) => person.setMode(e.target.value as MovementMode)}
                            className="bg-gray-800 border border-gray-600 rounded px-1 text-xs"
                         >
                             <option value={MovementMode.STILL}>Still</option>
                             <option value={MovementMode.RANDOM_WALK}>Random Walk</option>
                             <option value={MovementMode.TARGET}>Target</option>
                         </select>
                    </div>
                    {person.mode === MovementMode.TARGET && (
                        <div className="text-xs text-yellow-400 mt-1">
                            Click on map to set target
                        </div>
                    )}
                    
                    {/* App Controls */}
                    {sim && (
                        <div className="flex justify-between items-center mt-2 pt-2 border-t border-gray-800">
                            <span className="opacity-60">Announcing:</span>
                            <button 
                                className={`text-xs px-2 py-0.5 rounded border ${sim.isAnnouncing ? 'border-green-500 text-green-400' : 'border-red-500 text-red-400'}`}
                                onClick={() => {
                                    sim.isAnnouncing = !sim.isAnnouncing;
                                }}
                            >
                                {sim.isAnnouncing ? 'ON' : 'OFF'}
                            </button>
                        </div>
                    )}
                    
                    {/* Connection Settings */}
                    <div className="mt-4 border-t border-gray-700 pt-2">
                        <h3 className="font-bold text-gray-400 text-xs mb-2">BLE SETTINGS</h3>
                        
                        {/* Power Mode */}
                        <div className="flex justify-between items-center mb-2 text-xs">
                            <span className="opacity-60">Power:</span>
                            <select 
                                value={device.powerMode}
                                onChange={(e) => device.setPowerMode(e.target.value as PowerMode)}
                                className="bg-gray-800 border border-gray-600 rounded px-1 w-24"
                            >
                                {Object.values(PowerMode).map(mode => (
                                    <option key={mode} value={mode}>{mode}</option>
                                ))}
                            </select>
                        </div>
                        
                        {/* Limits */}
                        <div className="grid grid-cols-3 gap-1 text-[10px] text-center mb-2">
                            <div className="bg-gray-900 rounded p-1">
                                <div className="opacity-50">CLIENTS</div>
                                <input 
                                    type="number" 
                                    className="bg-transparent text-center w-full focus:outline-none"
                                    value={device.connectionSettings.maxClients}
                                    onChange={(e) => device.updateSettings({ maxClients: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="bg-gray-900 rounded p-1">
                                <div className="opacity-50">SERVERS</div>
                                <input 
                                    type="number" 
                                    className="bg-transparent text-center w-full focus:outline-none"
                                    value={device.connectionSettings.maxServers}
                                    onChange={(e) => device.updateSettings({ maxServers: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="bg-gray-900 rounded p-1">
                                <div className="opacity-50">TOTAL</div>
                                <input 
                                    type="number" 
                                    className="bg-transparent text-center w-full focus:outline-none"
                                    value={device.connectionSettings.maxTotal}
                                    onChange={(e) => device.updateSettings({ maxTotal: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mb-4 border-t border-gray-700 pt-2">
                    <h3 className="font-bold text-green-400 mb-1">Active Connections ({conns.length})</h3>
                    <ul className="space-y-1 pl-2">
                        {conns.map(p => (
                            <li key={p.peerIDHex} className="flex justify-between text-xs">
                                <span style={{ color: getPeerColor(p.peerIDHex) }}>{p.nickname}</span>
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
                            <li 
                                key={p.id} 
                                className="text-xs cursor-pointer hover:bg-white/10 rounded p-1"
                                onClick={() => setChatRecipientId(p.id)}
                            >
                                <div className="flex justify-between">
                                    <span>
                                        <span style={{ color: getPeerColor(p.id) }}>{p.nickname}</span>
                                        <span className={`ml-2 text-[10px] ${p.isDirect ? 'text-green-500' : 'text-orange-500'}`}>
                                            {p.isDirect ? '(Dir)' : '(Rtd)'}
                                        </span>
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
    }
    
    // Connection Inspection
    if (selectionType === 'connection') {
        const conns = engine.getAllConnections();
        const conn = conns.find(c => c.id === selectedId);
        
        if (!conn) return null;
        
        return (
            <div className="absolute top-4 right-4 w-80 bg-black/90 text-white p-4 rounded backdrop-blur-md border border-gray-700 shadow-xl font-mono text-sm pointer-events-auto">
                <button 
                    className="absolute top-2 right-2 text-gray-500 hover:text-white transition-colors"
                    onClick={() => select(null, null)}
                >
                    ✕
                </button>
                <h2 className="text-lg font-bold text-green-400 mb-2">Connection</h2>
                <div className="space-y-2">
                    <div className="bg-gray-900 p-2 rounded">
                        <div className="text-xs opacity-50">Endpoint A</div>
                        <div className="font-bold">{conn.endpointA.nickname}</div>
                        <div className="text-[10px] opacity-50">{conn.endpointA.peerIDHex.substring(0,8)}...</div>
                    </div>
                    <div className="text-center opacity-50">⬇⬆</div>
                     <div className="bg-gray-900 p-2 rounded">
                        <div className="text-xs opacity-50">Endpoint B</div>
                        <div className="font-bold">{conn.endpointB.nickname}</div>
                        <div className="text-[10px] opacity-50">{conn.endpointB.peerIDHex.substring(0,8)}...</div>
                    </div>
                </div>
                <div className="mt-4 text-xs space-y-1">
                    <div className="flex justify-between">
                        <span className="opacity-60">Status:</span>
                        <span className={conn.isActive ? 'text-green-400' : 'text-red-400'}>
                            {conn.isActive ? 'Active' : 'Broken'}
                        </span>
                    </div>
                    <div className="flex justify-between">
                        <span className="opacity-60">Total Packets:</span>
                        <span>{conn.packetsSent}</span>
                    </div>
                </div>
            </div>
        );
    }
    
    return null;
};
