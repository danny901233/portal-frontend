'use client';

import PageGate from '../PageGate';
import MessagingTab from '../_components/MessagingTab';

export default function MessagingPage() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <MessagingTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
