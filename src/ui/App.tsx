import { useEffect } from 'react';
import { SimulationProvider, useSimulation } from './context/SimulationContext';
import { SelectionProvider, useSelection } from './context/SelectionContext';
import { Scene } from './scene/Scene';
import { InspectorPanel } from './hud/InspectorPanel';
import { MainControlPanel } from './hud/MainControlPanel';
import { BottomPanel } from './hud/BottomPanel';

import { setupDemo } from '../simulation/DemoSetup';
import { probePeerRoute } from '../simulation/MeshProbe';

import { LayoutProvider } from './context/LayoutContext';
import { VisualizationProvider } from './context/VisualizationContext';
import { CameraProvider } from './context/CameraContext';
import { TerrainProvider } from './context/TerrainContext';
import { PeerLabels } from './overlays/PeerLabels';
import { ChatBubbles } from './overlays/ChatBubbles';
import { ViewDock } from './hud/ViewDock';
import { DevicePhone } from './hud/DevicePhone';

const SimulationController = () => {
    const engine = useSimulation();
    const { select } = useSelection();

    useEffect(() => {
        const handleReset = () => select(null, null);
        engine.events.on('reset', handleReset);
        setupDemo(engine, 5); // Auto init
        engine.start();
        return () => {
            engine.events.off('reset', handleReset);
            engine.stop();
        };
    }, [engine, select]);

    return null;
};

const RecipientPickBanner = () => {
    const engine = useSimulation();
    const { selectedId, isPickingRecipient, setPickingRecipient, highlightedId } = useSelection();

    if (!isPickingRecipient || !selectedId) return null;

    const sender = engine.getPerson(selectedId);
    const hovered = highlightedId ? engine.getPersonByPeerId(highlightedId) : undefined;
    const probe =
        sender && hovered && hovered.id !== sender.id
            ? probePeerRoute(engine, sender.device.peerIDHex, hovered.device.peerIDHex)
            : null;

    return (
        <div className="fixed top-[92px] left-1/2 -translate-x-1/2 z-30 pointer-events-auto bg-black/90 border border-cyan-500/70 rounded px-3.5 py-2 shadow-2xl font-mono text-xs text-cyan-100 flex items-center gap-3 backdrop-blur-md">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            <span>
                Click any node on the map to DM from{' '}
                <strong className="text-cyan-300">{sender?.device.nickname}</strong>
            </span>
            {probe && hovered && (
                <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                        probe.canDeliver
                            ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-300'
                            : 'bg-red-950/80 border-red-500/60 text-red-300'
                    }`}
                >
                    → {hovered.device.nickname}:{' '}
                    {probe.status === 'direct_ble'
                        ? `DIRECT BLE (${probe.directLink?.rssiDbm.toFixed(0)} dBm)`
                        : probe.status === 'direct_wifi'
                          ? `DIRECT Wi-Fi (${probe.directLink?.rssiDbm.toFixed(0)} dBm)`
                          : probe.status === 'source_route'
                            ? `SOURCE ROUTE · ${probe.hops}h`
                            : probe.status === 'flood_reachable'
                              ? `REACHABLE · ${probe.hops}h`
                              : probe.status === 'exceeds_ttl'
                                ? `TOO FAR (${probe.hops}h)`
                                : 'NO PATH'}
                </span>
            )}
            <button
                onClick={() => setPickingRecipient(false)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-600"
            >
                ESC
            </button>
        </div>
    );
};

const LayoutContent = () => {
    return (
        <SelectionProvider>
            <SimulationController />
            <CameraProvider>
                <Scene />
                <PeerLabels />
                <ChatBubbles />
                <ViewDock />
                <RecipientPickBanner />
                <MainControlPanel />
                <InspectorPanel />
                <DevicePhone />
                <BottomPanel />
            </CameraProvider>
        </SelectionProvider>
    );
};

function App() {
    return (
        <LayoutProvider>
            <VisualizationProvider>
                <SimulationProvider>
                    <TerrainProvider>
                        <LayoutContent />
                    </TerrainProvider>
                </SimulationProvider>
            </VisualizationProvider>
        </LayoutProvider>
    );
}

export default App;
