import { z } from 'zod';

import { WEEKDAY_ORDER } from './types.js';

export const transcriptEntrySchema = z.object({
  speaker: z.string().min(1),
  text: z.string().min(1),
  timestamp: z.number().nonnegative(),
});

export const metricsSchema = z
  .record(z.union([z.number(), z.string(), z.boolean(), z.null()]))
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
    durationSeconds: z.number().int().nonnegative().optional(),
    callType: z.string().min(1).optional(),
    metrics: metricsSchema,
    transcript: z.array(transcriptEntrySchema).min(1),
    summary: z.string().min(1),
  })
  .transform((payload) => ({
    ...payload,
    durationSeconds: Math.max(0, Math.trunc(payload.durationSeconds ?? 0)),
    callType: (payload.callType?.trim().toLowerCase() || 'unknown').slice(0, 100),
  }));

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  garageId: z.string().uuid(),
});

const optionalEmail = z
  .union([z.string().email().max(254), z.literal('')])
  .optional();

const optionalUrl = z
  .union([z.string().url().max(500), z.literal('')])
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

export const weeklyOpeningHoursSchema = z.object(
  WEEKDAY_ORDER.reduce((shape, day) => {
    return {
      ...shape,
      [day]: dailyHoursSchema,
    };
  }, {} as Record<(typeof WEEKDAY_ORDER)[number], typeof dailyHoursSchema>),
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
  callSummaryEmail: optionalEmail,
});

export const callFeedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  reasons: z.array(z.string().min(1).max(200)).max(10).default([]),
  notes: z.string().max(2000).optional(),
});
