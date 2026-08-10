'use client';

import PageGate from '../PageGate';
import VoiceTab from '../_components/VoiceTab';
import GreetingTab from '../_components/GreetingTab';
import PronunciationsTab from '../_components/PronunciationsTab';

export default function VoicePage() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <div className="space-y-6">
          <VoiceTab config={config} save={save} isSaving={isSaving} />
          <GreetingTab config={config} save={save} isSaving={isSaving} />
          <PronunciationsTab config={config} save={save} isSaving={isSaving} />
        </div>
      )}
    </PageGate>
  );
}
