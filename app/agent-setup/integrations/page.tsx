'use client';

import PageGate from '../PageGate';
import IntegrationsTab from '../_components/IntegrationsTab';

export default function Page() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <IntegrationsTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
