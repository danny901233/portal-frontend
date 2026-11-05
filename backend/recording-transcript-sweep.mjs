/**
 * Rebuild the CALLER's side of recent call transcripts from the call recording.
 *
 * Dan, 5 Nov 2026: "on a lot of our calls the transcript is not matching what was said out loud".
 * The live, streaming speech-to-text mishears callers (Elite 67195486: "Fair enough." for "Karina",
 * "x t v" for "XTB"); a batch pass over the finished recording does not. mergeRecordingTranscript
 * keeps the agent's lines and tool steps as logged and takes the caller's lines from the recording.
 * The live transcript is kept in metrics.transcript_live, so any call can be put back.
 *
 * Scheduled by pm2 cron-restart (every 10 minutes). Run from the backend dir so @prisma/client,
 * dotenv and the dist build resolve. Exits after each run.
 *
 *   node recording-transcript-sweep.mjs                 routine sweep (last 6 hours, untouched calls)
 *   node recording-transcript-sweep.mjs --hours=48      a wider window
 *   node recording-transcript-sweep.mjs --call=67195486 one call, whatever its state
 *   node recording-transcript-sweep.mjs --dry-run       report only, write nothing
 *   node recording-transcript-sweep.mjs --call=<id> --dry-run --show   print the merged conversation
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { mergeRecordingTranscript } from './dist/services/recordingTranscript.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const HOURS = Number(arg('hours', '6'));
const LIMIT = Number(arg('limit', '40'));
const ONE = arg('call', '');
const DRY_RUN = process.argv.includes('--dry-run');
const SHOW = process.argv.includes('--show');
const TIME_BUDGET_MS = 8 * 60 * 1000;            // inside the 10-minute cron window
const MIN_AGE_MS = 3 * 60 * 1000;                 // egress uploads after hang-up
const MAX_ATTEMPTS = 2;

const KEY = process.env.DEEPGRAM_API_KEY;
const REGION = process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';
const s3 = new S3Client({
  region: REGION,
  credentials: process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
    ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
    : undefined,
});
const prisma = new PrismaClient();
const log = (m) => console.log(`[rec-transcript] ${m}`);

const DG_URL = 'https://api.deepgram.com/v1/listen?model=nova-3&language=en-GB&diarize=true'
  + '&punctuate=true&utterances=true&smart_format=true';

async function recordingBytes(url) {
  const u = new URL(url);
  const bucket = u.hostname.split('.')[0];
  const key = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}

async function utterancesFor(bytes) {
  const res = await fetch(DG_URL, {
    method: 'POST',
    headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'audio/mp4' },
    body: bytes,
  });
  if (!res.ok) throw new Error(`deepgram ${res.status}`);
  const j = await res.json();
  return j?.results?.utterances || [];
}

async function main() {
  if (!KEY) { log('DEEPGRAM_API_KEY is not set — nothing to do'); return; }
  const started = Date.now();
  const where = ONE ? { id: ONE } : {
    createdAt: { gte: new Date(Date.now() - HOURS * 3600 * 1000), lte: new Date(Date.now() - MIN_AGE_MS) },
    recordingUrl: { not: null },
    durationSeconds: { gte: 15 },
  };
  const calls = await prisma.call.findMany({
    where, orderBy: { createdAt: 'desc' }, take: ONE ? 1 : LIMIT * 3,
    select: { id: true, recordingUrl: true, transcript: true, metrics: true },
  });
  let done = 0, skipped = 0, failed = 0;
  for (const c of calls) {
    if (Date.now() - started > TIME_BUDGET_MS || done >= LIMIT) break;
    const m = (c.metrics && typeof c.metrics === 'object') ? c.metrics : {};
    if (!ONE && (m.transcript_source === 'recording' || Number(m.transcript_recording_attempts || 0) >= MAX_ATTEMPTS)) continue;
    if (!c.recordingUrl || !Array.isArray(c.transcript) || !c.transcript.length) { skipped++; continue; }
    try {
      const live = Array.isArray(m.transcript_live) ? m.transcript_live : c.transcript;
      const merged = mergeRecordingTranscript(live, await utterancesFor(await recordingBytes(c.recordingUrl)),
        { transferAtSeconds: typeof m.transfer_at_seconds === 'number' ? m.transfer_at_seconds : null });
      if (!merged) {
        log(`${c.id}: recording did not line up with the call — left as it was`);
        if (!DRY_RUN) await prisma.call.update({ where: { id: c.id }, data: { metrics: { ...m,
          transcript_recording_attempts: Number(m.transcript_recording_attempts || 0) + 1 } } });
        skipped++;
        continue;
      }
      const callerLines = merged.filter((e) => e.type === 'message' && e.speaker === 'customer').length;
      log(`${c.id}: ${callerLines} caller line(s) from the recording${DRY_RUN ? ' (dry run)' : ''}`);
      if (SHOW) for (const e of merged) if (e.type === 'message') console.log(`   ${String(e.timestamp).padStart(6)} ${e.speaker === 'agent' ? 'A' : 'C'}: ${String(e.text).slice(0, 120)}`);
      if (!DRY_RUN) {
        await prisma.call.update({ where: { id: c.id }, data: {
          transcript: merged,
          metrics: { ...m, transcript_live: live, transcript_source: 'recording',
                     transcript_recording_at: new Date().toISOString() },
        } });
      }
      done++;
    } catch (e) {
      failed++;
      log(`${c.id}: ${e?.message || e}`);
      if (!DRY_RUN) await prisma.call.update({ where: { id: c.id }, data: { metrics: { ...m,
        transcript_recording_attempts: Number(m.transcript_recording_attempts || 0) + 1 } } }).catch(() => {});
    }
  }
  log(`done=${done} skipped=${skipped} failed=${failed} in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((e) => { log(`fatal: ${e?.message || e}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
