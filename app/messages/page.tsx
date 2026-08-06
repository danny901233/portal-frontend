'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Inbox, Link2 } from 'lucide-react';
import { getGarageId, getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';
import ConversationTaggingPanel from '../components/ConversationTaggingPanel';
import { Skeleton } from '../components/Skeleton';

interface Message {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  platform?: string;
  mediaUrl?: string;
  mediaType?: string;
}

interface Conversation {
  id: string;
  platform: string;
  platforms?: string[];
  customerPhone?: string;
  customerId?: string;
  customerName?: string;
  status: string;
  agentPaused?: boolean;
  agentPausedUntil?: string;
  needsAttention?: boolean;
  messageType?: string;
  confirmedBooking?: boolean;
  confirmedBookingCategory?: 'service' | 'diagnostic' | 'mot' | 'other' | null;
  capturedRevenue?: number | null;
  bookingDetails?: string;
  tags?: string[];
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
  withinMessagingWindow?: boolean;
}

// Platform SVG Logo Components
const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
  </svg>
);

const FacebookIcon = () => (
  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
  </svg>
);

const InstagramIcon = () => (
  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
  </svg>
);

const PLATFORM_ICONS: { [key: string]: () => React.JSX.Element } = {
  whatsapp: WhatsAppIcon,
  facebook: FacebookIcon,
  instagram: InstagramIcon,
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
  const [viewMode, setViewMode] = useState<'active' | 'resolved' | 'needsAttention'>('active');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedGarageId, setSelectedGarageId] = useState<string | null>(null);
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const [showPauseDropdown, setShowPauseDropdown] = useState(false);
  const [showTaggingPanel, setShowTaggingPanel] = useState(false);
  const [hasMessagingAccess, setHasMessagingAccess] = useState<boolean | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [selectedConversation?.messages]);

  useEffect(() => {
    const garageId = getGarageId();
    const token = getSessionToken();
    if (!garageId || !token) {
      router.push('/login');
      return;
    }
    setSelectedGarageId(garageId);

    // Check messaging access
    const checkAccess = async () => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/api/garages/${garageId}/messaging-access`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          const hasAccess = data.hasMessagingAccess || false;
          setHasMessagingAccess(hasAccess);

          if (!hasAccess) {
            router.push('/dashboard');
          }
        } else {
          router.push('/dashboard');
        }
      } catch (error) {
        console.error('Error checking messaging access:', error);
        router.push('/dashboard');
      }
    };

    void checkAccess();
  }, [router]);

  const fetchConversations = async () => {
    if (!selectedGarageId) return;

    try {
      const token = getSessionToken();
      const params = new URLSearchParams();
      if (platformFilter !== 'all') params.append('platform', platformFilter);

      // Handle different view modes
      if (viewMode === 'needsAttention') {
        params.append('status', 'active'); // Needs attention are active conversations
      } else {
        params.append('status', viewMode);
      }

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

      // Filter for needs attention view
      let filteredConversations = data.conversations;
      if (viewMode === 'needsAttention') {
        filteredConversations = data.conversations.filter((conv: Conversation) => conv.needsAttention);
      } else if (viewMode === 'active') {
        // Active view excludes conversations that need attention (they have their own tab)
        filteredConversations = data.conversations.filter((conv: Conversation) => !conv.needsAttention);
      }

      setConversations(filteredConversations);
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
    if (!selectedConversation || (!messageInput.trim() && !selectedFile)) return;

    setSending(true);
    try {
      const token = getSessionToken();
      let fetchOptions: RequestInit;

      let url: string;
      if (selectedFile) {
        const formData = new FormData();
        formData.append('image', selectedFile);
        if (messageInput.trim()) formData.append('caption', messageInput);
        fetchOptions = {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        };
        url = `${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${selectedConversation.id}/messages/image`;
      } else {
        fetchOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: messageInput }),
        };
        url = `${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${selectedConversation.id}/messages`;
      }

      const response = await fetch(url, fetchOptions);

      if (!response.ok) throw new Error('Failed to send message');

      setMessageInput('');
      setSelectedFile(null);
      setFilePreview(null);
      await fetchConversationDetail(selectedConversation.id);
      await fetchConversations();
    } catch (error) {
      console.error('Error sending message:', error);
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Only image files are supported');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      alert('Image must be under 10MB');
      return;
    }
    setSelectedFile(file);
    const reader = new FileReader();
    reader.onload = () => setFilePreview(reader.result as string);
    reader.readAsDataURL(file);
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

  const toggleAgent = async (pauseDurationHours?: number) => {
    if (!selectedConversation) return;

    try {
      const token = getSessionToken();
      const newAgentPaused = !selectedConversation.agentPaused;

      const body: any = { agentPaused: newAgentPaused };
      if (newAgentPaused && pauseDurationHours) {
        body.pauseDurationHours = pauseDurationHours;
      }

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${selectedConversation.id}/agent`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) throw new Error('Failed to toggle agent');

      const data = await response.json();

      // Update local state
      setSelectedConversation({
        ...selectedConversation,
        agentPaused: newAgentPaused,
        agentPausedUntil: data.agentPausedUntil,
      });

      setShowPauseDropdown(false);
      await fetchConversations();
    } catch (error) {
      console.error('Error toggling agent:', error);
      alert('Failed to toggle agent');
    }
  };

  const toggleFlag = async () => {
    if (!selectedConversation) return;

    try {
      const token = getSessionToken();
      const newNeedsAttention = !selectedConversation.needsAttention;

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${selectedConversation.id}/flag`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ needsAttention: newNeedsAttention }),
        }
      );

      if (!response.ok) throw new Error('Failed to toggle flag');

      const data = await response.json();

      // Update local state
      setSelectedConversation({
        ...selectedConversation,
        needsAttention: newNeedsAttention,
        agentPaused: data.agentPaused || selectedConversation.agentPaused,
      });

      await fetchConversations();
    } catch (error) {
      console.error('Error toggling flag:', error);
      alert('Failed to toggle flag');
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

  const formatPauseTime = (pausedUntil: string) => {
    const date = new Date(pausedUntil);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffHours = Math.ceil(diffMs / (60 * 60 * 1000));

    // Check if it's an indefinite pause (very far in the future)
    if (diffHours > 8760) return 'Paused indefinitely'; // More than 1 year

    if (diffHours < 1) return 'Resuming soon';
    if (diffHours === 1) return 'Resumes in 1 hour';
    if (diffHours < 24) return `Resumes in ${diffHours} hours`;
    const diffDays = Math.ceil(diffHours / 24);
    if (diffDays === 1) return 'Resumes in 1 day';
    return `Resumes in ${diffDays} days`;
  };

  const filteredConversations = conversations.filter(conv => {
    const searchLower = searchQuery.toLowerCase();
    const matchesSearch = !searchQuery ||
      (conv.customerName?.toLowerCase().includes(searchLower)) ||
      (conv.customerPhone?.toLowerCase().includes(searchLower)) ||
      (conv.customerId?.toLowerCase().includes(searchLower));

    return matchesSearch;
  });

  if (loading || hasMessagingAccess === null) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-slate-400">Loading conversations...</div>
      </div>
    );
  }

  if (hasMessagingAccess === false) {
    return null; // Will redirect in useEffect
  }

  return (
    <div className="space-y-4">
      {/* Header with Integrations Button */}
      <div className="flex flex-col gap-3 border-b border-slate-800/60 pb-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Messages</h1>
          <p className="mt-1 text-sm text-slate-400">Manage all customer conversations in one place.</p>
        </div>
        <button
          onClick={() => router.push('/integrations')}
          className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100 transition-colors hover:border-slate-500 hover:bg-slate-800 md:self-auto md:px-4"
        >
          <Link2 className="h-4 w-4" />
          <span className="text-sm font-medium">Connect platforms</span>
        </button>
      </div>

      <div className="flex h-[calc(100vh-200px)] flex-col gap-0 md:h-[calc(100vh-220px)] md:flex-row">
        {/* Left Sidebar - Conversations List (full width on mobile when no conversation selected) */}
        <div className={cn(
          'w-full bg-slate-900/40 border border-slate-800 flex flex-col md:w-96 md:rounded-l-lg',
          'rounded-lg',
          selectedConversation ? 'hidden md:flex' : 'flex',
        )}>
          {/* Search and Filters */}
          <div className="p-4 border-b border-slate-800">
          <div className="flex gap-2 mb-4">
            <div className="relative flex-1">
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

            {/* Platform Filter Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowFilterDropdown(!showFilterDropdown)}
                className="p-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-400 hover:text-slate-100 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
              </button>

              {showFilterDropdown && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowFilterDropdown(false)}
                  />
                  <div className="absolute right-0 mt-2 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20">
                    <div className="p-2">
                      <button
                        onClick={() => {
                          setPlatformFilter('all');
                          setShowFilterDropdown(false);
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2 rounded text-sm transition-colors flex items-center gap-2',
                          platformFilter === 'all'
                            ? 'bg-purple-600 text-white'
                            : 'text-slate-300 hover:bg-slate-700'
                        )}
                      >
                        <span className="flex-1">All Platforms</span>
                        {platformFilter === 'all' && (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setPlatformFilter('whatsapp');
                          setShowFilterDropdown(false);
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2 rounded text-sm transition-colors flex items-center gap-2',
                          platformFilter === 'whatsapp'
                            ? 'bg-green-600 text-white'
                            : 'text-slate-300 hover:bg-slate-700'
                        )}
                      >
                        <WhatsAppIcon />
                        <span className="flex-1">WhatsApp</span>
                        {platformFilter === 'whatsapp' && (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setPlatformFilter('facebook');
                          setShowFilterDropdown(false);
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2 rounded text-sm transition-colors flex items-center gap-2',
                          platformFilter === 'facebook'
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-300 hover:bg-slate-700'
                        )}
                      >
                        <FacebookIcon />
                        <span className="flex-1">Facebook</span>
                        {platformFilter === 'facebook' && (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setPlatformFilter('instagram');
                          setShowFilterDropdown(false);
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2 rounded text-sm transition-colors flex items-center gap-2',
                          platformFilter === 'instagram'
                            ? 'bg-purple-600 text-white'
                            : 'text-slate-300 hover:bg-slate-700'
                        )}
                      >
                        <InstagramIcon />
                        <span className="flex-1">Instagram</span>
                        {platformFilter === 'instagram' && (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Active / Needs Attention / Resolved Tabs */}
          <div className="flex gap-4 border-b border-slate-700">
            <button
              onClick={() => setViewMode('active')}
              className={cn(
                'pb-2 px-1 text-sm font-medium transition-colors relative',
                viewMode === 'active'
                  ? 'text-green-400'
                  : 'text-slate-500 hover:text-slate-300'
              )}
            >
              ACTIVE
              {viewMode === 'active' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-green-400" />
              )}
            </button>
            <button
              onClick={() => setViewMode('needsAttention')}
              className={cn(
                'pb-2 px-1 text-sm font-medium transition-colors relative',
                viewMode === 'needsAttention'
                  ? 'text-orange-400'
                  : 'text-slate-500 hover:text-slate-300'
              )}
            >
              NEEDS ATTENTION
              {viewMode === 'needsAttention' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-400" />
              )}
            </button>
            <button
              onClick={() => setViewMode('resolved')}
              className={cn(
                'pb-2 px-1 text-sm font-medium transition-colors relative',
                viewMode === 'resolved'
                  ? 'text-slate-400'
                  : 'text-slate-500 hover:text-slate-300'
              )}
            >
              RESOLVED
              {viewMode === 'resolved' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-slate-400" />
              )}
            </button>
          </div>
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="divide-y divide-slate-800/60">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 p-4">
                  <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-3 w-32" />
                      <Skeleton className="h-2.5 w-10" />
                    </div>
                    <Skeleton className="h-2.5 w-full" />
                    <Skeleton className="h-2.5 w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="rm-empty mx-4 my-6">
              <Inbox className="h-7 w-7 text-slate-500" />
              <p className="text-sm font-medium text-slate-200">
                {viewMode === 'needsAttention'
                  ? 'No conversations need attention'
                  : `No ${viewMode} conversations`}
              </p>
              <p className="text-xs text-slate-500">
                New customer messages will appear here as they come in.
              </p>
            </div>
          ) : (
            filteredConversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => fetchConversationDetail(conv.id)}
                className={cn(
                  'p-4 border-b border-slate-800 cursor-pointer transition-colors hover:bg-slate-800/40',
                  selectedConversation?.id === conv.id && 'bg-slate-800/60',
                  conv.needsAttention && 'border-l-4 border-l-orange-500'
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
                          {conv.platforms.map((p) => {
                            const IconComponent = PLATFORM_ICONS[p as keyof typeof PLATFORM_ICONS];
                            return IconComponent ? (
                              <span key={p} className={cn(
                                'p-1 rounded',
                                p === 'whatsapp' && 'text-green-400',
                                p === 'facebook' && 'text-blue-400',
                                p === 'instagram' && 'text-purple-400'
                              )}>
                                <IconComponent />
                              </span>
                            ) : null;
                          })}
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

      {/* Right Panel - Conversation Detail (full width on mobile when conversation selected) */}
      <div className={cn(
        'flex-1 bg-slate-900/40 border border-slate-800 flex flex-col',
        'rounded-lg md:rounded-l-none md:rounded-r-lg md:border-l-0',
        selectedConversation ? 'flex' : 'hidden md:flex',
      )}>
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
            <div className="border-b border-slate-800 p-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:p-4">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedConversation(null)}
                  className="-ml-1 shrink-0 rounded-lg p-1.5 text-slate-300 hover:bg-slate-800 hover:text-slate-100 md:hidden"
                  aria-label="Back to conversations"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <div className={cn(
                  'w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-medium shrink-0',
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
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 text-xs text-slate-400">
                      {(() => {
                        const IconComponent = PLATFORM_ICONS[selectedConversation.platform as keyof typeof PLATFORM_ICONS];
                        return IconComponent ? <IconComponent /> : null;
                      })()}
                      <span>{selectedConversation.platform}</span>
                    </div>
                    <span className="text-slate-600">•</span>
                    <div className={cn(
                      'flex items-center gap-1 text-xs',
                      selectedConversation.agentPaused ? 'text-orange-400' : 'text-green-400'
                    )}>
                      <div className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        selectedConversation.agentPaused ? 'bg-orange-400' : 'bg-green-400'
                      )} />
                      <span>
                        {selectedConversation.agentPaused ? (
                          selectedConversation.agentPausedUntil ? (
                            `Agent Paused • ${formatPauseTime(selectedConversation.agentPausedUntil)}`
                          ) : (
                            'Agent Paused'
                          )
                        ) : (
                          'Agent Active'
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
                <button
                  onClick={toggleFlag}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors md:px-3 md:text-sm',
                    selectedConversation.needsAttention
                      ? 'bg-orange-600 hover:bg-orange-700 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                  )}
                  title={selectedConversation.needsAttention ? 'Remove flag' : 'Flag for attention'}
                >
                  <svg className="h-3.5 w-3.5 shrink-0 md:h-4 md:w-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M3 6a3 3 0 013-3h10a1 1 0 01.8 1.6L14.25 8l2.55 3.4A1 1 0 0116 13H6a1 1 0 00-1 1v3a1 1 0 11-2 0V6z" clipRule="evenodd" />
                  </svg>
                  {selectedConversation.needsAttention ? 'Flagged' : 'Flag'}
                </button>

                <button
                  onClick={() => setShowTaggingPanel(!showTaggingPanel)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors md:px-3 md:text-sm',
                    showTaggingPanel
                      ? 'bg-purple-600 hover:bg-purple-700 text-white'
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
                  )}
                  title="Toggle tags panel"
                >
                  <svg className="h-3.5 w-3.5 shrink-0 md:h-4 md:w-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5c.256 0 .512.098.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                  Tags
                </button>

                {/* Pause Agent Button with Dropdown */}
                {selectedConversation.agentPaused ? (
                  <button
                    onClick={() => toggleAgent()}
                    className="shrink-0 rounded-md bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700 md:px-3 md:text-sm"
                  >
                    <span className="hidden md:inline">Resume Agent</span>
                    <span className="md:hidden">Resume</span>
                  </button>
                ) : (
                  <div className="relative shrink-0">
                    <button
                      onClick={() => setShowPauseDropdown(!showPauseDropdown)}
                      className="inline-flex items-center gap-1 rounded-md bg-orange-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-orange-700 md:px-3 md:text-sm"
                    >
                      <span className="hidden md:inline">Pause Agent</span>
                      <span className="md:hidden">Pause</span>
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    </button>

                    {showPauseDropdown && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setShowPauseDropdown(false)}
                        />
                        <div className="absolute right-0 mt-2 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20">
                          <div className="p-2">
                            <button
                              onClick={() => toggleAgent(2)}
                              className="w-full text-left px-3 py-2 rounded text-sm text-slate-300 hover:bg-slate-700 transition-colors"
                            >
                              Pause for 2 hours
                            </button>
                            <button
                              onClick={() => toggleAgent(4)}
                              className="w-full text-left px-3 py-2 rounded text-sm text-slate-300 hover:bg-slate-700 transition-colors"
                            >
                              Pause for 4 hours
                            </button>
                            <button
                              onClick={() => toggleAgent(8)}
                              className="w-full text-left px-3 py-2 rounded text-sm text-slate-300 hover:bg-slate-700 transition-colors"
                            >
                              Pause for 8 hours
                            </button>
                            <button
                              onClick={() => toggleAgent(24)}
                              className="w-full text-left px-3 py-2 rounded text-sm text-slate-300 hover:bg-slate-700 transition-colors"
                            >
                              Pause for 24 hours
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {selectedConversation.status === 'active' ? (
                  <button
                    onClick={() => updateConversationStatus('resolved')}
                    className="shrink-0 rounded-md bg-slate-700 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-600 md:px-3 md:text-sm"
                  >
                    Resolve
                  </button>
                ) : (
                  <button
                    onClick={() => updateConversationStatus('active')}
                    className="shrink-0 rounded-md bg-purple-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-purple-700 md:px-3 md:text-sm"
                  >
                    Reopen
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div
              ref={messagesContainerRef}
              className="flex-1 min-h-0 overflow-y-auto bg-gradient-to-b from-slate-950/40 via-slate-950/20 to-slate-950/40 p-4 space-y-3"
            >
              {selectedConversation.messages?.filter((message) => !message.content?.startsWith('[Context:')).map((message) => {
                const isUser = message.role === 'user';
                const PlatformIcon = message.platform
                  ? PLATFORM_ICONS[message.platform as keyof typeof PLATFORM_ICONS]
                  : null;
                return (
                  <div
                    key={message.id}
                    className={cn('flex flex-col gap-1', isUser ? 'items-start' : 'items-end')}
                  >
                    <div
                      className={cn(
                        'max-w-[85%] text-sm shadow-sm md:max-w-md',
                        message.mediaUrl ? 'overflow-hidden rounded-2xl' : 'rounded-2xl px-3.5 py-2.5',
                        isUser
                          ? 'rounded-bl-md border border-slate-800 bg-slate-800/70 text-slate-100'
                          : 'rounded-br-md bg-gradient-to-br from-purple-500 via-purple-600 to-purple-700 text-white shadow-md shadow-purple-900/30',
                      )}
                    >
                      {message.mediaUrl ? (
                        <>
                          <a
                            href={`/internal-api/conversations/media/${message.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <img
                              src={`/internal-api/conversations/media/${message.id}`}
                              alt="Shared image"
                              className="max-h-64 max-w-full cursor-pointer object-contain"
                              loading="lazy"
                            />
                          </a>
                          {message.content && message.content !== '[Image]' && (
                            <p className="px-3.5 py-2 text-sm leading-relaxed">{message.content}</p>
                          )}
                        </>
                      ) : (
                        <p className="leading-relaxed">{message.content}</p>
                      )}
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-1.5 px-1 text-[10px] text-slate-500',
                        isUser ? 'flex-row' : 'flex-row-reverse',
                      )}
                    >
                      {!isUser && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-purple-200">
                          AI
                        </span>
                      )}
                      {PlatformIcon && (
                        <span className="inline-flex items-center gap-1">
                          <PlatformIcon />
                        </span>
                      )}
                      <span>·</span>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Message Input */}
            {selectedConversation.status === 'active' && (
              <div className="p-4 border-t border-slate-800">
                {selectedConversation.withinMessagingWindow === false && ['whatsapp', 'facebook', 'instagram'].includes(selectedConversation.platform) ? (
                  <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3 text-center">
                    <p className="text-sm text-orange-400 font-medium">24-Hour Messaging Window Expired</p>
                    <p className="text-xs text-slate-400 mt-1">
                      You can no longer send messages to this customer. They must initiate contact again.
                    </p>
                  </div>
                ) : (
                  <>
                    {filePreview && (
                      <div className="mb-2 relative inline-block">
                        <img src={filePreview} alt="Preview" className="max-h-32 rounded-lg border border-slate-700" />
                        <button
                          onClick={() => { setSelectedFile(null); setFilePreview(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600"
                        >
                          ×
                        </button>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleFileSelect}
                        className="hidden"
                      />
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={sending}
                        className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors disabled:opacity-50"
                        title="Attach image"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                      </button>
                      <input
                        type="text"
                        value={messageInput}
                        onChange={(e) => setMessageInput(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                        placeholder={selectedFile ? 'Add a caption (optional)' : 'Write a message'}
                        maxLength={1600}
                        className="flex-1 px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                        disabled={sending}
                      />
                      <button
                        onClick={sendMessage}
                        disabled={sending || (!messageInput.trim() && !selectedFile)}
                        className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {sending ? 'Sending...' : 'Send'}
                      </button>
                    </div>
                    <div className="text-right text-xs text-slate-500 mt-1">
                      {messageInput.length} / 1600
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Tagging Panel */}
      {showTaggingPanel && selectedConversation && (
        <ConversationTaggingPanel
          conversationId={selectedConversation.id}
          initialTags={{
            messageType: selectedConversation.messageType,
            confirmedBooking: selectedConversation.confirmedBooking,
            confirmedBookingCategory: selectedConversation.confirmedBookingCategory,
            capturedRevenue: selectedConversation.capturedRevenue,
            bookingDetails: selectedConversation.bookingDetails,
            tags: selectedConversation.tags,
          }}
          onUpdate={(updatedTags) => {
            // Update the selected conversation with new tags
            setSelectedConversation({
              ...selectedConversation,
              ...updatedTags,
            });
            // Refresh conversations list
            fetchConversations();
          }}
        />
      )}
      </div>
    </div>
  );
}
