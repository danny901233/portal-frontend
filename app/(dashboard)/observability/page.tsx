'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff } from '../../lib/auth';
import { ObservabilityDashboard } from './ObservabilityDashboard';

export default function ObservabilityPage() {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);

  useEffect(() => {
    // Check if user is ReceptionMate staff
    if (!isReceptionMateStaff()) {
      router.replace('/dashboard');
    } else {
      setIsAuthorized(true);
    }
  }, [router]);

  if (!isAuthorized) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-100">
          Observability Dashboard
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Performance metrics, tool usage, and error analysis across all branches
        </p>
        <div className="mt-2 inline-flex items-center rounded-md bg-red-900/20 px-2 py-1 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-600/20">
          🔒 ReceptionMate Staff Only
        </div>
      </div>

      <ObservabilityDashboard />
    </div>
  );
}
