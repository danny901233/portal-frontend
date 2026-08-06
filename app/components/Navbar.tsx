'use client';

import { useRouter } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import { ChevronDown, LogOut, Menu, User } from 'lucide-react';
import type { GarageSummary } from '../types';
import { ALL_ASSIGNED_BRANCHES_IDENTIFIER } from '../lib/branchScope';
import { cn } from '../lib/utils';

interface NavbarProps {
  email: string;
  userId?: string | null;
  garages: GarageSummary[];
  selectedGarageId: string;
  onSelectGarage: (garageId: string) => void;
  allowAllAssignedBranches?: boolean;
  onLogout?: () => void;
  onMenuClick?: () => void;
}

export default function Navbar({
  email,
  userId = null,
  garages,
  selectedGarageId,
  onSelectGarage,
  allowAllAssignedBranches = false,
  onLogout,
  onMenuClick,
}: NavbarProps) {
  const router = useRouter();
  const showGarageId = Boolean(selectedGarageId) && selectedGarageId !== ALL_ASSIGNED_BRANCHES_IDENTIFIER;
  const [searchQuery, setSearchQuery] = useState('');
  const [isBranchOpen, setIsBranchOpen] = useState(false);
  const [isUserOpen, setIsUserOpen] = useState(false);
  const branchRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  const selectedGarage = garages.find((g) => g.id === selectedGarageId);
  const displayName =
    selectedGarageId === ALL_ASSIGNED_BRANCHES_IDENTIFIER
      ? 'All assigned branches'
      : selectedGarage?.name || 'Select a branch';

  const filteredGarages = garages.filter(
    (garage) =>
      garage.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      garage.id.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(event.target as Node)) {
        setIsBranchOpen(false);
        setSearchQuery('');
      }
      if (userRef.current && !userRef.current.contains(event.target as Node)) {
        setIsUserOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (garageId: string) => {
    onSelectGarage(garageId);
    setIsBranchOpen(false);
    setSearchQuery('');
  };

  const handleLogout = () => {
    setIsUserOpen(false);
    if (onLogout) onLogout();
    else router.replace('/login');
  };

  // Just initial(s) for the user avatar button
  const initial = email?.[0]?.toUpperCase() || '?';

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-950/80 px-3 md:gap-4 md:px-6">
      {/* Hamburger (mobile only) */}
      <button
        type="button"
        onClick={onMenuClick}
        className="shrink-0 rounded-lg border border-slate-800 bg-slate-900/80 p-2 text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100 md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Branch selector */}
      <div ref={branchRef} className="relative min-w-0 flex-1 md:max-w-sm">
        <span className="hidden text-xs uppercase tracking-wide text-slate-500 md:block">Branch</span>
        {garages.length > 0 || allowAllAssignedBranches ? (
          <>
            <button
              type="button"
              onClick={() => setIsBranchOpen((v) => !v)}
              className="mt-0 flex w-full items-center justify-between gap-2 rounded-md border border-slate-700 bg-slate-900/80 px-3 py-2 text-left text-sm text-slate-100 focus:border-sky-500 focus:outline-none md:mt-1"
            >
              <span className="truncate">{displayName}</span>
              <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', isBranchOpen && 'rotate-180')} />
            </button>

            {isBranchOpen && (
              <div className="absolute left-0 right-0 z-50 mt-1 rounded-md border border-slate-700 bg-slate-900 shadow-lg md:w-full">
                <div className="p-2">
                  <input
                    type="text"
                    placeholder="Search branches..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                    autoFocus
                  />
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {allowAllAssignedBranches && (
                    <button
                      type="button"
                      onClick={() => handleSelect(ALL_ASSIGNED_BRANCHES_IDENTIFIER)}
                      className={cn(
                        'w-full px-3 py-2 text-left text-sm hover:bg-slate-800',
                        selectedGarageId === ALL_ASSIGNED_BRANCHES_IDENTIFIER
                          ? 'bg-slate-800 text-sky-400'
                          : 'text-slate-100',
                      )}
                    >
                      All assigned branches
                    </button>
                  )}
                  {filteredGarages.length > 0 ? (
                    filteredGarages.map((garage) => (
                      <button
                        key={garage.id}
                        type="button"
                        onClick={() => handleSelect(garage.id)}
                        className={cn(
                          'w-full px-3 py-2 text-left text-sm hover:bg-slate-800',
                          garage.id === selectedGarageId ? 'bg-slate-800 text-sky-400' : 'text-slate-100',
                        )}
                      >
                        {garage.name}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-sm text-slate-500">No branches found</div>
                  )}
                </div>
                {showGarageId && (
                  <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-500">
                    Garage ID: <span className="font-mono break-all">{selectedGarageId}</span>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="mt-0 rounded-md border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-500 md:mt-1">
            {selectedGarageId || 'No branches available'}
          </div>
        )}
        {showGarageId && (
          <span className="mt-1 hidden truncate text-[11px] text-slate-500 md:block">
            Garage ID: <span className="font-mono">{selectedGarageId}</span>
          </span>
        )}
      </div>

      {/* User section */}
      <div ref={userRef} className="relative shrink-0">
        {/* Desktop view: full text + log out */}
        <div className="hidden items-center gap-4 md:flex">
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-[0.3em] text-slate-500">Signed in</p>
            <p className="text-sm font-semibold text-slate-100">{email}</p>
            {userId && (
              <p className="text-[11px] text-slate-500">
                User ID: <span className="font-mono break-all">{userId}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-md border border-slate-700 px-3 py-1 text-sm font-medium text-slate-100 transition-colors hover:border-slate-500 hover:text-slate-50"
          >
            Log out
          </button>
        </div>

        {/* Mobile view: avatar button with dropdown */}
        <button
          type="button"
          onClick={() => setIsUserOpen((v) => !v)}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-sm font-semibold text-slate-100 transition-colors hover:border-slate-500 md:hidden"
          aria-label="Account menu"
        >
          {initial}
        </button>

        {isUserOpen && (
          <div className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl md:hidden">
            <div className="flex items-center gap-3 border-b border-slate-800 pb-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-slate-100">
                <User className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Signed in</p>
                <p className="truncate text-sm font-semibold text-slate-100">{email}</p>
              </div>
            </div>
            {userId && (
              <p className="mt-2 break-all text-[11px] text-slate-500">
                User ID: <span className="font-mono">{userId}</span>
              </p>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:border-slate-500 hover:bg-slate-800"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}