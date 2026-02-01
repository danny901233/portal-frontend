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

const csvEscape = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = String(value);
  if (!raw) {
    return '';
  }
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

const extractBookingDate = (bookingDetails?: string | null) => {
  if (!bookingDetails) {
    return '';
  }
  const labeledMatch = bookingDetails.match(/Date:\s*([^,\n]+)(?:,|\n|$)/i);
  if (labeledMatch) {
    return labeledMatch[1].trim();
  }
  const isoMatch = bookingDetails.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch) {
    return isoMatch[0];
  }
  return '';
};

const extractRegistrationFromText = (text?: string | null) => {
  if (!text) {
    return '';
  }
  const labeledMatch = text.match(/Registration:\s*([^,\n]+)(?:,|\n|$)/i);
  if (labeledMatch) {
    return labeledMatch[1].trim();
  }
  const vrnMatch = text.match(/\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b/i);
  if (vrnMatch) {
    return vrnMatch[0].replace(/\s+/g, '').toUpperCase();
  }
  return '';
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

    // Try to get recording URL from stored callback data by roomName (unique per call)
    let finalRecordingUrl = payload.recordingUrl;
    let finalRecordingDuration: number | null = null;
    let finalRecordingCompletedAt: Date | null = null;
    if (payload.roomName) {
      const storedRecording = await prisma.twilioRecording.findFirst({
        where: { roomName: payload.roomName },
      });
      if (storedRecording?.recordingSid) {
        console.log(`[RECORDING] Found stored recording for room ${payload.roomName}: ${storedRecording.recordingSid}`);
        finalRecordingUrl = storedRecording.recordingSid;
        finalRecordingDuration = storedRecording.recordingDurationSeconds ?? null;
        finalRecordingCompletedAt = storedRecording.completedAt ?? null;
      } else {
        console.log(`[RECORDING] No stored recording found yet for room ${payload.roomName}, will be null`);
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
        recordingDurationSeconds: finalRecordingDuration,
        recordingCompletedAt: finalRecordingCompletedAt,
        durationSeconds: payload.durationSeconds,
        callType,
        twilioCallSid: payload.twilioCallSid,
        registrationNumber: payload.registrationNumber,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone,
        confirmedBooking: payload.confirmedBooking ?? false,
        confirmedBookingCategory: payload.confirmedBookingCategory,
        capturedRevenue: payload.capturedRevenue ?? null,
        bookingDetails: payload.bookingDetails,
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
  '/garages/:garageId/confirmed-bookings.csv',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const isStaff = req.user?.role === 'RECEPTIONMATE_STAFF';
      const allowedGarages = isStaff ? [] : resolveAllowedGarages(req.user);

      if (!isStaff && !allowedGarages.includes(garageId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { startDate, endDate, garageIds } = req.query;

      if ((startDate && Array.isArray(startDate)) || (endDate && Array.isArray(endDate))) {
        return res.status(400).json({ error: 'Invalid query parameters' });
      }

      const where: Prisma.CallWhereInput = {
        OR: [{ confirmedBooking: true }, { callType: 'confirmed booking' }],
      };

      if (garageIds) {
        const requestedGarageIds = Array.isArray(garageIds) ? garageIds : [garageIds];
        const validGarageIds = requestedGarageIds
          .filter((id): id is string => typeof id === 'string')
          .filter((id) => isStaff || allowedGarages.includes(id));
        if (validGarageIds.length === 0) {
          return res.status(403).json({ error: 'No valid garage IDs provided' });
        }
        where.garageId = { in: validGarageIds };
      } else {
        where.garageId = garageId;
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
        select: {
          garage: { select: { name: true } },
          registrationNumber: true,
          summary: true,
          createdAt: true,
          bookingDetails: true,
          confirmedBookingCategory: true,
          capturedRevenue: true,
        },
      });

      const header = [
        'Garage Name',
        'Registration Number',
        'Call Date',
        'Date of Booking',
        'Work Booked',
        'Booking Value',
      ];

      const rows = calls.map((call) => {
        const bookingDate = extractBookingDate(call.bookingDetails ?? undefined);
        const workBooked = call.bookingDetails || call.confirmedBookingCategory || '';
        const derivedRegistration =
          call.registrationNumber ||
          extractRegistrationFromText(call.bookingDetails) ||
          extractRegistrationFromText(call.summary);
        const bookingValue =
          typeof call.capturedRevenue === 'number'
            ? call.capturedRevenue.toFixed(2)
            : '';
        return [
          call.garage?.name ?? '',
          derivedRegistration,
          call.createdAt.toISOString(),
          bookingDate,
          workBooked,
          bookingValue,
        ];
      });

      const csv = [header, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="confirmed-bookings-${garageId}.csv"`,
      );
      res.status(200).send(`${csv}\n`);
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Failed to export confirmed bookings CSV', error);
      }
      res.status(500).json({ error: 'Failed to export confirmed bookings' });
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

// Fetch Twilio recording URL for a specific call
router.get('/calls/:id/recording', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Fetch call with garage info
    const call = await prisma.call.findUnique({
      where: { id },
      include: { garage: true },
    });

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Check user has access to this garage
    const allowedGarages = resolveAllowedGarages(req.user);
    if (req.user?.role !== 'RECEPTIONMATE_STAFF' && !allowedGarages.includes(call.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // If we already have a recording URL, return it
    if (call.recordingUrl) {
      const recordingUrl = `/api/calls/${id}/recording/audio`;
      return res.json({ recordingUrl });
    }

    // Prefer Twilio CallSid matching if available
    if (call.twilioCallSid) {
      const twilioRecording = await prisma.twilioRecording.findUnique({
        where: { callSid: call.twilioCallSid },
      });
      let recordingSid = twilioRecording?.recordingSid ?? null;

      if (!recordingSid && twilioRecording?.recordingUrl) {
        const match = twilioRecording.recordingUrl.match(/Recordings\/([^/.]+)/i);
        if (match) {
          recordingSid = match[1];
        }
      }

      if (recordingSid) {
        await prisma.call.update({
          where: { id },
          data: { recordingUrl: recordingSid },
        });
        const recordingUrl = `/api/calls/${id}/recording/audio`;
        return res.json({ recordingUrl });
      }
    }

    // Otherwise, try to fetch from Twilio using customer phone (fallback only when no CallSid)
    if (call.twilioCallSid) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;

      if (!accountSid || !authToken) {
        console.error('[RECORDING] Twilio credentials not configured');
        return res.status(500).json({ error: 'Recording service not configured' });
      }

      const fetchRecordingForCallSid = async (callSid: string) => {
        const recordingsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json`;
        const recordingsResponse = await fetch(recordingsUrl, {
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          },
        });

        if (!recordingsResponse.ok) {
          return null;
        }

        const recordingsData = await recordingsResponse.json();
        if (!recordingsData.recordings || recordingsData.recordings.length === 0) {
          return null;
        }

        const recording = recordingsData.recordings[0];
        const recordingSid = recording.sid;
        const recordingResourceUrl = recording.uri
          ? `https://api.twilio.com${String(recording.uri).replace(/\.json$/i, '')}`
          : null;
        const durationSeconds = recording.duration ? Number.parseInt(recording.duration, 10) : null;
        const completedAt = recording.date_created ? new Date(recording.date_created) : new Date();

        return {
          recordingSid,
          recordingUrlForDb: recordingResourceUrl ?? recordingSid,
          durationSeconds,
          completedAt,
        };
      };

      let recordingInfo = await fetchRecordingForCallSid(call.twilioCallSid);
      if (!recordingInfo) {
        const callDetailsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.twilioCallSid}.json`;
        const callDetailsResponse = await fetch(callDetailsUrl, {
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          },
        });

        if (callDetailsResponse.ok) {
          const callDetails = await callDetailsResponse.json();
          const parentCallSid = callDetails.parent_call_sid;
          if (parentCallSid) {
            recordingInfo = await fetchRecordingForCallSid(parentCallSid);
          }
        }
      }

      if (recordingInfo) {
        const recordingUrl = `/api/calls/${id}/recording/audio`;

        await prisma.twilioRecording.upsert({
          where: { callSid: call.twilioCallSid },
          update: {
            recordingSid: recordingInfo.recordingSid,
            recordingUrl: recordingInfo.recordingUrlForDb,
            recordingDurationSeconds: Number.isNaN(recordingInfo.durationSeconds ?? NaN)
              ? null
              : recordingInfo.durationSeconds,
            completedAt: recordingInfo.completedAt,
          },
          create: {
            callSid: call.twilioCallSid,
            recordingSid: recordingInfo.recordingSid,
            recordingUrl: recordingInfo.recordingUrlForDb,
            recordingDurationSeconds: Number.isNaN(recordingInfo.durationSeconds ?? NaN)
              ? null
              : recordingInfo.durationSeconds,
            completedAt: recordingInfo.completedAt,
          },
        });

        await prisma.call.update({
          where: { id },
          data: {
            recordingUrl: recordingInfo.recordingSid,
            recordingDurationSeconds: Number.isNaN(recordingInfo.durationSeconds ?? NaN)
              ? null
              : recordingInfo.durationSeconds,
            recordingCompletedAt: recordingInfo.completedAt,
          },
        });

        return res.json({ recordingUrl });
      }

      return res.status(404).json({ error: 'Recording not available yet for this call' });
    }

    // Strategy 1: Try matching by roomName (most reliable - each call has unique room)
    if (call.roomName) {
      console.log(`[RECORDING] Strategy 1: Looking for roomName match: ${call.roomName}`);
      const existingRecording = await prisma.twilioRecording.findFirst({
        where: { roomName: call.roomName },
      });

      if (existingRecording?.recordingSid) {
        console.log(`[RECORDING] Strategy 1 SUCCESS: Found roomName match`);
        // Update call with recordingUrl
        await prisma.call.update({
          where: { id },
          data: {
            recordingUrl: existingRecording.recordingSid,
          },
        });
        return res.json({ recordingUrl: `/api/calls/${id}/recording/audio` });
      }
    }

    // Strategy 2: Fetch from Twilio API with smart matching
    if (!call.customerPhone) {
      return res.status(404).json({ error: 'No customer phone number available for this call' });
    }

    console.log(`[RECORDING] Strategy 2: Fetching from Twilio API for phone: ${call.customerPhone}`);

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      console.error('[RECORDING] Twilio credentials not configured');
      return res.status(500).json({ error: 'Recording service not configured' });
    }

    // Search for recent calls from this number
    const callsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json?From=${encodeURIComponent(call.customerPhone)}&PageSize=20`;
    const callsResponse = await fetch(callsUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
    });

    if (!callsResponse.ok) {
      console.error('[RECORDING] Failed to fetch Twilio calls:', callsResponse.status);
      return res.status(500).json({ error: 'Failed to fetch recording' });
    }

    const callsData = await callsResponse.json();

    // Find calls within 90 seconds, score by duration similarity
    const callTime = call.createdAt.getTime();
    const tightTolerance = 90 * 1000; // 90 seconds (safer window)
    const broadTolerance = 5 * 60 * 1000; // 5 minutes (fallback)

    interface ScoredCall {
      twilioCall: any;
      timeDiff: number;
      durationDiff: number;
      score: number;
    }

    const scoredCalls: ScoredCall[] = [];

    for (const twilioCall of callsData.calls || []) {
      const twilioCallTime = new Date(twilioCall.start_time).getTime();
      const timeDiff = Math.abs(twilioCallTime - callTime);

      // Only consider calls within broad tolerance
      if (timeDiff < broadTolerance) {
        const twilioCallDuration = parseInt(twilioCall.duration || '0');
        const durationDiff = Math.abs(twilioCallDuration - call.durationSeconds);

        // Score: lower is better (prefer close time + close duration)
        // Time is weighted more heavily (×1000) than duration
        const score = timeDiff + (durationDiff * 1000);

        scoredCalls.push({
          twilioCall,
          timeDiff,
          durationDiff,
          score,
        });
      }
    }

    // Sort by score (best match first)
    scoredCalls.sort((a, b) => a.score - b.score);

    console.log(`[RECORDING] Found ${scoredCalls.length} candidate calls within broad window`);

    // Try candidates in order of best score
    for (const { twilioCall, timeDiff, durationDiff, score } of scoredCalls) {
      const withinTightWindow = timeDiff < tightTolerance;
      console.log(`[RECORDING] Checking CallSid ${twilioCall.sid}: timeDiff=${timeDiff}ms, durationDiff=${durationDiff}s, score=${score}, inTightWindow=${withinTightWindow}`);

      // Check if this call has recordings
      const recordingsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${twilioCall.sid}/Recordings.json`;
      const recordingsResponse = await fetch(recordingsUrl, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        },
      });

      if (recordingsResponse.ok) {
        const recordingsData = await recordingsResponse.json();
        if (recordingsData.recordings && recordingsData.recordings.length > 0) {
          const recording = recordingsData.recordings[0];
          const recordingSid = recording.sid;

          console.log(`[RECORDING] Strategy 2 SUCCESS: Found recording with score=${score}`);

          // Store in TwilioRecording for future lookups
          await prisma.twilioRecording.upsert({
            where: { callSid: twilioCall.sid },
            create: {
              callSid: twilioCall.sid,
              recordingSid,
              recordingUrl: recording.uri,
              recordingDurationSeconds: parseInt(recording.duration || '0'),
              roomName: call.roomName,
              completedAt: new Date(recording.date_created),
            },
            update: {
              recordingSid,
              recordingUrl: recording.uri,
              recordingDurationSeconds: parseInt(recording.duration || '0'),
              roomName: call.roomName,
              completedAt: new Date(recording.date_created),
            },
          });

          // Update call with twilioCallSid for future exact matches
          await prisma.call.update({
            where: { id },
            data: {
              recordingUrl: recordingSid,
              twilioCallSid: twilioCall.sid,
            },
          });

          return res.json({ recordingUrl: `/api/calls/${id}/recording/audio` });
        }
      }
    }

    // No recording found
    console.log(`[RECORDING] No recording found after trying all strategies`);
    return res.status(404).json({ error: 'No recording found for this call' });
  } catch (error) {
    console.error('[RECORDING] Error fetching recording:', error);
    res.status(500).json({ error: 'Failed to fetch recording' });
  }
});

// Proxy endpoint to stream recording audio (no auth - call ID provides security)
router.get('/calls/:id/recording/audio', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const call = await prisma.call.findUnique({
      where: { id },
      include: { garage: true },
    });

    if (!call) {
      return res.status(404).send('Recording not found');
    }

    if (!call.recordingUrl) {
      return res.status(404).send('No recording available');
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return res.status(500).send('Recording service not configured');
    }

    // Fetch the recording from Twilio and stream it
    const recordingValue = call.recordingUrl;
    const twilioUrl = recordingValue.startsWith('http')
      ? `${recordingValue.replace(/\.mp3$/i, '')}.mp3`
      : `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingValue}.mp3`;
    
    const twilioResponse = await fetch(twilioUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
    });

    if (!twilioResponse.ok) {
      return res.status(404).send('Recording not found');
    }

    // Stream the audio back to the client
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="recording-${id}.mp3"`);
    
    const buffer = await twilioResponse.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('[RECORDING] Error streaming recording:', error);
    res.status(500).send('Failed to stream recording');
  }
});

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
