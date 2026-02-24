'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

interface GarageConfig {
  name: string;
  phone?: string;
  whatsappNumber?: string;
  primaryColor?: string;
}

type ViewState = 'closed' | 'menu' | 'pre-chat' | 'chat';

export default function ChatWidget() {
  const params = useParams();
  const garageId = params?.garageId as string;
  const [viewState, setViewState] = useState<ViewState>('closed');
  const [config, setConfig] = useState<GarageConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Add multiple messages sequentially with typing indicator before each bubble
  const addMessagesSequentially = async (bubbles: string[]) => {
    for (let i = 0; i < bubbles.length; i++) {
      // Show typing indicator before every bubble (setSending(true) is already set by caller)
      // Wait proportional to message length — feels like Leah is typing it
      const delay = 500 + bubbles[i].length * 22;
      await new Promise(resolve => setTimeout(resolve, delay));
      // Add the bubble, then briefly keep the indicator on before the next one
      setMessages(prev => [...prev, {
        id: `${Date.now()}-${i}`,
        role: 'assistant' as const,
        content: bubbles[i],
        timestamp: new Date(),
      }]);
      // Short pause between consecutive bubbles so they don't pop in simultaneously
      if (i < bubbles.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
    setSending(false);
  };

  // Pre-chat form state
  const [preChatName, setPreChatName] = useState('');
  const [preChatPhone, setPreChatPhone] = useState('');
  const [preChatMessage, setPreChatMessage] = useState('');
  const [preChatSubmitting, setPreChatSubmitting] = useState(false);

  useEffect(() => {
    if (!garageId) return;
    
    fetch(`/api/widget/${garageId}`)
      .then((res) => {
        if (res.ok) {
          return res.json();
        }
        throw new Error('Failed to fetch');
      })
      .then((data) => {
        setConfig(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load widget config, using fallback:', err);
        // Fallback config for demo
        setConfig({
          name: 'Demo Garage',
          phone: '+447123456789',
          whatsappNumber: '447123456789',
          primaryColor: '#2C50EF'
        });
        setLoading(false);
      });
  }, [garageId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleStartChat = () => {
    setViewState('pre-chat');
  };

  const handlePreChatSubmit = async () => {
    if (!preChatName.trim() || !preChatPhone.trim() || !preChatMessage.trim()) return;
    setPreChatSubmitting(true);

    // Build the opening message from the form fields
    const openingMessage = `My name is ${preChatName.trim()}, my phone number is ${preChatPhone.trim()}. ${preChatMessage.trim()}`;

    // Switch to chat view and show the greeting
    setViewState('chat');
    const joinNotice: Message = {
      id: 'join-notice',
      role: 'system',
      content: 'Leah joined the chat',
      timestamp: new Date(),
    };
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: openingMessage,
      timestamp: new Date(),
    };
    setMessages([joinNotice, userMsg]);
    setSending(true);

    try {
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_API_BASE_URL || 'http://18.171.230.217:4000';
      const response = await fetch(`${backendUrl}/api/chat/widget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          garageId,
          message: openingMessage,
          conversationId,
          contactPhone: preChatPhone.trim(),
          contactName: preChatName.trim(),
        }),
      });

      if (!response.ok) throw new Error('Backend unavailable');

      const data = await response.json();
      if (data.conversationId && !conversationId) setConversationId(data.conversationId);

      const bubbles: string[] = data.messages && data.messages.length > 0 ? data.messages : [data.response];
      await addMessagesSequentially(bubbles);
    } catch {
      setMessages((prev) => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: "I'm sorry, the chat service is currently unavailable. Please try calling us or using WhatsApp instead.",
        timestamp: new Date(),
      }]);
    } finally {
      setPreChatSubmitting(false);
    }
  };

  const handleVoiceCall = () => {
    if (config?.phone) {
      window.location.href = `tel:${config.phone}`;
    }
  };

  const handleWhatsApp = () => {
    if (config?.whatsappNumber) {
      const message = encodeURIComponent('Hi, I would like to get in touch.');
      window.open(`https://wa.me/${config.whatsappNumber}?text=${message}`, '_blank');
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim() || sending) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setSending(true);

    try {
      // Use production backend
      const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_API_BASE_URL || 'http://18.171.230.217:4000';
      const response = await fetch(`${backendUrl}/api/chat/widget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          garageId,
          message: userMessage.content,
          conversationId,
          contactPhone: preChatPhone.trim() || undefined,
          contactName: preChatName.trim() || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error('Backend unavailable');
      }

      const data = await response.json();
      
      if (data.conversationId && !conversationId) {
        setConversationId(data.conversationId);
      }
      
      const bubbles: string[] = data.messages && data.messages.length > 0 ? data.messages : [data.response];
      await addMessagesSequentially(bubbles);
    } catch (error) {
      console.error('Chat error:', error);
      setMessages((prev) => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: "I'm sorry, the chat service is currently unavailable. Please try calling us or using WhatsApp instead.",
        timestamp: new Date(),
      }]);
      setSending(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  if (loading) {
    return null;
  }

  if (!config) {
    return null;
  }

  return (
    <>
      {/* Chat Window */}
      {viewState === 'chat' && (
        <div className="fixed bottom-24 right-6 z-50 w-[400px] max-w-[calc(100vw-48px)] h-[600px] max-h-[calc(100vh-120px)] flex flex-col animate-in slide-in-from-bottom-4 duration-200 rounded-2xl shadow-2xl overflow-hidden border border-slate-800" style={{ backgroundColor: '#020617' }}>
          {/* Header */}
          <div className="px-5 py-4 flex items-center justify-between border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center">
                <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-slate-100 font-semibold text-sm">Online now</h3>
                <p className="text-sky-400 text-xs">AI Assistant</p>
              </div>
            </div>
            
            <button
              onClick={() => setViewState('closed')}
              className="text-slate-400 hover:text-slate-100 transition-colors p-1.5 hover:bg-slate-800 rounded-lg"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Chat Content */}
          <div className="flex flex-col flex-1 overflow-hidden bg-slate-950">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4" style={{ scrollbarWidth: 'thin' }}>
              {messages.map((msg) => (
                msg.role === 'system' ? (
                  <div key={msg.id} className="flex items-center gap-2 justify-center py-1">
                    <div className="h-px flex-1 bg-slate-800" />
                    <span className="text-[11px] text-slate-500 font-medium px-2 whitespace-nowrap">{msg.content}</span>
                    <div className="h-px flex-1 bg-slate-800" />
                  </div>
                ) : (
                <div
                  key={msg.id}
                  className={`flex items-start gap-3 ${
                    msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                    </div>
                  )}
                  <div
                    className={`flex-1 max-w-[75%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-sky-500/20 text-slate-100 border border-sky-500/30'
                        : 'bg-slate-800/80 text-slate-200 border border-slate-700'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
                )
              ))}

              {sending && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                  <div className="flex gap-1.5 px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700">
                    <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></div>
                    <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="border-t border-slate-800 px-4 py-4 bg-slate-950 flex-shrink-0">
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Type your message..."
                  disabled={sending}
                  className="flex-1 px-4 py-2.5 bg-slate-800 border border-slate-700 rounded-full text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-all disabled:opacity-50"
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!input.trim() || sending}
                  className="w-9 h-9 rounded-full bg-sky-500 hover:bg-sky-400 flex items-center justify-center text-white disabled:opacity-40 transition-all hover:scale-105 active:scale-95 disabled:hover:scale-100 flex-shrink-0"
                >
                  {sending ? (
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="text-xs text-slate-600 mt-3 text-center">Powered by <span className="font-medium text-slate-500">ReceptionMate</span></p>
            </div>
          </div>
        </div>
      )}

      {/* Menu Options */}
      {viewState === 'menu' && (
        <div className="fixed bottom-24 right-6 z-50 w-[340px] animate-in slide-in-from-bottom-4 duration-200 rounded-3xl shadow-2xl overflow-hidden" style={{ backgroundColor: '#1e293b' }}>
          {/* Dark branded header */}
          <div className="px-5 pt-6 pb-5 flex flex-col items-center">
            <div className="w-12 h-12 rounded-2xl bg-blue-600/80 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-white font-bold text-lg">{config?.name ?? 'ReceptionMate Branch'}</h3>
            <p className="text-slate-400 text-sm mt-1">We typically reply instantly</p>
          </div>

          {/* White card body */}
          <div className="bg-white px-5 pt-4 pb-4 rounded-t-3xl">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">MESSAGE US ON...</p>

            <div className="space-y-2.5">
              {/* Live Chat Button */}
              <button
                onClick={handleStartChat}
                className="w-full flex items-center gap-3.5 px-4 py-4 rounded-2xl transition-all bg-white hover:bg-gray-50 active:scale-[0.98] border-2 border-blue-200"
              >
                <div className="w-11 h-11 bg-sky-500 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <span className="text-base font-bold text-gray-900">Live Chat</span>
              </button>

              {/* Phone Button */}
              {config.phone && (
                <button
                  onClick={handleVoiceCall}
                  className="w-full flex items-center gap-3.5 px-4 py-4 rounded-2xl transition-all bg-white hover:bg-gray-50 active:scale-[0.98] border-2 border-blue-200"
                >
                  <div className="w-11 h-11 bg-violet-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  </div>
                  <span className="text-base font-bold text-gray-900">Phone</span>
                </button>
              )}
            </div>

            {/* Powered by */}
            <div className="mt-4 pt-3 text-center">
              <p className="text-xs text-gray-400">Powered by <span className="font-bold text-gray-700">ReceptionMate</span></p>
            </div>
          </div>
        </div>
      )}

      {/* Pre-Chat Form */}
      {viewState === 'pre-chat' && (
        <div className="fixed bottom-24 right-6 z-50 w-[340px] max-w-[calc(100vw-48px)] animate-in slide-in-from-bottom-4 duration-200 rounded-3xl shadow-2xl overflow-hidden" style={{ backgroundColor: '#1e293b' }}>
          {/* Dark branded header */}
          <div className="px-5 pt-6 pb-5 flex flex-col items-center relative">
            <button
              onClick={() => setViewState('menu')}
              className="absolute top-4 left-4 text-slate-400 hover:text-white transition-colors p-1"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="w-12 h-12 rounded-2xl bg-blue-600/80 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-white font-bold text-lg">{config?.name ?? 'ReceptionMate Branch'}</h3>
            <p className="text-slate-400 text-sm mt-1">We typically reply instantly</p>
          </div>

          {/* White card form */}
          <div className="bg-white px-5 pt-6 pb-5 rounded-t-3xl space-y-3">
            <input
              type="text"
              value={preChatName}
              onChange={(e) => setPreChatName(e.target.value)}
              placeholder="First name"
              className="w-full px-5 py-3.5 bg-white border-2 border-gray-200 rounded-full text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-0 focus:border-blue-300"
            />

            <input
              type="tel"
              value={preChatPhone}
              onChange={(e) => setPreChatPhone(e.target.value)}
              placeholder="Phone number (e.g. 07700 900000)"
              className="w-full px-5 py-3.5 bg-white border-2 border-gray-200 rounded-full text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-0 focus:border-blue-300"
            />

            <textarea
              rows={4}
              value={preChatMessage}
              onChange={(e) => setPreChatMessage(e.target.value)}
              placeholder="Please, type your message here..."
              className="w-full px-5 py-3.5 bg-white border-2 border-gray-200 rounded-3xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-0 focus:border-blue-300 resize-none"
            />

            <button
              onClick={handlePreChatSubmit}
              disabled={!preChatName.trim() || !preChatPhone.trim() || !preChatMessage.trim() || preChatSubmitting}
              className="w-full py-3.5 rounded-full text-white text-base font-bold transition-all disabled:opacity-40 active:scale-[0.98]"
              style={{ backgroundColor: '#38bdf8' }}
            >
              {preChatSubmitting ? 'Starting chat…' : 'Start Chat'}
            </button>

            {/* Powered by */}
            <div className="pt-2 text-center">
              <p className="text-xs text-gray-400">Powered by <span className="font-bold text-gray-700">ReceptionMate</span></p>
            </div>
          </div>
        </div>
      )}

      {/* Floating Pill Button */}
      <button
        onClick={() => setViewState(viewState === 'closed' ? 'menu' : 'closed')}
        className="fixed bottom-6 right-6 z-50 h-14 px-6 rounded-full flex items-center gap-3 transition-all duration-300 hover:scale-105 active:scale-95 whitespace-nowrap"
        style={{ backgroundColor: '#1e293b', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}
        aria-label={viewState === 'closed' ? 'Open chat' : 'Close chat'}
      >
        {viewState === 'closed' ? (
          <>
            <svg className="w-5 h-5 text-white flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-white font-bold text-base">Chat now!</span>
          </>
        ) : (
          <>
            <svg className="w-5 h-5 text-white flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-white font-bold text-base">Close</span>
          </>
        )}
      </button>
    </>
  );
}
