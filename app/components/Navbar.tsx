'use client';

import { useRouter } from 'next/navigation';
import type { GarageSummary } from '../types';
import { ALL_ASSIGNED_BRANCHES_IDENTIFIER } from '../lib/branchScope';

interface NavbarProps {
  email: string;
  userId?: string | null;
  garages: GarageSummary[];
  selectedGarageId: string;
  onSelectGarage: (garageId: string) => void;
  allowAllAssignedBranches?: boolean;
  onLogout?: () => void;
}

export default function Navbar({
  email,
  userId = null,
  garages,
  selectedGarageId,
  onSelectGarage,
  allowAllAssignedBranches = false,
  onLogout,
}: NavbarProps) {
  const router = useRouter();
  const showGarageId = Boolean(selectedGarageId) && selectedGarageId !== ALL_ASSIGNED_BRANCHES_IDENTIFIER;

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6">
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-slate-500">Branch</span>
        {garages.length > 0 || allowAllAssignedBranches ? (
          <select
            value={selectedGarageId}
            onChange={(event) => onSelectGarage(event.target.value)}
            className="mt-1 w-64 rounded-md border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            {allowAllAssignedBranches && (
              <option value={ALL_ASSIGNED_BRANCHES_IDENTIFIER}>All assigned branches</option>
            )}
            {garages.map((garage) => (
              <option key={garage.id} value={garage.id}>
                {garage.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="mt-1 w-64 rounded-md border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-500">
            {selectedGarageId || 'No branches available'}
          </div>
        )}
        {showGarageId ? (
          <span className="mt-1 text-[11px] text-slate-500">Garage ID: <span className="font-mono break-all">{selectedGarageId}</span></span>
        ) : null}
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-[0.3em] text-slate-500">Signed in</p>
          <p className="text-sm font-semibold text-slate-100">{email}</p>
          {userId ? (
            <p className="text-[11px] text-slate-500">
              User ID: <span className="font-mono break-all">{userId}</span>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="rounded-md border border-slate-700 px-3 py-1 text-sm font-medium text-slate-100 transition-colors hover:border-slate-500 hover:text-slate-50"
          onClick={() => {
            if (onLogout) {
              onLogout();
            } else {
              router.replace('/login');
            }
          }}
        >
          Log out
        </button>
      </div>
    </header>
  );
}
