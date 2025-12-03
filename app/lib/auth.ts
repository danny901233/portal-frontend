import type { BranchRolesMap, UserRole } from '../types';

export const TOKEN_STORAGE_KEY = 'rm_token';
export const GARAGE_STORAGE_KEY = 'rm_garage_id';
export const GARAGES_STORAGE_KEY = 'rm_garages';
export const USER_EMAIL_STORAGE_KEY = 'rm_user_email';
export const USER_ROLE_STORAGE_KEY = 'rm_user_role';
export const USER_BRANCH_ROLES_KEY = 'rm_user_branch_roles';

export const persistSession = (params: {
  token: string;
  garageId: string;
  garages: { id: string; name: string }[];
  email: string;
  role: UserRole;
  branchRoles: BranchRolesMap;
}) => {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(TOKEN_STORAGE_KEY, params.token);
  localStorage.setItem(GARAGE_STORAGE_KEY, params.garageId);
  localStorage.setItem(GARAGES_STORAGE_KEY, JSON.stringify(params.garages));
  localStorage.setItem(USER_EMAIL_STORAGE_KEY, params.email);
  localStorage.setItem(USER_ROLE_STORAGE_KEY, params.role);
  localStorage.setItem(USER_BRANCH_ROLES_KEY, JSON.stringify(params.branchRoles));
};

export const clearSession = () => {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(GARAGE_STORAGE_KEY);
  localStorage.removeItem(GARAGES_STORAGE_KEY);
  localStorage.removeItem(USER_EMAIL_STORAGE_KEY);
  localStorage.removeItem(USER_ROLE_STORAGE_KEY);
  localStorage.removeItem(USER_BRANCH_ROLES_KEY);
};

export const getSessionToken = () => {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem(TOKEN_STORAGE_KEY);
};

export const getGarageId = () => {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem(GARAGE_STORAGE_KEY);
};

export const setGarageId = (garageId: string) => {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(GARAGE_STORAGE_KEY, garageId);
};

export const getGarages = () => {
  if (typeof window === 'undefined') {
    return [];
  }
  const raw = localStorage.getItem(GARAGES_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { id: string; name: string }[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry) => typeof entry?.id === 'string' && typeof entry?.name === 'string');
  } catch (error) {
    return [];
  }
};

export const setGarages = (garages: { id: string; name: string }[]) => {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(GARAGES_STORAGE_KEY, JSON.stringify(garages));
};

export const getUserEmail = () => {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem(USER_EMAIL_STORAGE_KEY);
};

export const getUserRole = (): UserRole | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return (localStorage.getItem(USER_ROLE_STORAGE_KEY) as UserRole | null);
};

export const isReceptionMateStaff = () => getUserRole() === 'RECEPTIONMATE_STAFF';
export const isAdmin = () => isReceptionMateStaff();

export const getUserBranchRoles = (): BranchRolesMap => {
  if (typeof window === 'undefined') {
    return {};
  }
  const raw = localStorage.getItem(USER_BRANCH_ROLES_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as BranchRolesMap;
  } catch {
    return {};
  }
};

export const isManagerForGarage = (garageId: string | null): boolean => {
  if (!garageId) {
    return false;
  }
  const role = getUserRole();
  if (role === 'ADMIN' || role === 'RECEPTIONMATE_STAFF') {
    return true;
  }
  const branchRoles = getUserBranchRoles();
  return branchRoles[garageId] === 'MANAGER';
};
