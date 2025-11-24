'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Sidebar from './Sidebar';
import Navbar from './Navbar';
import {
  clearSession,
  getGarageId,
  getGarages,
  getSessionToken,
  getUserEmail,
  setGarageId,
  setGarages,
} from '../lib/auth';
import { fetchGarages } from '../lib/api';
import type { GarageSummary } from '../types';

const publicPaths = new Set(['/login']);

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [garageId, setGarageIdState] = useState<string | null>(null);
  const [garages, setGaragesState] = useState<GarageSummary[]>([]);

  const shouldShowChrome = useMemo(() => !publicPaths.has(pathname ?? ''), [pathname]);

  const bootstrapSession = useCallback(async () => {
    const token = getSessionToken();
    const storedGarageId = getGarageId();
    const storedGarages = getGarages();
    const email = getUserEmail();

    if (!token || !storedGarageId) {
      clearSession();
      router.replace('/login');
      return;
    }

    setUserEmail(email);
    setGarageIdState(storedGarageId);

    if (storedGarages.length > 0) {
      setGaragesState(storedGarages);
      if (!storedGarages.some((garage) => garage.id === storedGarageId)) {
        const fallbackId = storedGarages[0]?.id;
        if (fallbackId) {
          setGarageId(fallbackId);
          setGarageIdState(fallbackId);
        }
      }
      setIsReady(true);
      return;
    }

    try {
      const response = await fetchGarages();
      const list = response.garages ?? [];
      setGaragesState(list);
      setGarages(list);

      if (list.length > 0 && !list.some((garage) => garage.id === storedGarageId)) {
        const fallbackId = list[0]?.id;
        if (fallbackId) {
          setGarageId(fallbackId);
          setGarageIdState(fallbackId);
        }
      }
    } catch (error: unknown) {
      const status = typeof error === 'object' && error && 'response' in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
      if (status === 401) {
        clearSession();
        router.replace('/login');
        return;
      }
      // eslint-disable-next-line no-console
      console.error('Failed to fetch garages', error);
    } finally {
      setIsReady(true);
    }
  }, [router]);

  useEffect(() => {
    if (!shouldShowChrome) {
      setIsReady(true);
      return;
    }

    void bootstrapSession();
  }, [bootstrapSession, shouldShowChrome]);

  if (!shouldShowChrome) {
    return <>{children}</>;
  }

  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        <div className="space-y-2 text-center">
          <div className="text-xl font-semibold">Loading ReceptionMate…</div>
          <div className="text-sm text-slate-400">Preparing your dashboard</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar activePath={pathname ?? '/calls'} />
      <div className="flex flex-1 flex-col">
        <Navbar
          email={userEmail ?? 'Unknown user'}
          garages={garages}
          selectedGarageId={garageId ?? ''}
          onSelectGarage={(nextGarageId) => {
            setGarageId(nextGarageId);
            setGarageIdState(nextGarageId);
            router.refresh();
          }}
          onLogout={() => {
            clearSession();
            router.replace('/login');
          }}
        />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
