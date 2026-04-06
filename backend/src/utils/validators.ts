import { z } from 'zod';

import { WEEKDAY_ORDER } from './types.js';

// Base message entry (conversation turns) - with explicit type
const messageEntryWithTypeSchema = z.object({
  type: z.literal('message'),
  speaker: z.string().min(1),
  text: z.string().min(1),
  timestamp: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(), // STT confidence score
  latency_ms: z.number().nonnegative().optional(), // Response latency
});

// Legacy message entry without type field
const messageLegacySchema = z.object({
  speaker: z.string().min(1),
  text: z.string().min(1),
  timestamp: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
  latency_ms: z.number().nonnegative().optional(),
});

// Tool call entry
const toolCallEntrySchema = z.object({
  type: z.literal('tool_call'),
  tool: z.string().min(1),
  parameters: z.record(z.any()).nullable().optional(),
  result: z.any().nullable().optional(),
  success: z.boolean(),
  duration_ms: z.number(),
  error: z.string().nullable().optional(),
  retry_count: z.number().nullable().optional(),
  timestamp: z.number().nonnegative(),
});

// Log entry
const logEntrySchema = z.object({
  type: z.literal('log'),
  level: z.enum(['INFO', 'WARN', 'ERROR', 'DEBUG']),
  logger: z.string().min(1),
  message: z.string().min(1),
  timestamp: z.number().nonnegative(),
  attributes: z.record(z.any()).optional(),
});

// Union of all transcript entry types
export const transcriptEntrySchema = z.union([
  messageEntryWithTypeSchema,
  toolCallEntrySchema,
  logEntrySchema,
  messageLegacySchema, // Last so it doesn't match entries with type field
]);

export const metricsSchema = z
  .record(z.any())
  .refine((metrics) => Object.keys(metrics).length > 0, {
    message: 'Metrics cannot be empty',
  });

export const createCallSchema = z
  .object({
    garageId: z.string().uuid(),
    roomName: z.string().min(1),
    recordingUrl: z
      .string()
      .url()
      .optional()
      .or(z.literal(''))
      .transform((val) => val || undefined),
    twilioCallSid: z.string().optional(),
    callSid: z.string().optional(),
    call_sid: z.string().optional(),
    durationSeconds: z.number().int().nonnegative().optional(),
    callType: z.string().min(1).optional(),
    metrics: metricsSchema,
    transcript: z.array(transcriptEntrySchema).min(1),
    summary: z.string().min(1),
    customerName: z.string().min(1).optional(),
    customerPhone: z.string().min(1).optional(),
    fromNumber: z.string().min(1).optional(),
    registrationNumber: z.string().min(1).optional(),
    registration: z.string().min(1).optional(),
    vehicleRegistration: z.string().min(1).optional(),
    vehicleReg: z.string().min(1).optional(),
    vehicle_reg: z.string().min(1).optional(),
    registration_no: z.string().min(1).optional(),
    reg: z.string().min(1).optional(),
    confirmedBooking: z.boolean().optional(),
    confirmedBookingCategory: z.enum(['service', 'mot', 'diagnostic', 'other']).optional(),
    capturedRevenue: z.number().nonnegative().optional(),
    bookingDetails: z.string().min(1).optional(),
    emotionData: z.record(z.any()).optional(),
  })
  .transform((payload) => {
    const derivedRegistration =
      payload.registrationNumber ??
      payload.registration ??
      payload.vehicleRegistration ??
      payload.vehicleReg ??
      payload.vehicle_reg ??
      payload.registration_no ??
      payload.reg;

    const derivedCallSid = payload.twilioCallSid ?? payload.callSid ?? payload.call_sid;

    return {
      ...payload,
      registrationNumber: derivedRegistration?.trim() || undefined,
      twilioCallSid: derivedCallSid?.trim() || undefined,
      durationSeconds: Math.max(0, Math.trunc(payload.durationSeconds ?? 0)),
      callType: (payload.callType?.trim().toLowerCase() || 'unknown').slice(0, 100),
    };
  });

const optionalGarageIdSchema = z
  .string()
  .uuid()
  .optional();

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  garageId: optionalGarageIdSchema,
});

const optionalEmail = z
  .union([z.string().email().max(254), z.literal('')])
  .optional();

const optionalUrl = z
  .union([z.string().url().max(500), z.literal('')])
  .optional();

const optionalBoundedString = (maxLength: number) =>
  z.union([z.string().max(maxLength), z.literal('')]).optional();

const garageHiveSettingsSchema = z
  .object({
    instanceUrl: z.union([z.string().max(2048), z.literal('')]).optional(),
    apiKey: optionalBoundedString(4096),
    customerId: optionalBoundedString(200),
    locationId: optionalBoundedString(200),
  })
  .optional();

const tyresoftSettingsSchema = z
  .object({
    tsWorkspace: optionalBoundedString(100),
    tsUsername: optionalBoundedString(100),
    tsPassword: optionalBoundedString(1000),
    tsApiKey: optionalBoundedString(1000),
    tsDepotId: z.union([z.string().max(20), z.number()]).optional(),
  })
  .optional();

const hubspotSettingsSchema = z
  .object({
    apiToken: optionalBoundedString(4096),
    ownerId: optionalBoundedString(100),
  })
  .optional();

const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM in 24-hour time');

const dailyHoursSchema = z
  .object({
    open: z.union([timeString, z.null()]),
    close: z.union([timeString, z.null()]),
    closed: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.closed) {
      if (value.open !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Clear the opening time when the day is marked closed.',
          path: ['open'],
        });
      }
      if (value.close !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Clear the closing time when the day is marked closed.',
          path: ['close'],
        });
      }
      return;
    }

    if (!value.open) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Opening time is required when the day is open.',
        path: ['open'],
      });
    }
    if (!value.close) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Closing time is required when the day is open.',
        path: ['close'],
      });
    }
  });

export const weeklyOpeningHoursSchema = z.preprocess(
  (val) => {
    // If weeklyOpeningHours is an empty object or missing days, fill with defaults
    if (typeof val === 'object' && val !== null) {
      const hasAllDays = WEEKDAY_ORDER.every((day) => day in val);
      if (!hasAllDays) {
        const defaults: any = {};
        WEEKDAY_ORDER.forEach((day) => {
          defaults[day] = (val as any)[day] || { open: null, close: null, closed: true };
        });
        return defaults;
      }
    }
    return val;
  },
  z.object(
    WEEKDAY_ORDER.reduce((shape, day) => {
      return {
        ...shape,
        [day]: dailyHoursSchema,
      };
    }, {} as Record<(typeof WEEKDAY_ORDER)[number], typeof dailyHoursSchema>),
  )
);

export const upsertAgentConfigurationSchema = z.object({
  branchName: z.string().min(1).max(200),
  phoneNumber: z.union([z.string().max(100), z.literal('')]).optional(),
  emailAddress: optionalEmail,
  branchAddress: z.union([z.string().max(1000), z.literal('')]).optional(),
  websiteUrl: optionalUrl,
  weeklyOpeningHours: weeklyOpeningHoursSchema.optional(),
  holidayClosures: z.union([z.string().max(2000), z.literal('')]).optional(),
  greetingLine: z.union([z.string().max(500), z.literal('')]).optional(),
  tonePreference: z.enum(['standard', 'upbeat', 'professional']),
  responseSpeed: z.enum(['slow', 'normal', 'fast']).optional(),
  interruptionSensitivity: z.number().min(0).max(1).optional(),
  allowFastFitOnly: z.boolean(),
  enableDropOffBookings: z.boolean().optional(),
  dropOffMessage: z.string().max(500).optional(),
  dropOffExcludeServices: z.array(z.string().max(100)).max(20).optional(),
  notificationEmails: z.array(z.string().email().max(254)).max(10).optional(),
  integrationProvider: z.enum(['none', 'garage_hive', 'hubspot']).optional(),
  garageHiveSettings: garageHiveSettingsSchema,
  tyresoftSettings: tyresoftSettingsSchema,
  hubspotSettings: hubspotSettingsSchema,
  agentType: z.enum(['assist', 'automate']).optional(),
  agentScript: z.enum(['receptionmate-agent', 'receptionmate-agent-v3', 'tyresoft-agent']).optional(),
  enableSmsBookingLinks: z.boolean().optional(),
  allowBookings: z.boolean().optional(),
  bookingLeadTimeDays: z.number().int().min(1).max(30).optional(),
  voice: z.enum(['tom', 'leah', 'sophie', 'gemma', 'isobel', 'fraser', 'amelia']).optional(),
}).superRefine((value, ctx) => {
  const provider = value.integrationProvider ?? 'none';
  if (provider !== 'garage_hive') {
    return;
  }

  const settings = value.garageHiveSettings ?? {};
  const instanceUrl = typeof settings.instanceUrl === 'string' ? settings.instanceUrl.trim() : '';
  const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
  const locationId = typeof settings.locationId === 'string' ? settings.locationId.trim() : '';

  if (!instanceUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide the Garage Hive instance name before saving.',
      path: ['garageHiveSettings', 'instanceUrl'],
    });
  }

  if (instanceUrl) {
    const instancePattern = /^[A-Za-z0-9._-]+$/;
    if (!instancePattern.test(instanceUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use the instance name provided by Garage Hive (letters, numbers, dashes, underscores, or dots).',
        path: ['garageHiveSettings', 'instanceUrl'],
      });
    }
    if (instanceUrl.includes('://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter only the instance name, not the full URL.',
        path: ['garageHiveSettings', 'instanceUrl'],
      });
    }
  }

  if (!apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide the Garage Hive API key before saving.',
      path: ['garageHiveSettings', 'apiKey'],
    });
  }

  if (!locationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide the Garage Hive location ID before saving.',
      path: ['garageHiveSettings', 'locationId'],
    });
  }
});

export const callFeedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  reasons: z.array(z.string().min(1).max(200)).max(10).default([]),
  notes: z.string().max(2000).optional(),
});

export const websiteScanSchema = z.object({
  url: z.string().url().max(2048),
  selectedUrls: z.array(z.string().url().max(2048)).min(1).max(25).optional(),
});
