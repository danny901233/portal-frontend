'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const DONE_KEY = 'rm_webchat_setup_done';
const STEP_KEY = 'rm_webchat_setup_step';

export function isWizardIncomplete(): boolean {
  if (typeof window === 'undefined') return false;
  return !localStorage.getItem(DONE_KEY);
}

export function getSavedStep(): number {
  if (typeof window === 'undefined') return 0;
  const saved = localStorage.getItem(STEP_KEY);
  return saved ? parseInt(saved, 10) : 0;
}

interface Props {
  onHide: () => void;
  onDone: () => void;
}

// ── Reusable icon components ──────────────────────────────────────────────────

const IconChat = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
);

const IconDeviceMobile = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
  </svg>
);

const IconBell = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>
);

const IconPaint = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
  </svg>
);

const IconCode = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
  </svg>
);

const IconLink = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
  </svg>
);

const IconCheck = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const IconFlag = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 21V4a1 1 0 011-1h14l-3 5 3 5H4" />
  </svg>
);

const IconReply = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
  </svg>
);

const IconCog = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const IconBook = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
  </svg>
);

// WhatsApp logo mark
const IconWhatsApp = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
    <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.118 1.528 5.845L.057 23.428a.5.5 0 00.515.572l5.75-1.507A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.006-1.373l-.36-.213-3.714.974.991-3.617-.234-.372A9.818 9.818 0 0112 2.182c5.428 0 9.818 4.39 9.818 9.818 0 5.429-4.39 9.818-9.818 9.818z" />
  </svg>
);

// Facebook logo mark
const IconFacebook = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073c0 6.03 4.388 11.03 10.125 11.927v-8.437H7.078v-3.49h3.047V9.43c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.931-1.956 1.886v2.248h3.328l-.532 3.49h-2.796v8.437C19.612 23.103 24 18.103 24 12.073z" />
  </svg>
);

// Instagram logo mark
const IconInstagram = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
  </svg>
);

export default function MessagingSetupWizard({ onHide, onDone }: Props) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState<number>(() => getSavedStep());

  const goToStep = (index: number) => {
    localStorage.setItem(STEP_KEY, String(index));
    setStepIndex(index);
  };

  const navigateAway = (url: string) => {
    onHide();
    router.push(url);
  };

  const markDone = () => {
    localStorage.setItem(DONE_KEY, '1');
    localStorage.removeItem(STEP_KEY);
    onDone();
  };

  const steps = [
    {
      id: 'welcome',
      title: 'Welcome to Webchat',
      subtitle: "ReceptionMate handles your customer conversations — let's get you set up in a few steps.",
      headerIcon: <IconChat className="w-7 h-7 text-sky-400" />,
      headerColor: 'bg-sky-500/10 border-sky-500/20',
      content: (
        <div className="space-y-4">
          <p className="text-slate-300 text-sm leading-relaxed">
            With ReceptionMate Webchat, your AI agent handles customer conversations on your website — answering questions, taking bookings, and handing off to your team when needed.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: <IconChat className="w-5 h-5 text-sky-400" />, bg: 'bg-sky-500/10 border-sky-500/20', label: 'AI-powered live chat on your website' },
              { icon: <IconDeviceMobile className="w-5 h-5 text-violet-400" />, bg: 'bg-violet-500/10 border-violet-500/20', label: 'WhatsApp & social media in one inbox' },
              { icon: <IconBell className="w-5 h-5 text-amber-400" />, bg: 'bg-amber-500/10 border-amber-500/20', label: 'Email alerts when customers need you' },
            ].map((item, i) => (
              <div key={i} className={`flex flex-col items-center gap-2.5 rounded-xl border ${item.bg} p-4 text-center`}>
                <div className={`w-9 h-9 rounded-xl ${item.bg} border flex items-center justify-center flex-shrink-0`}>
                  {item.icon}
                </div>
                <span className="text-xs text-slate-300 leading-snug">{item.label}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            This wizard takes about 2 minutes. Close it at any time — your progress is saved and you can reopen it with the{' '}
            <strong className="text-slate-400">Setup Guide</strong> button.
          </p>
        </div>
      ),
    },
    {
      id: 'customize',
      title: 'Brand Your Widget',
      subtitle: 'Match the chat button to your website colours and logo.',
      headerIcon: <IconPaint className="w-7 h-7 text-violet-400" />,
      headerColor: 'bg-violet-500/10 border-violet-500/20',
      content: (
        <div className="space-y-4">
          <p className="text-slate-300 text-sm leading-relaxed">
            Open the widget customiser to set your brand colours, upload your logo, and choose a button icon that matches your website.
          </p>
          <ul className="space-y-2.5 text-sm text-slate-400">
            {[
              'Set your primary colour to match your brand',
              'Upload your garage logo',
              'Choose from chat bubble, WhatsApp, or phone icons',
              'Preview exactly how it looks to your customers',
            ].map(point => (
              <li key={point} className="flex items-start gap-2.5">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-violet-400 flex-shrink-0" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <button
            onClick={() => navigateAway('/integrations/widget/customize')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors"
          >
            <IconPaint className="w-4 h-4" />
            Open Customiser
          </button>
        </div>
      ),
    },
    {
      id: 'embed',
      title: 'Add to Your Website',
      subtitle: 'Paste one snippet of code and the widget appears on your site.',
      headerIcon: <IconCode className="w-7 h-7 text-emerald-400" />,
      headerColor: 'bg-emerald-500/10 border-emerald-500/20',
      content: (
        <div className="space-y-4">
          <p className="text-slate-300 text-sm leading-relaxed">
            Copy your unique embed code from the <strong className="text-slate-200">Setup</strong> page and paste it into your
            website — just before the closing{' '}
            <code className="bg-slate-700/80 px-1.5 py-0.5 rounded text-xs font-mono text-slate-200">&lt;/body&gt;</code> tag.
          </p>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Works on</p>
            <div className="flex flex-wrap gap-2">
              {['WordPress', 'Wix', 'Squarespace', 'GoHighLevel', 'Any HTML site'].map(platform => (
                <span key={platform} className="px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs text-slate-300">
                  {platform}
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={() => navigateAway('/integrations/widget')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors"
          >
            <IconCode className="w-4 h-4" />
            Get Embed Code
          </button>
        </div>
      ),
    },
    {
      id: 'connect',
      title: 'Connect Social Platforms',
      subtitle: 'Bring WhatsApp, Facebook Messenger, and Instagram into your inbox.',
      headerIcon: <IconLink className="w-7 h-7 text-blue-400" />,
      headerColor: 'bg-blue-500/10 border-blue-500/20',
      content: (
        <div className="space-y-4">
          <p className="text-slate-300 text-sm leading-relaxed">
            Connect your social media accounts so all customer messages from WhatsApp, Facebook, and Instagram arrive in the same Messages inbox.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              {
                icon: <IconWhatsApp className="w-6 h-6" />,
                iconBg: 'bg-[#25D366]/10 border-[#25D366]/25 text-[#25D366]',
                name: 'WhatsApp',
                desc: 'Business account',
              },
              {
                icon: <IconFacebook className="w-6 h-6" />,
                iconBg: 'bg-[#1877F2]/10 border-[#1877F2]/25 text-[#1877F2]',
                name: 'Facebook',
                desc: 'Page Messenger',
              },
              {
                icon: <IconInstagram className="w-6 h-6" />,
                iconBg: 'bg-pink-500/10 border-pink-500/25 text-pink-400',
                name: 'Instagram',
                desc: 'Business DMs',
              },
            ].map(p => (
              <div key={p.name} className="flex flex-col items-center gap-2.5 rounded-xl border border-slate-700 bg-slate-800/50 p-4 text-center">
                <div className={`w-10 h-10 rounded-xl border flex items-center justify-center ${p.iconBg}`}>
                  {p.icon}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-200">{p.name}</p>
                  <p className="text-xs text-slate-500">{p.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => navigateAway('/integrations')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
          >
            <IconLink className="w-4 h-4" />
            Connect Platforms
          </button>
        </div>
      ),
    },
    {
      id: 'notifications',
      title: 'Set Up Notifications',
      subtitle: 'Make sure the right people are alerted when a customer needs attention.',
      headerIcon: <IconBell className="w-7 h-7 text-amber-400" />,
      headerColor: 'bg-amber-500/10 border-amber-500/20',
      content: (
        <div className="space-y-4">
          <p className="text-slate-300 text-sm leading-relaxed">
            Add email addresses in <strong className="text-slate-200">Agent Configurations</strong> to receive alerts whenever a conversation is flagged for human attention.
          </p>
          <ul className="space-y-2.5 text-sm text-slate-400">
            {[
              'Emails are sent when the AI flags a conversation, or when your team manually flags one',
              'The email includes the last 3 messages and a direct link to the conversation',
              'You can add multiple email addresses — great for team inboxes',
            ].map(point => (
              <li key={point} className="flex items-start gap-2.5">
                <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <button
            onClick={() => navigateAway('/agent-configurations')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium transition-colors"
          >
            <IconCog className="w-4 h-4" />
            Open Agent Configurations
          </button>
        </div>
      ),
    },
    {
      id: 'done',
      title: "You're all set!",
      subtitle: "Your webchat is ready to go. Here's a quick reminder of what you can do.",
      headerIcon: <IconCheck className="w-7 h-7 text-emerald-400" />,
      headerColor: 'bg-emerald-500/10 border-emerald-500/20',
      content: (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { icon: <IconFlag className="w-4 h-4 text-rose-400" />, bg: 'bg-rose-500/10 border-rose-500/20', title: 'Flag conversations', desc: 'Click the flag icon to alert your team and pause the AI' },
              { icon: <IconReply className="w-4 h-4 text-sky-400" />, bg: 'bg-sky-500/10 border-sky-500/20', title: 'Reply manually', desc: 'Type in the message box to respond directly to customers' },
              { icon: <IconCog className="w-4 h-4 text-violet-400" />, bg: 'bg-violet-500/10 border-violet-500/20', title: 'Human Escalation', desc: 'Toggle in Agent Configurations → Messaging & Connect Webchat' },
              { icon: <IconBook className="w-4 h-4 text-amber-400" />, bg: 'bg-amber-500/10 border-amber-500/20', title: 'Full guide', desc: 'Help & Guides in the sidebar has everything in detail' },
            ].map(item => (
              <div key={item.title} className="flex items-start gap-3 rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                <div className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${item.bg}`}>
                  {item.icon}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-200">{item.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 leading-snug">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
  ];

  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl shadow-black/60 flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center w-12 h-12 rounded-xl border flex-shrink-0 ${step.headerColor}`}>
              {step.headerIcon}
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">{step.title}</h2>
              <p className="text-xs text-slate-400 mt-0.5 leading-snug max-w-xs">{step.subtitle}</p>
            </div>
          </div>
          <button
            onClick={onHide}
            className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0 mt-0.5 p-1 rounded-lg hover:bg-slate-800"
            aria-label="Close"
            title="Close — your progress is saved. Reopen with the Setup Guide button."
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Progress bar */}
        <div className="flex gap-1.5 px-5 pt-4">
          {steps.map((s, i) => (
            <button
              key={s.id}
              onClick={() => goToStep(i)}
              className={`h-1 flex-1 rounded-full transition-all duration-200 ${i <= stepIndex ? 'bg-sky-500' : 'bg-slate-700 hover:bg-slate-600'}`}
              aria-label={`Go to step ${i + 1}: ${s.title}`}
            />
          ))}
        </div>
        <p className="px-5 pt-1.5 text-xs text-slate-600">
          Step {stepIndex + 1} of {steps.length}
        </p>

        {/* Content */}
        <div className="p-5 flex-1">{step.content}</div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 pb-5 border-t border-slate-800 pt-4">
          <button
            onClick={markDone}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Mark as done
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                onClick={() => goToStep(stepIndex - 1)}
                className="px-3.5 py-2 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors"
              >
                Back
              </button>
            )}
            {isLast ? (
              <button
                onClick={markDone}
                className="px-4 py-2 text-sm rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-medium transition-colors"
              >
                Finish Setup
              </button>
            ) : (
              <button
                onClick={() => goToStep(stepIndex + 1)}
                className="px-4 py-2 text-sm rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-medium transition-colors"
              >
                Next
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}