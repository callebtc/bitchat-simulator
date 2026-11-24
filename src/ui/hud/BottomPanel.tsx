import React, { useEffect, useRef } from 'react';
import { LogView } from './LogView';
import { ChatPanel } from './ChatPanel';
import { useSelection } from '../context/SelectionContext';
import { useSimulation } from '../context/SimulationContext';
import { useLayout } from '../context/LayoutContext';
import { usePersistedState } from '../../utils/usePersistedState';

export const BottomPanel: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType, chatRecipientId, isPickingRecipient } = useSelection();
    const { setBottomPanelHeight } = useLayout();
    const [isCollapsed, setIsCollapsed] = usePersistedState('bottom_panel_collapsed', false);
    const [activeTab, setActiveTab] = usePersistedState<'LOGS' | 'CHAT'>('bottom_panel_tab', 'LOGS');

    const prevRecipientRef = useRef<string | null>(null);

    // Chat tab is only valid when a node (not a connection edge) is selected
    const showChatTab = Boolean(selectedId && selectionType === 'node');

    useEffect(() => {
        setBottomPanelHeight(isCollapsed ? 32 : 272);
    }, [isCollapsed, setBottomPanelHeight]);

    // Automatically open & switch to CHAT when user picks a 2nd node on map or clicks a peer to DM
    useEffect(() => {
        if (showChatTab && chatRecipientId && chatRecipientId !== prevRecipientRef.current) {
            setActiveTab('CHAT');
            setIsCollapsed(false);
        }
        prevRecipientRef.current = chatRecipientId;
    }, [showChatTab, chatRecipientId, setActiveTab, setIsCollapsed]);

    // Automatically open CHAT when entering recipient picking mode
    useEffect(() => {
        if (showChatTab && isPickingRecipient) {
            setActiveTab('CHAT');
            setIsCollapsed(false);
        }
    }, [showChatTab, isPickingRecipient, setActiveTab, setIsCollapsed]);

    // Automatically switch back to LOGS if CHAT tab becomes invalid (e.g. deselection)
    useEffect(() => {
        if (!showChatTab && activeTab === 'CHAT') {
            setActiveTab('LOGS');
        }
    }, [showChatTab, activeTab, setActiveTab]);

    const senderPerson = showChatTab && selectedId ? engine.getPerson(selectedId) : undefined;
    const recipientPerson = chatRecipientId ? engine.getPersonByPeerId(chatRecipientId) : undefined;

    return (
        <div
            className={`absolute bottom-0 left-0 right-0 z-20 border-t border-white/10 bg-slate-950/85 backdrop-blur-xl flex flex-col shadow-[0_-8px_30px_rgba(0,0,0,0.35)] pointer-events-auto transition-all duration-200 ${
                isCollapsed ? 'h-8' : 'h-[272px]'
            }`}
        >
            {/* Header / Tabs */}
            <div
                className="flex items-center h-8 bg-slate-900/60 select-none border-b border-white/5 shrink-0"
                onClick={e => {
                    if (e.target === e.currentTarget) setIsCollapsed(!isCollapsed);
                }}
            >
                {/* Collapse Button */}
                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="w-8 h-full flex items-center justify-center text-green-500 hover:bg-white/5"
                    title={isCollapsed ? 'Expand bottom panel' : 'Collapse bottom panel'}
                >
                    {isCollapsed ? '▲' : '▼'}
                </button>

                {/* Tabs */}
                <div className="flex h-full">
                    <button
                        className={`px-4 text-xs font-bold font-mono transition-colors ${
                            activeTab === 'LOGS'
                                ? 'bg-black text-white border-t-2 border-green-500'
                                : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                        }`}
                        onClick={() => {
                            setActiveTab('LOGS');
                            setIsCollapsed(false);
                        }}
                    >
                        LOGS
                    </button>
                    {showChatTab && (
                        <button
                            className={`px-4 text-xs font-bold font-mono transition-colors flex items-center gap-2 ${
                                activeTab === 'CHAT'
                                    ? 'bg-black text-white border-t-2 border-cyan-500'
                                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                            }`}
                            onClick={() => {
                                setActiveTab('CHAT');
                                setIsCollapsed(false);
                            }}
                        >
                            <span>CHAT</span>
                            {senderPerson && recipientPerson ? (
                                <span className="text-[10px] font-normal text-fuchsia-300 bg-fuchsia-950/60 border border-fuchsia-800/60 px-1.5 py-0.5 rounded">
                                    {senderPerson.device.nickname} → {recipientPerson.device.nickname}
                                </span>
                            ) : senderPerson ? (
                                <span className="text-[10px] font-normal text-cyan-400/80">
                                    ({senderPerson.device.nickname})
                                </span>
                            ) : null}
                        </button>
                    )}
                </div>

                {/* Contextual 2-click hint */}
                <div className="flex-1 flex justify-end pr-3 text-[10px] font-mono text-gray-500 truncate">
                    {showChatTab && !chatRecipientId && !isPickingRecipient && (
                        <span>Tip: click any 2nd node on the map to start a DM &amp; probe route</span>
                    )}
                    {showChatTab && chatRecipientId && !isPickingRecipient && (
                        <span>Click another node to re-target · Click empty space to clear</span>
                    )}
                </div>
            </div>

            {/* Content Body */}
            {!isCollapsed && (
                <div className="flex-1 relative overflow-hidden bg-black/95">
                    {activeTab === 'LOGS' ? <LogView /> : <ChatPanel />}
                </div>
            )}
        </div>
    );
};
