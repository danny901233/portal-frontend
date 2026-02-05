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

export type UpdateBusinessContactPayload = {
  businessId: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactRole?: string;
};

export const updateBusinessContact = async (payload: UpdateBusinessContactPayload) => {
  const { businessId, ...contactData } = payload;
  const { data } = await api.patch<{ business: AdminBusiness }>(
    `/api/admin/businesses/${businessId}/contact`,
    contactData,
  );
  return data;
};

export const deleteAdminBusiness = async (businessId: string) => {
  await api.delete(`/api/admin/businesses/${businessId}`);
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

export const activateGarage = async (payload: { garageId: string; twilioNumber: string }) => {
  const { data } = await api.post<{ status: string; message?: string }>(
    `/api/admin/garages/${payload.garageId}/activate`,
    { twilioNumber: payload.twilioNumber },
  );
  return data;
};

export const updateGarageTwilioNumber = async (payload: { garageId: string; twilioNumber: string }) => {
  const { data } = await api.put<{ twilioNumber: string }>(
    `/api/admin/garages/${payload.garageId}/twilio-number`,
    { twilioNumber: payload.twilioNumber },
  );
  return data;
};

export const updateGarageMessagingAccess = async (payload: { garageId: string; hasMessagingAccess: boolean }) => {
  const { data } = await api.patch<{ hasMessagingAccess: boolean }>(
    `/api/garages/${payload.garageId}/messaging-access`,
    { hasMessagingAccess: payload.hasMessagingAccess },
  );
  return data;
};