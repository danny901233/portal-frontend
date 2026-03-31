'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';

// Load Poppins font
if (typeof window !== 'undefined') {
  const link = document.createElement('link');
  link.href = 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap';
  link.rel = 'stylesheet';
  document.head.appendChild(link);
}

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
  logoUrl?: string | null;
  logoWidth?: number;
  logoHeight?: number;
  buttonColor?: string;
  buttonShape?: string;
  buttonIcon?: string;
  agentName?: string;
}

type ViewState = 'closed' | 'menu' | 'pre-chat' | 'chat';

function renderMessageContent(content: string, primaryColor: string, isUser: boolean) {
  // Detect numbered list: at least two items like "1. ... 2. ..."
  const hasNumberedList = /\d+\.\s.+\s\d+\.\s/.test(content);

  if (!hasNumberedList || isUser) {
    return content.split('\n').map((line, i) => (
      <span key={i}>{i > 0 && <br />}{line}</span>
    ));
  }

  // Split intro text from list (find where "1. " starts)
  const listStartIdx = content.search(/(?:^|\s)1\.\s/);
  const intro = listStartIdx > 0 ? content.substring(0, listStartIdx).trim() : '';
  const listPart = content.substring(listStartIdx >= 0 ? listStartIdx : 0).trim();

  // Parse each "N. text — price" item
  const rawItems = listPart.split(/(?=\d+\.\s)/).filter(Boolean);
  const items = rawItems.map((part) => {
    const m = part.match(/^(\d+)\.\s([\s\S]+)$/);
    if (!m) return null;
    const full = m[2].trim();
    const dashIdx = full.indexOf(' — ');
    return {
      num: m[1],
      name: dashIdx >= 0 ? full.substring(0, dashIdx).trim() : full,
      price: dashIdx >= 0 ? full.substring(dashIdx + 3).trim() : undefined,
    };
  }).filter(Boolean) as { num: string; name: string; price?: string }[];

  return (
    <>
      {intro && <p style={{ marginBottom: '10px', color: '#374151' }}>{intro}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {items.map((item) => (
          <div key={item.num} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '9px 11px',
            backgroundColor: 'rgba(0,0,0,0.03)',
            borderRadius: '10px',
            border: '1px solid rgba(0,0,0,0.07)',
          }}>
            <div style={{
              width: '22px', height: '22px', borderRadius: '50%',
              backgroundColor: primaryColor, color: 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '11px', fontWeight: 700, flexShrink: 0,
            }}>{item.num}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: '13px', color: '#111827', lineHeight: '1.3' }}>{item.name}</div>
              {item.price && <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '1px' }}>{item.price}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export default function ChatWidget() {
  const params = useParams();
  const garageId = params?.garageId as string;
  const [viewState, setViewState] = useState<ViewState>('closed');
  const [isSpinning, setIsSpinning] = useState(false);
  const [config, setConfig] = useState<GarageConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Auto-focus input when entering chat view
  useEffect(() => {
    if (viewState === 'chat') {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [viewState]);

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
    // Use configured WhatsApp number or fallback to phone number
    const whatsappNum = config?.whatsappNumber || config?.phone?.replace(/[^0-9]/g, '');
    if (whatsappNum) {
      const message = encodeURIComponent('Hi, I would like to get in touch.');
      window.open(`https://wa.me/${whatsappNum}?text=${message}`, '_blank');
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
        <div className="fixed bottom-6 right-6 z-50 flex flex-col animate-in slide-in-from-bottom-4 duration-300" style={{
          width: '360px',
          height: '600px',
          backgroundColor: 'white',
          borderRadius: '20px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
          fontFamily: "'Poppins', sans-serif",
          overflow: 'hidden'
        }}>
          {/* Compact coloured header */}
          <div className="flex items-center gap-3 px-4 flex-shrink-0" style={{
            background: config?.primaryColor || '#1e3a8a',
            height: '60px'
          }}>
            {/* Logo or avatar */}
            {config?.logoUrl ? (
              <img src={config.logoUrl} alt="Logo" style={{ height: '32px', width: 'auto', maxWidth: '100px', objectFit: 'contain', flexShrink: 0 }} />
            ) : (
              <div className="relative flex-shrink-0">
                <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.2)' }}>
                  <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2" style={{ backgroundColor: '#22c55e', borderColor: config?.primaryColor || '#1e3a8a' }} />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-white truncate leading-tight" style={{ fontSize: '14px' }}>{config?.name || 'ReceptionMate'}</p>
              <p className="text-xs" style={{ color: 'rgba(255,255,255,0.75)' }}>● Online · Typically replies instantly</p>
            </div>
            <button
              onClick={() => setViewState('closed')}
              className="flex items-center justify-center rounded-full transition-all active:scale-90 flex-shrink-0"
              style={{ width: '30px', height: '30px', background: 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', color: 'white' }}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto" style={{
            padding: '16px 16px 8px',
            scrollbarWidth: 'thin',
            background: '#f9fafb'
          }}>
              {messages.map((msg, idx) => {
                // Compute group position for visual grouping (skip system messages in prev/next checks)
                const nonSystemMessages = messages.filter(m => m.role !== 'system');
                const nsIdx = nonSystemMessages.indexOf(msg);
                const prevMsg = nsIdx > 0 ? nonSystemMessages[nsIdx - 1] : null;
                const nextMsg = nsIdx < nonSystemMessages.length - 1 ? nonSystemMessages[nsIdx + 1] : null;
                const isFirstInGroup = !prevMsg || prevMsg.role !== msg.role;
                const isLastInGroup = !nextMsg || nextMsg.role !== msg.role;

                return msg.role === 'system' ? (
                  <div key={msg.id} className="flex items-center gap-2 justify-center py-1">
                    <div className="h-px flex-1" style={{ backgroundColor: 'rgba(0, 0, 0, 0.1)' }} />
                    <span className="text-xs font-medium px-2 whitespace-nowrap" style={{ color: 'rgba(0, 0, 0, 0.5)' }}>{msg.content}</span>
                    <div className="h-px flex-1" style={{ backgroundColor: 'rgba(0, 0, 0, 0.1)' }} />
                  </div>
                ) : (
                <div key={msg.id} className={`flex items-end gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`} style={{ marginBottom: isLastInGroup ? '4px' : '2px' }}>
                  {/* Avatar: only show on last bubble of an assistant group; reserve space otherwise */}
                  {msg.role === 'assistant' && (
                    <div className="w-8 flex-shrink-0 flex items-end justify-center" style={{ paddingBottom: '2px' }}>
                      {isLastInGroup && (
                        <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: config?.primaryColor || '#3f51b5' }}>
                          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex flex-col" style={{ maxWidth: '75%', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: '2px' }}>
                    {/* Name label: only on first assistant bubble in a group */}
                    {msg.role === 'assistant' && isFirstInGroup && (
                      <span className="text-xs font-medium px-1" style={{ color: '#6b7280', fontFamily: "'Poppins', sans-serif" }}>
                        {config?.agentName || 'Leah'}
                      </span>
                    )}
                    <div className="text-sm leading-relaxed" style={{
                      padding: '10px 14px',
                      borderRadius: '14px',
                      ...(msg.role === 'user' ? {
                        backgroundColor: config?.primaryColor || '#3f51b5',
                        color: 'white',
                        borderBottomRightRadius: isLastInGroup ? '4px' : '14px',
                        borderTopRightRadius: isFirstInGroup ? '14px' : '6px',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.12)'
                      } : {
                        backgroundColor: '#f3f4f6',
                        color: '#111827',
                        borderBottomLeftRadius: isLastInGroup ? '4px' : '14px',
                        borderTopLeftRadius: isFirstInGroup ? '14px' : '6px',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
                      })
                    }}>
                      {renderMessageContent(msg.content, config?.primaryColor || '#3f51b5', msg.role === 'user')}
                    </div>
                    {/* Timestamp: only on last bubble in a group */}
                    {isLastInGroup && (
                      <span className="text-xs px-1" style={{ color: 'rgba(0,0,0,0.35)', fontFamily: "'Poppins', sans-serif" }}>
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                </div>
                );
              })}

              {sending && (() => {
                const lastNonSystem = [...messages].reverse().find(m => m.role !== 'system');
                const prevIsAssistant = lastNonSystem?.role === 'assistant';
                return (
                  <div className="flex items-end gap-2">
                    <div className="w-8 flex-shrink-0" />
                    <div className="flex flex-col" style={{ gap: '2px' }}>
                      {!prevIsAssistant && (
                        <span className="text-xs font-medium px-1" style={{ color: '#6b7280', fontFamily: "'Poppins', sans-serif" }}>
                          {config?.agentName || 'Leah'}
                        </span>
                      )}
                      <div className="flex gap-1.5" style={{
                        padding: '10px 14px',
                        borderRadius: '14px',
                        borderBottomLeftRadius: '4px',
                        backgroundColor: '#f3f4f6',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.06)'
                      }}>
                        <div className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)' }}></div>
                        <div className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)', animationDelay: '150ms' }}></div>
                        <div className="w-2 h-2 rounded-full animate-bounce" style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)', animationDelay: '300ms' }}></div>
                      </div>
                    </div>
                  </div>
                );
              })()}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area - EXACT Cognigy Style */}
            <div className="px-4 py-4 flex-shrink-0" style={{
              backgroundColor: '#fafafa',
              borderTop: '1px solid rgba(0, 0, 0, 0.08)'
            }}>
              <div className="flex gap-2 items-center">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Type your message..."
                  disabled={sending}
                  className="flex-1"
                  style={{
                    padding: '12px 16px',
                    backgroundColor: 'white',
                    border: '1px solid rgba(0, 0, 0, 0.12)',
                    borderRadius: '24px',
                    fontSize: '16px',
                    color: '#000',
                    outline: 'none',
                    transition: 'border-color 0.2s'
                  }}
                  onFocus={(e) => e.currentTarget.style.borderColor = config?.primaryColor || '#3f51b5'}
                  onBlur={(e) => e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.12)'}
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!input.trim() || sending}
                  className="flex-shrink-0 rounded-full flex items-center justify-center transition-all"
                  style={{
                    width: '40px',
                    height: '40px',
                    backgroundColor: config?.primaryColor || '#3f51b5',
                    color: 'white',
                    border: 'none',
                    cursor: !input.trim() || sending ? 'not-allowed' : 'pointer',
                    opacity: !input.trim() || sending ? 0.4 : 1
                  }}
                >
                  {sending ? (
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="text-xs mt-3 text-center" style={{ color: 'rgba(0, 0, 0, 0.4)' }}>Powered by <span className="font-medium" style={{ color: 'rgba(0, 0, 0, 0.6)' }}>ReceptionMate</span></p>
            </div>
        </div>
      )}

      {/* Menu Options - Overlay Style: Large background with smaller white rectangle */}
      {viewState === 'menu' && (
        <div className="fixed bottom-28 right-6 z-50 animate-in slide-in-from-bottom-4 duration-200" style={{ 
          width: '380px',
          borderRadius: '32px',
          background: config?.primaryColor || '#1e3a8a',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
          fontSize: '17px',
          fontFamily: "'Poppins', sans-serif",
          paddingTop: `${Math.max(120, (config?.logoHeight || 60) + 70)}px`,
          paddingBottom: '40px',
          paddingLeft: '32px',
          paddingRight: '32px'
        }}>
          {/* Logo Area - Above the white card */}
          <div className="absolute top-8 left-0 right-0 flex justify-center">
            {config?.logoUrl ? (
              <img 
                src={config.logoUrl} 
                alt="Logo" 
                style={{ 
                  width: `${config?.logoWidth || 120}px`,
                  height: `${config?.logoHeight || 60}px`,
                  objectFit: 'contain',
                  display: 'block'
                }} 
              />
            ) : (
              <div style={{
                width: `${config?.logoWidth || 120}px`,
                height: `${config?.logoHeight || 60}px`,
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(10px)',
                borderRadius: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transform: 'rotate(12deg)'
              }}>
                <svg style={{ width: `${(config?.logoWidth || 120) * 0.6}px`, height: `${(config?.logoHeight || 60) * 0.6}px`, color: 'rgba(255, 255, 255, 0.6)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
            )}
          </div>

          {/* White overlay rectangle */}
          <div style={{ 
            backgroundColor: 'white', 
            borderRadius: '24px',
            padding: '24px 20px 24px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)'
          }}>
            <h4 className="text-gray-900 font-medium text-lg mb-5" style={{ fontFamily: "'Poppins', sans-serif" }}>Message us on...</h4>
            
            <div className="space-y-3">
              {/* WhatsApp Button */}
              <button
                onClick={handleWhatsApp}
                className="w-full flex items-center gap-4 transition-all"
                style={{ 
                  backgroundColor: 'white',
                  color: '#333',
                  padding: '16px 20px',
                  fontSize: '17px',
                  borderRadius: '16px',
                  border: '2px solid #5DDCC2',
                  outline: 'none',
                  cursor: 'pointer',
                  fontFamily: "'Poppins', sans-serif"
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.currentTarget.style.backgroundColor = '#f0fdf9';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.currentTarget.style.backgroundColor = 'white';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg className="w-7 h-7 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                </div>
                <div className="flex-1 text-left">
                  <span className="block font-medium">WhatsApp</span>
                </div>
              </button>

              {/* Live Chat Button */}
              <button
                onClick={handleStartChat}
                className="w-full flex items-center gap-4 transition-all"
                style={{ 
                  backgroundColor: 'white',
                  color: '#333',
                  padding: '16px 20px',
                  fontSize: '17px',
                  borderRadius: '16px',
                  border: '2px solid #5DDCC2',
                  outline: 'none',
                  cursor: 'pointer',
                  fontFamily: "'Poppins', sans-serif"
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.currentTarget.style.backgroundColor = '#f0fdf9';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.currentTarget.style.backgroundColor = 'white';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0" style={{
                  background: config?.primaryColor || '#5DDCC2'
                }}>
                  <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="flex-1 text-left">
                  <span className="block font-medium">Live Chat</span>
                </div>
              </button>

              {/* Phone Button */}
              {config.phone && (
                <button
                  onClick={handleVoiceCall}
                  className="w-full flex items-center gap-4 transition-all"
                  style={{ 
                    backgroundColor: 'white',
                    color: '#333',
                    padding: '16px 20px',
                    fontSize: '17px',
                    borderRadius: '16px',
                    border: '2px solid #5DDCC2',
                    outline: 'none',
                    cursor: 'pointer',
                    fontFamily: "'Poppins', sans-serif"
                  }}
                  onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.currentTarget.style.backgroundColor = '#f0fdf9';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                  }}
                  onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.currentTarget.style.backgroundColor = 'white';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0" style={{
                    background: config?.primaryColor || '#5DDCC2'
                  }}>
                    <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                  </div>
                  <div className="flex-1 text-left">
                    <span className="block font-medium">Phone</span>
                  </div>
                </button>
              )}
            </div>

          </div>
          
          {/* Powered by - outside white rectangle */}
          <div className="mt-10 text-center">
            <a 
              href="https://receptionmate.co.uk" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-base font-medium hover:underline" 
              style={{ color: 'white', fontFamily: "'Poppins', sans-serif", textDecoration: 'none' }}
            >
              Powered by ReceptionMate
            </a>
          </div>
        </div>
      )}

      {/* Pre-Chat Form - Overlay Style */}
      {viewState === 'pre-chat' && (
        <div className="fixed bottom-28 right-6 z-50 animate-in slide-in-from-bottom-4 duration-200" style={{ 
          width: '380px',
          borderRadius: '32px',
          background: config?.primaryColor || '#1e3a8a',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
          fontSize: '16px',
          fontFamily: "'Poppins', sans-serif",
          paddingTop: `${Math.max(120, (config?.logoHeight || 60) + 70)}px`,
          paddingBottom: '40px',
          paddingLeft: '32px',
          paddingRight: '32px'
        }}>
          {/* Logo Area - Above the white card */}
          <div className="absolute top-8 left-0 right-0 flex justify-center">
            {config?.logoUrl ? (
              <img 
                src={config.logoUrl} 
                alt="Logo" 
                style={{ 
                  height: `${config.logoHeight || 60}px`,
                  width: 'auto',
                  maxWidth: '200px',
                  objectFit: 'contain'
                }}
              />
            ) : (
              <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{
                background: 'white'
              }}>
                <svg className="w-8 h-8" style={{ color: config?.primaryColor || '#1e3a8a' }} fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
                </svg>
              </div>
            )}
          </div>
          
          {/* White overlay rectangle */}
          <div style={{ 
            backgroundColor: 'white', 
            borderRadius: '24px',
            padding: '24px',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)'
          }}>
            {/* Header with back button */}
            <div className="flex items-center mb-6">
              <button
                onClick={() => setViewState('menu')}
                className="p-2 rounded-full transition-all mr-3 flex-shrink-0"
                style={{ color: '#666' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.05)';
                  e.currentTarget.style.transform = 'translateX(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.transform = 'translateX(0)';
                }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div className="min-w-0 flex-1">
                <h3 className="text-gray-900 font-semibold text-lg truncate" style={{ fontFamily: "'Poppins', sans-serif" }}>{config?.name ?? 'ReceptionMate'}</h3>
                <p className="text-gray-500 text-sm truncate" style={{ fontFamily: "'Poppins', sans-serif" }}>We typically reply instantly</p>
              </div>
            </div>

            {/* Form content */}
            <div className="space-y-3">
              <input
                type="text"
                value={preChatName}
                onChange={(e) => setPreChatName(e.target.value)}
                placeholder="First name"
                style={{
                  width: '100%',
                  padding: '14px 18px',
                  backgroundColor: 'white',
                  border: '2px solid #e5e7eb',
                  borderRadius: '12px',
                  fontSize: '16px',
                  color: '#000',
                  outline: 'none',
                  fontFamily: "'Poppins', sans-serif",
                  transition: 'border-color 0.2s'
                }}
                onFocus={(e) => e.currentTarget.style.borderColor = config?.primaryColor || '#5DDCC2'}
                onBlur={(e) => e.currentTarget.style.borderColor = '#e5e7eb'}
              />

              <input
                type="tel"
                value={preChatPhone}
                onChange={(e) => setPreChatPhone(e.target.value)}
                placeholder="Phone number (e.g. 07700 900000)"
                style={{
                  width: '100%',
                  padding: '14px 18px',
                  backgroundColor: 'white',
                  border: '2px solid #e5e7eb',
                  borderRadius: '12px',
                  fontSize: '16px',
                  color: '#000',
                  outline: 'none',
                  fontFamily: "'Poppins', sans-serif",
                  transition: 'border-color 0.2s'
                }}
                onFocus={(e) => e.currentTarget.style.borderColor = config?.primaryColor || '#5DDCC2'}
                onBlur={(e) => e.currentTarget.style.borderColor = '#e5e7eb'}
              />

              <textarea
                rows={4}
                value={preChatMessage}
                onChange={(e) => setPreChatMessage(e.target.value)}
                placeholder="Please, type your message here..."
                style={{
                  width: '100%',
                  padding: '14px 18px',
                  backgroundColor: 'white',
                  border: '2px solid #e5e7eb',
                  borderRadius: '12px',
                  fontSize: '16px',
                  color: '#000',
                  outline: 'none',
                  resize: 'none',
                  fontFamily: "'Poppins', sans-serif",
                  transition: 'border-color 0.2s'
                }}
                onFocus={(e) => e.currentTarget.style.borderColor = config?.primaryColor || '#5DDCC2'}
                onBlur={(e) => e.currentTarget.style.borderColor = '#e5e7eb'}
              />

              <button
                onClick={handlePreChatSubmit}
                disabled={!preChatName.trim() || !preChatPhone.trim() || !preChatMessage.trim() || preChatSubmitting}
                style={{ 
                  width: '100%',
                  padding: '16px 20px',
                  backgroundColor: config?.primaryColor || '#1e3a8a',
                  color: 'white',
                  border: 'none',
                  borderRadius: '16px',
                  fontSize: '17px',
                  fontWeight: 600,
                  cursor: !preChatName.trim() || !preChatPhone.trim() || !preChatMessage.trim() || preChatSubmitting ? 'not-allowed' : 'pointer',
                  opacity: !preChatName.trim() || !preChatPhone.trim() || !preChatMessage.trim() || preChatSubmitting ? 0.4 : 1,
                  transition: 'all 0.2s',
                  fontFamily: "'Poppins', sans-serif"
                }}
                onMouseEnter={(e) => {
                  if (!(!preChatName.trim() || !preChatPhone.trim() || !preChatMessage.trim() || preChatSubmitting)) {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                {preChatSubmitting ? 'Starting chat…' : 'Start Chat'}
              </button>
            </div>

          </div>
          
          {/* Powered by - outside white rectangle */}
          <div className="mt-10 text-center">
            <a 
              href="https://receptionmate.co.uk" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-base font-medium hover:underline" 
              style={{ color: 'white', fontFamily: "'Poppins', sans-serif", textDecoration: 'none' }}
            >
              Powered by ReceptionMate
            </a>
          </div>
        </div>
      )}

      {/* Floating Action Button - Larger Design */}
      <style jsx>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      <button
        onClick={() => {
          if (viewState === 'closed') {
            setIsSpinning(true);
            setTimeout(() => {
              setViewState('menu');
              setIsSpinning(false);
            }, 600);
          } else {
            setViewState('closed');
          }
        }}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-3 transition-all duration-300 ease-out hover:scale-105 active:scale-95 whitespace-nowrap"
        style={{ 
          width: viewState === 'closed' && config?.buttonShape === 'pill' ? '180px' : '64px',
          height: '64px',
          background: config?.buttonColor || config?.primaryColor || '#3f51b5',
          boxShadow: '0 5px 18px 0 rgba(151, 124, 156, 0.2), 0 5px 32px 0 rgba(203, 195, 212, 0.2), 0 8px 58px 0 rgba(216, 212, 221, 0.1)',
          justifyContent: 'center',
          padding: viewState === 'closed' && config?.buttonShape === 'pill' ? '0 24px' : '0',
          border: 'none',
          cursor: 'pointer',
          fontSize: '17px',
          fontWeight: 700,
          fontFamily: "'Poppins', sans-serif",
          borderRadius: config?.buttonShape === 'pill' ? '32px' : config?.buttonShape === 'circle' ? '50%' : config?.buttonShape === 'square' ? '8px' : '16px',
          animation: isSpinning ? 'spin 0.6s linear' : 'none'
        }}
        aria-label={viewState === 'closed' ? 'Open chat' : 'Close chat'}
      >
        {viewState === 'closed' ? (
          <>
            {isSpinning ? (
              // Car wheel/tire icon when spinning
              <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                {/* Outer tire */}
                <circle cx="12" cy="12" r="10" strokeWidth={2.5} />
                {/* Inner rim */}
                <circle cx="12" cy="12" r="7" strokeWidth={2} />
                {/* Center hub */}
                <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                {/* 5 spokes pattern like real car wheel */}
                <path d="M12 4.5 L12 9.5" strokeWidth={2} strokeLinecap="round" />
                <path d="M16.95 6.55 L14.12 10.38" strokeWidth={2} strokeLinecap="round" />
                <path d="M18.45 12 L13.45 12" strokeWidth={2} strokeLinecap="round" />
                <path d="M16.95 17.45 L14.12 13.62" strokeWidth={2} strokeLinecap="round" />
                <path d="M12 19.5 L12 14.5" strokeWidth={2} strokeLinecap="round" />
                {/* Tire tread pattern (small lines on outer circle) */}
                <circle cx="12" cy="12" r="8.5" strokeWidth={0.5} strokeDasharray="2 2" opacity="0.6" />
              </svg>
            ) : (
              <>
                {config?.buttonIcon === 'whatsapp' ? (
                  <>
                    <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                    </svg>
                    {config?.buttonShape === 'pill' && <span className="text-white ml-2">Chat now!</span>}
                  </>
                ) : config?.buttonIcon === 'phone' ? (
                  <>
                    <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                    {config?.buttonShape === 'pill' && <span className="text-white ml-2">Chat now!</span>}
                  </>
                ) : (
                  <>
                    <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {config?.buttonShape === 'pill' && <span className="text-white ml-2">Chat now!</span>}
                  </>
                )}
              </>
            )}
          </>
        ) : (
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
      </button>
    </>
  );
}
