import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';
import { upsertAgentConfigurationSchema, weeklyOpeningHoursSchema } from '../utils/validators.js';
import {
  cloneWeeklyOpeningHours,
  createDefaultWeeklyOpeningHours,
} from '../utils/types.js';
import type {
  AgentConfigurationPayload,
  ResponseSpeed,
  WeeklyOpeningHours,
} from '../utils/types.js';

const router = Router();

const parseWeeklyOpeningHours = (value: unknown): WeeklyOpeningHours => {
  const parsed = weeklyOpeningHoursSchema.safeParse(value);
  if (parsed.success) {
    return cloneWeeklyOpeningHours(parsed.data);
  }
  return createDefaultWeeklyOpeningHours();
};

const defaultConfiguration: AgentConfigurationPayload = {
  branchName: '',
  phoneNumber: '',
  emailAddress: '',
  branchAddress: '',
  websiteUrl: '',
  weeklyOpeningHours: createDefaultWeeklyOpeningHours(),
  holidayClosures: '',
  greetingLine: '',
  tonePreference: 'standard' as const,
  responseSpeed: 'normal',
  interruptionSensitivity: 0.5,
  allowFastFitOnly: false,
  callSummaryEmail: '',
};
const sanitizeConfigForResponse = (config: AgentConfigurationPayload) => {
  const weeklyOpeningHours = config.weeklyOpeningHours
    ? cloneWeeklyOpeningHours(config.weeklyOpeningHours)
    : createDefaultWeeklyOpeningHours();

  return {
    ...config,
    phoneNumber: config.phoneNumber ?? '',
    emailAddress: config.emailAddress ?? '',
    branchAddress: config.branchAddress ?? '',
    websiteUrl: config.websiteUrl ?? '',
    weeklyOpeningHours,
    holidayClosures: config.holidayClosures ?? '',
    greetingLine: config.greetingLine ?? '',
    responseSpeed: config.responseSpeed ?? 'normal',
    interruptionSensitivity:
      typeof config.interruptionSensitivity === 'number'
        ? Math.min(1, Math.max(0, config.interruptionSensitivity))
        : 0.5,
    callSummaryEmail: config.callSummaryEmail ?? '',
  };
};

router.get(
  '/garages/:garageId/agent-config',
  authenticate,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);

    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const configuration = await prisma.agentConfiguration.findUnique({
      where: { garageId },
    });

    if (!configuration) {
      return res.json({ configuration: sanitizeConfigForResponse(defaultConfiguration) });
    }

    return res.json({
      configuration: sanitizeConfigForResponse({
        branchName: configuration.branchName,
        phoneNumber: configuration.phoneNumber,
        emailAddress: configuration.emailAddress,
        branchAddress: configuration.branchAddress,
        websiteUrl: configuration.websiteUrl,
        weeklyOpeningHours: parseWeeklyOpeningHours(configuration.weeklyOpeningHours),
        holidayClosures: configuration.holidayClosures,
        greetingLine: configuration.greetingLine,
        tonePreference: (configuration.tonePreference || 'standard') as 'standard' | 'upbeat' | 'professional',
        responseSpeed: (configuration.responseSpeed || 'normal') as ResponseSpeed,
        interruptionSensitivity:
          typeof configuration.interruptionSensitivity === 'number'
            ? Math.min(1, Math.max(0, configuration.interruptionSensitivity))
            : 0.5,
        allowFastFitOnly: configuration.allowFastFitOnly,
        callSummaryEmail: configuration.callSummaryEmail,
      }),
    });
  },
);

const sendAgentConfigWebhook = async (garageId: string, payload: Record<string, unknown>) => {
  const webhookUrl = process.env.AGENT_CONFIG_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.AGENT_CONFIG_WEBHOOK_SECRET) {
      headers['x-agent-config-secret'] = process.env.AGENT_CONFIG_WEBHOOK_SECRET;
    }

    await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ garageId, configuration: payload }),
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error('Failed to send agent configuration webhook', error);
    }
  }
};

router.put(
  '/garages/:garageId/agent-config',
  authenticate,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);

    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const parseResult = upsertAgentConfigurationSchema.safeParse(req.body);

    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.flatten() });
    }

    const data = parseResult.data;

    const normalizedWeeklyOpeningHours = data.weeklyOpeningHours
      ? cloneWeeklyOpeningHours(data.weeklyOpeningHours)
      : createDefaultWeeklyOpeningHours();

    const normalizedData = {
      branchName: data.branchName,
      phoneNumber: data.phoneNumber || null,
      emailAddress: data.emailAddress || null,
      branchAddress: data.branchAddress || null,
      websiteUrl: data.websiteUrl || null,
      weeklyOpeningHours: normalizedWeeklyOpeningHours,
      holidayClosures: data.holidayClosures || null,
      greetingLine: data.greetingLine || null,
      tonePreference: data.tonePreference,
      responseSpeed: (data.responseSpeed || 'normal') as ResponseSpeed,
      interruptionSensitivity:
        typeof data.interruptionSensitivity === 'number'
          ? Math.min(1, Math.max(0, data.interruptionSensitivity))
          : 0.5,
      allowFastFitOnly: data.allowFastFitOnly,
      callSummaryEmail: data.callSummaryEmail || null,
    };

    const configuration = await prisma.agentConfiguration.upsert({
      where: { garageId },
      update: normalizedData,
      create: {
        garageId,
        ...normalizedData,
      },
    });

    void sendAgentConfigWebhook(garageId, normalizedData);

    return res.json({
      configuration: sanitizeConfigForResponse({
        branchName: configuration.branchName,
        phoneNumber: configuration.phoneNumber,
        emailAddress: configuration.emailAddress,
        branchAddress: configuration.branchAddress,
        websiteUrl: configuration.websiteUrl,
        weeklyOpeningHours: parseWeeklyOpeningHours(configuration.weeklyOpeningHours),
        holidayClosures: configuration.holidayClosures,
        greetingLine: configuration.greetingLine,
        tonePreference: (configuration.tonePreference || 'standard') as 'standard' | 'upbeat' | 'professional',
        responseSpeed: (configuration.responseSpeed || 'normal') as ResponseSpeed,
        interruptionSensitivity:
          typeof configuration.interruptionSensitivity === 'number'
            ? Math.min(1, Math.max(0, configuration.interruptionSensitivity))
            : 0.5,
        allowFastFitOnly: configuration.allowFastFitOnly,
        callSummaryEmail: configuration.callSummaryEmail,
      }),
    });
  },
);

export default router;
