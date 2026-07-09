'use client';

import PageGate from '../PageGate';
import MessagingTab from '../_components/MessagingTab';
import IntegrationsPage from '../../integrations/page';

export default function MessagingPage() {
  return (
    <div className="space-y-8">
      <PageGate>
        {({ config, save, isSaving }) => (
          <MessagingTab config={config} save={save} isSaving={isSaving} />
        )}
      </PageGate>

      {/* Connected channels — the social + website-widget integrations used to
          live behind a button on the Messages page; they now sit here alongside
          the rest of the chat configuration. */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <header className="mb-6">
          <h2 className="text-xl font-semibold text-slate-900">Connected channels</h2>
          <p className="mt-1 text-sm text-slate-500">
            Connect the places your customers message you — WhatsApp, Facebook, Instagram and your website widget.
          </p>
        </header>
        <IntegrationsPage embedded />
      </section>
    </div>
  );
}
