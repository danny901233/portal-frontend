/**
 * Transcribe what was said AFTER a call was transferred to the garage's own staff.
 *
 * The agent deliberately stops transcribing at the handover: everything past that point is the
 * caller talking to a colleague, not to us, and the agent has switched its own audio off so it
 * cannot hear it anyway. The RECORDING keeps running though — LiveKit's room egress writes the
 * whole call to S3, and Twilio's own recording covers it too — so the conversation exists, it is
 * just never turned into text. Advanced Service Centre asked for it.
 *
 * Deliberately done AFTER the call from the recording rather than live. Keeping the agent's
 * microphone open through a transfer is what put it talking over a caller and her garage on call
 * 46797848; the comment in unified-agent/agent.py that disables the IO explains why that is the
 * only thing which makes it impossible. Nothing here touches the live path.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import OpenAI from 'openai';
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';

const BUCKET = () => process.env.S3_BUCKET || 'receptionmate-recordings';
const REGION = () => process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';

/** Whisper's hard limit is 25MB. A 20-minute call is comfortably under it; anything longer is
 *  skipped rather than failed, because a truncated transcript reads as a complete one. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const s3 = () => {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return new S3Client({ region: REGION(), credentials: { accessKeyId, secretAccessKey } });
};

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Did this call actually reach a human? Only a connected transfer is worth transcribing —
 *  a failed one has nothing after the handover but hold music. */
export const wasTransferConnected = (metrics: unknown): boolean => {
  const history = asObject(metrics).tool_call_history;
  if (!Array.isArray(history)) return false;
  return history.some(
    (t) =>
      asObject(t).tool === 'transfer_call' &&
      String(asObject(t).status ?? '').includes('STATUS: OK'),
  );
};

/** Pull the recording out of S3. Returns null for anything we cannot read — a missing
 *  transcript must never hold up the rest of the call record. */
const fetchRecording = async (recordingUrl: string): Promise<Buffer | null> => {
  const client = s3();
  if (!client) {
    console.warn('[XFER_TRANSCRIPT] S3 credentials not configured');
    return null;
  }
  try {
    const key = new URL(recordingUrl).pathname.replace(/^\//, '');
    const res = await client.send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
    const size = Number(res.ContentLength ?? 0);
    if (size > MAX_AUDIO_BYTES) {
      console.warn(`[XFER_TRANSCRIPT] ${key} is ${size} bytes — over Whisper's limit, skipping`);
      return null;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (err) {
    console.error('[XFER_TRANSCRIPT] could not fetch recording:', err);
    return null;
  }
};

/**
 * Transcribe one call's recording and keep the part that follows the handover.
 *
 * Whisper is asked for segments so the cut can be made on the clock rather than guessed at.
 * When we do not know where the handover fell, the whole thing is stored and labelled as such —
 * an over-long transcript is honest, a silently trimmed one is not.
 */
export const transcribeAfterTransfer = async (callId: string): Promise<boolean> => {
  if (!process.env.OPENAI_API_KEY) return false;

  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { id: true, garageId: true, recordingUrl: true, durationSeconds: true, metrics: true },
  });
  if (!call?.recordingUrl) return false;

  const metrics = asObject(call.metrics);
  if (!wasTransferConnected(metrics)) return false;
  if (asObject(metrics.post_transfer).text) return false; // already done

  const audio = await fetchRecording(call.recordingUrl);
  if (!audio) return false;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const ext = call.recordingUrl.endsWith('.mp4') ? 'mp4' : 'mp3';
    const file = new File([new Uint8Array(audio)], `call.${ext}`, {
      type: ext === 'mp4' ? 'audio/mp4' : 'audio/mpeg',
    });
    const out = (await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    })) as unknown as { text?: string; segments?: Array<{ start: number; text: string }> };

    // Where did the handover fall? The agent records its own last spoken moment; failing that,
    // fall back to the whole recording rather than inventing a cut point.
    const boundary = Number(metrics.transfer_at_seconds ?? NaN);
    const segments = Array.isArray(out.segments) ? out.segments : [];
    const known = Number.isFinite(boundary) && boundary > 0 && segments.length > 0;
    const kept = known ? segments.filter((s) => s.start >= boundary) : segments;
    const text = (kept.map((s) => s.text).join(' ').trim() || out.text || '').trim();
    if (!text) return false;

    await prisma.call.update({
      where: { id: call.id },
      data: {
        metrics: {
          ...metrics,
          post_transfer: {
            text,
            // Say plainly which of the two this is, so nobody reads a whole-call transcript as
            // if it were only the part after the handover.
            scope: known ? 'after-transfer' : 'whole-call',
            boundary_seconds: known ? boundary : null,
            transcribed_at: new Date().toISOString(),
            model: 'whisper-1',
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    console.log(`[XFER_TRANSCRIPT] ${call.id}: stored ${text.length} chars (${known ? 'after-transfer' : 'whole-call'})`);
    return true;
  } catch (err) {
    console.error('[XFER_TRANSCRIPT] transcription failed:', err);
    return false;
  }
};

/**
 * Sweep recently transferred calls that have no post-transfer transcript yet.
 *
 * Runs on a delay rather than at hang-up: the room egress file is not finalised the instant the
 * call ends, so transcribing immediately reads a partial object or none at all.
 */
export const sweepTransferredCalls = async (
  opts: { sinceHours?: number; limit?: number; garageId?: string } = {},
): Promise<{ considered: number; transcribed: number }> => {
  const since = new Date(Date.now() - (opts.sinceHours ?? 24) * 3600_000);
  const until = new Date(Date.now() - 10 * 60_000); // give egress 10 minutes to finalise
  const rows = await prisma.call.findMany({
    where: {
      createdAt: { gte: since, lte: until },
      recordingUrl: { not: null },
      ...(opts.garageId ? { garageId: opts.garageId } : {}),
    },
    select: { id: true, metrics: true },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
  });

  let considered = 0;
  let transcribed = 0;
  for (const row of rows) {
    const metrics = asObject(row.metrics);
    if (!wasTransferConnected(metrics)) continue;
    if (asObject(metrics.post_transfer).text) continue;
    considered += 1;
    if (await transcribeAfterTransfer(row.id)) transcribed += 1;
  }
  console.log(`[XFER_TRANSCRIPT] sweep: ${considered} transferred call(s) without a transcript, ${transcribed} done`);
  return { considered, transcribed };
};
