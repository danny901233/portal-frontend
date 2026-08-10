'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getGarageId, getGarages } from '../../lib/auth';
import { useLang } from '@/app/i18n/LocaleProvider';

export default function WidgetEmbedPage() {
  const router = useRouter();
  const lang = useLang();
  const c = {
    en: {
      loading: 'Loading...',
      title: 'Integrations',
      subtitle: 'Embed ReceptionMate widgets on your website to let customers reach you instantly.',
      tabSocial: 'Social media',
      tabWidget: 'Website widget',
      garageIdLabel: 'Garage ID',
      fallbackGarageName: 'Your Garage',
      chatTitle: 'Chat widget',
      chatSubtitle: 'WhatsApp, web chat and messaging in one floating button.',
      voiceTitle: 'Voice widget',
      voiceSubtitle: 'Let customers speak directly to Leah from your website.',
      preview: 'Preview',
      customise: 'Customise',
    },
    fr: {
      loading: 'Chargement...',
      title: 'Intégrations',
      subtitle: 'Intégrez les widgets ReceptionMate sur votre site web pour que vos clients vous joignent instantanément.',
      tabSocial: 'Réseaux sociaux',
      tabWidget: 'Widget de site web',
      garageIdLabel: 'ID du garage',
      fallbackGarageName: 'Votre garage',
      chatTitle: 'Widget de chat',
      chatSubtitle: 'WhatsApp, chat web et messagerie dans un seul bouton flottant.',
      voiceTitle: 'Widget vocal',
      voiceSubtitle: 'Laissez vos clients parler directement à Leah depuis votre site web.',
      preview: 'Aperçu',
      customise: 'Personnaliser',
    },
  }[lang];
  const [copiedChat, setCopiedChat] = useState(false);
  const [copiedVoice, setCopiedVoice] = useState(false);
  const [garageId, setGarageId] = useState<string>('');
  const [garageName, setGarageName] = useState<string>('');

  useEffect(() => {
    const storedGarageId = getGarageId();
    const garages = getGarages();
    const garage = garages.find(g => g.id === storedGarageId);
    const name = garage?.name || c.fallbackGarageName;
    if (storedGarageId) {
      setGarageId(storedGarageId);
      setGarageName(name);
    }
  }, []);

  const chatEmbedCode = garageId
    ? `<!-- ReceptionMate Chat Widget -->
<iframe
  src="https://portal.receptionmate.co.uk/widget/${garageId}"
  style="position: fixed; bottom: 0; right: 0; width: 100%; height: 100%; border: none; pointer-events: none; z-index: 999999;"
  allow="microphone"
  id="receptionmate-widget"
></iframe>
<script>
  // Make only the widget clickable
  document.getElementById('receptionmate-widget').contentWindow.document.body.style.pointerEvents = 'auto';
</script>`
    : '';

  const voiceEmbedCode = garageId
    ? `<!-- ReceptionMate Voice Widget (iframe) -->
<iframe
  src="https://portal.receptionmate.co.uk/voice-widget/embed?theme=dark"
  style="width: 320px; height: 64px; border: none;"
  allow="microphone"
></iframe>`
    : '';

  const handleCopyChat = () => {
    navigator.clipboard.writeText(chatEmbedCode);
    setCopiedChat(true);
    setTimeout(() => setCopiedChat(false), 2000);
  };

  const handleCopyVoice = () => {
    navigator.clipboard.writeText(voiceEmbedCode);
    setCopiedVoice(true);
    setTimeout(() => setCopiedVoice(false), 2000);
  };

  if (!garageId) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600 mx-auto"></div>
          <p className="mt-4 text-slate-500">{c.loading}</p>
        </div>
      </div>
    );
  }

  const installSteps: React.ReactNode[] = lang === 'fr'
    ? [
        'Copiez le code d\'intégration ci-dessus en cliquant sur « Copier le code ».',
        <>Collez le code dans le code HTML de votre site web, juste avant la balise de fermeture <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs font-mono text-slate-800">&lt;/body&gt;</code>.</>,
        'Enregistrez et publiez votre site web — le widget apparaîtra dans le coin inférieur droit.',
      ]
    : [
        'Copy the embed code above by clicking "Copy Code".',
        <>Paste the code into your website&apos;s HTML, just before the closing <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs font-mono text-slate-800">&lt;/body&gt;</code> tag.</>,
        'Save and publish your website — the widget will appear in the bottom-right corner.',
      ];

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{c.title}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {c.subtitle}
        </p>

        {/* Tab switcher */}
        <div className="flex gap-1 mt-5 p-1 bg-slate-100 rounded-lg w-fit">
          <button
            onClick={() => router.push('/integrations')}
            className="px-4 py-1.5 text-sm font-medium rounded-md text-slate-600 hover:text-slate-900 transition-colors"
          >
            {c.tabSocial}
          </button>
          <button
            className="px-4 py-1.5 text-sm font-semibold rounded-md bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
            aria-current="page"
          >
            {c.tabWidget}
          </button>
        </div>

        {/* Garage ID indicator */}
        <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs">
          <span className="font-medium text-slate-500">{c.garageIdLabel}</span>
          <code className="font-mono text-slate-900">{garageId}</code>
          <span className="text-slate-300">·</span>
          <span className="font-medium text-slate-700">{garageName}</span>
        </div>
      </div>

      {/* Chat Widget */}
      <WidgetCard
        accent="brand"
        title={c.chatTitle}
        subtitle={c.chatSubtitle}
        icon={(
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        )}
        headerActions={(
          <>
            <SecondaryBtn onClick={() => window.open(`/widget/${garageId}`, '_blank')} icon="external">
              {c.preview}
            </SecondaryBtn>
            <PrimaryBtn onClick={() => router.push('/integrations/widget/customize')} icon="customise">
              {c.customise}
            </PrimaryBtn>
          </>
        )}
        embedCode={chatEmbedCode}
        copied={copiedChat}
        onCopy={handleCopyChat}
        steps={installSteps}
        stepAccentClass="bg-brand-600"
      />

      {/* Voice Widget */}
      <WidgetCard
        accent="violet"
        title={c.voiceTitle}
        subtitle={c.voiceSubtitle}
        icon={(
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        )}
        headerActions={(
          <SecondaryBtn onClick={() => window.open('https://portal.receptionmate.co.uk/voice-widget/', '_blank')} icon="external">
            {c.preview}
          </SecondaryBtn>
        )}
        embedCode={voiceEmbedCode}
        copied={copiedVoice}
        onCopy={handleCopyVoice}
        steps={installSteps}
        stepAccentClass="bg-violet-600"
      />
    </div>
  );
}

// ---------- helpers ----------

function WidgetCard(props: {
  accent: 'brand' | 'violet';
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  headerActions: React.ReactNode;
  embedCode: string;
  copied: boolean;
  onCopy: () => void;
  steps: React.ReactNode[];
  stepAccentClass: string;
}) {
  const accentBgClass = props.accent === 'brand' ? 'bg-brand-50 text-brand-600' : 'bg-violet-50 text-violet-600';
  const lang = useLang();
  const c = {
    en: { embedCode: 'Embed code', copied: 'Copied!', copyCode: 'Copy code' },
    fr: { embedCode: "Code d'intégration", copied: 'Copié !', copyCode: 'Copier le code' },
  }[lang];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 border-b border-slate-200 px-6 py-4">
        <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${accentBgClass}`}>
          {props.icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-slate-900">{props.title}</h2>
          <p className="text-xs text-slate-500">{props.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {props.headerActions}
        </div>
      </div>

      <div className="p-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-slate-700">{c.embedCode}</span>
          <button
            onClick={props.onCopy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            {props.copied ? (
              <>
                <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                <span className="text-emerald-700">{c.copied}</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>
                {c.copyCode}
              </>
            )}
          </button>
        </div>

        {/* Code block stays dark — this is a code editor, dark is correct */}
        <div className="rounded-lg bg-slate-900 p-4 overflow-x-auto ring-1 ring-slate-800">
          <pre className="text-xs text-emerald-300 font-mono whitespace-pre">{props.embedCode}</pre>
        </div>

        <ol className="mt-5 space-y-3">
          {props.steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm text-slate-700">
              <span className={`flex-shrink-0 h-5 w-5 ${props.stepAccentClass} text-white rounded-full flex items-center justify-center text-xs font-semibold`}>
                {i + 1}
              </span>
              <span className="leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function SecondaryBtn({ children, onClick, icon }: { children: React.ReactNode; onClick: () => void; icon: 'external' | 'customise' }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
    >
      <ButtonIcon name={icon} />
      {children}
    </button>
  );
}

function PrimaryBtn({ children, onClick, icon }: { children: React.ReactNode; onClick: () => void; icon: 'external' | 'customise' }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 transition-colors"
    >
      <ButtonIcon name={icon} />
      {children}
    </button>
  );
}

function ButtonIcon({ name }: { name: 'external' | 'customise' }) {
  if (name === 'external') {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
    </svg>
  );
}
