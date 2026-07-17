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
import { sendNegativeFeedbackEmail, sendCallSummaryEmail, sendPaymentSetupReminderEmail, sendArrearsCallNoticeEmail } from '../utils/email.js';
import { sendDiscordNotification, DISCORD_COLORS } from '../utils/discord.js';
import { notifyGarageUsers, garageUnreadBadge } from '../utils/push.js';
import { trackConfirmedBooking } from '../services/billing.js';
import { logCallToHubSpot } from '../services/hubspot.js';
import { analyzeCall, analyzeDeep } from '../services/callDiagnosis.js';
import { cloneHubspotSettings } from '../utils/types.js';

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

// Express's `qs` query parser turns MORE THAN 20 repeated params (garageIds=a&garageIds=b&…) into an
// OBJECT keyed by index ({"0":"a","1":"b",…}) instead of an array. With 20+ branches the all-branches
// filter hit this: Array.isArray() was false, the object got wrapped as a single non-string element,
// and every id was dropped (403 "No valid garage IDs"). Normalise array | index-object | single -> string[].
const normalizeGarageIds = (garageIds: unknown): string[] => {
  if (Array.isArray(garageIds)) {
    return garageIds.filter((v): v is string => typeof v === 'string');
  }
  if (garageIds && typeof garageIds === 'object') {
    return Object.values(garageIds as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
  }
  return typeof garageIds === 'string' ? [garageIds] : [];
};

// Backend safety net for the agent-side categoriser bug: when the agent tags
// a call as "message_only" / "other" / "unknown" / "general enquiry" while the
// agent's own bookingDetails string describes a real confirmed booking
// (e.g. "MOT booked for Monday 29th June at 08:00 AM"), this helper rescues
// the row. Looks for both a confirmation verb and a clock time.
type BookingCategory = 'service' | 'mot' | 'diagnostic' | 'other';

// Heuristics for rescuing mistagged bookings.
// Positive signals: a confirmation verb ("booked"/"scheduled"/etc.) and a clock time.
// Negative signals: phrases that mean the call was about a PRE-EXISTING booking
// (modify/cancel/enquire) or was only intent, not confirmation. Without the
// negative pass, an enquiry like "wants to cancel MOT booked at 5pm" or
// "his already-booked MOT" would be wrongly upgraded to "confirmed booking".
const POSITIVE_RE = /\b(booked|scheduled|confirmed|reserved)\b/i;
const TIME_RE = /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b|\b\d{1,2}:\d{2}\b/i;
// A DROP-OFF booking the agent placed, in the exact shape it writes them:
// "<service>, drop-off Wednesday 22nd July". It legitimately has NO confirmation verb and NO
// clock time — a drop-off is a DATE only by design ("never a specific time") — so the
// verb+time test above rejects every one of them. Barrys Wed 29 Jul and Sawans Wed 22 Jul
// both landed as message_only, while a remap the agent WRONGLY gave a 10:00 AM time sailed
// through: we were counting the bug and dropping the correct behaviour.
//
// Deliberately NARROW: "drop-off" must be followed directly by a weekday. Matching a bare
// "drop off" + any date lets through "will drop off vehicle between 8am" (intent, no agreed
// day) and, once the time requirement is relaxed, a pile of PRE-EXISTING bookings that only
// failed before for want of a clock time ("previously booked in for a service", "booked a
// diagnostics test online for Friday 17th", "rescheduling his scheduled appointment for next
// Tuesday"). Tested against 1100 real bookingDetails: this matches the 2 genuine drop-offs and
// none of those 5.
const DROPOFF_BOOKING_RE = /\bdrop[\s-]?off\s+(?:on\s+)?(?:mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)/i;
const NEGATIVE_RE = new RegExp(
  [
    'already[\\s-]+booked',
    'already[\\s-]+scheduled',
    'has (?:an? )?(?:mot|service|booking)[\\s\\w]{0,20}booked',
    'pre[\\s-]?existing booking',
    'wants? to cancel',
    'cancell?(?:ing|ation)',
    'wants? to (?:know|reschedule|change|move)',
    'asking (?:if|about|whether)',
    'inquired? about',
    'enquired? about',
    'wants? to book(?!ed)',
    'next available (?:weekday|day|slot)',
  ].join('|'),
  'i',
);

const detectBookingFromDetails = (
  bookingDetails?: string | null,
): { isBooking: boolean; category: BookingCategory | undefined } => {
  if (!bookingDetails) return { isBooking: false, category: undefined };
  const text = String(bookingDetails);
  // Two ways to qualify: a timed booking (verb + clock time), or a drop-off (date only).
  // NEGATIVE_RE still vetoes both below.
  const isTimedBooking = POSITIVE_RE.test(text) && TIME_RE.test(text);
  const isDropOffBooking = DROPOFF_BOOKING_RE.test(text);
  if (!isTimedBooking && !isDropOffBooking) return { isBooking: false, category: undefined };
  if (NEGATIVE_RE.test(text)) return { isBooking: false, category: undefined };

  // Infer category from the text. When MOT + service both appear, service wins
  // (the bigger ticket job) — mirrors how the agent categorises clean cases.
  const lower = text.toLowerCase();
  let category: BookingCategory | undefined;
  if (/\b(full service|interim service|major service|annual service|service)\b/.test(lower)) {
    category = 'service';
  } else if (/\bmot\b/.test(lower)) {
    category = 'mot';
  } else if (/\bdiagnos/.test(lower)) {
    category = 'diagnostic';
  }
  return { isBooking: true, category };
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

// Arrears gating: strip every content field from a parsed call so a restricted garage's own
// users see ONLY when the call happened and its tag. Everything that identifies the caller or
// reveals what was said/booked is nulled server-side (including roomName, which embeds the
// caller's number, and metrics, which can carry the AI diagnosis). Internal staff never hit this.
const redactRestrictedCall = (call: ReturnType<typeof parseCallJson>) => ({
  ...call,
  roomName: '',
  recordingUrl: null,
  recordingDurationSeconds: null,
  recordingCompletedAt: null,
  twilioCallSid: null,
  fromNumber: null,
  registrationNumber: null,
  customerName: null,
  customerPhone: null,
  capturedRevenue: null,
  bookingDetails: null,
  summary: '',
  transcript: [],
  metrics: {},
  emotionData: null,
  restricted: true,
});

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
    // If confirmedBooking is true, always classify as "confirmed booking".
    // Then a secondary safety net rescues calls the agent mis-tagged as
    // "message_only" / "other" / "unknown" / "general enquiry" when its own
    // bookingDetails clearly describes a confirmed booking. The agent has a
    // long-standing bug where the Step.MESSAGE_ONLY override (and a string
    // mismatch between "new_booking" and "booking" in the intent check)
    // suppresses the booking tag even when the booking went through.
    let callType = payload.callType || 'unknown';
    let confirmedBooking = payload.confirmedBooking ?? false;
    let confirmedBookingCategory = payload.confirmedBookingCategory;

    if (confirmedBooking) {
      callType = 'confirmed booking';
      console.log(`[CALL] Overriding callType to "confirmed booking" based on confirmedBooking=true`);
    } else {
      const MISTAG_CANDIDATES = new Set([
        'message_only', 'other', 'unknown', 'general enquiry', 'general_enquiry',
      ]);
      if (MISTAG_CANDIDATES.has(callType.toLowerCase())) {
        const detected = detectBookingFromDetails(payload.bookingDetails);
        if (detected.isBooking) {
          console.log(
            `[CALL] Reclassifying mistagged call: callType "${callType}" → "confirmed booking" ` +
            `(bookingDetails: "${String(payload.bookingDetails).slice(0, 140)}")`,
          );
          callType = 'confirmed booking';
          confirmedBooking = true;
          if (!confirmedBookingCategory) confirmedBookingCategory = detected.category;
        }
      }
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
        confirmedBooking,
        confirmedBookingCategory,
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
                agentName: true,
                voice: true,
                notificationEmails: true,
                integrationProviderConfig: true,
              },
            },
          },
        },
      },
    });

    // Stage 2 — automatic AI call diagnosis (gpt-4o-mini). Fire-and-forget so it never
    // delays the agent's webhook response; the verdict is merged into the call's metrics
    // JSON (metrics.diagnosis) for the portal to display. Runs on every call (cheap triage).
    void (async () => {
      try {
        const diag = await analyzeCall({
          transcript: payload.transcript,
          metrics: payload.metrics,
          summary: payload.summary,
          callType,
          confirmedBooking,
        });
        if (diag) {
          // Two-tier: when triage flags an issue, auto-escalate to the deep-dive (root cause + fix)
          // which reads the richer trace (GH bodies, tool inputs) with a stronger model.
          if (diag.status === 'issue') {
            const deep = await analyzeDeep({
              transcript: payload.transcript,
              metrics: payload.metrics,
              summary: payload.summary,
              callType,
              confirmedBooking,
              triage: { headline: diag.headline, detail: diag.detail },
            });
            if (deep) {
              diag.rootCause = deep.rootCause;
              diag.fix = deep.fix;
              diag.severity = deep.severity;
              diag.deepModel = deep.model;
            }
          }
          const base =
            payload.metrics && typeof payload.metrics === 'object' && !Array.isArray(payload.metrics)
              ? (payload.metrics as Record<string, unknown>)
              : {};
          await prisma.call.update({
            where: { id: createdCall.id },
            data: { metrics: { ...base, diagnosis: diag } as Prisma.InputJsonValue },
          });
          console.log(`[DIAGNOSIS] ${createdCall.id}: ${diag.status} — ${diag.headline}${diag.fix ? ' | fix: ' + diag.fix : ''}`);
        }
      } catch (err) {
        console.error('[DIAGNOSIS] post-call analysis failed:', err);
      }
    })();

    // Track confirmed booking for subscription activation. Use the post-safety-net
    // value so rescued mistagged bookings also count toward activation.
    if (confirmedBooking) {
      try {
        await trackConfirmedBooking(payload.garageId);
      } catch (error) {
        console.error('[BILLING] Failed to track confirmed booking:', error);
      }
    }

    // Log to HubSpot if configured
    const rawConfig = createdCall.garage?.agentConfiguration?.integrationProviderConfig;
    if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
      const cfg = rawConfig as Record<string, unknown>;
      const rawHubspot = (cfg.hubspot && typeof cfg.hubspot === 'object' && !Array.isArray(cfg.hubspot))
        ? cfg.hubspot as Record<string, unknown>
        : null;
      if (rawHubspot?.enabled === true && typeof rawHubspot.apiToken === 'string' && rawHubspot.apiToken) {
        const hubspotSettings = cloneHubspotSettings({
          enabled: true,
          apiToken: rawHubspot.apiToken,
          ownerId: typeof rawHubspot.ownerId === 'string' ? rawHubspot.ownerId : '',
          inboxEmail: typeof rawHubspot.inboxEmail === 'string' ? rawHubspot.inboxEmail : '',
        });
        void logCallToHubSpot({
          customerName: payload.customerName ?? null,
          customerPhone: payload.customerPhone ?? null,
          fromNumber: null,
          registrationNumber: payload.registrationNumber ?? null,
          summary: payload.summary,
          bookingDetails: payload.bookingDetails ?? null,
          confirmedBooking: payload.confirmedBooking ?? false,
          durationSeconds: actualDuration,
          callType: payload.callType ?? 'unknown',
          createdAt: new Date(),
          branchName: createdCall.garage?.agentConfiguration?.branchName ?? '',
          recordingUrl: payload.recordingUrl ?? null,
        }, hubspotSettings).catch((err: unknown) => {
          console.error('[HUBSPOT] Failed to log call:', err);
        });
      }
    }

    // Send notification email (agent already filtered to only send calls >= 30s)
    if (createdCall.garage?.agentConfiguration?.notificationEmails &&
        createdCall.garage.agentConfiguration.notificationEmails.length > 0) {
      console.log(`[EMAIL] Checking payment status for call ${callId} notification (duration ${actualDuration}s)`);

      // Check if any users with access to this garage need to set up payment
      const usersWithAccess = await prisma.user.findMany({
        where: {
          garageAccessIds: {
            has: payload.garageId
          }
        },
        select: {
          email: true,
          mustSetupPayment: true
        }
      });

      const userNeedsPaymentSetup = usersWithAccess.some(u => u.mustSetupPayment);
      const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

      if (createdCall.garage?.accessRestricted) {
        // Arrears: don't reveal any call content by email — just notify that a call was handled
        // and that the details are locked until the account is brought up to date.
        console.log(`[EMAIL] ⛔ Garage in arrears - sending arrears call notice (details withheld)`);

        void sendArrearsCallNoticeEmail(createdCall.garage.agentConfiguration.notificationEmails, {
          branchName: createdCall.garage.agentConfiguration.branchName,
          createdAt: createdCall.createdAt.toISOString(),
          portalUrl,
        }).catch((error) => {
          console.error('[EMAIL] Failed to send arrears call notice email:', error);
        });
      } else if (userNeedsPaymentSetup) {
        console.log(`[EMAIL] 💳 User(s) need payment setup - sending payment reminder email`);
        
        void sendPaymentSetupReminderEmail(createdCall.garage.agentConfiguration.notificationEmails, {
          branchName: createdCall.garage.agentConfiguration.branchName,
          summary: payload.summary,
          customerPhone: payload.customerPhone,
          createdAt: createdCall.createdAt.toISOString(),
          portalUrl,
        }).catch((error) => {
          console.error('[EMAIL] Failed to send payment reminder email:', error);
        });
      } else {
        console.log(`[EMAIL] ✅ Sending standard call summary email`);
        
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
    }

    // Mobile push: tell the garage's users their AI receptionist just handled a
    // call, with the summary as the body (iOS shows it in full when expanded).
    // Independent of email config — fire-and-forget, dormant until APNs creds set.
    {
      const cfg = createdCall.garage?.agentConfiguration;
      const personaName =
        (cfg?.agentName && cfg.agentName.trim()) ||
        (cfg?.voice ? cfg.voice.charAt(0).toUpperCase() + cfg.voice.slice(1) : '') ||
        'Your receptionist';
      // Arrears: withhold the summary from the push body too — just say a call was handled.
      const restricted = Boolean(createdCall.garage?.accessRestricted);
      const summary = (payload.summary || '').trim();
      const pushBody = restricted
        ? 'Your account is in arrears — settle up to view this call.'
        : summary || 'Tap to see the call details.';
      void (async () => {
        const badge = await garageUnreadBadge(payload.garageId);
        await notifyGarageUsers(payload.garageId, {
          title: `${personaName} handled a call for you`,
          body: pushBody,
          data: { type: 'call', callId, garageId: payload.garageId },
          badge,
        });
      })();
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
        const requestedGarageIds = normalizeGarageIds(garageIds);
        // RECEPTIONMATE_STAFF can access all requested garages, others only their assigned ones
        const validGarageIds = requestedGarageIds.filter(id => isStaff || allowedGarages.includes(id));
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

      // Arrears gating: for a garage's OWN users (never staff), redact calls belonging to any
      // garage flagged accessRestricted — they keep only date + tag. One query for the flags.
      let outCalls = parsedCalls;
      if (!isStaff && parsedCalls.length > 0) {
        const gids = Array.from(new Set(calls.map((c) => c.garageId)));
        const restricted = await prisma.garage.findMany({
          where: { id: { in: gids }, accessRestricted: true },
          select: { id: true },
        });
        if (restricted.length > 0) {
          const restrictedIds = new Set(restricted.map((g) => g.id));
          outCalls = parsedCalls.map((pc) =>
            restrictedIds.has((pc as { garageId: string }).garageId) ? redactRestrictedCall(pc) : pc,
          );
        }
      }

      res.json({
        calls: outCalls,
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

// Staff-only chat-agent observability: tool-call success rates per tool & per agent type,
// recent failures, and overall volume. Aggregated in SQL (groupBy) — never hydrates every row.
router.get('/staff/chat-tool-stats', authenticate, async (req: Request, res: Response) => {
  try {
    if (req.user?.role !== 'RECEPTIONMATE_STAFF') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { startDate, endDate } = req.query;
    if ((startDate && Array.isArray(startDate)) || (endDate && Array.isArray(endDate))) {
      return res.status(400).json({ error: 'Invalid query parameters' });
    }
    const dateFilter: Prisma.DateTimeFilter = {};
    if (typeof startDate === 'string' && startDate.trim()) {
      const d = new Date(startDate);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid startDate parameter' });
      dateFilter.gte = d;
    }
    if (typeof endDate === 'string' && endDate.trim()) {
      const d = new Date(endDate);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid endDate parameter' });
      dateFilter.lte = d;
    }
    const where: Prisma.ChatToolCallWhereInput = {};
    if (Object.keys(dateFilter).length > 0) where.createdAt = dateFilter;

    const [byTool, byAgent, overall, failures] = await Promise.all([
      prisma.chatToolCall.groupBy({
        by: ['agentType', 'toolName', 'success'],
        where,
        _count: { _all: true },
        _avg: { durationMs: true },
      }),
      prisma.chatToolCall.groupBy({ by: ['agentType', 'success'], where, _count: { _all: true } }),
      prisma.chatToolCall.groupBy({ by: ['success'], where, _count: { _all: true } }),
      prisma.chatToolCall.findMany({
        where: { ...where, success: false },
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, conversationId: true, garageId: true, agentType: true, toolName: true, errorMessage: true, durationMs: true, createdAt: true },
      }),
    ]);

    // Resolve garage names for the failures list.
    const garageIds = [...new Set(failures.map(f => f.garageId))];
    const garages = garageIds.length
      ? await prisma.garage.findMany({ where: { id: { in: garageIds } }, select: { id: true, name: true } })
      : [];
    const garageName = new Map(garages.map(g => [g.id, g.name]));

    // Per-tool roll-up (weighted avg latency across the success/fail split).
    const toolMap = new Map<string, { agentType: string; toolName: string; total: number; success: number; failed: number; _avgSum: number; _avgWeight: number }>();
    for (const row of byTool) {
      const key = `${row.agentType}::${row.toolName}`;
      const e = toolMap.get(key) || { agentType: row.agentType, toolName: row.toolName, total: 0, success: 0, failed: 0, _avgSum: 0, _avgWeight: 0 };
      const c = row._count._all;
      e.total += c;
      if (row.success) e.success += c; else e.failed += c;
      if (row._avg.durationMs != null) { e._avgSum += row._avg.durationMs * c; e._avgWeight += c; }
      toolMap.set(key, e);
    }
    const byToolOut = [...toolMap.values()]
      .map(e => ({
        agentType: e.agentType,
        toolName: e.toolName,
        total: e.total,
        success: e.success,
        failed: e.failed,
        successRate: e.total ? Math.round((e.success / e.total) * 100) : 0,
        avgMs: e._avgWeight ? Math.round(e._avgSum / e._avgWeight) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    // Per-agent-type roll-up.
    const agentMap = new Map<string, { agentType: string; total: number; success: number; failed: number }>();
    for (const row of byAgent) {
      const e = agentMap.get(row.agentType) || { agentType: row.agentType, total: 0, success: 0, failed: 0 };
      const c = row._count._all;
      e.total += c;
      if (row.success) e.success += c; else e.failed += c;
      agentMap.set(row.agentType, e);
    }
    const byAgentOut = [...agentMap.values()]
      .map(e => ({ ...e, successRate: e.total ? Math.round((e.success / e.total) * 100) : 0 }))
      .sort((a, b) => b.total - a.total);

    const overallTotal = overall.reduce((s, r) => s + r._count._all, 0);
    const overallSuccess = overall.filter(r => r.success).reduce((s, r) => s + r._count._all, 0);

    res.json({
      overall: {
        total: overallTotal,
        success: overallSuccess,
        failed: overallTotal - overallSuccess,
        successRate: overallTotal ? Math.round((overallSuccess / overallTotal) * 100) : 0,
      },
      byAgent: byAgentOut,
      byTool: byToolOut,
      recentFailures: failures.map(f => ({ ...f, garageName: garageName.get(f.garageId) || f.garageId })),
    });
  } catch (error) {
    console.error('[CALLS] GET /staff/chat-tool-stats error:', error);
    res.status(500).json({ error: 'Failed to fetch chat tool stats' });
  }
});

// Staff-only cross-garage leaderboard for the observability page: per-garage totals (calls,
// bookings, minutes, captured revenue) aggregated in SQL so we never hydrate every call row.
router.get('/staff/garage-stats', authenticate, async (req: Request, res: Response) => {
  try {
    if (req.user?.role !== 'RECEPTIONMATE_STAFF') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { startDate, endDate } = req.query;
    if ((startDate && Array.isArray(startDate)) || (endDate && Array.isArray(endDate))) {
      return res.status(400).json({ error: 'Invalid query parameters' });
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

    const where: Prisma.CallWhereInput = {};
    if (Object.keys(dateFilter).length > 0) {
      where.createdAt = dateFilter;
    }

    // One groupBy for calls/minutes/revenue, one for bookings (filtered) — both per garage.
    const [grouped, bookingGroup, garages] = await Promise.all([
      prisma.call.groupBy({
        by: ['garageId'],
        where,
        _count: { _all: true },
        _sum: { durationSeconds: true, capturedRevenue: true },
      }),
      prisma.call.groupBy({
        by: ['garageId'],
        where: { ...where, confirmedBooking: true },
        _count: { _all: true },
      }),
      prisma.garage.findMany({ select: { id: true, name: true } }),
    ]);

    const bookingByGarage = new Map(bookingGroup.map((g) => [g.garageId, g._count._all]));
    const nameById = new Map(garages.map((g) => [g.id, g.name]));

    const stats = grouped
      .map((g) => ({
        garageId: g.garageId,
        name: nameById.get(g.garageId) ?? g.garageId,
        callCount: g._count._all,
        bookingCount: bookingByGarage.get(g.garageId) ?? 0,
        totalDurationSeconds: g._sum.durationSeconds ?? 0,
        capturedRevenue: g._sum.capturedRevenue ?? 0,
      }))
      .sort((a, b) => b.callCount - a.callCount);

    res.json({ stats, totalGarages: garages.length });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Failed to fetch garage stats', error);
    }
    res.status(500).json({ error: 'Failed to fetch garage stats' });
  }
});

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
        const requestedGarageIds = normalizeGarageIds(garageIds);
        const validGarageIds = requestedGarageIds.filter((id) => isStaff || allowedGarages.includes(id));
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

      // Arrears gating: a restricted garage's own users get the redacted call (date + tag only).
      if (!isStaff) {
        const g = await prisma.garage.findUnique({
          where: { id: garageId },
          select: { accessRestricted: true },
        });
        if (g?.accessRestricted) {
          return res.json({ call: redactRestrictedCall(parseCallJson(call)) });
        }
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

// On-demand "analyse in depth" — re-run the AI call diagnosis with a stronger model
// (default gpt-4o) and store the new verdict in metrics.diagnosis. Used by the call-page button.
router.post('/calls/:id/analyze', authenticate, async (req: Request, res: Response) => {
  try {
    const call = await prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call) {
      return res.status(404).json({ error: 'not_found' });
    }
    const diagnosis = await analyzeCall({
      transcript: call.transcript,
      metrics: call.metrics,
      summary: call.summary ?? undefined,
      callType: call.callType ?? undefined,
      confirmedBooking: call.confirmedBooking,
      model: 'gpt-4o-mini',
    });
    if (!diagnosis) {
      return res.status(502).json({ error: 'analysis_unavailable' });
    }
    // The button always runs the deep-dive (root cause + fix) with the strong model.
    const deep = await analyzeDeep({
      transcript: call.transcript,
      metrics: call.metrics,
      summary: call.summary ?? undefined,
      callType: call.callType ?? undefined,
      confirmedBooking: call.confirmedBooking,
      triage: { headline: diagnosis.headline, detail: diagnosis.detail },
      model: typeof req.body?.model === 'string' && req.body.model ? req.body.model : 'gpt-4o',
    });
    if (deep) {
      diagnosis.rootCause = deep.rootCause;
      diagnosis.fix = deep.fix;
      diagnosis.severity = deep.severity;
      diagnosis.deepModel = deep.model;
    }
    const base =
      call.metrics && typeof call.metrics === 'object' && !Array.isArray(call.metrics)
        ? (call.metrics as Record<string, unknown>)
        : {};
    await prisma.call.update({
      where: { id: call.id },
      data: { metrics: { ...base, diagnosis } as Prisma.InputJsonValue },
    });
    return res.json({ diagnosis });
  } catch (err) {
    console.error('[DIAGNOSIS] on-demand analyze failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

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
    const isStaff = req.user?.role === 'RECEPTIONMATE_STAFF';
    if (!isStaff && !allowedGarages.includes(call.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Arrears gating: withhold recordings from a restricted garage's own users (staff unaffected).
    if (!isStaff && call.garage?.accessRestricted) {
      return res.status(403).json({ error: 'restricted', restricted: true });
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

    // Fetch from Twilio API with phone-based matching
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

    // Score all calls by duration similarity — no time window exclusion.
    // From+To filter already scopes to exact caller+garage, so duration picks
    // the right call if the same person called twice in one day.
    interface ScoredCall {
      twilioCall: any;
      durationDiff: number;
    }

    const scoredCalls: ScoredCall[] = [];

    for (const twilioCall of callsData.calls || []) {
      const twilioCallDuration = parseInt(twilioCall.duration || '0');
      const durationDiff = Math.abs(twilioCallDuration - call.durationSeconds);
      scoredCalls.push({ twilioCall, durationDiff });
    }

    // Sort by duration similarity (closest duration wins)
    scoredCalls.sort((a, b) => a.durationDiff - b.durationDiff);

    console.log(`[RECORDING] Found ${scoredCalls.length} candidate calls, matching by duration`);

    // Try candidates in order of best duration match
    for (const { twilioCall, durationDiff } of scoredCalls) {
      console.log(`[RECORDING] Checking CallSid ${twilioCall.sid}: durationDiff=${durationDiff}s (twilio=${twilioCall.duration}s, portal=${call.durationSeconds}s)`);

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

          console.log(`[RECORDING] SUCCESS: Found recording, durationDiff=${durationDiff}s`);

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

    // Stream the audio back to the client WITH HTTP Range support. iOS Safari /
    // the mobile WebView send a `Range` request for <audio> and refuse to play
    // unless the server answers 206 with Accept-Ranges/Content-Range. The old
    // code always replied 200 with the whole body, so recordings were silent on
    // iPhone (they worked on desktop Chrome, which is more lenient).
    const buffer = Buffer.from(await twilioResponse.arrayBuffer());
    const total = buffer.length;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="recording-${id}.mp3"`);
    res.setHeader('Accept-Ranges', 'bytes');

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      const start = match ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const safeEnd = Math.min(end, total - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${total}`);
      res.setHeader('Content-Length', safeEnd - start + 1);
      return res.end(buffer.subarray(start, safeEnd + 1));
    }

    res.setHeader('Content-Length', total);
    return res.end(buffer);
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
      return res.json({
        garages: garages.map((garage) => ({ id: garage.id, name: garage.name })),
        role: req.user.role,
        branchRoles: req.user.branchRoles ?? {},
      });
    }

    // Regular users see only their assigned garages
    // req.user is hydrated from the DB by authenticate(), so this is the CURRENT answer, not
    // whatever was true when they logged in.
    const allowedGarages = resolveAllowedGarages(req.user);
    if (allowedGarages.length === 0) {
      return res.json({ garages: [], role: req.user?.role, branchRoles: req.user?.branchRoles ?? {} });
    }

    const garages = await prisma.garage.findMany({
      where: { id: { in: allowedGarages } },
      orderBy: { name: 'asc' },
    });

    // branchRoles rides along so the browser can refresh its cached copy — the branch switcher
    // filters the list by it, and until now it could only be updated by logging in again.
    res.json({
      garages: garages.map((garage) => ({ id: garage.id, name: garage.name })),
      role: req.user?.role,
      branchRoles: req.user?.branchRoles ?? {},
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Failed to fetch garages', error);
    }
    res.status(500).json({ error: 'Failed to fetch garages' });
  }
});

// Toggle the "reviewed" flag on a flagged call. Stored inside metrics.reviewed so it rides
// along with the existing calls list (no schema change) and is shared across all staff. Staff only.
router.post('/calls/:id/reviewed', authenticate, async (req: Request, res: Response) => {
  try {
    if (req.user?.role !== 'RECEPTIONMATE_STAFF') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const call = await prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call) {
      return res.status(404).json({ error: 'not_found' });
    }
    const base =
      call.metrics && typeof call.metrics === 'object' && !Array.isArray(call.metrics)
        ? (call.metrics as Record<string, unknown>)
        : {};
    const reviewed =
      req.body?.reviewed === true
        ? { at: new Date().toISOString(), by: req.user?.email ?? req.user?.userId ?? 'staff' }
        : null;
    const nextMetrics: Record<string, unknown> = { ...base };
    if (reviewed) {
      nextMetrics.reviewed = reviewed;
    } else {
      delete nextMetrics.reviewed;
    }
    await prisma.call.update({
      where: { id: call.id },
      data: { metrics: nextMetrics as Prisma.InputJsonValue },
    });
    return res.json({ reviewed });
  } catch (err) {
    console.error('[REVIEWED] toggle failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Mark a call as VIEWED by the current user (opening its detail). Stored in metrics.viewedAt
// (no schema change), so a call counts as "unread" for the badge until it's opened. Any user
// with access to the call's garage can mark it; the flag is shared (first view clears it).
router.post('/calls/:id/viewed', authenticate, async (req: Request, res: Response) => {
  try {
    const call = await prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call) {
      return res.status(404).json({ error: 'not_found' });
    }
    const isStaff = req.user?.role === 'RECEPTIONMATE_STAFF';
    if (!isStaff) {
      const allowed = resolveAllowedGarages(req.user);
      if (!call.garageId || !allowed.includes(call.garageId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    const base =
      call.metrics && typeof call.metrics === 'object' && !Array.isArray(call.metrics)
        ? (call.metrics as Record<string, unknown>)
        : {};
    if (!base.viewedAt) {
      await prisma.call.update({
        where: { id: call.id },
        data: {
          metrics: { ...base, viewedAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[VIEWED] mark failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Unread badge counts for the mobile app: calls not yet opened + unread chat messages, across
// the user's accessible garages. Calls created before CALL_BADGE_SINCE are treated as already
// seen so the badge starts clean at launch (only new calls accrue until viewed).
const CALL_BADGE_SINCE = new Date(process.env.CALL_BADGE_SINCE || '2026-07-06T20:00:00Z');
router.get('/notifications/counts', authenticate, async (req: Request, res: Response) => {
  try {
    const isStaff = req.user?.role === 'RECEPTIONMATE_STAFF';
    // Badges are a garage-user feature; staff use desktop, so skip the (huge) all-garages count.
    const allowed = isStaff ? [] : resolveAllowedGarages(req.user);
    if (allowed.length === 0) {
      return res.json({ unreadCalls: 0, unreadMessages: 0 });
    }

    // Unread calls: not viewed, created since launch. metrics.viewedAt lives in JSON -> raw query.
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Call"
      WHERE "garageId" = ANY(${allowed}) AND "createdAt" >= ${CALL_BADGE_SINCE}
        AND ("metrics"->>'viewedAt') IS NULL`;
    const unreadCalls = Number(rows[0]?.n ?? 0);

    // Unread chat messages: sum of ChatConversation.unreadCount across accessible garages.
    const agg = await prisma.chatConversation.aggregate({
      where: { garageId: { in: allowed } },
      _sum: { unreadCount: true },
    });
    const unreadMessages = agg._sum.unreadCount ?? 0;

    return res.json({ unreadCalls, unreadMessages });
  } catch (err) {
    console.error('[COUNTS] failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
