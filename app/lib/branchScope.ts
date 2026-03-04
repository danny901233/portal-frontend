'use client';

import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

export type BranchScope = 'single' | 'all';

export const ALL_ASSIGNED_BRANCHES_IDENTIFIER = '__ALL_ASSIGNED_BRANCHES__';

type BranchScopeContextValue = {
  scope: BranchScope;
  setBranchScope: Dispatch<SetStateAction<BranchScope>>;
  managedGarageIds: string[];
  allowAllAssignedOption: boolean;
  selectedGarageId: string | null;
  assignedGarageIds: string[];
};

const BranchScopeContext = createContext<BranchScopeContextValue | undefined>(undefined);

export const BranchScopeProvider = BranchScopeContext.Provider;

export const useBranchScope = (): BranchScopeContextValue => {
  const context = useContext(BranchScopeContext);
  if (!context) {
    throw new Error('useBranchScope must be used within a BranchScopeProvider');
  }
  return context;
};
