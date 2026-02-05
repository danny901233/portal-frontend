'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getGarageId, getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';

interface Message {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  platform?: string;
}

interface Conversation {
  id: string;
  platform: string;
  platforms?: string[];
  customerPhone?: string;
  customerId?: string;
  customerName?: string;
  status: string;
  unreadCount: number;
  lastMessageAt: string;
  messages: Message[];
  conversationIds?: string[];
}

interface ConversationDetail extends Conversation {
  garage: {
    id: string;
    name: string;
  };
}

const PLATFORM_ICONS = {
  whatsapp: '📱',
  facebook: '💬',
  instagram: '📷',
};

const PLATFORM_COLORS = {
  whatsapp: 'bg-green-600',
  facebook: 'bg-blue-600',
  instagram: 'bg-purple-600',
};

export default function MessagesPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<ConversationDetail | null>(null);
  const [viewMode, setViewMode] = useState<'open' | 'closed'>('open');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [selectedGarageId, setSelectedGarageId] = useState<string | null>(null);

  useEffect(() => {
    const garageId = getGarageId();
    const token = getSessionToken();
    if (!garageId || !token) {
      router.push('/login');
      return;
    }
    setSelectedGarageId(garageId);
  }, [router]);

  const fetchConversations = async () => {
    if (!selectedGarageId) return;

    try {
      const token = getSessionToken();
      const params = new URLSearchParams();
      if (platformFilter !== 'all') params.append('platform', platformFilter);
      params.append('status', viewMode === 'open' ? 'active' : 'resolved');

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${selectedGarageId}/conversations?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch conversations');

      const data = await response.json();
      setConversations(data.conversations);
    } catch (error) {
      console.error('Error fetching conversations:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchConversationDetail = async (conversationId: string) => {
    try {
      const token = getSessionToken();
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${conversationId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) throw new Error('Failed to fetch conversation');

      const data = await response.json();
      setSelectedConversation(data.conversation);
    } catch (error) {
      console.error('Error fetching conversation:', error);
    }
  };

  const sendMessage = async () => {
    if (!selectedConversation || !messageInput.trim()) return;

    setSending(true);
    try {
      const token = getSessionToken();
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${selectedConversation.id}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: messageInput }),
        }
      );

      if (!response.ok) throw new Error('Failed to send message');

      setMessageInput('');
      await fetchConversationDetail(selectedConversation.id);
      await fetchConversations();
    } catch (error) {
      console.error('Error sending message:', error);
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const updateConversationStatus = async (status: string) => {
    if (!selectedConversation) return;

    try {
      const token = getSessionToken();
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${selectedConversation.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status }),
      });

      await fetchConversations();
      setSelectedConversation(null);
    } catch (error) {
      console.error('Error updating conversation:', error);
    }
  };

  useEffect(() => {
    if (!selectedGarageId) return;

    fetchConversations();
    const interval = setInterval(fetchConversations, 10000);
    return () => clearInterval(interval);
  }, [selectedGarageId, platformFilter, viewMode]);

  useEffect(() => {
    if (!selectedConversation) return;

    const interval = setInterval(() => {
      fetchConversationDetail(selectedConversation.id);
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedConversation]);

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const getInitials = (name: string) => {
    const words = name.split(' ');
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  const filteredConversations = conversations.filter(conv => {
    const searchLower = searchQuery.toLowerCase();
    const matchesSearch = !searchQuery ||
      (conv.customerName?.toLowerCase().includes(searchLower)) ||
      (conv.customerPhone?.toLowerCase().includes(searchLower)) ||
      (conv.customerId?.toLowerCase().includes(searchLower));

    return matchesSearch;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-slate-400">Loading conversations...</div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-140px)] gap-0">
      {/* Left Sidebar - Conversations List */}
      <div className="w-96 bg-slate-900/40 border border-slate-800 rounded-l-lg flex flex-col">
        {/* Search and Filters */}
        <div className="p-4 border-b border-slate-800">
          <div className="relative mb-4">
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-4 py-2 pl-10 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            <svg className="absolute left-3 top-2.5 w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          {/* Platform Filter */}
          <div className="flex gap-1 mb-3">
            <button
              onClick={() => setPlatformFilter('all')}
              className={cn(
                'flex-1 px-2 py-1 rounded text-xs font-medium transition-colors',
                platformFilter === 'all'
                  ? 'bg-purple-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-100'
              )}
            >
              All
            </button>
            <button
              onClick={() => setPlatformFilter('whatsapp')}
              className={cn(
                'flex-1 px-2 py-1 rounded text-xs font-medium transition-colors',
                platformFilter === 'whatsapp'
                  ? 'bg-green-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-100'
              )}
            >
              📱 WhatsApp
            </button>
            <button
              onClick={() => setPlatformFilter('facebook')}
              className={cn(
                'flex-1 px-2 py-1 rounded text-xs font-medium transition-colors',
                platformFilter === 'facebook'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-100'
              )}
            >
              💬 Facebook
            </button>
            <button
              onClick={() => setPlatformFilter('instagram')}
              className={cn(
                'flex-1 px-2 py-1 rounded text-xs font-medium transition-colors',
                platformFilter === 'instagram'
                  ? 'bg-purple-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-100'
              )}
            >
              📷 Instagram
            </button>
          </div>

          {/* Open / Closed Tabs */}
          <div className="flex gap-4 border-b border-slate-700">
            <button
              onClick={() => setViewMode('open')}
              className={cn(
                'pb-2 px-1 text-sm font-medium transition-colors relative',
                viewMode === 'open'
                  ? 'text-blue-400'
                  : 'text-slate-500 hover:text-slate-300'
              )}
            >
              🔓 OPEN
              {viewMode === 'open' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400" />
              )}
            </button>
            <button
              onClick={() => setViewMode('closed')}
              className={cn(
                'pb-2 px-1 text-sm font-medium transition-colors relative',
                viewMode === 'closed'
                  ? 'text-slate-400'
                  : 'text-slate-500 hover:text-slate-300'
              )}
            >
              🔒 CLOSED
              {viewMode === 'closed' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-slate-400" />
              )}
            </button>
          </div>
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.length === 0 ? (
            <div className="p-4 text-center text-slate-500 text-sm">
              No {viewMode} conversations
            </div>
          ) : (
            filteredConversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => fetchConversationDetail(conv.id)}
                className={cn(
                  'p-4 border-b border-slate-800 cursor-pointer transition-colors hover:bg-slate-800/40',
                  selectedConversation?.id === conv.id && 'bg-slate-800/60'
                )}
              >
                <div className="flex items-start gap-3">
                  <div className={cn(
                    'w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0',
                    PLATFORM_COLORS[conv.platform as keyof typeof PLATFORM_COLORS]
                  )}>
                    {getInitials(conv.customerName || conv.customerPhone || conv.customerId || 'UK')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between mb-1">
                      <h3 className="font-medium text-slate-100 text-sm truncate">
                        {conv.customerName || conv.customerPhone || conv.customerId || 'Unknown'}
                      </h3>
                      <span className="text-xs text-slate-500 ml-2 flex-shrink-0">{formatTime(conv.lastMessageAt)}</span>
                    </div>
                    <p className="text-xs text-slate-400 truncate mb-2">
                      {conv.messages[0]?.content || 'No messages'}
                    </p>
                    <div className="flex items-center gap-2">
                      {/* Show all platforms if merged */}
                      {conv.platforms && conv.platforms.length > 1 ? (
                        <div className="flex gap-1">
                          {conv.platforms.map((p) => (
                            <span key={p} className="text-xs">
                              {PLATFORM_ICONS[p as keyof typeof PLATFORM_ICONS]}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className={cn(
                          'text-xs px-2 py-0.5 rounded-full',
                          conv.platform === 'whatsapp' && 'bg-green-500/20 text-green-300',
                          conv.platform === 'facebook' && 'bg-blue-500/20 text-blue-300',
                          conv.platform === 'instagram' && 'bg-purple-500/20 text-purple-300'
                        )}>
                          Lead
                        </span>
                      )}
                      {conv.unreadCount > 0 && (
                        <span className="w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right Panel - Conversation Detail */}
      <div className="flex-1 bg-slate-900/40 border border-l-0 border-slate-800 rounded-r-lg flex flex-col">
        {!selectedConversation ? (
          <div className="flex-1 flex items-center justify-center text-slate-500">
            <div className="text-center">
              <div className="text-4xl mb-4">💬</div>
              <div>Select a conversation to view messages</div>
            </div>
          </div>
        ) : (
          <>
            {/* Conversation Header */}
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={cn(
                  'w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-medium',
                  PLATFORM_COLORS[selectedConversation.platform as keyof typeof PLATFORM_COLORS]
                )}>
                  {getInitials(selectedConversation.customerName || selectedConversation.customerPhone || selectedConversation.customerId || 'UK')}
                </div>
                <div>
                  <h2 className="text-base font-semibold text-slate-100">
                    {selectedConversation.customerName ||
                     selectedConversation.customerPhone ||
                     selectedConversation.customerId ||
                     'Unknown'}
                  </h2>
                  <p className="text-xs text-slate-400">
                    {PLATFORM_ICONS[selectedConversation.platform as keyof typeof PLATFORM_ICONS]} {selectedConversation.platform}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                {selectedConversation.status === 'active' ? (
                  <button
                    onClick={() => updateConversationStatus('resolved')}
                    className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors"
                  >
                    Close Conversation
                  </button>
                ) : (
                  <button
                    onClick={() => updateConversationStatus('active')}
                    className="px-3 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-colors"
                  >
                    Reopen
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950/20">
              {selectedConversation.messages?.map((message) => (
                <div
                  key={message.id}
                  className={cn('flex flex-col', message.role === 'user' ? 'items-start' : 'items-end')}
                >
                  {/* Platform badge */}
                  {message.platform && (
                    <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                      <span>{PLATFORM_ICONS[message.platform as keyof typeof PLATFORM_ICONS]}</span>
                      <span>{message.platform}</span>
                    </div>
                  )}
                  <div
                    className={cn(
                      'max-w-md px-4 py-2 rounded-lg',
                      message.role === 'user'
                        ? 'bg-slate-800 text-slate-100'
                        : 'bg-purple-600 text-white'
                    )}
                  >
                    <p className="text-sm">{message.content}</p>
                    <p className={cn('text-xs mt-1', message.role === 'user' ? 'text-slate-500' : 'text-purple-200')}>
                      {formatTime(message.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Message Input */}
            {selectedConversation.status === 'active' && (
              <div className="p-4 border-t border-slate-800">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                    placeholder="Write a message"
                    maxLength={1600}
                    className="flex-1 px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                    disabled={sending}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={sending || !messageInput.trim()}
                    className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                </div>
                <div className="text-right text-xs text-slate-500 mt-1">
                  {messageInput.length} / 1600
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
