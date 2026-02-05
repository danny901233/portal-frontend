'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Message {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface Conversation {
  id: string;
  platform: string;
  customerPhone?: string;
  customerId?: string;
  customerName?: string;
  status: string;
  unreadCount: number;
  lastMessageAt: string;
  messages: Message[];
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
  whatsapp: 'bg-green-100 text-green-800',
  facebook: 'bg-blue-100 text-blue-800',
  instagram: 'bg-purple-100 text-purple-800',
};

export default function MessagesPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<ConversationDetail | null>(null);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('active');
  const [messageInput, setMessageInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [selectedGarageId, setSelectedGarageId] = useState<string | null>(null);

  // Get garage ID from session storage (set during login)
  useEffect(() => {
    const garageId = sessionStorage.getItem('selectedGarageId');
    if (!garageId) {
      router.push('/login');
      return;
    }
    setSelectedGarageId(garageId);
  }, [router]);

  // Fetch conversations
  const fetchConversations = async () => {
    if (!selectedGarageId) return;

    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams();
      if (platformFilter !== 'all') params.append('platform', platformFilter);
      if (statusFilter !== 'all') params.append('status', statusFilter);

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

  // Fetch single conversation with full message history
  const fetchConversation = async (conversationId: string) => {
    try {
      const token = localStorage.getItem('token');
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

  // Send message
  const sendMessage = async () => {
    if (!selectedConversation || !messageInput.trim()) return;

    setSending(true);
    try {
      const token = localStorage.getItem('token');
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
      await fetchConversation(selectedConversation.id);
    } catch (error) {
      console.error('Error sending message:', error);
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  // Update conversation status
  const updateConversationStatus = async (status: string) => {
    if (!selectedConversation) return;

    try {
      const token = localStorage.getItem('token');
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${selectedConversation.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status }),
      });

      await fetchConversations();
      if (status !== 'active') {
        setSelectedConversation(null);
      }
    } catch (error) {
      console.error('Error updating conversation:', error);
    }
  };

  // Poll for updates
  useEffect(() => {
    if (!selectedGarageId) return;

    fetchConversations();
    const interval = setInterval(fetchConversations, 5000);
    return () => clearInterval(interval);
  }, [selectedGarageId, platformFilter, statusFilter]);

  // Refresh selected conversation
  useEffect(() => {
    if (!selectedConversation) return;

    const interval = setInterval(() => {
      fetchConversation(selectedConversation.id);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-gray-500">Loading conversations...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Left sidebar - Conversations list */}
      <div className="w-1/3 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">Messages</h1>

          {/* Filters */}
          <div className="space-y-2">
            <select
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="all">All Platforms</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="resolved">Resolved</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>

        {/* Conversations list */}
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="p-4 text-center text-gray-500">No conversations found</div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => fetchConversation(conv.id)}
                className={`p-4 border-b border-gray-200 cursor-pointer hover:bg-gray-50 ${
                  selectedConversation?.id === conv.id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-start justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{PLATFORM_ICONS[conv.platform as keyof typeof PLATFORM_ICONS]}</span>
                    <span className="font-medium text-gray-900">
                      {conv.customerName || conv.customerPhone || conv.customerId || 'Unknown'}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">{formatTime(conv.lastMessageAt)}</span>
                </div>
                <p className="text-sm text-gray-600 truncate">
                  {conv.messages[0]?.content || 'No messages'}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`text-xs px-2 py-1 rounded-full ${PLATFORM_COLORS[conv.platform as keyof typeof PLATFORM_COLORS]}`}>
                    {conv.platform}
                  </span>
                  {conv.unreadCount > 0 && (
                    <span className="text-xs px-2 py-1 rounded-full bg-red-100 text-red-800">
                      {conv.unreadCount} new
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel - Conversation detail */}
      <div className="flex-1 flex flex-col bg-white">
        {!selectedConversation ? (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            Select a conversation to view messages
          </div>
        ) : (
          <>
            {/* Conversation header */}
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  {selectedConversation.customerName ||
                   selectedConversation.customerPhone ||
                   selectedConversation.customerId ||
                   'Unknown'}
                </h2>
                <p className="text-sm text-gray-500">
                  {PLATFORM_ICONS[selectedConversation.platform as keyof typeof PLATFORM_ICONS]} {selectedConversation.platform}
                </p>
              </div>
              <div className="flex gap-2">
                {selectedConversation.status === 'active' && (
                  <button
                    onClick={() => updateConversationStatus('resolved')}
                    className="px-3 py-1 text-sm bg-green-600 text-white rounded-md hover:bg-green-700"
                  >
                    Resolve
                  </button>
                )}
                <button
                  onClick={() => updateConversationStatus('archived')}
                  className="px-3 py-1 text-sm bg-gray-600 text-white rounded-md hover:bg-gray-700"
                >
                  Archive
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {selectedConversation.messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.role === 'user' ? 'justify-start' : 'justify-end'}`}
                >
                  <div
                    className={`max-w-xs px-4 py-2 rounded-lg ${
                      message.role === 'user'
                        ? 'bg-gray-200 text-gray-900'
                        : 'bg-blue-600 text-white'
                    }`}
                  >
                    <p className="text-sm">{message.content}</p>
                    <p className={`text-xs mt-1 ${message.role === 'user' ? 'text-gray-500' : 'text-blue-100'}`}>
                      {formatTime(message.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Message input */}
            <div className="p-4 border-t border-gray-200">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="Type a message..."
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={sending}
                />
                <button
                  onClick={sendMessage}
                  disabled={sending || !messageInput.trim()}
                  className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
