import React, { useEffect, useState } from 'react';
import { useSelection } from '../context/SelectionContext';
import { useSimulation } from '../context/SimulationContext';
import { BitchatAppSimulator } from '../../simulation/AppLayer/BitchatAppSimulator';
import { MeshPolicyPreset } from '../../simulation/AppLayer/MeshPolicy';
import { MovementMode } from '../../simulation/BitchatPerson';
import { getPeerColor } from '../../utils/colorUtils';
import { PowerMode } from '../../simulation/BitchatDevice';
import { useLayout } from '../context/LayoutContext';
import { useCamera } from '../context/CameraContext';
import { BitchatConnectionBLE, RSSI_CONFIG, setRssiNoiseAmplitude } from '../../simulation/BitchatConnectionBLE';
import { useVisualization } from '../context/VisualizationContext';
import { HudPanel, Section } from './primitives';

// Collapsible section (shared HUD style; bleeds to the panel edges)
const CollapsibleSection: React.FC<{
    title: string;
    children: React.ReactNode;
    persistenceKey: string;
    defaultOpen?: boolean;
    accentColor?: string;
}> = ({ title, children, persistenceKey, defaultOpen = true }) => (
    <Section title={title} persistKey={persistenceKey} defaultOpen={defaultOpen} className="-mx-3">
        {children}
    </Section>
);

// Reusable List Item for Peers and Connections
const ListItem: React.FC<{
    title: string;
    subtitle?: string;
    rightElement?: React.ReactNode;
    color?: string;
    onClick?: () => void;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    highlighted?: boolean;
}> = ({ title, subtitle, rightElement, color, onClick, onMouseEnter, onMouseLeave, highlighted }) => (
    <div 
        className={`group flex justify-between items-center text-xs p-1.5 rounded border border-transparent cursor-pointer transition-all ${
            highlighted 
            ? 'bg-white/[0.07] border-white/10' 
            : 'hover:bg-white/[0.05] hover:border-white/10'
        }`}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
    >
        <div className="flex flex-col min-w-0 flex-1 mr-2">
            <div className="flex items-center gap-2">
                <span className="font-bold truncate" style={{ color: color || 'white' }}>{title}</span>
                {subtitle && <span className="text-[9px] text-slate-500 font-mono truncate">{subtitle}</span>}
            </div>
        </div>
        {rightElement && (
            <div className="flex-shrink-0">
                {rightElement}
            </div>
        )}
    </div>
);

// Reusable Key-Value Row
const DataRow: React.FC<{ label: string; value: React.ReactNode; valueColor?: string }> = ({ label, value, valueColor = 'text-white' }) => (
    <div className="flex justify-between items-baseline text-xs mb-1 last:mb-0">
        <span className="text-slate-500 font-medium">{label}</span>
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
            <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
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

const PanelWrapper: React.FC<{
    children: React.ReactNode;
    title: string;
    subtitle?: string;
    onClose: () => void;
    height: number;
    color?: string;
}> = ({ children, title, subtitle, onClose, height, color }) => (
    <HudPanel
        className="absolute right-3 top-3 z-20 w-[300px] overflow-hidden"
        style={{ maxHeight: `calc(100vh - ${height + 24}px)` }}
    >
        <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
            {color && (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }} />
            )}
            <div className="min-w-0">
                <h2 className="truncate text-[13px] font-semibold leading-tight text-slate-100">{title}</h2>
                {subtitle && <div className="truncate font-mono text-[9.5px] text-slate-500">{subtitle}</div>}
            </div>
            <button
                className="ml-auto rounded p-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-white"
                onClick={onClose}
                title="Close (Esc)"
            >
                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M13 1L1 13M1 1l12 12" />
                </svg>
            </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto border-t border-white/[0.06] px-3 pb-3 pt-2.5 text-[12px]">
            {children}
        </div>
    </HudPanel>
);

export const InspectorPanel: React.FC = () => {
    const {
        selectedId,
        selectionType,
        select,
        setChatRecipientId,
        isPickingRecipient,
        setPickingRecipient,
        setHighlightedId,
    } = useSelection();
    const { highlightOwnMesh, setHighlightOwnMesh } = useVisualization();
    const { bottomPanelHeight, phoneOpen, setPhoneOpen } = useLayout();
    const { mode: cameraMode, followId, follow, release: releaseCamera } = useCamera();
    const engine = useSimulation();
    const [, forceUpdate] = useState(0);

    // Force update loop for live data (4 Hz)
    useEffect(() => {
        if (!selectedId) return;
        const interval = setInterval(() => forceUpdate(n => n + 1), 250);
        return () => clearInterval(interval);
    }, [selectedId]);

    if (!selectedId) return null;

    // --- NODE INSPECTOR ---
    if (selectionType === 'node') {
        const person = engine.getPerson(selectedId);
        if (!person) return null;

        const device = person.device;
        const activeConns = device.connectionManager.getActiveConnections();
        const sim = device.appSimulator as BitchatAppSimulator | undefined;
        const knownPeers = sim?.peerManager.getAllPeers() || [];
        // Render direct peers first and cap DOM list to 50 rows so selecting a node in a 2,000+ crowd stays instant
        const MAX_DISPLAYED_PEERS = 50;
        const displayedPeers =
            knownPeers.length <= MAX_DISPLAYED_PEERS
                ? knownPeers
                : [...knownPeers]
                      .sort((a, b) => (a.isDirect === b.isDirect ? b.lastSeen - a.lastSeen : a.isDirect ? -1 : 1))
                      .slice(0, MAX_DISPLAYED_PEERS);

        return (
            <PanelWrapper
                title={device.nickname}
                subtitle={device.peerIDHex}
                color={getPeerColor(device.peerIDHex)}
                onClose={() => select(null, null)}
                height={bottomPanelHeight}
            >
                {/* Status */}
                <div className="grid grid-cols-2 gap-1.5">
                    <div className="rounded-lg bg-white/[0.03] px-2 py-1.5 ring-1 ring-white/[0.05]">
                        <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">Position</div>
                        <div className="mt-0.5 font-mono text-[12px] tabular-nums text-cyan-300">
                            {person.position.x.toFixed(0)}, {person.position.y.toFixed(0)} m
                        </div>
                    </div>
                    <div className="rounded-lg bg-white/[0.03] px-2 py-1.5 ring-1 ring-white/[0.05]">
                        <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">Movement</div>
                        <select
                            value={person.mode}
                            onChange={e => person.setMode(e.target.value as MovementMode)}
                            className="mt-0.5 w-full cursor-pointer bg-transparent text-[12px] text-amber-300 focus:outline-none"
                        >
                            <option value={MovementMode.STILL}>Still</option>
                            <option value={MovementMode.RANDOM_WALK}>Stroll</option>
                            <option value={MovementMode.TARGET}>Go to target</option>
                            <option value={MovementMode.BUSY}>Errands</option>
                        </select>
                    </div>
                </div>

                {/* What they're doing */}
                {(() => {
                    const group = engine.crowd.groupOf(person.id);
                    const mates = (group?.members ?? [])
                        .filter(id => id !== person.id)
                        .map(id => engine.getPerson(id)?.device.nickname)
                        .filter(Boolean);
                    const place: Record<string, string> = {
                        entrance: 'a shop entrance',
                        plaza: 'the plaza',
                        park: 'the park',
                        sidewalk: 'down the street',
                        hotspot: 'a meeting spot',
                    };
                    const doing =
                        person.mode === MovementMode.STILL
                            ? 'Standing still'
                            : person.mode === MovementMode.TARGET
                              ? 'Walking to your target'
                              : person.activity === 'dwelling'
                                ? `Lingering at ${place[person.destinationKind ?? ''] ?? 'a spot'}`
                                : person.activity === 'following'
                                  ? 'Walking with their group'
                                  : person.destinationKind
                                    ? `Heading to ${place[person.destinationKind]}`
                                    : 'Walking';
                    const speed = Math.hypot(person.velocity.x, person.velocity.y);
                    return (
                        <div className="rounded-lg bg-white/[0.03] px-2 py-1.5 text-[11px] ring-1 ring-white/[0.05]">
                            <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-slate-200">{doing}</span>
                                <span className="shrink-0 font-mono text-[10px] tabular-nums text-slate-500">
                                    {speed.toFixed(1)} / {person.prefSpeed.toFixed(1)} m/s
                                </span>
                            </div>
                            {mates.length > 0 && (
                                <div className="mt-0.5 truncate text-[10px] text-emerald-300/80">
                                    {group?.members[0] === person.id ? 'Leading' : 'With'} {mates.join(', ')}
                                </div>
                            )}
                        </div>
                    );
                })()}

                {/* Camera + phone */}
                <div className="grid grid-cols-4 gap-1">
                    {(
                        [
                            ['follow', 'Follow'],
                            ['chase', 'Chase'],
                            ['fpv', 'Eyes'],
                        ] as const
                    ).map(([m, label]) => {
                        const on = cameraMode === m && followId === person.id;
                        return (
                            <button
                                key={m}
                                onClick={() => (on ? releaseCamera() : follow(person.id, m))}
                                className={`rounded-md border px-1.5 py-1 text-[11px] font-medium transition-colors ${
                                    on
                                        ? 'border-emerald-300/50 bg-emerald-400/15 text-emerald-100'
                                        : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]'
                                }`}
                            >
                                {label}
                            </button>
                        );
                    })}
                    <button
                        onClick={() => setPhoneOpen(!phoneOpen)}
                        title="Show this device's BitChat app"
                        className={`rounded-md border px-1.5 py-1 text-[11px] font-medium transition-colors ${
                            phoneOpen
                                ? 'border-cyan-300/45 bg-cyan-400/15 text-cyan-100'
                                : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]'
                        }`}
                    >
                        Phone
                    </button>
                </div>

                {/* Direct message / route probe */}
                <button
                    className={`w-full rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                        isPickingRecipient
                            ? 'animate-pulse border-cyan-300/60 bg-cyan-400/20 text-white'
                            : 'border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-100 hover:bg-fuchsia-500/20'
                    }`}
                    onClick={() => setPickingRecipient(!isPickingRecipient)}
                >
                    {isPickingRecipient ? 'Click a device on the map… (Esc)' : '⌖ Message / probe another device'}
                </button>

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

                {/* Visualization Section */}
                <CollapsibleSection title="VISUALIZATION" accentColor="text-purple-500" persistenceKey="inspector_viz">
                     <div className="flex items-center justify-between bg-slate-900/30 px-2 py-1.5 rounded border border-slate-800">
                        <label className="text-[10px] text-slate-400 flex items-center gap-1.5 cursor-pointer select-none">
                            <span className="uppercase tracking-wider">Highlight Own Mesh</span>
                        </label>
                        <button
                            onClick={() => setHighlightOwnMesh(!highlightOwnMesh)}
                            className={`relative w-8 h-4 rounded-full transition-colors ${
                                highlightOwnMesh ? 'bg-purple-600' : 'bg-slate-700'
                            }`}
                        >
                            <div
                                className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                                    highlightOwnMesh ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                            />
                        </button>
                    </div>
                </CollapsibleSection>

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
                                className="bg-slate-800/50 border border-slate-700 rounded px-1 py-0.5 text-[10px] w-24 text-center focus:outline-none focus:border-cyan-500"
                            >
                                {Object.values(PowerMode).map(mode => (
                                    <option key={mode} value={mode}>{mode}</option>
                                ))}
                            </select>
                        } 
                    />
                    <div className="mt-2" />
                    <DataRow 
                        label="BT Strength" 
                        value={
                            <div className="flex items-center gap-2 w-32">
                                <input 
                                    type="range"
                                    min="0"
                                    max="100"
                                    step="1"
                                    value={device.bluetoothStrength}
                                    onChange={(e) => device.bluetoothStrength = parseInt(e.target.value)}
                                    className="flex-1 h-1 accent-cyan-500 cursor-pointer bg-slate-700 rounded-lg appearance-none"
                                />
                                <span className="text-[10px] w-6 text-right font-mono text-cyan-400">
                                    {device.bluetoothStrength.toFixed(0)}
                                </span>
                            </div>
                        } 
                    />
                    <div className="mt-2" />
                    <DataRow
                        label="Mesh Policy"
                        value={
                            <select
                                value={sim?.policy.preset ?? 'android'}
                                onChange={(e) => sim?.setPolicy(e.target.value as MeshPolicyPreset)}
                                className="bg-slate-800/50 border border-slate-700 rounded px-1 py-0.5 text-[10px] w-24 text-center focus:outline-none focus:border-cyan-500 uppercase"
                            >
                                <option value="android">ANDROID</option>
                                <option value="ios">IOS</option>
                            </select>
                        }
                    />
                    <div className="mt-2" />
                    <DataRow
                        label="Wi-Fi Aware"
                        value={
                            <button
                                className={`text-[10px] px-2 py-0.5 rounded border transition-all ${
                                    device.wifiAwareEnabled
                                        ? 'bg-purple-500/20 border-purple-500/60 text-purple-300 hover:bg-purple-500/30'
                                        : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:bg-slate-700/50'
                                }`}
                                onClick={() => {
                                    device.wifiAwareEnabled = !device.wifiAwareEnabled;
                                    forceUpdate(n => n + 1);
                                }}
                            >
                                {device.wifiAwareEnabled ? '5GHz ON' : 'OFF'}
                            </button>
                        }
                    />
                    {sim && (
                        <div className="mt-2 pt-2 border-t border-slate-800/70 grid grid-cols-3 gap-1 text-center">
                            <div className="rounded-md bg-white/[0.03] p-1 ring-1 ring-white/[0.05]">
                                <div className="text-[8px] text-slate-500">SYNC</div>
                                <div className="text-[10px] text-sky-400">
                                    {sim.gossipSync.getCachedMessageCount()}
                                </div>
                            </div>
                            <div className="rounded-md bg-white/[0.03] p-1 ring-1 ring-white/[0.05]">
                                <div className="text-[8px] text-slate-500">OUTBOX</div>
                                <div className="text-[10px] text-fuchsia-400">
                                    {sim.messageRouter.getOutboxCount()}
                                </div>
                            </div>
                            <div className="rounded-md bg-white/[0.03] p-1 ring-1 ring-white/[0.05]">
                                <div className="text-[8px] text-slate-500">BRIDGED</div>
                                <div className="text-[10px] text-purple-400">
                                    {sim.transportBridge.bridgedCount}
                                </div>
                            </div>
                        </div>
                    )}
                </CollapsibleSection>

                {/* BLE Configuration - Compact */}
                <CollapsibleSection title="BLE CONFIG" accentColor="text-slate-500" persistenceKey="inspector_ble_config" defaultOpen={false}>
                    {/* Connection Limits - Single Row */}
                    <div className="flex items-center gap-1 text-[10px] mb-2">
                        <span className="text-slate-500 w-12">Limits:</span>
                        <div className="flex gap-1 flex-1">
                            <div className="flex items-center gap-1 rounded-md bg-white/[0.03] px-1.5 py-0.5 ring-1 ring-white/[0.06]">
                                <span className="text-slate-600">CL</span>
                                <input 
                                    type="number" 
                                    className="bg-transparent w-6 text-center focus:outline-none text-white font-bold"
                                    value={device.connectionSettings.maxClients}
                                    onChange={(e) => device.updateSettings({ maxClients: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="flex items-center gap-1 rounded-md bg-white/[0.03] px-1.5 py-0.5 ring-1 ring-white/[0.06]">
                                <span className="text-slate-600">SV</span>
                                <input 
                                    type="number" 
                                    className="bg-transparent w-6 text-center focus:outline-none text-white font-bold"
                                    value={device.connectionSettings.maxServers}
                                    onChange={(e) => device.updateSettings({ maxServers: parseInt(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="flex items-center gap-1 rounded-md bg-white/[0.03] px-1.5 py-0.5 ring-1 ring-white/[0.06]">
                                <span className="text-slate-600">TOT</span>
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
                        <span className="text-slate-500 w-12">Noise:</span>
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
                        {displayedPeers.map(p => (
                            <ListItem
                                key={p.id}
                                title={p.nickname}
                                color={getPeerColor(p.id)}
                                onClick={() => setChatRecipientId(p.id)}
                                onMouseEnter={() => setHighlightedId(p.id)}
                                onMouseLeave={() => setHighlightedId(null)}
                                rightElement={
                                    <div className="flex items-center gap-1.5">
                                        <span className={`text-[8px] px-1 rounded-sm ${p.isDirect ? 'bg-green-900/30 text-green-500' : 'bg-orange-900/30 text-orange-500'}`}>
                                            {p.isDirect ? 'DIR' : 'RTE'}
                                        </span>
                                        <span className="text-[9px] font-mono text-slate-500">
                                            {p.id.substring(0, 8)}
                                        </span>
                                        <span className="text-[9px] text-slate-600">
                                            {Math.max(0, (engine.simTimeMs - p.lastSeen) / 1000).toFixed(0)}s
                                        </span>
                                    </div>
                                }
                            />
                        ))}
                        {knownPeers.length > MAX_DISPLAYED_PEERS && (
                            <div className="text-[9px] text-slate-500 text-center py-1">
                                +{knownPeers.length - MAX_DISPLAYED_PEERS} more peers in mesh
                            </div>
                        )}
                        {knownPeers.length === 0 && <div className="text-[10px] text-slate-600 italic text-center py-2">Network is empty</div>}
                    </div>
                </CollapsibleSection>

                {/* Active Connections */}
                <CollapsibleSection title={`CONNECTIONS (${activeConns.length})`} accentColor="text-green-600" persistenceKey="inspector_node_connections">
                    <div className="space-y-1">
                        {activeConns.map(conn => {
                            const p = conn.getOtherParty(device);
                            const rssi = conn instanceof BitchatConnectionBLE ? conn.rssi : null;
                            const rssiColor = rssi !== null ? getRssiColor(rssi) : 'text-slate-500';
                            
                            return (
                                <ListItem
                                    key={conn.id}
                                    title={p.nickname}
                                    color={getPeerColor(p.peerIDHex)}
                                    onMouseEnter={() => setHighlightedId(p.peerIDHex)}
                                    onMouseLeave={() => setHighlightedId(null)}
                                    rightElement={
                                        <div className="flex items-center gap-2">
                                            {rssi !== null && (
                                                <span className={`font-mono text-[10px] ${rssiColor}`}>
                                                    {rssi.toFixed(0)}dBm
                                                </span>
                                            )}
                                            <span className="font-mono text-slate-600 text-[9px]">{p.peerIDHex.substring(0,6)}</span>
                                        </div>
                                    }
                                />
                            );
                        })}
                        {activeConns.length === 0 && <div className="text-[10px] text-slate-600 italic text-center py-2">No active physical links</div>}
                    </div>
                </CollapsibleSection>

                {/* Actions */}
                <div className="mt-4 pt-2 border-t border-slate-800">
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
        const conn = engine.getConnectionById(selectedId);
        
        if (!conn) return null;
        
        const isBLE = conn instanceof BitchatConnectionBLE;
        const rssi = isBLE ? conn.rssi : null;

        return (
            <PanelWrapper title="Connection link" subtitle={conn.id.substring(0, 18) + "…"} onClose={() => select(null, null)} height={bottomPanelHeight}>
                 {/* Connection Visual */}
                <div className="flex items-center justify-between mb-4 bg-slate-900/50 p-3 rounded border border-slate-800">
                    <div className="text-center">
                        <div className="text-xs font-bold mb-1" style={{ color: getPeerColor(conn.endpointA.peerIDHex) }}>
                            {conn.endpointA.nickname}
                        </div>
                        <div className="text-[9px] text-slate-600 font-mono">{conn.endpointA.peerIDHex.substring(0,4)}</div>
                    </div>
                    
                    <div className="flex flex-col items-center gap-1">
                        <span className={`text-[9px] uppercase font-bold tracking-wider ${conn.isActive ? 'text-green-500' : 'text-red-500'}`}>
                            {conn.isActive ? 'LINKED' : 'BROKEN'}
                        </span>
                        <div className={`h-0.5 w-16 ${conn.isActive ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-red-500/50'}`} />
                         <span className="text-[9px] text-slate-600">BLE</span>
                    </div>

                    <div className="text-center">
                        <div className="text-xs font-bold mb-1" style={{ color: getPeerColor(conn.endpointB.peerIDHex) }}>
                            {conn.endpointB.nickname}
                        </div>
                        <div className="text-[9px] text-slate-600 font-mono">{conn.endpointB.peerIDHex.substring(0,4)}</div>
                    </div>
                </div>

                {/* RSSI Signal Strength */}
                {rssi !== null && (
                    <div className="mb-3 bg-slate-900/30 p-2.5 rounded border border-slate-800">
                        <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500 mb-2">SIGNAL STRENGTH</div>
                        <RssiBar rssi={rssi} />
                        <div className="flex justify-between mt-1.5 text-[9px] text-slate-600">
                            <span>Threshold: {RSSI_CONFIG.DISCONNECT_THRESHOLD}dBm</span>
                            <span>Max: {RSSI_CONFIG.MAX_RSSI}dBm</span>
                        </div>

                        {/* Detailed Stats */}
                        {isBLE && conn.lastStats && (
                            <div className="mt-3 pt-2 border-t border-slate-800 space-y-1">
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-slate-500">Distance</span>
                                    <span className="font-mono text-slate-300">{conn.lastStats.distance.toFixed(1)}m</span>
                                </div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-slate-500">Free Space Loss</span>
                                    <span className="font-mono text-slate-400">-{conn.lastStats.pathLoss.toFixed(1)}dB</span>
                                </div>
                                {conn.lastStats.gain !== 0 && (
                                     <div className="flex justify-between text-[10px]">
                                        <span className="text-slate-500">Device Gain</span>
                                        <span className="font-mono text-green-400">+{conn.lastStats.gain.toFixed(1)}dB</span>
                                    </div>
                                )}
                                {conn.lastStats.wallsCrossed > 0 && (
                                    <div className="flex justify-between text-[10px]">
                                        <span className="text-slate-500">Walls ({conn.lastStats.wallsCrossed})</span>
                                        <span className="font-mono text-red-400">-{conn.lastStats.wallLoss.toFixed(1)}dB</span>
                                    </div>
                                )}
                                {conn.lastStats.materialLoss > 0.1 && (
                                    <div className="flex justify-between text-[10px]">
                                        <span className="text-slate-500">Material Abs.</span>
                                        <span className="font-mono text-orange-400">-{conn.lastStats.materialLoss.toFixed(1)}dB</span>
                                    </div>
                                )}
                                <div className="flex justify-between text-[10px] pt-1 mt-1 border-t border-slate-800/50">
                                    <span className="text-slate-400">Target RSSI</span>
                                    <span className="font-mono text-white">{conn.lastStats.targetRSSI.toFixed(1)}dBm</span>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <CollapsibleSection title="TRAFFIC STATS" accentColor="text-cyan-600" persistenceKey="inspector_conn_traffic">
                    <div className="grid grid-cols-2 gap-2 mb-2">
                        <div className="rounded-lg bg-white/[0.03] p-2 ring-1 ring-white/[0.05]">
                            <div className="text-[9px] text-slate-500 mb-1">TOTAL PACKETS</div>
                            <div className="text-xl font-mono text-white">{conn.packetsSent}</div>
                        </div>
                        <div className="rounded-lg bg-white/[0.03] p-2 ring-1 ring-white/[0.05]">
                             <div className="text-[9px] text-slate-500 mb-1">LATENCY (SIM)</div>
                             <div className="text-xl font-mono text-white">~10ms</div>
                        </div>
                    </div>
                </CollapsibleSection>

                 <CollapsibleSection title="DEBUG INFO" accentColor="text-slate-600" persistenceKey="inspector_conn_debug">
                    <DataRow label="Initiator" value={conn.initiator === conn.endpointA ? 'Endpoint A' : 'Endpoint B'} />
                    <DataRow label="Created At" value="--:--:--" />
                    <DataRow label="Last Activity" value="0s ago" />
                 </CollapsibleSection>

            </PanelWrapper>
        );
    }

    return null;
};
