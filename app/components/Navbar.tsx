'use client';

import { useRouter } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import type { GarageSummary } from '../types';
import { ALL_ASSIGNED_BRANCHES_IDENTIFIER } from '../lib/branchScope';

interface NavbarProps {
  email: string;
  userId?: string | null;
  garages: GarageSummary[];
  selectedGarageId: string;
  onSelectGarage: (garageId: string) => void;
  allowAllAssignedBranches?: boolean;
  isStaff?: boolean;
  onLogout?: () => void;
}

export default function Navbar({
  email,
  userId = null,
  garages,
  selectedGarageId,
  onSelectGarage,
  allowAllAssignedBranches = false,
  isStaff = false,
  onLogout,
}: NavbarProps) {
  const router = useRouter();
  const showGarageId = Boolean(selectedGarageId) && selectedGarageId !== ALL_ASSIGNED_BRANCHES_IDENTIFIER;
  const [searchQuery, setSearchQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Staff aggregate across every garage; managers across only their assigned branches.
  const allBranchesLabel = isStaff ? 'All branches' : 'All assigned branches';

  // Get the selected garage name
  const selectedGarage = garages.find((g) => g.id === selectedGarageId);
  const displayName = selectedGarageId === ALL_ASSIGNED_BRANCHES_IDENTIFIER
    ? allBranchesLabel
    : selectedGarage?.name || 'Select a branch';

  // Filter garages based on search query (searches both name and ID)
  const filteredGarages = garages.filter((garage) =>
    garage.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    garage.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (garageId: string) => {
    onSelectGarage(garageId);
    setIsOpen(false);
    setSearchQuery('');
  };

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="flex flex-col">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Branch</span>
        {garages.length > 0 || allowAllAssignedBranches ? (
          <div ref={dropdownRef} className="relative mt-1 w-64">
            <button
              type="button"
              onClick={() => setIsOpen(!isOpen)}
              className="flex w-full items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 transition-colors hover:border-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
            >
              <span className="truncate">{displayName}</span>
              <svg
                className={`h-4 w-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isOpen && (
              <div className="absolute z-50 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg ring-1 ring-slate-900/5">
                <div className="p-2">
                  <input
                    type="text"
                    placeholder="Search branches by name or ID..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
                    autoFocus
                  />
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {allowAllAssignedBranches && (
                    <button
                      type="button"
                      onClick={() => handleSelect(ALL_ASSIGNED_BRANCHES_IDENTIFIER)}
                      className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 ${
                        selectedGarageId === ALL_ASSIGNED_BRANCHES_IDENTIFIER
                          ? 'bg-brand-50 font-semibold text-brand-700'
                          : 'text-slate-700'
                      }`}
                    >
                      {allBranchesLabel}
                    </button>
                  )}
                  {filteredGarages.length > 0 ? (
                    filteredGarages.map((garage) => (
                      <button
                        key={garage.id}
                        type="button"
                        onClick={() => handleSelect(garage.id)}
                        className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 ${
                          garage.id === selectedGarageId
                            ? 'bg-brand-50 font-semibold text-brand-700'
                            : 'text-slate-700'
                        }`}
                      >
                        {garage.name}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-sm text-slate-500">
                      No branches found
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-1 w-64 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
            {selectedGarageId || 'No branches available'}
          </div>
        )}
        {showGarageId ? (
          <span className="mt-1 text-[11px] text-slate-500">Garage ID: <span className="font-mono break-all">{selectedGarageId}</span></span>
        ) : null}
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-slate-500">Signed in</p>
          <p className="text-sm font-semibold text-slate-900">{email}</p>
          {userId ? (
            <p className="text-[11px] text-slate-500">
              User ID: <span className="font-mono break-all">{userId}</span>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 hover:text-slate-900"
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
