import React, { useState, useEffect } from 'react';
import { LogView } from './LogView';
import { ChatPanel } from './ChatPanel';
import { useSelection } from '../context/SelectionContext';
import { useLayout } from '../context/LayoutContext';

export const BottomPanel: React.FC = () => {
    const { selectedId } = useSelection();
    const { setBottomPanelHeight } = useLayout();
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [activeTab, setActiveTab] = useState<'LOGS' | 'CHAT'>('LOGS');

    useEffect(() => {
        setBottomPanelHeight(isCollapsed ? 32 : 256);
    }, [isCollapsed, setBottomPanelHeight]);

    // Auto-switch to CHAT when a node is selected if it wasn't already?
    // Or just let user switch.
    // If we want chat button visible only when node selected:
    const showChatTab = !!selectedId;

    return (
        <div className={`absolute bottom-0 left-0 right-0 border-t border-gray-800 flex flex-col shadow-lg pointer-events-auto transition-all duration-300 ${isCollapsed ? 'h-8' : 'h-64'}`}>
            {/* Header / Tabs */}
            <div 
                className="flex items-center h-8 bg-gray-900 select-none border-b border-gray-800"
                onClick={(e) => {
                    // Toggle collapse if clicking background
                    if (e.target === e.currentTarget) setIsCollapsed(!isCollapsed);
                }}
            >
                {/* Collapse Button */}
                <button 
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="w-8 h-full flex items-center justify-center text-green-500 hover:bg-white/5"
                >
                    {isCollapsed ? '▲' : '▼'}
                </button>

                {/* Tabs */}
                <div className="flex h-full">
                    <button 
                        className={`px-4 text-xs font-bold font-mono transition-colors ${activeTab === 'LOGS' ? 'bg-black text-white border-t-2 border-green-500' : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'}`}
                        onClick={() => { setActiveTab('LOGS'); setIsCollapsed(false); }}
                    >
                        LOGS
                    </button>
                    {showChatTab && (
                        <button 
                            className={`px-4 text-xs font-bold font-mono transition-colors ${activeTab === 'CHAT' ? 'bg-black text-white border-t-2 border-cyan-500' : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'}`}
                            onClick={() => { setActiveTab('CHAT'); setIsCollapsed(false); }}
                        >
                            CHAT
                        </button>
                    )}
                </div>
                
                {/* Spacer */}
                <div className="flex-1" />
            </div>

            {/* Content Body */}
            {!isCollapsed && (
                <div className="flex-1 relative overflow-hidden bg-black/90">
                    {activeTab === 'LOGS' ? (
                        <LogView />
                    ) : (
                        <ChatPanel />
                    )}
                </div>
            )}
        </div>
    );
};
