'use client';

// Which garages this person's phone buzzes for.
//
// Push used to go to everyone with access to the garage, and staff are granted access to every
// garage the moment it is onboarded — so a staff phone ended up ringing for twenty-odd customers.
// The choice lives here rather than in the access list because access keeps re-broadening itself.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchPushSettings, savePushSettings, type PushSettings } from '../lib/api';

export default function NotificationsPage() {
  const [settings, setSettings] = useState<PushSettings | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPushSettings()
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        // An empty stored list means "all of them" — show every garage ticked, not none.
        setSelected(
          new Set(data.pushGarageIds.length ? data.pushGarageIds : data.garages.map((g) => g.id)),
        );
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your notification settings.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const garages = settings?.garages ?? [];
  const allOn = garages.length > 0 && selected.size === garages.length;

  const persist = useCallback(async (update: { enabled?: boolean; garageIds?: string[] }) => {
    setSaving(true);
    setError(null);
    try {
      const result = await savePushSettings(update);
      setSettings((prev) => (prev ? { ...prev, ...result } : prev));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError('That did not save. Try again.');
    } finally {
      setSaving(false);
    }
  }, []);

  const toggleGarage = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    void persist({ garageIds: [...next] });
  };

  const setAll = (on: boolean) => {
    const next = new Set(on ? garages.map((g) => g.id) : []);
    setSelected(next);
    void persist({ garageIds: [...next] });
  };

  const summary = useMemo(() => {
    if (!settings) return '';
    if (!settings.pushEnabled) return 'Push notifications are off for your account.';
    if (selected.size === 0) return 'No garages selected — your phone will stay quiet.';
    if (allOn) return `All ${garages.length} garages, including any added later.`;
    return `${selected.size} of ${garages.length} garages.`;
  }, [settings, selected, allOn, garages.length]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Notifications</h1>
        <p className="mt-1 text-sm text-slate-600">
          Choose which garages send a push notification to the ReceptionMate app on your phone.
          This only affects your own devices — it does not change anyone else&apos;s alerts, or the
          notification emails a garage receives.
        </p>
      </header>

      {loading ? (
        <p className="mt-8 text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-slate-900">Push notifications</p>
                <p className="mt-0.5 text-sm text-slate-600">{summary}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings?.pushEnabled ?? false}
                onClick={() => {
                  const next = !(settings?.pushEnabled ?? false);
                  setSettings((prev) => (prev ? { ...prev, pushEnabled: next } : prev));
                  void persist({ enabled: next });
                }}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  settings?.pushEnabled ? 'bg-brand-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    settings?.pushEnabled ? 'left-[22px]' : 'left-0.5'
                  }`}
                />
              </button>
            </div>
            {settings && settings.deviceCount === 0 ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                No device is registered yet. Sign in to the ReceptionMate app on your phone and
                allow notifications — settings here take effect as soon as it is.
              </p>
            ) : null}
          </section>

          <section className="mt-6 rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">Garages</h2>
              <div className="flex items-center gap-3 text-xs">
                {saving ? <span className="text-slate-400">Saving…</span> : null}
                {saved && !saving ? <span className="text-emerald-600">Saved</span> : null}
                <button
                  type="button"
                  onClick={() => setAll(!allOn)}
                  className="font-medium text-brand-600 hover:text-brand-700"
                >
                  {allOn ? 'Clear all' : 'Select all'}
                </button>
              </div>
            </div>

            {garages.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">You have no garages yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {garages.map((garage) => {
                  const on = selected.has(garage.id);
                  return (
                    <li key={garage.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleGarage(garage.id)}
                          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        />
                        <span className={`text-sm ${on ? 'text-slate-900' : 'text-slate-500'}`}>
                          {garage.name}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}
        </>
      )}
    </div>
  );
}
