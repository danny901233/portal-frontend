'use client';

import { useState, useEffect } from 'react';
import { getGarageId, getGarages } from '../../lib/auth';

export default function WidgetEmbedPage() {
  const [copiedChat, setCopiedChat] = useState(false);
  const [copiedVoice, setCopiedVoice] = useState(false);
  const [garageId, setGarageId] = useState<string>('');
  const [garageName, setGarageName] = useState<string>('');

  useEffect(() => {
    const storedGarageId = getGarageId();
    const garages = getGarages();
    const garage = garages.find(g => g.id === storedGarageId);
    const name = garage?.name || 'Your Garage';
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
    ? `<!-- ReceptionMate Voice Widget -->
<script 
  src="https://widget.receptionmate.co.uk/embed.js" 
  data-garage-id="${garageId}"
  async
></script>`
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
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-slate-400">Loading...</p>
        </div>
      </div>
    );
  }

  const installSteps = [
    'Copy the embed code above by clicking "Copy Code"',
    <>Paste the code into your website&apos;s HTML, just before the closing <code className="bg-slate-700 px-1.5 py-0.5 rounded text-xs">&lt;/body&gt;</code> tag</>,
    'Save and publish your website — the widget will appear in the bottom right corner',
  ];

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Website Widgets</h1>
        <p className="text-sm text-slate-400 mt-1">
          Embed ReceptionMate widgets on your website to let customers reach you instantly.
        </p>
        <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-400">
          <span className="text-slate-500">Garage ID:</span>
          <code className="text-slate-300">{garageId}</code>
          <span className="text-slate-600">·</span>
          <span className="text-slate-300">{garageName}</span>
        </div>
      </div>

      {/* Chat Widget */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600/20 border border-blue-500/30">
            <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-100">Chat Widget</h2>
            <p className="text-xs text-slate-400">WhatsApp, web chat, and messaging in one floating button</p>
          </div>
          <button
            onClick={() => window.open(`/widget/${garageId}`, '_blank')}
            className="ml-auto flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Preview
          </button>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-slate-300">Embed Code</span>
            <button
              onClick={handleCopyChat}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition-colors"
            >
              {copiedChat ? (
                <><svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><span className="text-green-400">Copied!</span></>
              ) : (
                <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>Copy Code</>
              )}
            </button>
          </div>
          <div className="bg-slate-950 rounded-lg p-4 overflow-x-auto">
            <pre className="text-xs text-green-400 font-mono whitespace-pre">{chatEmbedCode}</pre>
          </div>
          <ol className="mt-4 space-y-2">
            {installSteps.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm text-slate-400">
                <span className="flex-shrink-0 w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-semibold">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/* Voice Widget */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-purple-600/20 border border-purple-500/30">
            <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-100">Voice Widget</h2>
            <p className="text-xs text-slate-400">Let customers speak directly to your AI agent from your website</p>
          </div>
          <button
            onClick={() => window.open('https://widget.receptionmate.co.uk', '_blank')}
            className="ml-auto flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Preview
          </button>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-slate-300">Embed Code</span>
            <button
              onClick={handleCopyVoice}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition-colors"
            >
              {copiedVoice ? (
                <><svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><span className="text-green-400">Copied!</span></>
              ) : (
                <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" /></svg>Copy Code</>
              )}
            </button>
          </div>
          <div className="bg-slate-950 rounded-lg p-4 overflow-x-auto">
            <pre className="text-xs text-green-400 font-mono whitespace-pre">{voiceEmbedCode}</pre>
          </div>
          <ol className="mt-4 space-y-2">
            {installSteps.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm text-slate-400">
                <span className="flex-shrink-0 w-5 h-5 bg-purple-600 text-white rounded-full flex items-center justify-center text-xs font-semibold">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
