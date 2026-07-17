'use client';

import PageGate from '../PageGate';
import TrainingTab from '../_components/TrainingTab';

export default function Page() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <TrainingTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
