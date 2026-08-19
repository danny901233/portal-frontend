'use client';

// How this customer pays, and a way to change it themselves.
//
// Before this, a garage whose card expired had to email us and wait — they could see their
// invoices and their Direct Debit status, but could not update anything. Card customers now
// replace their card here; Direct Debit customers keep the mandate card they already had, since
// changing a mandate is a GoCardless redirect rather than a form.

import { useEffect, useState, type ReactNode } from 'react';
import CardSetupForm from './CardSetupForm';

interface Method {
  method: 'card' | 'direct_debit';
  garageName?: string;
  alreadySetUp?: boolean;
}

export default function PaymentMethodCard({ mandateCard }: { mandateCard: ReactNode }) {
  const [info, setInfo] = useState<Method | null>(null);
  const [changing, setChanging] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/internal-api/payment/method', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        setInfo(await res.json());
      } catch {
        /* leave it hidden rather than showing a broken panel */
      }
    })();
  }, []);

  // Not a card customer — show exactly what was there before.
  if (!info || info.method !== 'card') return <>{mandateCard}</>;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-slate-900">Payment method</h2>
      <p className="mt-1 text-sm text-slate-600">
        {info.alreadySetUp
          ? 'Your subscription is paid by card. You can replace the card we hold at any time — the new one takes over from your next payment.'
          : 'You have no card on file yet. Add one so your service carries on when your trial ends.'}
      </p>

      {saved ? (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Card saved. Your next payment will use it — nothing has been charged today.
        </p>
      ) : changing ? (
        <div className="mt-4 max-w-md">
          <CardSetupForm onDone={() => { setSaved(true); setChanging(false); }} />
          <button
            type="button"
            onClick={() => setChanging(false)}
            className="mt-3 text-sm text-slate-500 underline"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setChanging(true)}
          className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {info.alreadySetUp ? 'Update my card' : 'Add a card'}
        </button>
      )}
    </div>
  );
}
