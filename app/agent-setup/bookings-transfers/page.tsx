'use client';

import PageGate from '../PageGate';
import BookingTab from '../_components/BookingTab';
import TransfersTab from '../_components/TransfersTab';

export default function BookingsTransfersPage() {
  return (
    <PageGate>
      {({ config, save, isSaving }) => (
        <div className="space-y-6">
          <BookingTab config={config} save={save} isSaving={isSaving} />
          <TransfersTab config={config} save={save} isSaving={isSaving} />
        </div>
      )}
    </PageGate>
  );
}
