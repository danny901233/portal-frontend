export type BranchRole = 'MANAGER' | 'USER';
export type UserRole = 'ADMIN' | 'USER' | 'RECEPTIONMATE_STAFF';

const isBranchRoleValue = (value: unknown): value is BranchRole => value === 'MANAGER' || value === 'USER';

export const sanitizeBranchRoles = (value: unknown): Record<string, BranchRole> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, BranchRole> = {};
  Object.entries(value).forEach(([key, rawValue]) => {
    if (isBranchRoleValue(rawValue)) {
      normalized[key] = rawValue;
    }
  });

  return normalized;
};

export const isManagerForGarage = (
  payload: { role?: UserRole; branchRoles?: Record<string, BranchRole> } | undefined,
  garageId: string,
) => {
  if (!payload) {
    return false;
  }

  if (payload.role === 'ADMIN') {
    return true;
  }

  const branchRoles = payload.branchRoles;
  if (!branchRoles) {
    return false;
  }

  return branchRoles[garageId] === 'MANAGER';
};
