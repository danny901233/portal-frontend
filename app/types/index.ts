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
  feedback: CallFeedbackRecord | null;
  createdAt: string;
}

export interface GarageSummary {
  id: string;
  name: string;
}

export interface LoginResponse {
  success: boolean;
  token: string;
  user: {
    id: string;
    email: string;
  };
  garages: GarageSummary[];
  selectedGarageId: string;
}

export interface CallsResponse {
  calls: CallRecord[];
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
  callSummaryEmail: string;
}

export interface AgentConfigurationResponse {
  configuration: AgentConfiguration;
}
