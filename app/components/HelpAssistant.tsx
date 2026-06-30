"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

const SUPPORT_EMAIL = "hello@receptionmate.co.uk";

const QUICK_TOPICS = [
  {
    id: "search",
    label: "Call search tips",
    prompt: "How do I use the call search?",
  },
  {
    id: "feedback",
    label: "Leave feedback",
    prompt: "How do I leave call feedback?",
  },
  {
    id: "knowledge",
    label: "Knowledge base",
    prompt: "How do I update the knowledge base?",
  },
  {
    id: "support",
    label: "Contact support",
    prompt: "I need to reach support",
  },
];

const KNOWLEDGE = [
  {
    id: "search",
    keywords: ["search", "boolean", "find", "filter"],
    title: "Call search",
    summary:
      "The Calls page supports AND, OR, and NOT plus quoted phrases. For example: service AND (booking OR estimate) will show service calls that mention bookings or estimates. If a query fails, the portal falls back to simple keyword matching.",
    linkLabel: "Learn search basics",
    linkHref: "/help#advanced-search",
  },
  {
    id: "feedback",
    keywords: ["feedback", "thumb", "rating", "review"],
    title: "Leaving call feedback",
    summary:
      "Open a call and use the thumbs icons. A down vote asks for reasons and optional notes so we can action the issue. Feedback syncs immediately and shows on that call's detail page.",
    linkLabel: "Feedback workflow",
    linkHref: "/help#call-feedback",
  },
  {
    id: "knowledge",
    keywords: ["knowledge", "website", "scan", "ingest", "pages"],
    title: "Updating the knowledge base",
    summary:
      "Go to Agent Configurations, run a discovery scan, tick the pages you want, then publish. Repeat scans whenever the site changes so your agent stays up to date.",
    linkLabel: "Knowledge base guide",
    linkHref: "/help#knowledge-base",
  },
  {
    id: "garages",
    keywords: ["garage", "switch", "access", "login"],
    title: "Garage access",
    summary:
      "Use the garage selector in the top bar. If the list looks empty, refresh or sign out/in. Persistent issues? Email hello@receptionmate.co.uk with the garage name and time.",
    linkLabel: "Getting started",
    linkHref: "/help#getting-started",
  },
  {
    id: "troubleshooting",
    keywords: ["error", "issue", "problem", "help", "support"],
    title: "Troubleshooting",
    summary:
      "Try refreshing, clearing filters, or rechecking your Boolean syntax. Still stuck? Drop us a note with call IDs, timestamps, and screenshots so we can investigate.",
    linkLabel: "Troubleshooting checklist",
    linkHref: "/help#troubleshooting",
  },
];

type Message = {
  id: string;
  role: "assistant" | "user";
  content: string;
  topicId?: string;
};

const createId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

const INITIAL_MESSAGES: Message[] = [
  {
    id: createId(),
    role: "assistant",
    content:
      "Hi! I’m the ReceptionMate help bot. Ask me how to find calls, configure your agent, or troubleshoot an issue. You can also pick a quick topic below.",
  },
];

const normalise = (value: string) => value.toLowerCase();

const matchTopic = (input: string) => {
  const normInput = normalise(input);
  return (
    KNOWLEDGE.find((entry) =>
      entry.keywords.some((keyword) => normInput.includes(normalise(keyword)))
    ) ?? null
  );
};

export default function HelpAssistant() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<Message[]>(INITIAL_MESSAGES);

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const fallbackReply = useCallback(
    (question: string) =>
      `I can help with ReceptionMate portal questions like “${question}”. If you need deeper support, email ${SUPPORT_EMAIL} with any call IDs or timestamps so the team can investigate.`,
    []
  );

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || isSending) {
        return;
      }

      setInput("");
      setErrorMessage(null);
      const userMessage: Message = {
        id: createId(),
        role: "user",
        content: trimmed,
      };

      const conversation = [...messagesRef.current, userMessage];
      messagesRef.current = conversation;
      setMessages(conversation);
      setIsSending(true);

      try {
        const response = await fetch("/api/help-assistant", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: conversation.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          }),
        });

        const rawBody = await response.text();
        let parsed: { reply?: string; error?: string } | null = null;
        if (rawBody) {
          try {
            parsed = JSON.parse(rawBody) as { reply?: string; error?: string };
          } catch {
            parsed = null;
          }
        }

        if (!response.ok) {
          const message = parsed?.error || rawBody || "Failed to fetch assistant response.";
          throw new Error(message);
        }

        const { reply } = parsed ?? {};
        const assistantContent = reply?.trim() || fallbackReply(trimmed);
        const matchingTopic = matchTopic(assistantContent);
        const assistantMessage: Message = {
          id: createId(),
          role: "assistant",
          content: assistantContent,
          topicId: matchingTopic?.id,
        };

        const withAssistant = [...conversation, assistantMessage];
        messagesRef.current = withAssistant;
        setMessages(withAssistant);
      } catch (error) {
        console.error("Help assistant request failed", error);
        setErrorMessage(
          "I hit a snag answering that. Try again in a moment, or email hello@receptionmate.co.uk with your question."
        );
        const assistantMessage: Message = {
          id: createId(),
          role: "assistant",
          content: fallbackReply(trimmed),
        };
        const withAssistant = [...conversation, assistantMessage];
        messagesRef.current = withAssistant;
        setMessages(withAssistant);
      } finally {
        setIsSending(false);
      }
    },
    [fallbackReply, isSending]
  );

  const handleSubmit = () => {
    void sendMessage(input);
  };

  const handleQuickPrompt = (prompt: string) => {
    void sendMessage(prompt);
  };

  const knowledgeById = useMemo(() => {
    return KNOWLEDGE.reduce<Record<string, (typeof KNOWLEDGE)[number]>>((acc, entry) => {
      acc[entry.id] = entry;
      return acc;
    }, {});
  }, []);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-lg shadow-slate-900/5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Need a hand?</h2>
          <p className="text-sm text-slate-500">
            Start a conversation with the ReceptionMate help bot. It points you to the right guide and lets you know when to reach out to a human.
          </p>
        </div>
        <Link
          href={`mailto:${SUPPORT_EMAIL}`}
          className="rounded-md border border-slate-300 px-3 py-1 text-xs text-brand-600 transition-colors hover:border-slate-500 hover:text-brand-700"
        >
          Email support
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {QUICK_TOPICS.map((topic) => (
          <button
            key={topic.id}
            type="button"
            onClick={() => handleQuickPrompt(topic.prompt)}
            className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-brand-400 hover:text-brand-700"
          >
            {topic.label}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        className="mt-4 max-h-72 space-y-3 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
      >
        {messages.map((message) => {
          const topic =
            message.role === "assistant"
              ? message.topicId
                ? knowledgeById[message.topicId]
                : matchTopic(message.content)
              : null;
          return (
            <div
              key={message.id}
              className={
                message.role === "assistant"
                  ? "rounded-lg border border-slate-200 bg-white p-3"
                  : "ml-auto w-fit rounded-lg border border-brand-300 bg-brand-100 p-3"
              }
            >
              <p>{message.content}</p>
              {topic ? (
                <div className="mt-2 inline-flex items-center gap-2 text-xs text-slate-600">
                  <span>Need more?</span>
                  <Link
                    href={topic.linkHref}
                    className="rounded border border-slate-300 px-2 py-0.5 text-brand-600 transition-colors hover:border-slate-500 hover:text-brand-700"
                  >
                    {topic.linkLabel}
                  </Link>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <textarea
          id="help-assistant-input"
          rows={3}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Ask a question about the portal..."
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none"
          disabled={isSending}
        />
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Tip: include call IDs or page names when asking about specific issues.</span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSending}
            className="rounded-md border border-brand-300 bg-brand-100 px-4 py-1 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-100"
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
        {errorMessage ? (
          <p className="text-xs text-rose-300" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
