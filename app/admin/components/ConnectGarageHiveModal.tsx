'use client';

import { useState } from 'react';
import api from '../../lib/api';

type GhLocation = { id: number; name: string; address: string };
type Branch = {
  garageId: string;
  garageName: string;
  matchedLocationId: number | null;
  confidence: 'auto' | 'high' | 'low' | 'none';
  score: number;
  runnerUpScore: number;
  currentLocationId: string | null;
};
type PreviewResp = {
  instance: string;
  locations: GhLocation[];
  branches: Branch[];
  garageCount: number;
  agreementCentresCount: number | null;
};
type ConnectResp = {
  instance: string;
  connected: number;
  results: Array<{ garageId: string; ok: boolean; locationId?: string; error?: string }>;
};

const confidenceBadge = (c: Branch['confidence']) => {
  switch (c) {
    case 'auto': return { label: 'auto', cls: 'bg-emerald-100 text-emerald-700' };
    case 'high': return { label: 'matched', cls: 'bg-emerald-100 text-emerald-700' };
    case 'low': return { label: 'check this', cls: 'bg-amber-100 text-amber-800' };
    default: return { label: 'no match', cls: 'bg-red-100 text-red-700' };
  }
};

export default function ConnectGarageHiveModal({
  agreementId,
  clientName,
  onClose,
}: {
  agreementId: string;
  clientName: string;
  onClose: () => void;
}) {
  const [instance, setInstance] = useState('');
  const [phase, setPhase] = useState<'input' | 'preview' | 'done'>('input');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  // garageId -> chosen locationId (string)
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ConnectResp | null>(null);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/admin/garagehive/preview', { agreementId, instance: instance.trim() });
      const data = res.data as PreviewResp;
      setPreview(data);
      const initial: Record<string, string> = {};
      for (const b of data.branches) {
        initial[b.garageId] = b.matchedLocationId != null ? String(b.matchedLocationId) : (b.currentLocationId ?? '');
      }
      setChoice(initial);
      setPhase('preview');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Could not fetch branches. Check the instance name.');
    } finally {
      setBusy(false);
    }
  };

  const runConnect = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const mappings = preview.branches
        .map((b) => ({ garageId: b.garageId, locationId: choice[b.garageId] }))
        .filter((m) => m.locationId);
      const res = await api.post('/admin/garagehive/connect', { instance: preview.instance, mappings });
      setResult(res.data as ConnectResp);
      setPhase('done');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Connect failed.');
    } finally {
      setBusy(false);
    }
  };

  const countMismatch =
    preview && preview.agreementCentresCount != null && preview.agreementCentresCount !== preview.garageCount;
  const allChosen = preview ? preview.branches.every((b) => choice[b.garageId]) : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Connect GarageHive</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <p className="mb-4 text-sm text-slate-500">
          {clientName} — enter the GarageHive <strong>instance</strong> they sent you. We fetch the
          location(s) and match each branch automatically.
        </p>

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {phase === 'input' && (
          <div className="flex items-end gap-3">
            <label className="flex-1 text-sm">
              <span className="mb-1 block font-medium text-slate-700">GarageHive instance</span>
              <input
                autoFocus
                value={instance}
                onChange={(e) => setInstance(e.target.value)}
                placeholder="e.g. inoplus"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                onKeyDown={(e) => { if (e.key === 'Enter' && instance.trim()) runPreview(); }}
              />
            </label>
            <button
              onClick={runPreview}
              disabled={busy || !instance.trim()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Fetching…' : 'Fetch branches'}
            </button>
          </div>
        )}

        {phase === 'preview' && preview && (
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                instance <strong>{preview.instance}</strong>
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                {preview.locations.length} location{preview.locations.length === 1 ? '' : 's'}
              </span>
              <span className={`rounded-full px-2 py-0.5 ${countMismatch ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
                {preview.garageCount} branch{preview.garageCount === 1 ? '' : 'es'}
                {preview.agreementCentresCount != null ? ` · agreement says ${preview.agreementCentresCount}` : ''}
              </span>
            </div>

            <div className="max-h-80 space-y-2 overflow-y-auto">
              {preview.branches.map((b) => {
                const badge = confidenceBadge(b.confidence);
                return (
                  <div key={b.garageId} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-900">{b.garageName}</div>
                      <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </div>
                    <select
                      value={choice[b.garageId] ?? ''}
                      onChange={(e) => setChoice((c) => ({ ...c, [b.garageId]: e.target.value }))}
                      className="max-w-[16rem] rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                    >
                      <option value="">— pick location —</option>
                      {preview.locations.map((l) => (
                        <option key={l.id} value={String(l.id)}>
                          {l.name || `Location ${l.id}`} ({l.id})
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-between">
              <button onClick={() => setPhase('input')} className="text-sm text-slate-500 hover:text-slate-700">
                ← change instance
              </button>
              <button
                onClick={runConnect}
                disabled={busy || !allChosen}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Connecting…' : `Connect ${preview.branches.length} branch${preview.branches.length === 1 ? '' : 'es'} to Automate`}
              </button>
            </div>
            {!allChosen && (
              <p className="mt-2 text-right text-xs text-amber-700">Pick a location for every branch first.</p>
            )}
          </div>
        )}

        {phase === 'done' && result && (
          <div>
            <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Connected {result.connected} of {result.results.length} branch(es) to Automate — the
              agent config has been pushed.
            </div>
            <div className="space-y-1 text-sm">
              {result.results.map((r) => (
                <div key={r.garageId} className="flex items-center justify-between rounded border border-slate-100 px-2 py-1">
                  <span className="font-mono text-xs text-slate-500">{r.garageId.slice(0, 10)}</span>
                  {r.ok ? (
                    <span className="text-emerald-700">✓ location {r.locationId}</span>
                  ) : (
                    <span className="text-red-700">✗ {r.error}</span>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-4 text-right">
              <button onClick={onClose} className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
