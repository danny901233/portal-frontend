'use client';

import PageGate from '../PageGate';
import ServicesTab from '../_components/ServicesTab';

export default function Page() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <ServicesTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
