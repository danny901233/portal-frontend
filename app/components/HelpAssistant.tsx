"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLang } from "@/app/i18n/LocaleProvider";
import type { Locale } from "@/app/i18n/messages";

const SUPPORT_EMAIL = "hello@receptionmate.co.uk";

const COPY = {
  en: {
    quickTopics: [
      { id: "search", label: "Call search tips", prompt: "How do I use the call search?" },
      { id: "feedback", label: "Leave feedback", prompt: "How do I leave call feedback?" },
      { id: "knowledge", label: "Knowledge base", prompt: "How do I update the knowledge base?" },
      { id: "support", label: "Contact support", prompt: "I need to reach support" },
    ],
    knowledge: [
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
    ],
    initialMessage:
      "Hi! I’m the ReceptionMate help bot. Ask me how to find calls, configure your agent, or troubleshoot an issue. You can also pick a quick topic below.",
    fallbackReply: (question: string) =>
      `I can help with ReceptionMate portal questions like “${question}”. If you need deeper support, email ${SUPPORT_EMAIL} with any call IDs or timestamps so the team can investigate.`,
    genericError: "Failed to fetch assistant response.",
    snagError:
      "I hit a snag answering that. Try again in a moment, or email hello@receptionmate.co.uk with your question.",
    heading: "Need a hand?",
    intro:
      "Start a conversation with the ReceptionMate help bot. It points you to the right guide and lets you know when to reach out to a human.",
    emailSupport: "Email support",
    needMore: "Need more?",
    placeholder: "Ask a question about the portal...",
    tip: "Tip: include call IDs or page names when asking about specific issues.",
    sending: "Sending…",
    send: "Send",
  },
  fr: {
    quickTopics: [
      { id: "search", label: "Conseils de recherche d’appels", prompt: "Comment utiliser la recherche d’appels ?" },
      { id: "feedback", label: "Laisser un avis", prompt: "Comment laisser un avis sur un appel ?" },
      { id: "knowledge", label: "Base de connaissances", prompt: "Comment mettre à jour la base de connaissances ?" },
      { id: "support", label: "Contacter le support", prompt: "J’ai besoin de joindre le support" },
    ],
    knowledge: [
      {
        id: "search",
        keywords: ["search", "boolean", "find", "filter"],
        title: "Recherche d’appels",
        summary:
          "La page Appels prend en charge AND, OR et NOT ainsi que les expressions entre guillemets. Par exemple : service AND (booking OR estimate) affichera les appels de service mentionnant des réservations ou des devis. Si une requête échoue, le portail revient à une simple recherche par mots-clés.",
        linkLabel: "Découvrir les bases de la recherche",
        linkHref: "/help#advanced-search",
      },
      {
        id: "feedback",
        keywords: ["feedback", "thumb", "rating", "review"],
        title: "Laisser un avis sur un appel",
        summary:
          "Ouvrez un appel et utilisez les icônes de pouce. Un vote négatif demande des raisons et des notes facultatives afin que nous puissions traiter le problème. L’avis se synchronise immédiatement et apparaît sur la page de détail de cet appel.",
        linkLabel: "Processus d’avis",
        linkHref: "/help#call-feedback",
      },
      {
        id: "knowledge",
        keywords: ["knowledge", "website", "scan", "ingest", "pages"],
        title: "Mettre à jour la base de connaissances",
        summary:
          "Allez dans Configurations de l’agent, lancez une analyse de découverte, cochez les pages souhaitées, puis publiez. Répétez les analyses à chaque modification du site pour que votre agent reste à jour.",
        linkLabel: "Guide de la base de connaissances",
        linkHref: "/help#knowledge-base",
      },
      {
        id: "garages",
        keywords: ["garage", "switch", "access", "login"],
        title: "Accès au garage",
        summary:
          "Utilisez le sélecteur de garage dans la barre supérieure. Si la liste semble vide, actualisez ou déconnectez-vous puis reconnectez-vous. Problèmes persistants ? Envoyez un e-mail à hello@receptionmate.co.uk en indiquant le nom du garage et l’heure.",
        linkLabel: "Prise en main",
        linkHref: "/help#getting-started",
      },
      {
        id: "troubleshooting",
        keywords: ["error", "issue", "problem", "help", "support"],
        title: "Dépannage",
        summary:
          "Essayez d’actualiser, d’effacer les filtres ou de revérifier votre syntaxe booléenne. Toujours bloqué ? Envoyez-nous un message avec les identifiants d’appels, les horodatages et des captures d’écran afin que nous puissions enquêter.",
        linkLabel: "Liste de vérification de dépannage",
        linkHref: "/help#troubleshooting",
      },
    ],
    initialMessage:
      "Bonjour ! Je suis l’assistant d’aide ReceptionMate. Demandez-moi comment trouver des appels, configurer votre agent ou résoudre un problème. Vous pouvez aussi choisir un sujet rapide ci-dessous.",
    fallbackReply: (question: string) =>
      `Je peux vous aider sur des questions du portail ReceptionMate comme « ${question} ». Si vous avez besoin d’une assistance plus poussée, envoyez un e-mail à ${SUPPORT_EMAIL} avec les identifiants d’appels ou les horodatages afin que l’équipe puisse enquêter.`,
    genericError: "Échec de la récupération de la réponse de l’assistant.",
    snagError:
      "J’ai rencontré un souci pour répondre. Réessayez dans un instant ou envoyez un e-mail à hello@receptionmate.co.uk avec votre question.",
    heading: "Besoin d’aide ?",
    intro:
      "Démarrez une conversation avec l’assistant d’aide ReceptionMate. Il vous oriente vers le bon guide et vous indique quand contacter un humain.",
    emailSupport: "Contacter le support par e-mail",
    needMore: "Besoin de plus ?",
    placeholder: "Posez une question sur le portail...",
    tip: "Astuce : indiquez les identifiants d’appels ou les noms de pages lorsque vous posez une question sur un problème précis.",
    sending: "Envoi…",
    send: "Envoyer",
  },
} as const;

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

type KnowledgeEntry = (typeof COPY)[Locale]["knowledge"][number];

const makeInitialMessages = (content: string): Message[] => [
  {
    id: createId(),
    role: "assistant",
    content,
  },
];

const normalise = (value: string) => value.toLowerCase();

const matchTopic = (input: string, knowledge: readonly KnowledgeEntry[]) => {
  const normInput = normalise(input);
  return (
    knowledge.find((entry) =>
      entry.keywords.some((keyword) => normInput.includes(normalise(keyword)))
    ) ?? null
  );
};

export default function HelpAssistant() {
  const lang = useLang();
  const c = COPY[lang];
  const initialMessages = useMemo(() => makeInitialMessages(c.initialMessage), [c.initialMessage]);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<Message[]>(initialMessages);

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
    (question: string) => c.fallbackReply(question),
    [c]
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
          const message = parsed?.error || rawBody || c.genericError;
          throw new Error(message);
        }

        const { reply } = parsed ?? {};
        const assistantContent = reply?.trim() || fallbackReply(trimmed);
        const matchingTopic = matchTopic(assistantContent, c.knowledge);
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
        setErrorMessage(c.snagError);
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
    [fallbackReply, isSending, c]
  );

  const handleSubmit = () => {
    void sendMessage(input);
  };

  const handleQuickPrompt = (prompt: string) => {
    void sendMessage(prompt);
  };

  const knowledgeById = useMemo(() => {
    return c.knowledge.reduce<Record<string, KnowledgeEntry>>((acc, entry) => {
      acc[entry.id] = entry;
      return acc;
    }, {});
  }, [c.knowledge]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-lg shadow-slate-900/5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{c.heading}</h2>
          <p className="text-sm text-slate-500">
            {c.intro}
          </p>
        </div>
        <Link
          href={`mailto:${SUPPORT_EMAIL}`}
          className="rounded-md border border-slate-300 px-3 py-1 text-xs text-brand-600 transition-colors hover:border-slate-500 hover:text-brand-700"
        >
          {c.emailSupport}
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {c.quickTopics.map((topic) => (
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
                : matchTopic(message.content, c.knowledge)
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
                  <span>{c.needMore}</span>
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
          placeholder={c.placeholder}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none"
          disabled={isSending}
        />
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{c.tip}</span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSending}
            className="rounded-md border border-brand-300 bg-brand-100 px-4 py-1 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-100"
          >
            {isSending ? c.sending : c.send}
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
