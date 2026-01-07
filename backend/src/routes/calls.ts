import type { Call, CallFeedback, Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { callFeedbackSchema, createCallSchema } from '../utils/validators.js';
import { classifyCallCategory } from '../utils/callClassifier.js';
import type {
  CallWithParsedJson,
  MetricsRecord,
  SerializedCallFeedback,
  TranscriptEntry,
} from '../utils/types.js';
import { resolveAllowedGarages } from '../utils/auth.js';
import { sendCallSummaryEmail, sendNegativeFeedbackEmail } from '../utils/email.js';

const router = Router();

const CALL_ID_LENGTH = 8;

const generateCandidateCallId = () => randomInt(0, 10 ** CALL_ID_LENGTH).toString().padStart(CALL_ID_LENGTH, '0');

const generateUniqueCallId = async () => {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateCandidateCallId();
    const existing = await prisma.call.findUnique({ where: { id: candidate } });
    if (!existing) {
      return candidate;
    }
  }
  throw new Error('Failed to generate unique call identifier');
};

const serializeCallFeedback = (feedback?: CallFeedback | null): SerializedCallFeedback | null => {
  if (!feedback) {
    return null;
  }

  return {
    id: feedback.id,
    callId: feedback.callId,
    rating: feedback.rating === 'up' ? 'up' : 'down',
    reasons: Array.isArray(feedback.reasons) ? [...feedback.reasons] : [],
    notes: feedback.notes ?? null,
    createdAt: feedback.createdAt.toISOString(),
    updatedAt: feedback.updatedAt.toISOString(),
  };
};

const parseCallJson = (call: Call & { feedback?: CallFeedback | null }): CallWithParsedJson => {
  const { feedback, ...rest } = call;
  const metricsCandidate = rest.metrics as Prisma.JsonValue;
  const transcriptCandidate = rest.transcript as Prisma.JsonValue;

  const metrics: MetricsRecord =
    metricsCandidate && typeof metricsCandidate === 'object' && !Array.isArray(metricsCandidate)
      ? (metricsCandidate as MetricsRecord)
      : {};

  const transcript: TranscriptEntry[] = Array.isArray(transcriptCandidate)
    ? (transcriptCandidate as TranscriptEntry[])
    : [];

  return {
    ...rest,
    metrics,
    transcript,
    feedback: serializeCallFeedback(feedback ?? null),
  };
};

const ensureWebhookSecret = (req: Request) => {
  const configuredSecret = process.env.WEBHOOK_SECRET;
  if (!configuredSecret) {
    return true;
  }
  const headerSecret =
    req.headers['x-webhook-secret'] ??
    req.headers['webhook-secret'] ??
    req.headers['x-webhook_secret'];

  if (Array.isArray(headerSecret)) {
    return headerSecret.includes(configuredSecret);
  }

  return headerSecret === configuredSecret;
};

router.post('/calls', async (req: Request, res: Response) => {
  try {
    if (!ensureWebhookSecret(req)) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const parseResult = createCallSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.flatten() });
    }

    const payload = parseResult.data;

    // If Twilio CallSid provided, try to get recording URL from callback data
    let finalRecordingUrl = payload.recordingUrl;
    if (payload.twilioCallSid && global.twilioRecordings) {
      const recordingData = global.twilioRecordings.get(payload.twilioCallSid);
      if (recordingData?.recordingUrl) {
        console.log(`[RECORDING] Found Twilio recording for CallSid ${payload.twilioCallSid}:`, recordingData.recordingUrl);
        finalRecordingUrl = recordingData.recordingUrl;
        // Clean up the map entry
        global.twilioRecordings.delete(payload.twilioCallSid);
      } else {
        console.log(`[RECORDING] No recording found yet for CallSid ${payload.twilioCallSid}, will be null`);
      }
    }

    await prisma.garage.upsert({
      where: { id: payload.garageId },
      create: {
        id: payload.garageId,
        name: payload.roomName.replace(/-.*/, ' Garage'),
      },
      update: {},
    });

    // Use AI classification from agent directly (no pattern matching override)
    const callType = payload.callType || 'unknown';

    const callId = await generateUniqueCallId();

    await prisma.call.create({
      data: {
        id: callId,
        garageId: payload.garageId,
        roomName: payload.roomName,
        recordingUrl: finalRecordingUrl,
        durationSeconds: payload.durationSeconds,
        callType,
        registrationNumber: payload.registrationNumber,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone,
        confirmedBooking: payload.confirmedBooking ?? false,
        confirmedBookingCategory: payload.confirmedBookingCategory,
        capturedRevenue: payload.capturedRevenue ?? null,
        metrics: payload.metrics,
        transcript: payload.transcript,
        summary: payload.summary,
        ...(payload.emotionData && { emotionData: payload.emotionData }),
      },
    });

    // Send notification emails asynchronously
    const agentConfiguration = await prisma.agentConfiguration.findUnique({
      where: { garageId: payload.garageId },
      select: { 
        branchName: true,
        notificationEmails: true,
      },
    });

    if (agentConfiguration?.notificationEmails && agentConfiguration.notificationEmails.length > 0) {
      void sendCallSummaryEmail(agentConfiguration.notificationEmails, {
        branchName: agentConfiguration.branchName,
        summary: payload.summary,
        transcript: payload.transcript,
        durationSeconds: payload.durationSeconds,
        callType,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone,
        registrationNumber: payload.registrationNumber,
        confirmedBooking: payload.confirmedBooking,
        capturedRevenue: payload.capturedRevenue,
        createdAt: new Date().toISOString(),
        bookingDate: null, // Not currently captured
        priceQuoted: payload.capturedRevenue, // Use captured revenue as price quoted for now
      }).catch((error) => {
        console.error('Failed to send notification email:', error);
      });
    }

    res.status(201).json({ success: true, callId });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Failed to create call', error);
    }
    res.status(500).json({ error: 'Failed to create call' });
  }
});

router.get(
  '/garages/:garageId/calls',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const isStaff = req.user?.role === 'RECEPTIONMATE_STAFF';
      const allowedGarages = isStaff ? [] : resolveAllowedGarages(req.user);

      // RECEPTIONMATE_STAFF can access any garage, others must have explicit access
      if (!isStaff && !allowedGarages.includes(garageId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { callType, startDate, endDate, garageIds } = req.query;

      if (
        (callType && Array.isArray(callType)) ||
        (startDate && Array.isArray(startDate)) ||
        (endDate && Array.isArray(endDate))
      ) {
        return res.status(400).json({ error: 'Invalid query parameters' });
      }

      const where: Prisma.CallWhereInput = {};

      // If garageIds filter is provided, use it (for "all assigned branches")
      if (garageIds) {
        const requestedGarageIds = Array.isArray(garageIds) ? garageIds : [garageIds];
        // RECEPTIONMATE_STAFF can access all requested garages, others only their assigned ones
        const validGarageIds = requestedGarageIds
          .filter((id): id is string => typeof id === 'string')
          .filter(id => isStaff || allowedGarages.includes(id));
        if (validGarageIds.length === 0) {
          return res.status(403).json({ error: 'No valid garage IDs provided' });
        }
        where.garageId = { in: validGarageIds };
      } else {
        // Single garage mode
        where.garageId = garageId;
      }

      if (typeof callType === 'string') {
        const normalizedType = callType.trim().toLowerCase();
        if (normalizedType && normalizedType !== 'all') {
          where.callType = normalizedType;
        }
      }

      const dateFilter: Prisma.DateTimeFilter = {};

      if (typeof startDate === 'string' && startDate.trim()) {
        const parsedStart = new Date(startDate);
        if (Number.isNaN(parsedStart.getTime())) {
          return res.status(400).json({ error: 'Invalid startDate parameter' });
        }
        dateFilter.gte = parsedStart;
      }

      if (typeof endDate === 'string' && endDate.trim()) {
        const parsedEnd = new Date(endDate);
        if (Number.isNaN(parsedEnd.getTime())) {
          return res.status(400).json({ error: 'Invalid endDate parameter' });
        }
        dateFilter.lte = parsedEnd;
      }

      if (Object.keys(dateFilter).length > 0) {
        where.createdAt = dateFilter;
      }

      const calls = await prisma.call.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { feedback: true },
      });

      const parsedCalls = calls.map((call: Call & { feedback?: CallFeedback | null }) => parseCallJson(call));

      res.json({ calls: parsedCalls });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Failed to fetch calls', error);
      }
      res.status(500).json({ error: 'Failed to fetch calls' });
    }
  },
);

router.get(
  '/garages/:garageId/calls/:callId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId, callId } = req.params;
      const isStaff = req.user?.role === 'RECEPTIONMATE_STAFF';
      const allowedGarages = isStaff ? [] : resolveAllowedGarages(req.user);

      // RECEPTIONMATE_STAFF can access any garage, others must have explicit access
      if (!isStaff && !allowedGarages.includes(garageId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const call = await prisma.call.findFirst({
        where: { id: callId, garageId },
        include: { feedback: true },
      });

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      res.json({ call: parseCallJson(call) });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Failed to fetch call', error);
      }
      res.status(500).json({ error: 'Failed to fetch call' });
    }
  },
);

router.post(
  '/garages/:garageId/calls/:callId/feedback',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId, callId } = req.params;
      const isStaff = req.user?.role === 'RECEPTIONMATE_STAFF';
      const allowedGarages = isStaff ? [] : resolveAllowedGarages(req.user);

      // RECEPTIONMATE_STAFF can access any garage, others must have explicit access
      if (!isStaff && !allowedGarages.includes(garageId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const call = await prisma.call.findFirst({
        where: { id: callId, garageId },
        include: { garage: true },
      });

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      const parseResult = callFeedbackSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: parseResult.error.flatten() });
      }

      const { rating, reasons, notes } = parseResult.data;
      const normalizedReasons = Array.from(new Set((reasons ?? []).map((reason) => reason.trim()).filter(Boolean)));
      const sanitizedNotes = notes?.trim() ? notes.trim() : null;

      const feedback = await prisma.callFeedback.upsert({
        where: { callId },
        update: {
          rating,
          reasons: normalizedReasons,
          notes: sanitizedNotes,
        },
        create: {
          callId,
          rating,
          reasons: normalizedReasons,
          notes: sanitizedNotes,
        },
      });

      // Send email notification for negative feedback
      if (rating === 'down' && req.user?.email) {
        void sendNegativeFeedbackEmail({
          branchName: call.garage.name,
          callId,
          rating: 'down',
          reasons: normalizedReasons,
          notes: sanitizedNotes,
          userEmail: req.user.email,
          submittedAt: new Date().toISOString(),
        }).catch((error) => {
          console.error('Failed to send negative feedback email:', error);
        });
      }

      res.json({ feedback: serializeCallFeedback(feedback) });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Failed to upsert call feedback', error);
      }
      res.status(500).json({ error: 'Failed to save call feedback' });
    }
  },
);

router.get('/garages', authenticate, async (req: Request, res: Response) => {
  try {
    // RECEPTIONMATE_STAFF can see all garages
    if (req.user?.role === 'RECEPTIONMATE_STAFF') {
      const garages = await prisma.garage.findMany({
        orderBy: { name: 'asc' },
      });
      return res.json({ garages: garages.map((garage) => ({ id: garage.id, name: garage.name })) });
    }

    // Regular users see only their assigned garages
    const allowedGarages = resolveAllowedGarages(req.user);
    if (allowedGarages.length === 0) {
      return res.json({ garages: [] });
    }

    const garages = await prisma.garage.findMany({
      where: { id: { in: allowedGarages } },
      orderBy: { name: 'asc' },
    });

    res.json({ garages: garages.map((garage) => ({ id: garage.id, name: garage.name })) });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Failed to fetch garages', error);
    }
    res.status(500).json({ error: 'Failed to fetch garages' });
  }
});

export default router;
