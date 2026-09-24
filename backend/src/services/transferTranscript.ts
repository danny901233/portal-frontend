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
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
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

const execFileP = promisify(execFile);

/**
 * Cut the recording at the handover BEFORE Whisper hears any of it.
 *
 * The first version sent the whole file and kept the segments after the boundary. Whisper
 * carries context forward, and on Advanced Service Centre call 84809921 it carried the plate
 * read-back from before the handover across the hold music and produced "E19JSS. E19JSS.
 * E19JSS." seven times over — while the same audio, cut at 78.5s and transcribed alone, came
 * back as the colleague and the caller sorting a booking date. Give it only what it should hear.
 * Returns null if ffmpeg is unavailable or fails, and the caller falls back to the old method.
 */
const sliceAfter = async (audio: Buffer, ext: string, boundarySeconds: number): Promise<Buffer | null> => {
  if (!ffmpegPath) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfer-'));
  const inPath = path.join(dir, `in.${ext}`);
  const outPath = path.join(dir, 'after.mp3');
  try {
    await fs.writeFile(inPath, audio);
    await execFileP(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', boundarySeconds.toFixed(2), '-i', inPath,
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', outPath,
    ], { timeout: 60_000 });
    return await fs.readFile(outPath);
  } catch (err) {
    console.warn('[XFER_TRANSCRIPT] could not cut the recording at the handover:', err);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

/** Whisper's failure mode on music and silence is the same short line over and over. Collapse
 *  consecutive repeats so a hallucination loop reads as one line, not a transcript. */
const collapseRepeats = (segments: Array<{ text: string }>): string[] => {
  const out: string[] = [];
  for (const seg of segments) {
    const t = seg.text.trim();
    if (!t) continue;
    const norm = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const prev = out.length ? out[out.length - 1].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
    if (norm && norm === prev) continue;
    out.push(t);
  }
  return out;
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
    // Where did the handover fall? The agent records its own last spoken moment. With it, cut
    // the audio there and transcribe only what follows; without it, the whole recording.
    const boundary = Number(metrics.transfer_at_seconds ?? NaN);
    const knownBoundary = Number.isFinite(boundary) && boundary > 0;
    const cut = knownBoundary ? await sliceAfter(audio, ext, boundary) : null;
    const file = cut
      ? new File([new Uint8Array(cut)], 'after.mp3', { type: 'audio/mpeg' })
      : new File([new Uint8Array(audio)], `call.${ext}`, { type: ext === 'mp4' ? 'audio/mp4' : 'audio/mpeg' });
    const out = (await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    })) as unknown as { text?: string; segments?: Array<{ start: number; text: string }> };

    const segments = Array.isArray(out.segments) ? out.segments : [];
    // Cut audio needs no filtering. Uncut audio with a known boundary keeps only what follows it
    // (the old method, still the fallback when ffmpeg is unavailable).
    const known = knownBoundary && (cut !== null || segments.length > 0);
    const kept = cut ? segments : known ? segments.filter((s) => s.start >= boundary) : segments;
    const text = (collapseRepeats(kept).join(' ').trim() || (cut ? '' : out.text || '')).trim();
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
