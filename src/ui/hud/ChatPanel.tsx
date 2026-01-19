import React, { useEffect, useRef, useState } from 'react';
import { useSelection } from '../context/SelectionContext';
import { useSimulation } from '../context/SimulationContext';
import { BitchatAppSimulator, ChatMessage } from '../../simulation/AppLayer/BitchatAppSimulator';
import { getPeerColor } from '../../utils/colorUtils';

export const ChatPanel: React.FC = () => {
    const { selectedId, chatRecipientId, setChatRecipientId } = useSelection();
    const engine = useSimulation();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [inputText, setInputText] = useState('');
    const bottomRef = useRef<HTMLDivElement>(null);

    const person = selectedId ? engine.getPerson(selectedId) : null;
    const sim = person?.device.appSimulator as BitchatAppSimulator | undefined;

    useEffect(() => {
        if (!sim) return;
        
        // Poll for new messages (dirty but works for sim)
        const interval = setInterval(() => {
            if (sim.messages.length !== messages.length) {
                setMessages([...sim.messages]);
            }
        }, 200);
        
        return () => clearInterval(interval);
    }, [sim, messages.length]);

    useEffect(() => {
        if (bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    const handleSend = () => {
        if (!sim || !inputText.trim()) return;
        sim.sendMessage(inputText, chatRecipientId || undefined);
        setInputText('');
        setMessages([...sim.messages]); // Immediate update
    };

    if (!sim) return <div className="p-4 opacity-50">Select a node to chat</div>;

    return (
        <div className="flex flex-col h-full bg-black/90 font-mono text-xs">
            {/* Header / Target */}
            <div className="flex items-center gap-2 p-2 border-b border-gray-700 bg-gray-900/50">
                <span className="text-gray-400">To:</span>
                {chatRecipientId ? (
                    <div className="flex items-center gap-1 bg-blue-900/50 px-2 py-0.5 rounded border border-blue-700/50">
                        <span style={{ color: getPeerColor(chatRecipientId) }}>
                            {chatRecipientId.substring(0,8)}...
                        </span>
                        <button 
                            onClick={() => setChatRecipientId(null)}
                            className="ml-1 text-red-400 hover:text-red-300 font-bold"
                        >
                            ✕
                        </button>
                    </div>
                ) : (
                    <span className="text-cyan-400 font-bold">[BROADCAST]</span>
                )}
            </div>

            {/* Message History */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {messages.map(msg => (
                    <div key={msg.id} className="break-all hover:bg-white/5 p-0.5 rounded">
                        <span className="opacity-40 mr-2">
                            [{new Date(msg.timestamp).toLocaleTimeString()}]
                        </span>
                        
                        {/* Sender */}
                        <span 
                            className="font-bold"
                            style={{ color: getPeerColor(msg.senderId) }}
                        >
                            &lt;{msg.senderId.substring(0,6)}&gt;
                        </span>

                        {/* DM Indicator */}
                        {msg.recipientId && (
                            <>
                                <span className="text-gray-500 mx-1">➜</span>
                                <span style={{ color: getPeerColor(msg.recipientId) }}>
                                    &lt;{msg.recipientId.substring(0,6)}&gt;
                                </span>
                            </>
                        )}

                        <span className="ml-2 text-gray-200">{msg.text}</span>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="p-2 border-t border-gray-700 flex gap-2">
                <input 
                    type="text" 
                    className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white focus:border-cyan-500 focus:outline-none"
                    placeholder={`Message ${chatRecipientId ? 'user...' : 'broadcast...'}`}
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSend()}
                />
                <button 
                    onClick={handleSend}
                    className="bg-cyan-700 hover:bg-cyan-600 text-white px-3 py-1 rounded"
                >
                    SEND
                </button>
            </div>
        </div>
    );
};
