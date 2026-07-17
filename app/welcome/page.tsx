'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { persistSession } from '../lib/auth';

// Auto-login landing for self-serve Connect signups. The marketing signup mints a
// session token and passes the full session bundle in the URL fragment (#s=...), which
// stays client-side (never sent to the server / access logs). We persist it exactly like
// a normal login, then drop the user into Integrations to connect their WhatsApp number —
// no password re-entry.
export default function WelcomePage() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    try {
      const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('s');
      if (!raw) {
        router.replace('/login');
        return;
      }
      const s = JSON.parse(raw);
      if (!s?.token || !s?.garageId) {
        router.replace('/login');
        return;
      }
      persistSession({
        token: s.token,
        garageId: s.garageId,
        garages: s.garages || [{ id: s.garageId, name: s.email || 'Your garage' }],
        userId: s.userId,
        email: s.email,
        role: s.role,
        branchRoles: s.branchRoles || { [s.garageId]: 'MANAGER' },
      });
      // Clear the token from the URL, then head to WhatsApp connect.
      window.history.replaceState({}, '', '/welcome');
      router.replace('/integrations');
    } catch {
      setFailed(true);
    }
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="text-center">
        {failed ? (
          <>
            <p className="text-slate-900 font-semibold">Couldn’t sign you in automatically.</p>
            <a href="/login" className="mt-3 inline-block text-brand-600 hover:underline">Go to login</a>
          </>
        ) : (
          <p className="text-slate-600">Signing you in…</p>
        )}
      </div>
    </div>
  );
}
