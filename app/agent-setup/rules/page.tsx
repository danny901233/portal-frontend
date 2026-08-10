'use client';

import PageGate from '../PageGate';
import RulesTab from '../_components/RulesTab';

export default function Page() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <RulesTab config={config} save={save} isSaving={isSaving} />
      )}
    </PageGate>
  );
}
