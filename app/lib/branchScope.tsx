'use client';

import { createContext, type Dispatch, type SetStateAction, useContext } from 'react';

export type BranchScope = 'single' | 'all';
export const ALL_ASSIGNED_BRANCHES_IDENTIFIER = '__rm_all_assigned__';

export interface BranchScopeContextValue {
  scope: BranchScope;
  setBranchScope: Dispatch<SetStateAction<BranchScope>>;
  managedGarageIds: string[];
  allowAllAssignedOption: boolean;
  selectedGarageId: string | null;
  assignedGarageIds: string[];
}

const BranchScopeContext = createContext<BranchScopeContextValue | undefined>(undefined);

export const BranchScopeProvider = BranchScopeContext.Provider;

export const useBranchScope = () => {
  const context = useContext(BranchScopeContext);
  if (!context) {
    throw new Error('useBranchScope must be used within a BranchScopeProvider');
  }
  return context;
};
