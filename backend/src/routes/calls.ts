import type { Call, CallFeedback, Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
import { sendNegativeFeedbackEmail, sendCallSummaryEmail } from '../utils/email.js';
import { sendDiscordNotification, DISCORD_COLORS } from '../utils/discord.js';
import { trackConfirmedBooking } from '../services/billing.js';

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

    // Log incoming payload to debug duration
    console.log('[CALL] Incoming webhook payload:', JSON.stringify({
      garageId: req.body.garageId,
      durationSeconds: req.body.durationSeconds,
      roomName: req.body.roomName,
      customerName: req.body.customerName,
      callType: req.body.callType,
    }));

    const parseResult = createCallSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.flatten() });
    }

    const payload = parseResult.data;

    // Try to get recording data from Twilio recording callback by twilioCallSid
    let finalRecordingUrl = payload.recordingUrl;
    let finalRecordingDuration: number | null = null;
    let finalRecordingCompletedAt: Date | null = null;
    if (payload.twilioCallSid) {
      const storedRecording = await prisma.twilioRecording.findFirst({
        where: { callSid: payload.twilioCallSid },
      });
      if (storedRecording?.recordingSid) {
        console.log(`[RECORDING] Found stored recording for CallSid ${payload.twilioCallSid}: ${storedRecording.recordingSid}`);
        console.log(`[RECORDING] Actual recording duration from Twilio: ${storedRecording.recordingDurationSeconds}s (agent reported: ${payload.durationSeconds}s)`);
        finalRecordingUrl = storedRecording.recordingSid;
        finalRecordingDuration = storedRecording.recordingDurationSeconds ?? null;
        finalRecordingCompletedAt = storedRecording.completedAt ?? null;
      } else {
        console.log(`[RECORDING] No stored recording found yet for CallSid ${payload.twilioCallSid}, using agent-reported duration: ${payload.durationSeconds}s`);
      }
    }

    // Use recording duration if available (actual call time), otherwise use agent-reported duration
    const actualDuration = finalRecordingDuration ?? payload.durationSeconds;

    // Skip calls under 30 seconds (dropped calls, wrong numbers, etc.)
    if (actualDuration < 30) {
      console.log(`[CALL] Skipping short call (${actualDuration}s) for garage ${payload.garageId} - under 30 second threshold`);
      return res.status(201).json({ success: true, callId: 'skipped', reason: 'Call duration under 30 seconds' });
    }

    await prisma.garage.upsert({
      where: { id: payload.garageId },
      create: {
        id: payload.garageId,
        name: payload.roomName.replace(/-.*/, ' Garage'),
      },
      update: {},
    });

    // Determine call type:
    // If confirmedBooking is true, always classify as "confirmed booking"
    // Otherwise use the AI classification from the agent
    let callType = payload.callType || 'unknown';
    if (payload.confirmedBooking === true) {
      callType = 'confirmed booking';
      console.log(`[CALL] Overriding callType to "confirmed booking" based on confirmedBooking=true`);
    }

    const callId = await generateUniqueCallId();

    const createdCall = await prisma.call.create({
      data: {
        id: callId,
        garageId: payload.garageId,
        roomName: payload.roomName,
        recordingUrl: finalRecordingUrl,
        recordingDurationSeconds: finalRecordingDuration,
        recordingCompletedAt: finalRecordingCompletedAt,
        durationSeconds: actualDuration,
        callType,
        twilioCallSid: payload.twilioCallSid,
        fromNumber: payload.fromNumber,
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
      include: {
        garage: {
          include: {
            agentConfiguration: {
              select: {
                branchName: true,
                notificationEmails: true,
              },
            },
          },
        },
      },
    });

    // Track confirmed booking for subscription activation
    if (payload.confirmedBooking) {
      try {
        await trackConfirmedBooking(payload.garageId);
      } catch (error) {
        console.error('[BILLING] Failed to track confirmed booking:', error);
      }
    }

    // Send notification email (agent already filtered to only send calls >= 30s)
    if (createdCall.garage?.agentConfiguration?.notificationEmails &&
        createdCall.garage.agentConfiguration.notificationEmails.length > 0) {
      console.log(`[EMAIL] Sending notification for call ${callId} with duration ${actualDuration}s`);

      void sendCallSummaryEmail(createdCall.garage.agentConfiguration.notificationEmails, {
        branchName: createdCall.garage.agentConfiguration.branchName,
        summary: payload.summary,
        transcript: payload.transcript as any,
        durationSeconds: actualDuration,
        callType: callType,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone,
        registrationNumber: payload.registrationNumber,
        confirmedBooking: payload.confirmedBooking ?? false,
        capturedRevenue: payload.capturedRevenue ?? null,
        createdAt: createdCall.createdAt.toISOString(),
        bookingDate: null,
        priceQuoted: payload.capturedRevenue ?? null,
      }).catch((error) => {
        console.error('[EMAIL] Failed to send notification email:', error);
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

      const { callType, startDate, endDate, garageIds, page, pageSize } = req.query;

      if (
        (callType && Array.isArray(callType)) ||
        (startDate && Array.isArray(startDate)) ||
        (endDate && Array.isArray(endDate)) ||
        (page && Array.isArray(page)) ||
        (pageSize && Array.isArray(pageSize))
      ) {
        return res.status(400).json({ error: 'Invalid query parameters' });
      }

      // Parse pagination parameters
      const currentPage = typeof page === 'string' ? Math.max(1, parseInt(page, 10)) : 1;
      const itemsPerPage = typeof pageSize === 'string' ? Math.min(50000, Math.max(1, parseInt(pageSize, 10))) : 100;
      const skip = (currentPage - 1) * itemsPerPage;

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

      // Get total count for pagination
      const totalCount = await prisma.call.count({ where });
      const totalPages = Math.ceil(totalCount / itemsPerPage);

      // Fetch paginated calls
      const calls = await prisma.call.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { feedback: true },
        skip,
        take: itemsPerPage,
      });

      const parsedCalls = calls.map((call: Call & { feedback?: CallFeedback | null }) => parseCallJson(call));

      res.json({ 
        calls: parsedCalls,
        pagination: {
          page: currentPage,
          pageSize: itemsPerPage,
          total: totalCount,
          totalPages,
        },
      });
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

      // Send notifications for negative feedback
      if (rating === 'down') {
        const fields = [
          { name: 'Branch', value: call.garage.name, inline: true },
          { name: 'Call ID', value: callId, inline: true },
          { name: 'Duration', value: call.durationSeconds ? `${call.durationSeconds}s` : 'n/a', inline: true },
        ];
        if (call.callType) fields.push({ name: 'Type', value: call.callType, inline: true });
        if (call.customerPhone) fields.push({ name: 'Caller', value: call.customerPhone, inline: true });
        if (normalizedReasons.length) fields.push({ name: 'Reasons', value: normalizedReasons.join(', '), inline: false });
        if (sanitizedNotes) fields.push({ name: 'Notes', value: sanitizedNotes, inline: false });

        void sendDiscordNotification({
          title: 'Negative Call Rating',
          description: `A call at **${call.garage.name}** was rated thumbs down.`,
          color: DISCORD_COLORS.error,
          fields,
        }).catch((error) => {
          console.error('Failed to send Discord notification:', error);
        });

        if (req.user?.email) {
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
    // Prefer fromNumber (full E.164) over customerPhone (may be partial/truncated)
    let phoneForTwilioLookup = call.fromNumber || call.customerPhone;
    if (!phoneForTwilioLookup) {
      return res.status(404).json({ error: 'No customer phone number available for this call' });
    }

    // Normalize UK phone numbers to E.164 format for Twilio lookup
    // Twilio stores numbers as +447xxx but database may have 07xxx
    if (phoneForTwilioLookup.startsWith('0') && phoneForTwilioLookup.length >= 10) {
      // UK number without country code: 07xxx -> +447xxx
      phoneForTwilioLookup = '+44' + phoneForTwilioLookup.substring(1);
      console.log(`[RECORDING] Normalized UK phone to E.164: ${phoneForTwilioLookup}`);
    }

    console.log(`[RECORDING] Strategy 2: Fetching from Twilio API for phone: ${phoneForTwilioLookup}`);

    // CRITICAL SECURITY FIX: Get garage's ReceptionMate number to validate recording matches
    const garage = await prisma.garage.findUnique({
      where: { id: call.garageId },
      select: { twilioNumber: true },
    });

    if (!garage?.twilioNumber) {
      console.error('[RECORDING] Cannot fetch recording: garage ReceptionMate number not configured');
      return res.status(404).json({ 
        error: 'Recording not available: garage ReceptionMate number not configured' 
      });
    }

    let garagePhoneNumber = garage.twilioNumber;
    console.log(`[RECORDING] ReceptionMate number: ${garagePhoneNumber}`);
    
    // Normalize garage phone to E.164 format for Twilio API
    garagePhoneNumber = garagePhoneNumber.replace(/\s+/g, ''); // Remove spaces
    if (!garagePhoneNumber.startsWith('+')) {
      // Add + prefix if missing (e.g., "441603249593" -> "+441603249593")
      if (garagePhoneNumber.startsWith('44')) {
        garagePhoneNumber = '+' + garagePhoneNumber;
      } else if (garagePhoneNumber.startsWith('0') && garagePhoneNumber.length >= 10) {
        // UK number without country code: 01905xxx -> +441905xxx
        garagePhoneNumber = '+44' + garagePhoneNumber.substring(1);
      }
      console.log(`[RECORDING] Normalized ReceptionMate number to E.164: ${garagePhoneNumber}`);
    }
    
    console.log(`[RECORDING] Validating recordings match garage number: ${garagePhoneNumber}`);

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      console.error('[RECORDING] Twilio credentials not configured');
      return res.status(500).json({ error: 'Recording service not configured' });
    }

    // Search for recent calls TO this specific garage, filtered by caller phone when available
    let callsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json?To=${encodeURIComponent(garagePhoneNumber)}&PageSize=20`;
    if (phoneForTwilioLookup) {
      callsUrl += `&From=${encodeURIComponent(phoneForTwilioLookup)}`;
      console.log(`[RECORDING] Including From filter: ${phoneForTwilioLookup}`);
    }
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

      // CRITICAL SECURITY: Verify this call was TO our garage's number
      // Prevents cross-garage contamination when same customer calls multiple garages
      // Normalize both numbers for comparison (remove all spaces/formatting)
      const normalizedTwilioTo = twilioCall.to.replace(/\s+/g, '');
      const normalizedGaragePhone = garagePhoneNumber.replace(/\s+/g, '');
      
      if (normalizedTwilioTo !== normalizedGaragePhone) {
        console.log(`[RECORDING] ❌ REJECTED: Call ${twilioCall.sid} was to ${twilioCall.to} (normalized: ${normalizedTwilioTo}), not our garage ${garagePhoneNumber} (normalized: ${normalizedGaragePhone})`);
        continue;
      }
      console.log(`[RECORDING] ✅ Validated: Call ${twilioCall.sid} was to correct garage ${garagePhoneNumber}`);

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

// Proxy endpoint to stream recording audio - no auth required (security via obscure call IDs)
// Note: Browser <audio> tags can't send auth headers, so we rely on call ID being hard to guess
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

    // Note: No explicit auth check here because:
    // 1. Browser <audio> tags can't send auth headers through Next.js rewrites
    // 2. Call IDs are large numeric values that are hard to guess
    // 3. Access control is enforced when fetching the call list (only shows user's garage calls)

    if (!call.recordingUrl) {
      return res.status(404).send('No recording available');
    }

    const recordingValue = call.recordingUrl;

    // S3 recordings — fetch securely using AWS SDK
    if (recordingValue.startsWith('http') && recordingValue.includes('amazonaws.com')) {
      const awsAccessKey = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
      const awsSecretKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
      const awsRegion = process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';
      const s3Bucket = process.env.S3_BUCKET || 'receptionmate-recordings';

      if (!awsAccessKey || !awsSecretKey) {
        return res.status(500).send('S3 recording service not configured');
      }

      // Extract S3 object key from URL
      const url = new URL(recordingValue);
      const s3Key = url.pathname.replace(/^\//, '');

      const s3Client = new S3Client({
        region: awsRegion,
        credentials: { accessKeyId: awsAccessKey, secretAccessKey: awsSecretKey },
      });

      const signedUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
        { expiresIn: 3600 }
      );

      return res.redirect(302, signedUrl);
    }

    // Twilio recording (SID or twilio.com URL)
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return res.status(500).send('Recording service not configured');
    }

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
