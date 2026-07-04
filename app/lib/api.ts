import axios from "axios";
import type { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import type {
  AgentConfiguration,
  AgentConfigurationResponse,
  AgentKnowledgeDocument,
  CallFeedbackResponse,
  CallResponse,
  CallsResponse,
  GaragesResponse,
  LoginResponse,
  WebsiteIngestResponse,
  WebsiteScanResponse,
} from "../types";
import { API_PROXY_PREFIX } from "./constants";
import { TOKEN_STORAGE_KEY, clearSession, getGarageId } from "./auth";

const backendOrigin = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");

const api = axios.create({
  baseURL: backendOrigin,
  withCredentials: false,
});

api.interceptors.request.use((config) => {
  // Always use the backend origin directly, prepend /api to all relative paths
  const url = config.url ?? "";
  if (!url.startsWith("/api") && !/^https?:\/\//i.test(url)) {
    if (url.startsWith("/")) {
      config.url = `/api${url}`;
    } else {
      config.url = `/api/${url}`;
    }
  }
  return config;
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError) => {
    if (typeof window !== "undefined" && error.response?.status === 401) {
      clearSession();
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

export type CallFilters = {
  callType?: string;
  startDate?: string;
  endDate?: string;
  garageIds?: string[];
};

export const downloadConfirmedBookingsCsv = async (
  garageId?: string,
  filters?: CallFilters
): Promise<Blob> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }
  const params = new URLSearchParams();
  if (filters?.startDate) {
    params.set("startDate", filters.startDate);
  }
  if (filters?.endDate) {
    params.set("endDate", filters.endDate);
  }
  if (filters?.garageIds && filters.garageIds.length > 0) {
    filters.garageIds.forEach((id) => params.append("garageIds", id));
  }
  const querySuffix = params.toString();
  const { data } = await api.get<Blob>(
    `/api/garages/${targetGarageId}/confirmed-bookings.csv${querySuffix ? `?${querySuffix}` : ""}`,
    { responseType: "blob" }
  );
  return data;
};

export const fetchCalls = async (
  garageId?: string,
  filters?: CallFilters & { page?: number; pageSize?: number }
): Promise<CallsResponse> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }
  const params = new URLSearchParams();
  if (filters?.callType && filters.callType !== "all") {
    params.set("callType", filters.callType);
  }
  if (filters?.startDate) {
    params.set("startDate", filters.startDate);
  }
  if (filters?.endDate) {
    params.set("endDate", filters.endDate);
  }
  if (filters?.garageIds && filters.garageIds.length > 0) {
    filters.garageIds.forEach(id => params.append("garageIds", id));
  }
  if (filters?.page) {
    params.set("page", filters.page.toString());
  }
  if (filters?.pageSize) {
    params.set("pageSize", filters.pageSize.toString());
  }

  const querySuffix = params.toString();

  const { data } = await api.get<CallsResponse>(
    `/api/garages/${targetGarageId}/calls${querySuffix ? `?${querySuffix}` : ""}`
  );
  return data;
};

export const fetchCallById = async (
  callId: string,
  garageId?: string
): Promise<CallResponse> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again.");
  }
  const { data } = await api.get<CallResponse>(
    `/api/garages/${targetGarageId}/calls/${callId}`
  );
  return data;
};

export const fetchGarages = async (): Promise<GaragesResponse> => {
  const { data } = await api.get<GaragesResponse>(`/api/garages`);
  return data;
};

export const fetchAgentConfiguration = async (
  garageId?: string
): Promise<AgentConfigurationResponse> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }
  const { data } = await api.get<AgentConfigurationResponse>(
    `/api/garages/${targetGarageId}/agent-config`
  );
  console.log('FRONTEND API: Received agentScript:', data.configuration?.agentScript);
  return data;
};

export const updateAgentConfiguration = async (
  payload: AgentConfiguration,
  garageId?: string
): Promise<AgentConfigurationResponse> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }
  console.log('FRONTEND API UPDATE: Sending payload with agentScript:', payload.agentScript);
  const { data } = await api.put<AgentConfigurationResponse>(
    `/api/garages/${targetGarageId}/agent-config`,
    payload
  );
  return data;
};

export const login = async (
  email: string,
  password: string,
  garageId?: string
): Promise<LoginResponse> => {
  const payload: {
    email: string;
    password: string;
    garageId?: string;
  } = {
    email,
    password,
  };

  if (garageId && garageId.trim()) {
    payload.garageId = garageId.trim();
  }

  const { data } = await api.post<LoginResponse>("/api/auth/login", payload);
  return data;
};

export type SubmitCallFeedbackPayload = {
  rating: "up" | "down";
  reasons: string[];
  notes?: string;
};

export const submitCallFeedback = async (
  callId: string,
  payload: SubmitCallFeedbackPayload,
  garageId?: string
): Promise<CallFeedbackResponse> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }

  const requestBody: SubmitCallFeedbackPayload = {
    rating: payload.rating,
    reasons: payload.reasons,
    ...(payload.notes && payload.notes.trim() ? { notes: payload.notes.trim() } : {}),
  };

  const { data } = await api.post<CallFeedbackResponse>(
    `/api/garages/${targetGarageId}/calls/${callId}/feedback`,
    requestBody
  );
  return data;
};

export const discoverWebsitePages = async (
  url: string,
  garageId?: string
): Promise<WebsiteScanResponse> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }

  const { data } = await api.post<WebsiteScanResponse>(
    `/api/garages/${targetGarageId}/website-scan`,
    { url }
  );
  return data;
};

export const generateVoicePreview = async (
  voiceId: string,
  garageId?: string,
  lang?: string
): Promise<Blob> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }

  const { data } = await api.post(
    `/api/garages/${targetGarageId}/voice-preview`,
    { voiceId, lang },
    { responseType: 'blob' }
  );
  return data;
};

export const ingestWebsiteKnowledge = async (
  url: string,
  selectedUrls: string[],
  garageId?: string
): Promise<WebsiteIngestResponse> => {
  if (!selectedUrls.length) {
    throw new Error("Select at least one page before publishing the knowledge base.");
  }

  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }

  const { data } = await api.post<WebsiteIngestResponse>(
    `/api/garages/${targetGarageId}/website-scan`,
    { url, selectedUrls }
  );
  return data;
};

export interface KnowledgeUploadResponse {
  knowledgeBase: AgentKnowledgeDocument[];
  uploadId: string;
  chunks: number;
}

// Upload a document (PDF / Word / CSV / Excel / text) into the garage's knowledge base.
// kind 'price-list' is shown only for Assist garages and lets the agent quote from it.
export const uploadKnowledgeDocument = async (
  file: File,
  kind: 'document' | 'price-list',
  garageId?: string
): Promise<KnowledgeUploadResponse> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);
  const { data } = await api.post<KnowledgeUploadResponse>(
    `/api/garages/${targetGarageId}/knowledge-upload`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
  return data;
};

export interface TyresoftServicesCsvResponse {
  ok: true;
  imported: { services: number; brackets: number };
  warnings: string[];
}

// Upload a Tyresoft Services.csv export and replace the garage's tsServices +
// pricingRules. Engine-size rows get grouped into bracketed services; rows with
// no engine range become fixed-price services.
export const uploadTyresoftServicesCsv = async (
  file: File,
  garageId?: string
): Promise<TyresoftServicesCsvResponse> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<TyresoftServicesCsvResponse>(
    `/api/garages/${targetGarageId}/tyresoft-services-csv`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
  return data;
};

// Clears tsServices, pricingRules, and tsServicesUpload from the garage's
// integrationProviderConfig. Used when the garage toggles "Give prices on
// calls" off.
export const deleteTyresoftServicesCsv = async (
  garageId?: string
): Promise<{ ok: true }> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }
  const { data } = await api.delete<{ ok: true }>(
    `/api/garages/${targetGarageId}/tyresoft-services-csv`
  );
  return data;
};

export const deleteKnowledgeDocument = async (
  uploadId: string,
  garageId?: string
): Promise<{ knowledgeBase: AgentKnowledgeDocument[]; deleted: number }> => {
  const targetGarageId = garageId ?? getGarageId();
  if (!targetGarageId) {
    throw new Error("Missing garage id. Log in again or set a default garage id.");
  }
  const { data } = await api.delete<{ knowledgeBase: AgentKnowledgeDocument[]; deleted: number }>(
    `/api/garages/${targetGarageId}/knowledge/${uploadId}`
  );
  return data;
};

export default api;
// Billing API Functions
export const fetchBillingConfig = async (garageId: string): Promise<{ config: import('../types').BillingConfig }> => {
  const { data } = await api.get(`/api/billing/garages/${garageId}/config`);
  return data;
};

export const updateBillingConfig = async (
  garageId: string,
  config: {
    subscriptionCostGbp: number;
    includedMinutes: number;
    costPerMinuteGbp: number;
    vatRate: number;
    trialDays?: number;
    requiresBookingActivation?: boolean;
    bookingsRequiredForActivation?: number;
    messagingSubscriptionCostGbp?: number;
    includedMessages?: number;
    costPerMessageGbp?: number;
  }
): Promise<{ config: import('../types').BillingConfig }> => {
  const { data } = await api.put(`/api/billing/garages/${garageId}/config`, config);
  return data;
};

export const fetchUsage = async (
  garageId: string,
  startDate: string,
  endDate: string
): Promise<{ usage: import('../types').UsageSummary; billing: import('../types').BillingCalculation }> => {
  const { data } = await api.get(`/api/billing/garages/${garageId}/usage`, {
    params: { startDate, endDate },
  });
  return data;
};

export const generateInvoice = async (payload: {
  garageId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<{ invoice: import('../types').Invoice }> => {
  const { data } = await api.post('/api/billing/invoices/generate', payload);
  return data;
};

export const generateBatchInvoices = async (payload: {
  periodStart: string;
  periodEnd: string;
}): Promise<{ summary: { total: number; succeeded: number; failed: number }; results: any[] }> => {
  const { data } = await api.post('/api/billing/invoices/generate-batch', payload);
  return data;
};

export const fetchInvoices = async (params?: {
  garageId?: string;
  status?: string;
  limit?: number;
}): Promise<{ invoices: import('../types').Invoice[] }> => {
  const { data } = await api.get('/api/billing/invoices', { params });
  return data;
};

export const fetchInvoice = async (invoiceId: string): Promise<{ invoice: import('../types').Invoice }> => {
  const { data } = await api.get(`/api/billing/invoices/${invoiceId}`);
  return data;
};

export const chargeInvoice = async (invoiceId: string): Promise<{ invoice: import('../types').Invoice; payment: any }> => {
  const { data } = await api.post(`/api/billing/invoices/${invoiceId}/charge`);
  return data;
};

export const fetchUsersDueForBilling = async (): Promise<{ users: any[] }> => {
  const { data } = await api.get('/api/billing/users-due?forecast=true');
  return data;
};

export const processMonthlyBilling = async (): Promise<{ summary: { processed: number; successful: number; failed: number }; results: any[] }> => {
  const { data } = await api.post('/api/billing/process-monthly');
  return data;
};

export const fetchUsersPendingBilling = async (): Promise<{ users: any[] }> => {
  const { data } = await api.get('/api/admin/users-pending-billing');
  return data;
};

export const activateBilling = async (userId: string): Promise<any> => {
  const { data } = await api.post(`/api/admin/activate-billing/${userId}`);
  return data;
};

export const fetchUsersWithoutMandate = async (): Promise<{ users: any[] }> => {
  const { data } = await api.get('/api/admin/users-without-mandate');
  return data;
};

export const requestDirectDebitSetup = async (userId: string): Promise<any> => {
  const { data } = await api.post(`/api/admin/request-direct-debit/${userId}`);
  return data;
};

export const generateInvoicesForUser = async (userId: string): Promise<any> => {
  const { data } = await api.post(`/api/billing/users/${userId}/generate-invoices`);
  return data;
};

export const deleteInvoice = async (invoiceId: string): Promise<{ success: boolean }> => {
  const { data } = await api.delete(`/api/admin/invoices/${invoiceId}`);
  return data;
};

export const creditInvoice = async (invoiceId: string, reason: string): Promise<{ invoice: import('../types').Invoice }> => {
  const { data } = await api.post(`/api/admin/invoices/${invoiceId}/credit`, { reason });
  return data;
};

export const markInvoicePaid = async (invoiceId: string): Promise<{ success: boolean; marked: number }> => {
  const { data } = await api.post(`/api/admin/invoices/${invoiceId}/mark-paid`);
  return data;
};

export const updateGarageBillingEmail = async (garageId: string, billingEmail: string): Promise<any> => {
  const { data } = await api.put(`/api/customer/billing/garages/${garageId}/billing-email`, { billingEmail });
  return data;
};

export const sendGarageInvoices = async (garageId: string): Promise<any> => {
  const { data } = await api.post(`/api/customer/billing/garages/${garageId}/send-invoices`);
  return data;
};

// ---------------------------------------------------------------------------
// Outbound Messaging
// ---------------------------------------------------------------------------

export interface OutboundContactInput {
  customerName: string;
  phone: string;
  registration?: string;
  motDueDate?: string;
  serviceDueDate?: string;
}

export interface OutboundContact extends OutboundContactInput {
  id: string;
  campaignId: string;
  garageId: string;
  messageType: string;
  status: string;
  messageSid?: string | null;
  errorReason?: string | null;
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundCampaign {
  id: string;
  garageId: string;
  name: string;
  channel: 'sms' | 'whatsapp';
  status: string;
  totalContacts: number;
  sentCount: number;
  sentAt?: string | null;
  messageTemplateId?: string | null;
  variableMapping?: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  contacts?: OutboundContact[];
  _count?: { contacts: number };
}

export interface MessageTemplate {
  id: string;
  garageId: string;
  name: string;
  category: string;
  language: string;
  bodyText: string;
  headerType?: string | null;
  headerContent?: string | null;
  footerText?: string | null;
  buttonType?: string | null;
  buttonText?: string | null;
  metaTemplateId?: string | null;
  status: string;
  variableSamples?: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

export const createOutboundCampaign = async (payload: {
  garageId: string;
  name: string;
  channel: 'sms' | 'whatsapp';
  contacts: OutboundContactInput[];
  messageTemplateId?: string;
  variableMapping?: Record<string, string>;
}): Promise<{ campaign: OutboundCampaign }> => {
  const { data } = await api.post('/api/outbound/campaigns', payload);
  return data;
};

export const fetchGarageTemplates = async (garageId: string): Promise<{ templates: MessageTemplate[] }> => {
  const { data } = await api.get(`/api/garages/${garageId}/templates`);
  return data;
};

export const updateTemplate = async (
  garageId: string,
  templateId: string,
  payload: Partial<Pick<MessageTemplate, 'category' | 'language' | 'headerType' | 'headerContent' | 'bodyText' | 'footerText' | 'buttonType' | 'buttonText'> & { variableSamples?: Record<string, string> | null; headerSample?: string | null; buttonValue?: string | null }>
): Promise<{ template: MessageTemplate }> => {
  const { data } = await api.put(`/api/garages/${garageId}/templates/${templateId}`, payload);
  return data;
};

export const fetchOutboundCampaigns = async (garageId: string): Promise<{ campaigns: OutboundCampaign[] }> => {
  const { data } = await api.get('/api/outbound/campaigns', { params: { garageId } });
  return data;
};

export const fetchOutboundCampaign = async (id: string): Promise<{ campaign: OutboundCampaign }> => {
  const { data } = await api.get(`/api/outbound/campaigns/${id}`);
  return data;
};

export const sendOutboundCampaign = async (id: string): Promise<{ success: boolean; message: string }> => {
  const { data } = await api.post(`/api/outbound/campaigns/${id}/send`);
  return data;
};

/**
 * Pull reminder contacts from Garage Hive (vehicles due MOT/service in `days`
 * days), resolving each owner's number. Returns the same contact shape a CSV
 * upload produces, so the caller can preview + create a campaign identically.
 */
export const fetchGarageHiveReminders = async (
  garageId: string,
  days = 30,
): Promise<{
  source: 'garagehive';
  days: number;
  contacts: OutboundContactInput[];
  skipped: { reg: string; reason: string }[];
}> => {
  const { data } = await api.get('/api/outbound/garagehive/preview', { params: { garageId, days } });
  return data;
};

export interface GarageHiveSettings {
  connected: boolean;
  isGarageHiveAgent?: boolean;
  remindersEnabled?: boolean;
  reminderDaysAhead?: number;
  reminderTemplateId?: string | null;
  reminderChannel?: string;
  callerRecognitionEnabled?: boolean;
  advisoryUpsellsEnabled?: boolean;
  lastRunAt?: string | null;
  lastRunError?: string | null;
}

export const fetchGarageHiveSettings = async (garageId: string): Promise<GarageHiveSettings> => {
  const { data } = await api.get('/api/outbound/garagehive/settings', { params: { garageId } });
  return data;
};

export const updateGarageHiveSettings = async (payload: {
  garageId: string;
  remindersEnabled?: boolean;
  reminderDaysAhead?: number;
  reminderTemplateId?: string | null;
  advisoryUpsellsEnabled?: boolean;
  callerRecognitionEnabled?: boolean;
}): Promise<GarageHiveSettings> => {
  const { data } = await api.put('/api/outbound/garagehive/settings', payload);
  return data;
};

// ---------------------------------------------------------------------------
// Service agreement
// ---------------------------------------------------------------------------

export type AgreementSummary = {
  id: string;
  clientName: string;
  setupFeeGbp: number;
  licenceFeeGbp: number;
  centresCount: number;
  licences: string[];
  goLiveDate: string | null;
  status: 'draft' | 'sent' | 'signed' | 'externally_signed' | 'voided';
  version: string;
};

export type PendingAgreementResponse = {
  agreement: AgreementSummary | null;
  html?: string;
  css?: string;
};

export const fetchPendingAgreement = async (): Promise<PendingAgreementResponse> => {
  const { data } = await api.get<PendingAgreementResponse>('/api/agreements/me/pending');
  return data;
};

export const fetchAgreementByToken = async (
  token: string
): Promise<{ agreement: AgreementSummary; customerEmail: string; html: string; css: string }> => {
  const { data } = await api.get(`/api/agreements/sign/${encodeURIComponent(token)}`);
  return data;
};

export type SignAgreementResponse = {
  success: boolean;
  agreement: AgreementSummary;
  nextStep?: 'payment' | 'dashboard';
};

export const signAgreement = async (
  agreementId: string,
  payload: { signedByName: string; signedByPosition: string; signatureDataUrl: string }
): Promise<SignAgreementResponse> => {
  const { data } = await api.post(`/api/agreements/${agreementId}/sign`, { ...payload, accepted: true });
  return data;
};

export const signAgreementByToken = async (
  token: string,
  payload: { signedByName: string; signedByPosition: string; signatureDataUrl: string }
): Promise<SignAgreementResponse> => {
  const { data } = await api.post(`/api/agreements/sign/${encodeURIComponent(token)}`, {
    ...payload,
    accepted: true,
  });
  return data;
};

// ---------------------------------------------------------------------------
// In-portal support chat
// ---------------------------------------------------------------------------

export type SupportMessage = {
  id: string;
  conversationId: string;
  senderRole: 'customer' | 'ai' | 'staff' | 'system';
  senderUserId: string | null;
  channel: string;
  body: string;
  createdAt: string;
  sender?: { email: string } | null;
};

export type SupportConversationStatus = 'ai' | 'awaiting_staff' | 'staff_handled' | 'closed';

export type SupportConversationSummary = {
  id: string;
  lastMessageAt: string;
  lastMessageText: string | null;
  unreadForUser: number;
  status?: SupportConversationStatus;
};

export type SupportSendResponse = {
  messages: SupportMessage[];
  status: SupportConversationStatus;
};

export type SupportThreadResponse = {
  conversation: SupportConversationSummary;
  messages: SupportMessage[];
};

export const fetchMySupportThread = async (): Promise<SupportThreadResponse> => {
  const { data } = await api.get<SupportThreadResponse>('/api/support/me');
  return data;
};

export const sendSupportMessage = async (body: string): Promise<SupportSendResponse> => {
  // Include the currently-selected branch so the AI sees the right config.
  const selectedGarageId = getGarageId() ?? undefined;
  const { data } = await api.post<SupportSendResponse>('/api/support/me/messages', {
    body,
    selectedGarageId,
  });
  return data;
};

export const markSupportThreadRead = async (): Promise<void> => {
  await api.post('/api/support/me/read');
};

// Admin
export type AdminSupportConversation = SupportConversationSummary & {
  userId: string;
  unreadForStaff: number;
  user: { email: string };
  closedAt: string | null;
};

export const fetchAdminSupportConversations = async (): Promise<{ conversations: AdminSupportConversation[] }> => {
  const { data } = await api.get('/api/admin/support');
  return data;
};

export const fetchAdminSupportConversation = async (
  id: string,
): Promise<{ conversation: AdminSupportConversation; messages: SupportMessage[] }> => {
  const { data } = await api.get(`/api/admin/support/${id}`);
  return data;
};

export const sendAdminSupportReply = async (id: string, body: string): Promise<{ message: SupportMessage }> => {
  const { data } = await api.post(`/api/admin/support/${id}/messages`, { body });
  return data;
};

export const markAdminSupportRead = async (id: string): Promise<void> => {
  await api.post(`/api/admin/support/${id}/read`);
};
