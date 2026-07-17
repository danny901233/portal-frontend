'use client';

import PageGate from '../PageGate';
import NotificationsTab from '../_components/NotificationsTab';

export default function Page() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <NotificationsTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
