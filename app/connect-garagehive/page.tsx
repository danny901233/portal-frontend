'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const API = (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');

function ConnectInner() {
  const token = useSearchParams().get('token') ?? '';
  const [phase, setPhase] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [businessName, setBusinessName] = useState('this garage');
  const [instance, setInstance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ connectedCount: number; flaggedCount: number } | null>(null);

  useEffect(() => {
    if (!token) { setPhase('invalid'); return; }
    fetch(`${API}/api/garagehive-connect/validate?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) { setBusinessName(d.businessName || 'this garage'); setPhase('ready'); }
        else setPhase('invalid');
      })
      .catch(() => setPhase('invalid'));
  }, [token]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API}/api/garagehive-connect/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, instance: instance.trim() }),
      });
      const d = await r.json();
      if (!r.ok || !d?.ok) { setError(d?.error || 'Could not connect. Please check the instance and try again.'); return; }
      setResult({ connectedCount: d.connectedCount, flaggedCount: d.flaggedCount });
      setPhase('done');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(160deg,#3426cf,#251aa6)', padding: 20, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ background: '#fff', borderRadius: 20, padding: '38px 32px', maxWidth: 440, width: '100%', boxShadow: '0 30px 70px rgba(15,23,42,.35)' }}>
        <div style={{ display: 'inline-flex', background: '#3426cf', borderRadius: 16, padding: '14px 18px', marginBottom: 20 }}>
          <span style={{ color: '#fff', fontWeight: 800, fontSize: 18 }}>ReceptionMate</span>
        </div>

        {phase === 'loading' && <p style={{ color: '#5b6b82' }}>Checking your link…</p>}

        {phase === 'invalid' && (
          <>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', margin: '0 0 6px' }}>Link expired or invalid</h1>
            <p style={{ color: '#5b6b82', fontSize: 14 }}>This connect link isn&apos;t valid any more. Please ask ReceptionMate to resend it.</p>
          </>
        )}

        {phase === 'ready' && (
          <>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', margin: '0 0 6px' }}>Connect GarageHive diary</h1>
            <p style={{ color: '#5b6b82', fontSize: 14, margin: '0 0 20px', lineHeight: 1.5 }}>
              For <strong>{businessName}</strong>. Enter the GarageHive <strong>instance</strong> and we&apos;ll connect
              the diary automatically — matching every branch for you.
            </p>
            {error && <div style={{ background: '#fef2f2', color: '#b91c1c', borderRadius: 10, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>{error}</div>}
            <label style={{ fontSize: 13, fontWeight: 600, color: '#334155', display: 'block', marginBottom: 6 }}>GarageHive instance</label>
            <input
              autoFocus
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && instance.trim()) submit(); }}
              placeholder="e.g. inoplus"
              style={{ width: '100%', padding: '12px 14px', border: '1px solid #e2e8f0', borderRadius: 11, fontSize: 15, boxSizing: 'border-box', marginBottom: 14 }}
            />
            <button
              onClick={submit}
              disabled={busy || !instance.trim()}
              style={{ width: '100%', padding: 13, border: 'none', borderRadius: 11, background: busy || !instance.trim() ? '#a5b4fc' : '#3426cf', color: '#fff', fontWeight: 700, fontSize: 15, cursor: busy || !instance.trim() ? 'default' : 'pointer' }}
            >
              {busy ? 'Connecting…' : 'Connect diary'}
            </button>
          </>
        )}

        {phase === 'done' && result && (
          <>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', margin: '0 0 10px' }}>
              {result.connectedCount > 0 ? '✓ Diary connected' : 'Received'}
            </h1>
            <p style={{ color: '#5b6b82', fontSize: 14, lineHeight: 1.5 }}>
              {result.connectedCount > 0
                ? `We connected ${result.connectedCount} branch${result.connectedCount === 1 ? '' : 'es'} to ReceptionMate.`
                : 'Thanks — we&apos;ve received the instance.'}
              {result.flaggedCount > 0
                ? ` ${result.flaggedCount} branch${result.flaggedCount === 1 ? '' : 'es'} need${result.flaggedCount === 1 ? 's' : ''} a quick check by our team; we&apos;re on it.`
                : ' Nothing more is needed — thank you.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function ConnectGarageHivePage() {
  return (
    <Suspense fallback={null}>
      <ConnectInner />
    </Suspense>
  );
}
