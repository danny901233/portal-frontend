export interface MetricsRecord {
  [key: string]: number | string | boolean | null;
}

export interface TranscriptEntry {
  speaker: string;
  text: string;
  timestamp: number;
}

export interface CallFeedbackRecord {
  id: string;
  callId: string;
  rating: 'up' | 'down';
  reasons: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallRecord {
  id: string;
  garageId: string;
  roomName: string;
  recordingUrl?: string | null;
  durationSeconds: number;
  callType: string;
  metrics: MetricsRecord;
  transcript: TranscriptEntry[];
  summary: string;
  callerName?: string | null;
  callerNumber?: string | null;
  fromNumber?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  registrationNumber?: string | null;
  feedback: CallFeedbackRecord | null;
  confirmedBooking?: boolean | null;
  confirmedBookingCategory?: ConfirmedBookingCategory | null;
  capturedRevenue?: number | null;
  bookingDetails?: string | null;
  createdAt: string;
}

export interface GarageSummary {
  id: string;
  name: string;
}

export type BranchRole = 'MANAGER' | 'USER';
export type BranchRolesMap = Record<string, BranchRole>;
export type UserRole = 'MANAGER' | 'USER' | 'RECEPTIONMATE_STAFF';
export type ConfirmedBookingCategory = 'service' | 'diagnostic' | 'mot' | 'other';

export interface LoginResponse {
  success: boolean;
  token?: string;
  user?: {
    id: string;
    email: string;
    role: UserRole;
    branchRoles: BranchRolesMap;
  };
  garages?: GarageSummary[];
  selectedGarageId?: string;
  passwordChangeRequired?: boolean;
  paymentSetupRequired?: boolean;
  resetToken?: string;
}

export interface CallsResponse {
  calls: CallRecord[];
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface CallResponse {
  call: CallRecord;
}

export interface CallFeedbackResponse {
  feedback: CallFeedbackRecord;
}

export interface GaragesResponse {
  garages: GarageSummary[];
}

export interface AdminGarageAgentConfiguration {
  branchName: string;
  phoneNumber: string;
  emailAddress: string;
  notificationEmails: string[];
  callSummaryEmail?: string | null;
}

export interface AdminGarage {
  id: string;
  name: string;
  businessId: string | null;
  twilioNumber: string;
  hasMessagingAccess: boolean;
  subscriptionCostGbp: number;
  includedMinutes: number;
  costPerMinuteGbp: number;
  vatRate: number;
  trialEndDate: string | null;
  requiresBookingActivation: boolean;
  bookingsRequiredForActivation: number;
  activationBookingsCount: number;
  subscriptionActivatedAt: string | null;
  nextBillingDate: string | null;
  billingDay: number | null;
  agentConfiguration: AdminGarageAgentConfiguration | null;
}

export interface AdminBusiness {
  id: string;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactRole?: string | null;
  branches: AdminGarage[];
}

export interface AdminUser {
  id: string;
  email: string;
  garageAccessIds: string[];
  role: UserRole;
  branchRoles: BranchRolesMap;
}

export type TonePreference = 'standard' | 'upbeat' | 'professional';
export type ResponseSpeed = 'slow' | 'normal' | 'fast';

export const WEEKDAY_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type DayOfWeek = (typeof WEEKDAY_ORDER)[number];

export interface DailyOpeningHours {
  open: string | null;
  close: string | null;
  closed: boolean;
}

export type WeeklyOpeningHours = Record<DayOfWeek, DailyOpeningHours>;

export const createEmptyWeeklyOpeningHours = (): WeeklyOpeningHours => {
  return WEEKDAY_ORDER.reduce<WeeklyOpeningHours>((acc, day) => {
    acc[day] = { open: null, close: null, closed: true };
    return acc;
  }, {} as WeeklyOpeningHours);
};

export type IntegrationProvider = 'none' | 'garage_hive';

export type AgentType = 'assist' | 'automate';

export type VoiceOption = 'tom' | 'leah' | 'sophie' | 'gemma' | 'isobel' | 'fraser' | 'amelia';

export interface DataCollectionField {
  key: string;
  label: string;
  active: boolean;
  required: boolean;
  instruction?: string | null;
}

export interface GarageHiveSettings {
  instanceUrl: string;
  apiKey: string;
  customerId: string;
  locationId: string;
}

export interface PricingBracket {
  maxCC: number;
  price: number;
}

export interface TsService {
  id: string;
  name: string;
  pricingType: 'fixed' | 'engine-size';
  price?: number;
}

export interface TyresoftSettings {
  tsWorkspace: string;
  tsUsername: string;
  tsPassword: string;
  tsApiKey: string;
  tsDepotId: string;
  tsChannelId?: number;
  tsServices?: TsService[];
  pricingRules?: Record<string, PricingBracket[]>;
}

export interface HubspotSettings {
  enabled: boolean;
  apiToken: string;
  ownerId: string;
  inboxEmail: string;
}

export interface AgentConfiguration {
  branchName: string;
  phoneNumber: string;
  emailAddress: string;
  branchAddress: string;
  websiteUrl: string;
  weeklyOpeningHours: WeeklyOpeningHours;
  holidayClosures: string;
  greetingLine: string;
  tonePreference: TonePreference;
  responseSpeed: ResponseSpeed;
  interruptionSensitivity: number;
  allowFastFitOnly: boolean;
  enableDropOffBookings: boolean;
  dropOffMessage: string;
  dropOffExcludeServices: string[];
  notificationEmails: string[];
  integrationProvider: IntegrationProvider;
  garageHiveSettings: GarageHiveSettings;
  tyresoftSettings: TyresoftSettings;
  hubspotSettings: HubspotSettings;
  agentType: AgentType;
  agentScript: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent';
  enableSmsBookingLinks: boolean;
  transferNumber: string;
  allowBookings: boolean;
  bookingLeadTimeDays: number;
  voice: VoiceOption;
  dataCollectionFields?: DataCollectionField[] | null;
  customRules?: CustomRule[] | null;
}

// Free-text behaviour rules per garage (injected at the very top of the agent
// prompt). Each rule is a short sentence the agent must obey, e.g. "For air-con
// services tell callers to just turn up — no booking needed." Inactive rules
// are ignored by the agent.
export interface CustomRule {
  text: string;
  active: boolean;
}

// Jodie-style per-garage toggleable data-collection fields (consumed by RMB agents).
// Each entry tells the agent: ask for this info, mark it required if so flagged,
// and use the instruction as a how-to hint in the prompt.
export interface DataCollectionField {
  key: string;
  label: string;
  active: boolean;
  required: boolean;
  instruction?: string | null;
}

export interface AgentConfigurationResponse {
  configuration: AgentConfiguration;
  knowledgeBase: AgentKnowledgeDocument[];
  twilioNumber: string | null;
}

export interface WebsiteScanSummaryPage {
  url: string;
  title?: string;
  description?: string;
  snippet?: string;
  phoneNumbers: string[];
  emails: string[];
  hours: string[];
  address?: string;
  chunkCount: number;
}

export interface WebsiteScanResponse {
  origin: string;
  pages: WebsiteScanSummaryPage[];
}

export interface WebsiteIngestResponse {
  knowledgeBase: AgentKnowledgeDocument[];
  processedPages: number;
}

export interface AgentKnowledgeDocument {
  id: string;
  source: string;
  title: string | null;
  url: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// Billing Types
export interface BillingConfig {
  id: string;
  name: string;
  subscriptionCostGbp: number;
  includedMinutes: number;
  costPerMinuteGbp: number;
  vatRate: number;
  trialEndDate: string | null;
  requiresBookingActivation: boolean;
  bookingsRequiredForActivation: number;
  activationBookingsCount: number;
  subscriptionActivatedAt: string | null;
}

export interface UsageSummary {
  minutesUsed: number;
  smsCount: number;
}

export interface BillingBreakdown {
  subscriptionCostGbp: number;
  minutesUsed: number;
  minutesIncluded: number;
  overageMinutes: number;
  costPerMinuteGbp: number;
  smsCount: number;
  costPerSmsGbp: number;
  vatRate: number;
}

export interface BillingCalculation {
  subscriptionAmount: number;
  minutesAmount: number;
  smsAmount: number;
  subtotal: number;
  vatAmount: number;
  total: number;
  breakdown: BillingBreakdown;
}

export interface Invoice {
  id: string;
  garageId: string;
  garage?: {
    id: string;
    name: string;
  };
  businessId: string | null;
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
  creditReason?: string | null;
  creditedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
