import api from './api';

export interface OnboardingStatus {
  needsSetup: boolean;
  agentType: 'assist' | 'automate';
}

export interface AgentConfigData {
  branchName: string;
  phoneNumber?: string | null;
  emailAddress?: string | null;
  branchAddress?: string | null;
  websiteUrl?: string | null;
  weeklyOpeningHours?: any;
  holidayClosures?: string | null;
  greetingLine?: string | null;
  voice: string;
  allowFastFitOnly: boolean;
  enableSmsBookingLinks: boolean;
  notificationEmails: string[];
}

export interface BusinessInfo {
  name: string;
  billingAddress?: string | null;
  billingCity?: string | null;
  billingPostcode?: string | null;
  billingCountry?: string | null;
  vatNumber?: string | null;
  companyRegNumber?: string | null;
  billingEmail?: string | null;
}

export interface OnboardingInitialData {
  garageId: string;
  twilioNumber?: string | null;
  agentType: 'assist' | 'automate';
  agentConfiguration: AgentConfigData | null;
  businessInfo: BusinessInfo | null;
}

/**
 * Check if the logged-in user needs to complete the setup wizard
 */
export const fetchOnboardingStatus = async (): Promise<OnboardingStatus> => {
  const { data } = await api.get<OnboardingStatus>('/api/onboarding/status');
  return data;
};

/**
 * Mark the setup wizard as completed
 */
export const completeSetupWizard = async (): Promise<{ success: boolean; message: string }> => {
  const { data } = await api.post<{ success: boolean; message: string }>(
    '/api/onboarding/wizard-complete'
  );
  return data;
};

/**
 * Fetch initial data for wizard pre-population
 */
export const fetchOnboardingInitialData = async (): Promise<OnboardingInitialData> => {
  const { data } = await api.get<OnboardingInitialData>('/api/onboarding/initial-data');
  return data;
};
