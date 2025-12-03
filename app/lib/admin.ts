import api from './api';
import type { AdminBusiness, AdminGarage, AdminUser, UserRole } from '../types';

export const fetchAdminBusinesses = async (): Promise<{ businesses: AdminBusiness[] }> => {
  const { data } = await api.get<{ businesses: AdminBusiness[] }>('/api/admin/businesses');
  return data;
};

export const createAdminBusiness = async (payload: { name: string }) => {
  const { data } = await api.post<{ business: AdminBusiness }>('/api/admin/businesses', payload);
  return data;
};

export const createAdminBranch = async (payload: { businessId: string; name: string }) => {
  const { data } = await api.post<{ branch: AdminGarage }>(
    `/api/admin/businesses/${payload.businessId}/branches`,
    { name: payload.name },
  );
  return data;
};

export const deleteAdminBranch = async (branchId: string) => {
  await api.delete(`/api/admin/branches/${branchId}`);
};

export const fetchAdminUsers = async (): Promise<{ users: AdminUser[] }> => {
  const { data } = await api.get<{ users: AdminUser[] }>('/api/admin/users');
  return data;
};

export type CreateAdminUserPayload = {
  email: string;
  password: string;
  role: UserRole;
  garageAccessIds: string[];
};

export const createAdminUser = async (payload: CreateAdminUserPayload) => {
  const { data } = await api.post<{ user: AdminUser }>('/api/admin/users', payload);
  return data;
};

export type UpdateAdminUserPayload = {
  userId: string;
  password?: string;
  role?: UserRole;
  garageAccessIds?: string[];
};

export const updateAdminUser = async (payload: UpdateAdminUserPayload) => {
  const { data } = await api.put<{ user: AdminUser }>(
    `/api/admin/users/${payload.userId}`,
    payload,
  );
  return data;
};

export const deleteAdminUser = async (userId: string) => {
  await api.delete(`/api/admin/users/${userId}`);
};