'use client';

import PageGate from '../PageGate';
import IdentityTab from '../_components/IdentityTab';

export default function Page() {
  return (
    <PageGate>
      {({ config, save, isSaving, twilioNumber }) => (
        <IdentityTab config={config} save={save} isSaving={isSaving} twilioNumber={twilioNumber} />
      )}
    </PageGate>
  );
}
