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

export type PricingBracket = {
  maxCC: number;
  price: number;
};

export type TsService = {
  id: string;
  name: string;
  pricingType: 'fixed' | 'engine-size';
  price?: number;
};

export type TyresoftSettings = {
  tsWorkspace: string;
  tsUsername: string;
  tsPassword: string;
  tsApiKey: string;
  tsDepotId: string;
  tsChannelId?: string;
  tsServices?: TsService[];
  pricingRules?: Record<string, PricingBracket[]>;
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
  tsChannelId: typeof settings?.tsChannelId === 'string' ? settings.tsChannelId : undefined,
  tsServices: Array.isArray(settings?.tsServices) ? settings.tsServices : undefined,
  pricingRules: settings?.pricingRules && typeof settings.pricingRules === 'object' ? settings.pricingRules : undefined,
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
  enableDropOffBookings?: boolean;
  dropOffMessage?: string;
  dropOffExcludeServices?: string[];
  notificationEmails?: string[];
  integrationProvider: IntegrationProvider;
  garageHiveSettings: GarageHiveSettings;
  tyresoftSettings?: TyresoftSettings;
  agentType: AgentType;
  agentScript?: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent';
  enableSmsBookingLinks?: boolean;
  humanEscalation?: boolean;
  allowBookings?: boolean;
  bookingLeadTimeDays?: number;
  voice?: VoiceOption;
  humanEscalation?: boolean;
};
