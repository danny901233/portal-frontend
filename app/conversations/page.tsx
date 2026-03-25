'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getGarageId, getSessionToken, isManager, isReceptionMateStaff } from '../lib/auth';
import { cn } from '../lib/utils';

interface Conversation {
  id: string;
  garageId: string;
  platform: string;
  customerName: string | null;
  customerPhone: string | null;
  platformUserId: string | null;
  status: string;
  agentPaused: boolean;
  needsAttention: boolean;
  confirmedBooking: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessage: string | null;
  createdAt: string;
}

interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'staff';
  content: string;
  createdAt: string;
}

type Tab = 'all' | 'needs_attention' | 'active' | 'resolved';

const PLATFORM_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  instagram: 'Instagram',
  widget: 'Widget',
  web: 'Widget',
  livechat: 'LiveChat',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const garageId = getGarageId();
  const canReply = isReceptionMateStaff() || isManager();

  const fetchConversations = useCallback(async () => {
    if (!garageId) return;
    const token = getSessionToken();
    const params = new URLSearchParams();
    if (!isReceptionMateStaff()) {
      params.set('garageId', garageId);
    }
    try {
      const res = await fetch(`/internal-api/conversations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { conversations: Conversation[] };
        setConversations(data.conversations ?? []);
      }
    } catch (err) {
      console.error('[CONVERSATIONS] fetch error', err);
    } finally {
      setLoading(false);
    }
  }, [garageId]);

  useEffect(() => {
    void fetchConversations();
    const interval = setInterval(() => void fetchConversations(), 30000);
    return () => clearInterval(interval);
  }, [fetchConversations]);

  const loadMessages = useCallback(async (convId: string) => {
    setMessagesLoading(true);
    const token = getSessionToken();
    try {
      const res = await fetch(`/internal-api/conversations/${convId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { conversation: Conversation; messages: Message[] };
        setMessages(data.messages ?? []);
        setSelectedConv(data.conversation ?? null);
        setConversations(prev =>
          prev.map(c => (c.id === convId ? { ...c, unreadCount: 0 } : c))
        );
      }
    } catch (err) {
      console.error('[CONVERSATIONS] loadMessages error', err);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  // Scroll to bottom whenever messages change (covers both conversation switch and new messages)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const handleReply = async () => {
    if (!selectedId || !replyText.trim() || sending) return;
    setSending(true);
    setActionError(null);
    const token = getSessionToken();
    try {
      const res = await fetch(`/internal-api/conversations/${selectedId}/reply`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: replyText.trim() }),
      });
      if (res.ok) {
        setReplyText('');
        await loadMessages(selectedId);
        await fetchConversations();
      } else {
        const data = await res.json() as { error?: string };
        setActionError(data.error ?? 'Failed to send reply');
      }
    } catch {
      setActionError('Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  const handleResume = async () => {
    if (!selectedId) return;
    const token = getSessionToken();
    const res = await fetch(`/internal-api/conversations/${selectedId}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      await loadMessages(selectedId);
      await fetchConversations();
    }
  };

  const handleResolve = async () => {
    if (!selectedId) return;
    const token = getSessionToken();
    const res = await fetch(`/internal-api/conversations/${selectedId}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      await loadMessages(selectedId);
      await fetchConversations();
    }
  };

  const filtered = conversations.filter(c => {
    if (tab === 'needs_attention') return c.needsAttention;
    if (tab === 'active') return c.status === 'active';
    if (tab === 'resolved') return c.status === 'resolved';
    return true;
  });

  const needsAttentionCount = conversations.filter(c => c.needsAttention).length;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'needs_attention', label: 'Needs Attention' },
    { key: 'active', label: 'Active' },
    { key: 'resolved', label: 'Resolved' },
  ];

  return (
    <div className="flex h-[calc(100vh-5rem)] gap-0 overflow-hidden rounded-lg border border-slate-800">
      {/* Left panel: conversation list */}
      <div className="flex w-80 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-4 py-4">
          <h1 className="text-lg font-semibold text-slate-100">Conversations</h1>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 overflow-x-auto">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors whitespace-nowrap',
                tab === t.key
                  ? 'border-b-2 border-blue-500 text-blue-400'
                  : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {t.label}
              {t.key === 'needs_attention' && needsAttentionCount > 0 && (
                <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                  {needsAttentionCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-500">No conversations</div>
          ) : (
            filtered.map(conv => (
              <button
                key={conv.id}
                onClick={() => setSelectedId(conv.id)}
                className={cn(
                  'w-full border-b border-slate-800 px-4 py-3 text-left transition-colors',
                  selectedId === conv.id
                    ? 'bg-slate-800'
                    : 'hover:bg-slate-800/50',
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-slate-100">
                        {conv.customerName ?? 'Unknown'}
                      </span>
                      {conv.needsAttention && (
                        <span className="shrink-0 text-sm text-amber-400" title="Needs attention">⚠</span>
                      )}
                      {conv.unreadCount > 0 && (
                        <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold text-white">
                          {conv.unreadCount}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {conv.lastMessage ?? '—'}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500">
                      <span>{PLATFORM_LABELS[conv.platform] ?? conv.platform}</span>
                      {conv.lastMessageAt && (
                        <>
                          <span>·</span>
                          <span>{timeAgo(conv.lastMessageAt)}</span>
                        </>
                      )}
                      {conv.agentPaused && <span className="text-amber-500">· Paused</span>}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                      conv.status === 'resolved'
                        ? 'bg-slate-700 text-slate-400'
                        : 'bg-green-900/50 text-green-400',
                    )}
                  >
                    {conv.status}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel: message thread */}
      <div className="flex flex-1 flex-col bg-slate-950 min-w-0">
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
            Select a conversation to view messages
          </div>
        ) : (
          <>
            {/* Thread header */}
            {selectedConv && (
              <div className="flex items-center justify-between gap-4 border-b border-slate-800 px-6 py-4">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold text-slate-100">
                    {selectedConv.customerName ?? 'Unknown'}
                  </h2>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span>{PLATFORM_LABELS[selectedConv.platform] ?? selectedConv.platform}</span>
                    {selectedConv.customerPhone && (
                      <>
                        <span>·</span>
                        <span>{selectedConv.customerPhone}</span>
                      </>
                    )}
                    <span>·</span>
                    <span className="capitalize">{selectedConv.status}</span>
                    {selectedConv.agentPaused && (
                      <span className="text-amber-400">· AI Paused</span>
                    )}
                    {selectedConv.needsAttention && (
                      <span className="text-red-400">· Needs Attention</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {selectedConv.agentPaused && selectedConv.status !== 'resolved' && (
                    <button
                      onClick={() => void handleResume()}
                      className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-600"
                    >
                      Resume AI
                    </button>
                  )}
                  {selectedConv.status !== 'resolved' && (
                    <button
                      onClick={() => void handleResolve()}
                      className="rounded-md bg-green-800 px-3 py-1.5 text-xs font-medium text-green-100 transition-colors hover:bg-green-700"
                    >
                      Mark Resolved
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Messages */}
            <div ref={messagesContainerRef} className="flex-1 overflow-y-auto space-y-3 px-6 py-4">
              {messagesLoading ? (
                <div className="text-center text-sm text-slate-500">Loading messages…</div>
              ) : messages.length === 0 ? (
                <div className="text-center text-sm text-slate-500">No messages yet</div>
              ) : (
                messages.map(msg => (
                  <div
                    key={msg.id}
                    className={cn(
                      'flex',
                      msg.role === 'user' ? 'justify-start' : 'justify-end',
                    )}
                  >
                    <div
                      className={cn(
                        'max-w-[70%] rounded-2xl px-4 py-2.5 text-sm',
                        msg.role === 'user'
                          ? 'rounded-tl-sm bg-slate-800 text-slate-100'
                          : msg.role === 'staff'
                            ? 'rounded-tr-sm bg-blue-700 text-white'
                            : 'rounded-tr-sm bg-slate-700 text-slate-100',
                      )}
                    >
                      {msg.role === 'staff' && (
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-blue-200">
                          You
                        </div>
                      )}
                      {msg.role === 'assistant' && (
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          AI Agent
                        </div>
                      )}
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                      <div className="mt-1 text-right text-[10px] text-slate-400 opacity-70">
                        {new Date(msg.createdAt).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply input */}
            {canReply && selectedConv?.status !== 'resolved' && (
              <div className="border-t border-slate-800 p-4">
                {actionError && (
                  <p className="mb-2 text-xs text-red-400">{actionError}</p>
                )}
                <div className="flex gap-2">
                  <textarea
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleReply();
                      }
                    }}
                    placeholder="Type a reply… (Enter to send, Shift+Enter for new line)"
                    rows={2}
                    className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    onClick={() => void handleReply()}
                    disabled={sending || !replyText.trim()}
                    className="self-end rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                  >
                    {sending ? '…' : 'Send'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
