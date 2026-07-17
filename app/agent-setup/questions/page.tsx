'use client';

import PageGate from '../PageGate';
import CaptureTab from '../_components/CaptureTab';
import FaqsTab from '../_components/FaqsTab';

export default function QuestionsPage() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <div className="space-y-6">
          <CaptureTab config={config} save={save} isSaving={isSaving} />
          <FaqsTab config={config} save={save} isSaving={isSaving} />
        </div>
      )}
    </PageGate>
  );
}
