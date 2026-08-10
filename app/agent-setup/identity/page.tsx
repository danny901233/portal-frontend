'use client';

import PageGate from '../PageGate';
import IdentityTab from '../_components/IdentityTab';

export default function IdentityPage() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <IdentityTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
