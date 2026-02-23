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
        <div className="fixed bottom-6 right-6 z-50 w-[400px] max-w-[calc(100vw-48px)] h-[600px] max-h-[calc(100vh-48px)] flex flex-col animate-in slide-in-from-bottom-4 duration-200 rounded-2xl shadow-2xl overflow-hidden" style={{ backgroundColor: '#F5F5F7' }}>
          {/* Header with gradient blue */}
          <div className="px-6 py-4 flex items-center justify-between" style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-white font-medium text-base">Online now</h3>
              </div>
            </div>
            
            <button
              onClick={() => setViewState('closed')}
              className="text-white/90 hover:text-white transition-colors p-1 hover:bg-white/10 rounded-lg"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Chat Content */}
          <div className="flex flex-col flex-1 overflow-hidden bg-white">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4" style={{ scrollbarWidth: 'thin' }}>
              {messages.map((msg) => (
                msg.role === 'system' ? (
                  <div key={msg.id} className="flex items-center gap-2 justify-center py-1">
                    <div className="h-px flex-1 bg-gray-200" />
                    <span className="text-[11px] text-gray-400 font-medium px-2 whitespace-nowrap">{msg.content}</span>
                    <div className="h-px flex-1 bg-gray-200" />
                  </div>
                ) : (
                <div
                  key={msg.id}
                  className={`flex items-start gap-3 ${
                    msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}>
                      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                    </div>
                  )}
                  <div
                    className={`flex-1 max-w-[75%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-transparent text-gray-900'
                        : 'text-gray-800 shadow-sm'
                    }`}
                    style={{
                      backgroundColor: msg.role === 'user' ? '#F0F0F0' : '#FFFFFF',
                      border: msg.role === 'assistant' ? '1px solid #E5E5E7' : 'none'
                    }}
                  >
                    {msg.content}
                  </div>
                </div>
                )
              ))}

              {sending && (
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}>
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                  <div className="flex gap-1.5 px-4 py-3 rounded-2xl bg-white border border-gray-200 shadow-sm">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="border-t border-gray-200 px-6 py-4 bg-white flex-shrink-0">
              <div className="flex gap-3 items-center">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Type your message..."
                  disabled={sending}
                  className="flex-1 px-4 py-3 bg-gray-100 border-0 rounded-full resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 transition-all text-[15px] disabled:bg-gray-100 disabled:opacity-50"
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!input.trim() || sending}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-medium disabled:opacity-40 transition-all hover:scale-105 active:scale-95 disabled:hover:scale-100 flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}
                >
                  {sending ? (
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-3 text-center">Powered by <span className="font-medium text-gray-600">ReceptionMate</span></p>
            </div>
          </div>
        </div>
      )}

      {/* Menu Options */}
      {viewState === 'menu' && (
        <div className="fixed bottom-6 right-6 z-50 w-[380px] animate-in slide-in-from-bottom-4 duration-200 bg-white rounded-xl shadow-2xl overflow-hidden">
          {/* Simple Header */}
          <div className="px-5 py-4 flex items-center justify-between" style={{ backgroundColor: '#2C50EF' }}>
            <h3 className="text-white font-semibold text-lg">Get in Touch</h3>
            <button
              onClick={() => setViewState('closed')}
              className="text-white/80 hover:text-white transition-colors p-1.5 hover:bg-white/10 rounded-lg"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Menu Content */}
          <div className="p-5">
            <p className="text-sm text-gray-600 text-center mb-5">Choose your preferred way to reach us</p>
              
            <div className="space-y-2.5">
              {/* WhatsApp Button */}
              {config.whatsappNumber && (
                <button
                  onClick={handleWhatsApp}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-lg transition-all hover:bg-gray-50 active:scale-[0.98] border border-gray-200 hover:border-green-500 hover:shadow-sm"
                >
                  <div className="w-11 h-11 bg-green-500 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                    </svg>
                  </div>
                  <div className="text-left flex-1">
                    <div className="font-semibold text-gray-900">WhatsApp</div>
                    <div className="text-xs text-gray-500">Message on WhatsApp</div>
                  </div>
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}

              {/* Live Chat Button */}
              <button
                onClick={handleStartChat}
                className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-lg transition-all hover:bg-gray-50 active:scale-[0.98] border border-gray-200 hover:border-blue-500 hover:shadow-sm"
              >
                <div className="w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}>
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="text-left flex-1">
                  <div className="font-semibold text-gray-900">Live Chat</div>
                  <div className="text-xs text-gray-500">Chat with our AI assistant</div>
                </div>
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>

              {/* Phone Button */}
              {config.phone && (
                <button
                  onClick={handleVoiceCall}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 rounded-lg transition-all hover:bg-gray-50 active:scale-[0.98] border border-gray-200 hover:border-purple-500 hover:shadow-sm"
                >
                  <div className="w-11 h-11 bg-purple-500 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  </div>
                  <div className="text-left flex-1">
                    <div className="font-semibold text-gray-900">Phone</div>
                    <div className="text-xs text-gray-500">Speak to our AI assistant</div>
                  </div>
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}
            </div>
            
            <div className="mt-5 pt-4 border-t border-gray-100 text-center">
              <p className="text-xs text-gray-400">Powered by <span className="font-medium text-gray-600">ReceptionMate</span></p>
            </div>
          </div>
        </div>
      )}

      {/* Pre-Chat Form */}
      {viewState === 'pre-chat' && (
        <div className="fixed bottom-6 right-6 z-50 w-[380px] max-w-[calc(100vw-48px)] animate-in slide-in-from-bottom-4 duration-200 bg-white rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="px-6 py-4 flex items-center justify-between" style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118z" />
                </svg>
              </div>
              <div>
                <h3 className="text-white font-semibold text-base">{config?.name ?? 'Chat'}</h3>
                <p className="text-white/70 text-xs">We typically reply instantly</p>
              </div>
            </div>
            <button
              onClick={() => setViewState('menu')}
              className="text-white/90 hover:text-white transition-colors p-1 hover:bg-white/10 rounded-lg"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </div>

          {/* Form */}
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600">Please share a few details before we get started.</p>

            <div>
              <label className="block text-sm font-medium text-gray-800 mb-1">Your name <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={preChatName}
                onChange={(e) => setPreChatName(e.target.value)}
                placeholder="e.g. John Smith"
                className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-gray-50"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-800 mb-1">Phone number <span className="text-red-500">*</span></label>
              <input
                type="tel"
                value={preChatPhone}
                onChange={(e) => setPreChatPhone(e.target.value)}
                placeholder="e.g. 07700 900000"
                className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-gray-50"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-800 mb-1">How can we help? <span className="text-red-500">*</span></label>
              <textarea
                rows={3}
                value={preChatMessage}
                onChange={(e) => setPreChatMessage(e.target.value)}
                placeholder="e.g. I'd like to book a service for my car…"
                className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-gray-50 resize-none"
              />
            </div>

            <button
              onClick={handlePreChatSubmit}
              disabled={!preChatName.trim() || !preChatPhone.trim() || !preChatMessage.trim() || preChatSubmitting}
              className="w-full py-3 rounded-xl text-white font-medium transition-all disabled:opacity-40 hover:opacity-90 active:scale-[0.98]"
              style={{ background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)' }}
            >
              {preChatSubmitting ? 'Starting chat…' : 'Start Chat'}
            </button>

            <p className="text-xs text-gray-400 text-center">Powered by <span className="font-medium text-gray-600">ReceptionMate</span></p>
          </div>
        </div>
      )}

      {/* Floating Button */}
      <button
        onClick={() => setViewState(viewState === 'closed' ? 'menu' : 'closed')}

        className="fixed bottom-6 right-6 z-50 w-16 h-16 rounded-full shadow-2xl hover:shadow-3xl flex items-center justify-center transition-all duration-300 hover:scale-105 active:scale-95"
        style={{ 
          background: 'linear-gradient(135deg, #5B8DEE 0%, #4776E6 100%)',
          boxShadow: '0 8px 24px rgba(75, 118, 230, 0.4)'
        }}
        aria-label={viewState === 'closed' ? 'Open chat' : 'Close chat'}
      >
        {viewState === 'closed' ? (
          <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ) : (
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>
    </>
  );
}
