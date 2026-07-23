import type { Call, CallFeedback } from '@prisma/client';

export type TranscriptEntry = {
  speaker: string;
  text: string;
  timestamp: number;
};

export type MetricsRecord = Record<string, number | string | boolean | null>;

export type SerializedCallFeedback = {
  id: string;
  callId: string;
  rating: 'up' | 'down';
  reasons: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CallWithParsedJson = Omit<Call, 'metrics' | 'transcript'> & {
  metrics: MetricsRecord;
  transcript: TranscriptEntry[];
  feedback: SerializedCallFeedback | null;
};

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

export type DailyOpeningHours = {
  open: string | null;
  close: string | null;
  closed: boolean;
};

export type WeeklyOpeningHours = Record<DayOfWeek, DailyOpeningHours>;

export type ResponseSpeed = 'slow' | 'normal' | 'fast';

export type IntegrationProvider = 'none' | 'garage_hive';

export type AgentType = 'assist' | 'automate';

export type VoiceOption = 'tom' | 'leah' | 'sophie' | 'gemma' | 'isobel' | 'fraser' | 'amelia';

// Per-service price brackets keyed by service code (e.g. "FULL_SERVICE").
// Each bracket = "vehicles with engine cc <= maxCC pay this price".
export type PricingBracket = {
  maxCC: number;
  price: number;
};

// Tyresoft service catalogue entry. Engine-size services use `pricingRules`;
// fixed-price services store the price directly on the entry.
export type TsService = {
  id: string;
  name: string;
  pricingType: 'fixed' | 'engine-size';
  price?: number;
  // Numeric Tyresoft API serviceID — the agent needs this to book the service
  // (without it the service falls back to MISC or is unbookable). Edited on the
  // portal price list. Stored as string|number since the UI edits it as text.
  tsServiceId?: string | number;
};

export type TyresoftSettings = {
  tsWorkspace: string;
  tsUsername: string;
  tsPassword: string;
  tsApiKey: string;
  tsDepotId: string;
  // Per-garage Tyresoft client channel id. Sent on createSale; a wrong/unset
  // value makes Tyresoft reject the booking ("Invalid client channel id").
  tsChannelId?: string;
  // Optional structured fields — populated when a garage's Tyresoft
  // services have been synced and per-bracket pricing has been set.
  tsServices?: TsService[];
  pricingRules?: Record<string, PricingBracket[]>;
  // Metadata about the most recent Services.csv upload. Written by the CSV
  // import endpoint and surfaced on GET so the Training tab can show
  // "Currently using …".
  tsServicesUpload?: {
    fileName: string;
    uploadedAt: string;
    services: number;
    brackets: number;
  };
  // Per-garage tyre markup. The deployed agent at optimised-tyresoft/agent.py
  // reads tyreMarkupFlat / tyreMarkupPercent off integrationProviderConfig
  // (top-level) and applies via _marked_price(). We persist both the
  // form-friendly { type, value } AND the numeric tyreMarkupFlat/Percent so
  // the form repopulates AND the agent sees the value it expects.
  tyreMarkupType?: 'flat' | 'percent';
  tyreMarkupValue?: string;
  // Numeric mirrors of the form fields above. Surfaced on GET so the deployed
  // agent (which reads tyresoftSettings.tyreMarkupFlat / tyreMarkupPercent as
  // numbers) finds them in the DynamoDB-synced config.
  tyreMarkupFlat?: number;
  tyreMarkupPercent?: number;
};

export const createDefaultTyresoftSettings = (): TyresoftSettings => ({
  tsWorkspace: '',
  tsUsername: '',
  tsPassword: '',
  tsApiKey: '',
  tsDepotId: '',
});

export const cloneTyresoftSettings = (settings?: TyresoftSettings | null): TyresoftSettings => ({
  tsWorkspace: typeof settings?.tsWorkspace === 'string' ? settings.tsWorkspace : '',
  tsUsername: typeof settings?.tsUsername === 'string' ? settings.tsUsername : '',
  tsPassword: typeof settings?.tsPassword === 'string' ? settings.tsPassword : '',
  tsApiKey: typeof settings?.tsApiKey === 'string' ? settings.tsApiKey : '',
  tsDepotId: typeof settings?.tsDepotId === 'string' ? settings.tsDepotId : (settings?.tsDepotId != null ? String(settings.tsDepotId) : ''),
  ...(settings?.tsChannelId != null && String(settings.tsChannelId) !== ''
    ? { tsChannelId: String(settings.tsChannelId) }
    : {}),
  ...(Array.isArray(settings?.tsServices) ? { tsServices: settings.tsServices } : {}),
  ...(settings?.pricingRules && typeof settings.pricingRules === 'object' && !Array.isArray(settings.pricingRules)
    ? { pricingRules: settings.pricingRules }
    : {}),
  ...(settings?.tsServicesUpload && typeof settings.tsServicesUpload === 'object'
    ? { tsServicesUpload: settings.tsServicesUpload }
    : {}),
  ...(settings?.tyreMarkupType === 'flat' || settings?.tyreMarkupType === 'percent'
    ? { tyreMarkupType: settings.tyreMarkupType }
    : {}),
  ...(typeof settings?.tyreMarkupValue === 'string'
    ? { tyreMarkupValue: settings.tyreMarkupValue }
    : {}),
  // Numeric mirrors — must survive clone() so DynamoDB sync ships them to the
  // agent (agent.py reads tyresoftSettings.tyreMarkupFlat / tyreMarkupPercent
  // as numbers).
  ...(typeof settings?.tyreMarkupFlat === 'number'
    ? { tyreMarkupFlat: settings.tyreMarkupFlat }
    : {}),
  ...(typeof settings?.tyreMarkupPercent === 'number'
    ? { tyreMarkupPercent: settings.tyreMarkupPercent }
    : {}),
});

export type GarageHiveSettings = {
  instanceUrl: string;
  apiKey: string;
  customerId: string;
  locationId: string;
};

export const createDefaultWeeklyOpeningHours = (): WeeklyOpeningHours => {
  return WEEKDAY_ORDER.reduce<WeeklyOpeningHours>((acc, day) => {
    acc[day] = { open: null, close: null, closed: true };
    return acc;
  }, {} as WeeklyOpeningHours);
};

export const cloneWeeklyOpeningHours = (hours: WeeklyOpeningHours): WeeklyOpeningHours => {
  return WEEKDAY_ORDER.reduce<WeeklyOpeningHours>((acc, day) => {
    const entry = hours?.[day];
    acc[day] = {
      open: entry?.open ?? null,
      close: entry?.close ?? null,
      closed: entry?.closed ?? true,
    };
    return acc;
  }, {} as WeeklyOpeningHours);
};

export const createDefaultGarageHiveSettings = (): GarageHiveSettings => ({
  instanceUrl: '',
  apiKey: '',
  customerId: '',
  locationId: '',
});

export const cloneGarageHiveSettings = (settings?: GarageHiveSettings | null): GarageHiveSettings => ({
  instanceUrl: typeof settings?.instanceUrl === 'string' ? settings.instanceUrl : '',
  apiKey: typeof settings?.apiKey === 'string' ? settings.apiKey : '',
  customerId: typeof settings?.customerId === 'string' ? settings.customerId : '',
  locationId: typeof settings?.locationId === 'string' ? settings.locationId : '',
});

export type HubspotSettings = {
  enabled: boolean;
  apiToken: string;
  ownerId: string;
  inboxEmail: string;
};

export const createDefaultHubspotSettings = (): HubspotSettings => ({
  enabled: false,
  apiToken: '',
  ownerId: '',
  inboxEmail: '',
});

export const cloneHubspotSettings = (settings?: HubspotSettings | null): HubspotSettings => ({
  enabled: settings?.enabled === true,
  apiToken: typeof settings?.apiToken === 'string' ? settings.apiToken : '',
  ownerId: typeof settings?.ownerId === 'string' ? settings.ownerId : '',
  inboxEmail: typeof settings?.inboxEmail === 'string' ? settings.inboxEmail : '',
});

export type AgentConfigurationPayload = {
  branchName: string;
  phoneNumber?: string | null;
  emailAddress?: string | null;
  branchAddress?: string | null;
  websiteUrl?: string | null;
  weeklyOpeningHours?: WeeklyOpeningHours | null;
  holidayClosures?: string | null;
  greetingLine?: string | null;
  tonePreference: 'standard' | 'upbeat' | 'professional';
  responseSpeed: ResponseSpeed;
  interruptionSensitivity: number;
  allowFastFitOnly: boolean;
  callerRecognitionEnabled?: boolean;
  advisoryUpsellsEnabled?: boolean;
  enableDropOffBookings?: boolean;
  dropOffMessage?: string;
  dropOffExcludeServices?: string[];
  notificationEmails?: string[];
  integrationProvider: IntegrationProvider;
  garageHiveSettings: GarageHiveSettings;
  tyresoftSettings?: TyresoftSettings;
  hubspotSettings?: HubspotSettings;
  agentType: AgentType;
  agentScript?: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent' | 'MMH-agent' | 'bookar-agent';
  enableSmsBookingLinks?: boolean;
  humanEscalation?: boolean;
  messagingHumanHandoff?: boolean;
  messagingHandoffMessage?: string | null;
  messagingNotifyScope?: string;
  messagingNotifyEmail?: boolean;
  messagingNotifySms?: boolean;
  messagingNotifyPhone?: string | null;
  transferNumber?: string | null;
  allowBookings?: boolean;
  bookingLeadTimeDays?: number;
  voice?: VoiceOption;
  customRules?: Array<{ text: string; active: boolean }> | null;
  dataCollectionFields?: Array<{
    key: string;
    label: string;
    active: boolean;
    required: boolean;
    instruction?: string | null;
  }> | null;
};
