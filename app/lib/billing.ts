import api from './api';

export interface Invoice {
  id: string;
  garageId: string;
  garage: {
    id: string;
    name: string;
  };
  periodStart: string;
  periodEnd: string;
  minutesUsed: number;
  minutesIncluded: number;
  smsCount: number;
  subscriptionAmount: number;
  minutesAmount: number;
  smsAmount: number;
  subtotal: number;
  vatAmount: number;
  total: number;
  subscriptionCostGbp: number;
  costPerMinuteGbp: number;
  vatRate: number;
  status: string;
  gocardlessPaymentId: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessBillingInfo {
  id: string;
  name: string;
  billingAddress: string | null;
  billingCity: string | null;
  billingPostcode: string | null;
  billingCountry: string | null;
  vatNumber: string | null;
  companyRegNumber: string | null;
  billingEmail: string | null;
  billingInfoUpdatedAt: string | null;
}

export interface MandateStatus {
  hasMandate: boolean;
  status: string;
  mandateId: string | null;
  customerId: string | null;
  nextBillingDate: string | null;
}

export interface InvoicesResponse {
  invoices: Invoice[];
}

export interface BusinessInfoResponse {
  business: BusinessBillingInfo;
}

export interface MandateStatusResponse extends MandateStatus {}

export interface MandateFlowResponse {
  success: boolean;
  redirectUrl: string;
  redirectFlowId: string;
}

export interface MandateUpdateConfirmResponse {
  success: boolean;
  message: string;
  mandateId: string;
}

/**
 * Fetch invoices for user's managed garages
 * @param garageId Optional - filter to specific garage
 */
export async function fetchCustomerInvoices(garageId?: string): Promise<Invoice[]> {
  const params = new URLSearchParams();
  if (garageId) {
    params.set('garageId', garageId);
  }

  const queryString = params.toString();
  const url = `/api/customer/billing/invoices${queryString ? `?${queryString}` : ''}`;

  const { data } = await api.get<InvoicesResponse>(url);
  return data.invoices;
}

/**
 * Download invoice PDF
 * @param invoiceId Invoice ID
 * @returns Blob for download
 */
export async function downloadInvoicePdf(invoiceId: string): Promise<Blob> {
  const { data } = await api.get<Blob>(`/api/customer/billing/invoices/${invoiceId}/pdf`, {
    responseType: 'blob',
  });
  return data;
}

/**
 * Fetch business billing information
 * @param garageId Optional - get info for specific garage's business
 */
export async function fetchBusinessBillingInfo(garageId?: string): Promise<BusinessBillingInfo> {
  const params = new URLSearchParams();
  if (garageId) {
    params.set('garageId', garageId);
  }
  const queryString = params.toString();
  const url = `/api/customer/billing/business-info${queryString ? `?${queryString}` : ''}`;
  const { data } = await api.get<BusinessInfoResponse>(url);
  return data.business;
}

/**
 * Update business billing information
 */
export async function updateBusinessBillingInfo(
  info: Partial<Omit<BusinessBillingInfo, 'id' | 'name' | 'billingInfoUpdatedAt'>>
): Promise<BusinessBillingInfo> {
  const { data } = await api.put<BusinessInfoResponse>('/api/customer/billing/business-info', info);
  return data.business;
}

/**
 * Get Direct Debit mandate status
 * @param garageId Optional - check mandate for specific garage's business
 */
export async function getMandateStatus(garageId?: string): Promise<MandateStatus> {
  const params = new URLSearchParams();
  if (garageId) {
    params.set('garageId', garageId);
  }

  const queryString = params.toString();
  const url = `/api/customer/billing/mandate-status${queryString ? `?${queryString}` : ''}`;

  const { data } = await api.get<MandateStatusResponse>(url);
  return data;
}

/**
 * Create a new mandate update flow
 * @returns Redirect URL and flow ID
 */
export async function createMandateUpdateFlow(): Promise<MandateFlowResponse> {
  const { data } = await api.post<MandateFlowResponse>('/api/payment/update-mandate-flow');
  return data;
}

/**
 * Confirm mandate update after user returns from GoCardless
 * @param redirectFlowId Flow ID from URL params
 */
export async function confirmMandateUpdate(redirectFlowId: string): Promise<MandateUpdateConfirmResponse> {
  const { data } = await api.post<MandateUpdateConfirmResponse>('/api/payment/confirm-mandate-update', {
    redirectFlowId,
  });
  return data;
}

/**
 * Trigger PDF download in browser
 */
export function triggerPdfDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}
