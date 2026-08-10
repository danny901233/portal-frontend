'use client';

import PageGate from '../PageGate';
import HoursTab from '../_components/HoursTab';

export default function Page() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <HoursTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
