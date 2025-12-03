import axios, { AxiosHeaders } from "axios";
import type { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import type {
  AgentConfiguration,
  AgentConfigurationResponse,
  CallFeedbackResponse,
  CallResponse,
  CallsResponse,
  GaragesResponse,
  LoginResponse,
  WebsiteIngestResponse,
  WebsiteScanResponse,
} from "../types";
import { TOKEN_STORAGE_KEY, clearSession, getGarageId } from "./auth";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000",
  withCredentials: false,
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (token) {
      const headers = AxiosHeaders.from(config.headers);
      headers.set("Authorization", `Bearer ${token}`);
      config.headers = headers;
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

export const fetchCalls = async (
  garageId?: string,
  filters?: CallFilters
): Promise<CallsResponse> => {
  const hasGarageIds = Boolean(filters?.garageIds?.length);
  const targetGarageId = hasGarageIds ? undefined : garageId ?? getGarageId();
  if (!hasGarageIds && !targetGarageId) {
    throw new Error('Missing garage id. Log in again or set a default garage id.');
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
  if (hasGarageIds) {
    filters?.garageIds?.forEach((id) => {
      if (id) {
        params.append('garageIds', id);
      }
    });
  }

  const querySuffix = params.toString();

  const endpoint = hasGarageIds
    ? `/api/calls${querySuffix ? `?${querySuffix}` : ''}`
    : `/api/garages/${targetGarageId}/calls${querySuffix ? `?${querySuffix}` : ''}`;

  const { data } = await api.get<CallsResponse>(endpoint);
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
  const { data } = await api.put<AgentConfigurationResponse>(
    `/api/garages/${targetGarageId}/agent-config`,
    payload
  );
  return data;
};

export const login = async (
  email: string,
  password: string
): Promise<LoginResponse> => {
  const { data } = await api.post<LoginResponse>('/api/auth/login', {
    email,
    password,
  });
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

export default api;