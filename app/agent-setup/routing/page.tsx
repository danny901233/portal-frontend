'use client';

import PageGate from '../PageGate';
import AdminTab from '../_components/AdminTab';

export default function Page() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <AdminTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
