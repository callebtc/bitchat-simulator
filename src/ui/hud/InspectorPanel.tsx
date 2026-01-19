import React, { useEffect, useState } from 'react';
import { useSelection } from '../context/SelectionContext';
import { useSimulation } from '../context/SimulationContext';
import { BitchatAppSimulator } from '../../simulation/AppLayer/BitchatAppSimulator';
import { MovementMode } from '../../simulation/BitchatPerson';
import { getPeerColor } from '../../utils/colorUtils';
import { PowerMode } from '../../simulation/BitchatDevice';
import { useLayout } from '../context/LayoutContext';
import { usePersistedState } from '../../utils/usePersistedState';
import { BitchatConnectionBLE, RSSI_CONFIG, setRssiNoiseAmplitude } from '../../simulation/BitchatConnectionBLE';

// Helper for Collapsible Sections
const CollapsibleSection: React.FC<{ 
    title: string; 
    children: React.ReactNode; 
    persistenceKey: string;
    defaultOpen?: boolean;
    accentColor?: string;
}> = ({ title, children, persistenceKey, defaultOpen = true, accentColor = 'text-gray-500' }) => {
    const [isOpen, setIsOpen] = usePersistedState(persistenceKey, defaultOpen);

    return (
        <div className="border-t border-gray-800">
            <button 
                className="w-full flex justify-between items-center py-2 px-1 hover:bg-white/5 transition-colors group"
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className={`text-[10px] font-bold uppercase tracking-wider ${accentColor} group-hover:text-white transition-colors`}>
                    {title}
                </span>
                <span className={`transform transition-transform duration-200 ${isOpen ? 'rotate-180' : ''} text-gray-600`}>
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
                        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                </span>
            </button>
            <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isOpen ? 'max-h-[500px] opacity-100 pb-2' : 'max-h-0 opacity-0'}`}>
                {children}
            </div>
        </div>
    );
};

// Reusable Key-Value Row
const DataRow: React.FC<{ label: string; value: React.ReactNode; valueColor?: string }> = ({ label, value, valueColor = 'text-white' }) => (
    <div className="flex justify-between items-baseline text-xs mb-1 last:mb-0">
        <span className="text-gray-500 font-medium">{label}</span>
        <span className={`font-mono ${valueColor} text-right truncate ml-2`}>{value}</span>
    </div>
);

// RSSI color helper
const getRssiColor = (rssi: number): string => {
    const range = RSSI_CONFIG.MAX_RSSI - RSSI_CONFIG.DISCONNECT_THRESHOLD;
    const normalized = Math.max(0, Math.min(1, (rssi - RSSI_CONFIG.DISCONNECT_THRESHOLD) / range));
    
    if (normalized > 0.7) return 'text-green-400';
    if (normalized > 0.4) return 'text-yellow-400';
    if (normalized > 0.2) return 'text-orange-400';
    return 'text-red-400';
};

// RSSI bar component
const RssiBar: React.FC<{ rssi: number }> = ({ rssi }) => {
    const range = RSSI_CONFIG.MAX_RSSI - RSSI_CONFIG.DISCONNECT_THRESHOLD;
    const normalized = Math.max(0, Math.min(1, (rssi - RSSI_CONFIG.DISCONNECT_THRESHOLD) / range));
    const percentage = normalized * 100;
    
    let barColor = 'bg-green-500';
    if (normalized <= 0.2) barColor = 'bg-red-500';
    else if (normalized <= 0.4) barColor = 'bg-orange-500';
    else if (normalized <= 0.7) barColor = 'bg-yellow-500';
    
    return (
        <div className="flex items-center gap-2 w-full">
            <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div 
                    className={`h-full ${barColor} transition-all duration-300`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            <span className={`font-mono text-[10px] w-14 text-right ${getRssiColor(rssi)}`}>
                {rssi.toFixed(0)} dBm
            </span>
        </div>
    );
};

const PanelWrapper: React.FC<{ children: React.ReactNode; title: string; subtitle?: string; onClose: () => void; height: number }> = ({ children, title, subtitle, onClose, height }) => (
    <div 
        className="absolute top-4 right-4 w-72 bg-black/90 text-white p-0 rounded backdrop-blur-md border border-gray-800 shadow-2xl font-mono text-sm pointer-events-auto flex flex-col transition-all duration-300 animate-in fade-in slide-in-from-right-4"
        style={{ maxHeight: `calc(100vh - ${height + 32}px)` }}
    >
        {/* Header */}
        <div className="flex justify-between items-start p-3 pb-2 border-b border-gray-800 bg-gray-900/30">
            <div>
                <h2 className="text-sm font-bold tracking-widest text-white leading-none mb-1">
                    {title}
                </h2>
                {subtitle && <div className="text-[10px] text-gray-500 font-mono">{subtitle}</div>}
            </div>
            <button 
                className="text-gray-500 hover:text-white transition-colors p-1 -mr-1 -mt-1"
                onClick={onClose}
            >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 1L1 13M1 1l12 12"/>
                </svg>
            </button>
        </div>
        
        {/* Content Scroll Area */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1 custom-scrollbar">
            {children}
        </div>
    </div>
);

export const InspectorPanel: React.FC = () => {
    const { selectedId, selectionType, select, setChatRecipientId, setHighlightedId } = useSelection();
    const { bottomPanelHeight } = useLayout();
    const engine = useSimulation();
    const [, forceUpdate] = useState(0);

    // Force update loop for live data
    useEffect(() => {
        if (!selectedId) return;
        const interval = setInterval(() => forceUpdate(n => n + 1), 100); 
        return () => clearInterval(interval);
    }, [selectedId]);

    if (!selectedId) return null;

    // --- NODE INSPECTOR ---
    if (selectionType === 'node') {
        const person = engine.getPerson(selectedId);
        if (!person) return null;

        const device = person.device;
        const conns = device.connectionManager.getConnectedPeers();
        const sim = device.appSimulator as BitchatAppSimulator | undefined;
        const knownPeers = sim?.peerManager.getAllPeers() || [];

        return (
            <PanelWrapper title={device.nickname} subtitle={device.peerIDHex} onClose={() => select(null, null)} height={bottomPanelHeight}>
                {/* Status Grid */}
                <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="bg-gray-900/50 p-2 rounded border border-gray-800">
                        <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Position</div>
                        <div className="font-mono text-cyan-400 text-xs">
                            {person.position.x.toFixed(0)}, {person.position.y.toFixed(0)}
                        </div>
                    </div>
                    <div className="bg-gray-900/50 p-2 rounded border border-gray-800">
                        <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Mode</div>
                        <select 
                            value={person.mode} 
                            onChange={(e) => person.setMode(e.target.value as MovementMode)}
                            className="bg-transparent text-xs text-yellow-400 focus:outline-none w-full cursor-pointer hover:text-yellow-300"
                        >
                            <option value={MovementMode.STILL}>STILL</option>
                            <option value={MovementMode.RANDOM_WALK}>RANDOM</option>
                            <option value={MovementMode.TARGET}>TARGET</option>
                            <option value={MovementMode.BUSY}>BUSY</option>
                        </select>
                    </div>
                </div>

                {person.mode === MovementMode.TARGET && (
                    <div className="text-[10px] text-yellow-500/80 mb-3 text-center bg-yellow-900/10 py-1 rounded border border-yellow-900/30">
                        Click map to set target
                    </div>
                )}

                {person.mode === MovementMode.BUSY && (
                    <div className="text-[10px] text-orange-500/80 mb-3 text-center bg-orange-900/10 py-1 rounded border border-orange-900/30">
                        Walking to random locations
                    </div>
                )}

                {/* Simulation Settings */}
                <CollapsibleSection title="DEVICE STATE" accentColor="text-cyan-600" persistenceKey="inspector_device_state">
                    <DataRow 
                        label="Announcing" 
                        value={
                            <button 
                                className={`text-[10px] px-2 py-0.5 rounded border transition-all ${
                                    sim?.isAnnouncing 
                                    ? 'bg-green-500/10 border-green-500/50 text-green-400 hover:bg-green-500/20' 
                                    : 'bg-red-500/10 border-red-500/50 text-red-400 hover:bg-red-500/20'
                                }`}
                                onClick={() => { if(sim) sim.isAnnouncing = !sim.isAnnouncing; }}
                            >
                                {sim?.isAnnouncing ? 'ACTIVE' : 'SILENT'}
                            </button>
                        } 
                    />
                    <div className="mt-2" />
                    <DataRow 
                        label="Power Mode" 
                        value={
                            <select 
                                value={device.powerMode}
                                onChange={(e) => device.setPowerMode(e.target.value as PowerMode)}
                                className="bg-gray-800/50 border border-gray-700 rounded px-1 py-0.5 text-[10px] w-24 text-center focus:outline-none focus:border-cyan-500"
                            >
                                {Object.values(PowerMode).map(mode => (
                                    <option key={mode} value={mode}>{mode}</option>
                                ))}
                            </select>
                        } 
                    />
                </CollapsibleSection>

                {/* BLE Configuration - Compact */}
                <CollapsibleSection title="BLE CONFIG" accentColor="text-gray-500" persistenceKey="inspector_ble_config" defaultOpen={false}>
                    {/* Connection Limits - Single Row */}
                    <div className="flex items-center gap-1 text-[10px] mb-2">
                        <span className="text-gray-500 w-12">Limits:</span>
                        <div className="flex gap-1 flex-1">
                            <div className="flex items-center gap-1 bg-gray-900/50 px-1.5 py-0.5 rounded border border-gray-800">
                                <span className="text-gray-600">CL</span>
                                <input 
                                    type="number" 
                                    className="bg-transparent w-6 text-center focus:outline-none text-white font-bold"
                                    value={device.connectionSettings.maxClients}
                                    onChange={(e) => device.updateSettings({ maxClients: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="flex items-center gap-1 bg-gray-900/50 px-1.5 py-0.5 rounded border border-gray-800">
                                <span className="text-gray-600">SV</span>
                                <input 
                                    type="number" 
                                    className="bg-transparent w-6 text-center focus:outline-none text-white font-bold"
                                    value={device.connectionSettings.maxServers}
                                    onChange={(e) => device.updateSettings({ maxServers: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="flex items-center gap-1 bg-gray-900/50 px-1.5 py-0.5 rounded border border-gray-800">
                                <span className="text-gray-600">TOT</span>
                                <input 
                                    type="number" 
                                    className="bg-transparent w-6 text-center focus:outline-none text-white font-bold"
                                    value={device.connectionSettings.maxTotal}
                                    onChange={(e) => device.updateSettings({ maxTotal: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                        </div>
                    </div>
                    
                    {/* RSSI Noise Level */}
                    <div className="flex items-center gap-2 text-[10px]">
                        <span className="text-gray-500 w-12">Noise:</span>
                        <input 
                            type="range"
                            min="0"
                            max="10"
                            step="0.5"
                            value={RSSI_CONFIG.NOISE_AMPLITUDE}
                            onChange={(e) => setRssiNoiseAmplitude(parseFloat(e.target.value))}
                            className="flex-1 h-1 accent-cyan-500 cursor-pointer"
                        />
                        <span className="text-cyan-400 font-mono w-10 text-right">{RSSI_CONFIG.NOISE_AMPLITUDE.toFixed(1)}dB</span>
                    </div>
                </CollapsibleSection>

                 {/* Known Peers */}
                 <CollapsibleSection title={`PEER LIST (${knownPeers.length})`} accentColor="text-orange-600" persistenceKey="inspector_peer_list">
                     <div className="space-y-1">
                        {knownPeers.map(p => (
                            <div 
                                key={p.id} 
                                className="group flex justify-between items-center text-xs p-1.5 rounded border border-transparent hover:bg-gray-800/50 hover:border-gray-700 cursor-pointer transition-all"
                                onClick={() => setChatRecipientId(p.id)}
                                onMouseEnter={() => setHighlightedId(p.id)}
                                onMouseLeave={() => setHighlightedId(null)}
                            >
                                <div className="flex flex-col">
                                    <div className="flex items-center gap-2">
                                        <span className="font-bold" style={{ color: getPeerColor(p.id) }}>{p.nickname}</span>
                                        <span className={`text-[9px] px-1 rounded ${p.isDirect ? 'bg-green-900/30 text-green-500' : 'bg-orange-900/30 text-orange-500'}`}>
                                            {p.isDirect ? 'DIR' : 'RTE'}
                                        </span>
                                    </div>
                                    <span className="text-[9px] text-gray-600 font-mono">{p.id.substring(0,8)}...</span>
                                </div>
                                <div className="text-[10px] text-gray-500 group-hover:text-white transition-colors">
                                    {((Date.now() - p.lastSeen)/1000).toFixed(0)}s
                                </div>
                            </div>
                        ))}
                        {knownPeers.length === 0 && <div className="text-[10px] text-gray-600 italic text-center py-2">Network is empty</div>}
                    </div>
                </CollapsibleSection>

                {/* Active Connections */}
                <CollapsibleSection title={`CONNECTIONS (${conns.length})`} accentColor="text-green-600" persistenceKey="inspector_node_connections">
                    <div className="space-y-1">
                        {conns.map(p => {
                            // Find the connection to get RSSI
                            const allConns = engine.getAllConnections();
                            const conn = allConns.find(c => 
                                c.involves(device) && c.involves(p)
                            );
                            const rssi = conn instanceof BitchatConnectionBLE ? conn.rssi : null;
                            const rssiColor = rssi !== null ? getRssiColor(rssi) : 'text-gray-500';
                            
                            return (
                                <div 
                                    key={p.peerIDHex} 
                                    className="flex justify-between items-center text-xs bg-gray-900/30 p-1.5 rounded border border-gray-800/50 hover:bg-gray-800/50 transition-colors"
                                    onMouseEnter={() => setHighlightedId(p.peerIDHex)}
                                    onMouseLeave={() => setHighlightedId(null)}
                                >
                                    <span className="font-bold" style={{ color: getPeerColor(p.peerIDHex) }}>{p.nickname}</span>
                                    <div className="flex items-center gap-2">
                                        {rssi !== null && (
                                            <span className={`font-mono text-[10px] ${rssiColor}`}>
                                                {rssi.toFixed(0)}dBm
                                            </span>
                                        )}
                                        <span className="font-mono text-gray-600 text-[10px]">{p.peerIDHex.substring(0,6)}</span>
                                    </div>
                                </div>
                            );
                        })}
                        {conns.length === 0 && <div className="text-[10px] text-gray-600 italic text-center py-2">No active physical links</div>}
                    </div>
                </CollapsibleSection>

                {/* Actions */}
                <div className="mt-4 pt-2 border-t border-gray-800">
                    <button 
                        className="w-full bg-red-900/20 hover:bg-red-900/40 text-red-400 hover:text-red-300 text-[10px] py-2 rounded border border-red-900/50 transition-all font-bold tracking-wider"
                        onClick={() => {
                            engine.removePerson(selectedId);
                            select(null, null);
                        }}
                    >
                        REMOVE NODE
                    </button>
                </div>
            </PanelWrapper>
        );
    }

    // --- CONNECTION INSPECTOR ---
    if (selectionType === 'connection') {
        const conns = engine.getAllConnections();
        const conn = conns.find(c => c.id === selectedId);
        
        if (!conn) return null;
        
        const isBLE = conn instanceof BitchatConnectionBLE;
        const rssi = isBLE ? conn.rssi : null;

        return (
            <PanelWrapper title="CONNECTION LINK" subtitle={conn.id.substring(0,18) + "..."} onClose={() => select(null, null)} height={bottomPanelHeight}>
                 {/* Connection Visual */}
                <div className="flex items-center justify-between mb-4 bg-gray-900/50 p-3 rounded border border-gray-800">
                    <div className="text-center">
                        <div className="text-xs font-bold mb-1" style={{ color: getPeerColor(conn.endpointA.peerIDHex) }}>
                            {conn.endpointA.nickname}
                        </div>
                        <div className="text-[9px] text-gray-600 font-mono">{conn.endpointA.peerIDHex.substring(0,4)}</div>
                    </div>
                    
                    <div className="flex flex-col items-center gap-1">
                        <span className={`text-[9px] uppercase font-bold tracking-wider ${conn.isActive ? 'text-green-500' : 'text-red-500'}`}>
                            {conn.isActive ? 'LINKED' : 'BROKEN'}
                        </span>
                        <div className={`h-0.5 w-16 ${conn.isActive ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-red-500/50'}`} />
                         <span className="text-[9px] text-gray-600">BLE</span>
                    </div>

                    <div className="text-center">
                        <div className="text-xs font-bold mb-1" style={{ color: getPeerColor(conn.endpointB.peerIDHex) }}>
                            {conn.endpointB.nickname}
                        </div>
                        <div className="text-[9px] text-gray-600 font-mono">{conn.endpointB.peerIDHex.substring(0,4)}</div>
                    </div>
                </div>

                {/* RSSI Signal Strength */}
                {rssi !== null && (
                    <div className="mb-3 bg-gray-900/30 p-2.5 rounded border border-gray-800">
                        <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-2">SIGNAL STRENGTH</div>
                        <RssiBar rssi={rssi} />
                        <div className="flex justify-between mt-1.5 text-[9px] text-gray-600">
                            <span>Threshold: {RSSI_CONFIG.DISCONNECT_THRESHOLD}dBm</span>
                            <span>Max: {RSSI_CONFIG.MAX_RSSI}dBm</span>
                        </div>
                    </div>
                )}

                <CollapsibleSection title="TRAFFIC STATS" accentColor="text-cyan-600" persistenceKey="inspector_conn_traffic">
                    <div className="grid grid-cols-2 gap-2 mb-2">
                        <div className="bg-gray-900/30 p-2 rounded border border-gray-800">
                            <div className="text-[9px] text-gray-500 mb-1">TOTAL PACKETS</div>
                            <div className="text-xl font-mono text-white">{conn.packetsSent}</div>
                        </div>
                        <div className="bg-gray-900/30 p-2 rounded border border-gray-800">
                             <div className="text-[9px] text-gray-500 mb-1">LATENCY (SIM)</div>
                             <div className="text-xl font-mono text-white">~10ms</div>
                        </div>
                    </div>
                </CollapsibleSection>

                 <CollapsibleSection title="DEBUG INFO" accentColor="text-gray-600" persistenceKey="inspector_conn_debug">
                    <DataRow label="Initiator" value={conn.initiator === conn.endpointA ? 'Endpoint A' : 'Endpoint B'} />
                    <DataRow label="Created At" value="--:--:--" />
                    <DataRow label="Last Activity" value="0s ago" />
                 </CollapsibleSection>

            </PanelWrapper>
        );
    }

    return null;
};
