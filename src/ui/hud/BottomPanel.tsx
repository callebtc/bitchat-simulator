import React, { useEffect, useRef } from 'react';
import { LogView } from './LogView';
import { ChatPanel } from './ChatPanel';
import { useSelection } from '../context/SelectionContext';
import { useSimulation } from '../context/SimulationContext';
import { useLayout } from '../context/LayoutContext';
import { usePersistedState } from '../../utils/usePersistedState';
import { HudPanel, cx } from './primitives';

const COLLAPSED_H = 36;
const EXPANDED_H = 272;

const Tab: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
    <button
        onClick={onClick}
        className={cx(
            'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
            active
                ? 'bg-cyan-400/15 text-cyan-100 ring-1 ring-cyan-300/35'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
        )}
    >
        {children}
    </button>
);

/** Floating console card: simulation log and the DM / broadcast chat composer. */
export const BottomPanel: React.FC = () => {
    const engine = useSimulation();
    const { selectedId, selectionType, chatRecipientId, isPickingRecipient } = useSelection();
    const { setBottomPanelHeight } = useLayout();
    const [isCollapsed, setIsCollapsed] = usePersistedState('bottom_panel_collapsed', false);
    const [activeTab, setActiveTab] = usePersistedState<'LOGS' | 'CHAT'>('bottom_panel_tab', 'LOGS');

    const prevRecipientRef = useRef<string | null>(null);

    // Chat tab is only valid when a node (not a connection edge) is selected
    const showChatTab = Boolean(selectedId && selectionType === 'node');

    // Reported height includes the 12 px gap below the floating card
    useEffect(() => {
        setBottomPanelHeight((isCollapsed ? COLLAPSED_H : EXPANDED_H) + 12);
    }, [isCollapsed, setBottomPanelHeight]);

    // Automatically open & switch to CHAT when a DM recipient is picked
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

    const open = (tab: 'LOGS' | 'CHAT') => {
        setActiveTab(tab);
        setIsCollapsed(false);
    };

    return (
        <HudPanel
            className="absolute bottom-3 left-3 right-3 z-20 overflow-hidden transition-[height] duration-200"
            style={{ height: isCollapsed ? COLLAPSED_H : EXPANDED_H }}
        >
            <div
                className="flex h-9 shrink-0 select-none items-center gap-1 px-2"
                onDoubleClick={() => setIsCollapsed(!isCollapsed)}
            >
                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="mr-1 flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-white/5 hover:text-white"
                    title={isCollapsed ? 'Expand console' : 'Collapse console'}
                >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                        <polyline points={isCollapsed ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
                    </svg>
                </button>
                <Tab active={activeTab === 'LOGS' && !isCollapsed} onClick={() => open('LOGS')}>
                    Log
                </Tab>
                {showChatTab && (
                    <Tab active={activeTab === 'CHAT' && !isCollapsed} onClick={() => open('CHAT')}>
                        Chat
                        {senderPerson && recipientPerson ? (
                            <span className="rounded bg-fuchsia-500/15 px-1.5 text-[10px] font-normal text-fuchsia-200 ring-1 ring-fuchsia-400/30">
                                {senderPerson.device.nickname} → {recipientPerson.device.nickname}
                            </span>
                        ) : senderPerson ? (
                            <span className="text-[10px] font-normal text-cyan-300/80">{senderPerson.device.nickname}</span>
                        ) : null}
                    </Tab>
                )}
                <div className="ml-auto truncate pr-1 text-[10px] text-slate-500">
                    {showChatTab && !chatRecipientId && !isPickingRecipient && (
                        <span>Chat → click the To: badge, then a device on the map, to start a DM</span>
                    )}
                    {showChatTab && chatRecipientId && !isPickingRecipient && (
                        <span>Click the To: badge to re-target · click empty map to deselect</span>
                    )}
                </div>
            </div>

            {!isCollapsed && (
                <div className="relative min-h-0 flex-1 overflow-hidden border-t border-white/[0.06]">
                    {activeTab === 'LOGS' ? <LogView /> : <ChatPanel />}
                </div>
            )}
        </HudPanel>
    );
};
