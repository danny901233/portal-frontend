'use client';

import { useRouter } from 'next/navigation';
import type { GarageSummary } from '../types';

interface NavbarProps {
  email: string;
  garages: GarageSummary[];
  selectedGarageId: string;
  onSelectGarage: (garageId: string) => void;
  onLogout?: () => void;
}

export default function Navbar({
  email,
  garages,
  selectedGarageId,
  onSelectGarage,
  onLogout,
}: NavbarProps) {
  const router = useRouter();

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6">
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-slate-500">Branch</span>
        {garages.length > 0 ? (
          <select
            value={selectedGarageId}
            onChange={(event) => onSelectGarage(event.target.value)}
            className="mt-1 w-64 rounded-md border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
          >
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
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-slate-400">{email}</span>
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
