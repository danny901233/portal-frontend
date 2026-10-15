/**
 * Move the moov atom to the front of call recordings, so a click plays instead of waiting.
 *
 * LiveKit egress writes MP4 with the moov atom at the END of the file — it has to, because it is
 * streaming and does not know the duration until the call stops. The cost lands on the browser:
 * before it can play a single second it must find the moov, so it fetches the head, misses, then
 * ranges for the tail, then finally streams. Two extra round trips on every play, and on the
 * calls list it was far worse than that — twenty <audio> elements each reading to the end of a
 * multi-megabyte file just to label a scrubber, ~32MB before anyone clicked anything. That is
 * also what kept exhausting the shared S3 socket pool when those fetches were cancelled.
 *
 * Egress has no faststart option, so the fix is a remux afterwards: `-c copy -movflags +faststart`
 * rewrites the container with moov first and does NOT re-encode, so it is lossless and takes about
 * 40ms for a two-minute call.
 *
 * Scheduled by pm2 cron-restart, like agent-watchdog. Run from the backend dir so @prisma/client,
 * dotenv and ffmpeg-static resolve. Exits after each run.
 *
 *   node faststart-sweep.cjs                 routine sweep (last 1 day, whatever is untagged)
 *   node faststart-sweep.cjs --days=30       backfill a wider window
 *   node faststart-sweep.cjs --dry-run       report only, write nothing
 *   node faststart-sweep.cjs --limit=500     cap the number of objects touched
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { PrismaClient } = require('@prisma/client');
const { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const ffmpegPath = require('ffmpeg-static');

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();

// ---- config ----
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const DAYS = Number(arg('days', '1'));
const LIMIT = Number(arg('limit', '400'));
const DRY_RUN = process.argv.includes('--dry-run');

// Keep a run inside the 5-minute cron window so two sweeps never overlap on a 3.8GB box.
const TIME_BUDGET_MS = Number(arg('budget', String(4 * 60 * 1000)));

// Egress uploads the finished file in one go, but give it a moment rather than racing the write.
const MIN_AGE_MS = 2 * 60 * 1000;

// The moov has to land inside what a browser grabs on its first read for any of this to be worth
// doing, and it is the same window we search to decide a file is already done.
const HEAD_PROBE_BYTES = 64 * 1024;

const BUCKET = process.env.S3_BUCKET || 'receptionmate-recordings';
const REGION = process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';

// PutObject needs the explicit S3_ key. The box's default credential chain resolves to a
// read-only IAM user that reads this bucket perfectly and AccessDenies every write.
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;

const s3 = new S3Client({
  region: REGION,
  credentials: ACCESS_KEY && SECRET_KEY
    ? { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
    : undefined,
});

const log = (msg) => console.log(`[faststart] ${msg}`);

/** The portal derives the key this way too; keep them identical or we rewrite the wrong object. */
const keyFromUrl = (url) => new URL(url).pathname.replace(/^\//, '');

const moovOffset = (buf) => buf.indexOf(Buffer.from('moov', 'ascii'));

/** Read only the opening bytes — these files are small, but the box is not, and this runs in a loop. */
const readHead = (file, n) => {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
};

/** ffmpeg prints the duration to stderr; there is no ffprobe in ffmpeg-static. */
const probeDuration = async (file) => {
  try {
    await execFileAsync(ffmpegPath, ['-nostdin', '-hide_banner', '-i', file]);
    return null;
  } catch (err) {
    const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err.stderr || '');
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
};

const drainToFile = async (body, dest) => {
  await pipeline(body, fs.createWriteStream(dest));
};

/**
 * Rewrite one object in place, but only once the replacement has been proved sound.
 *
 * This overwrites the only copy of a customer's call, so the bar before PutObject is: ffmpeg
 * succeeded, the output decodes, its duration matches the original, and the moov really did move
 * to the front. PutObject is atomic, so anything that fails here leaves the original untouched.
 */
const remuxOne = async (key, tmpDir) => {
  const inFile = path.join(tmpDir, 'in.mp4');
  const outFile = path.join(tmpDir, 'out.mp4');

  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await drainToFile(obj.Body, inFile);

  const inSize = fs.statSync(inFile).size;
  const inHead = readHead(inFile, HEAD_PROBE_BYTES);
  if (moovOffset(inHead) !== -1) return { status: 'already' };

  await execFileAsync(ffmpegPath, [
    '-nostdin', '-v', 'error', '-i', inFile, '-c', 'copy', '-movflags', '+faststart', '-y', outFile,
  ]);

  const outSize = fs.statSync(outFile).size;
  if (outSize < inSize * 0.5 || outSize > inSize * 1.5) {
    throw new Error(`implausible output size ${outSize} from ${inSize}`);
  }

  const outHead = readHead(outFile, HEAD_PROBE_BYTES);
  if (moovOffset(outHead) === -1) throw new Error('moov still not in the first 64KB');

  const [inDur, outDur] = await Promise.all([probeDuration(inFile), probeDuration(outFile)]);
  if (inDur === null || outDur === null) throw new Error('could not read a duration to compare');
  if (Math.abs(inDur - outDur) > 0.5) throw new Error(`duration moved ${inDur}s -> ${outDur}s`);

  if (DRY_RUN) return { status: 'would-fix', inSize, outSize };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fs.createReadStream(outFile),
    ContentLength: outSize,
    // Keep whatever type the object already had; changing it is a separate decision.
    ...(obj.ContentType ? { ContentType: obj.ContentType } : {}),
    ...(obj.ContentDisposition ? { ContentDisposition: obj.ContentDisposition } : {}),
    // The tag is what makes the next sweep cheap: a HEAD is enough to skip this object.
    Metadata: { ...(obj.Metadata || {}), faststart: '1' },
  }));

  return { status: 'fixed', inSize, outSize };
};

const main = async () => {
  const startedAt = Date.now();
  if (!ACCESS_KEY || !SECRET_KEY) {
    log('S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY not set — writes would AccessDenied. Stopping.');
    process.exit(1);
  }

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const calls = await prisma.call.findMany({
    where: {
      createdAt: { gte: since },
      recordingUrl: { contains: 'amazonaws.com' },
    },
    select: { id: true, recordingUrl: true },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
  });

  const seen = new Set();
  let already = 0, fixed = 0, failed = 0, tooNew = 0, missing = 0, budgetHit = false;
  let bytesIn = 0, bytesOut = 0;

  for (const call of calls) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { budgetHit = true; break; }

    let key;
    try {
      key = keyFromUrl(call.recordingUrl);
    } catch {
      continue;
    }
    // Several calls can share one recording; only touch each object once per run.
    if (seen.has(key)) continue;
    seen.add(key);

    let head;
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) { missing++; continue; }
      failed++;
      log(`HEAD failed for ${key}: ${err.message}`);
      continue;
    }

    if (head.Metadata?.faststart === '1') { already++; continue; }
    if (head.LastModified && Date.now() - head.LastModified.getTime() < MIN_AGE_MS) { tooNew++; continue; }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faststart-'));
    try {
      const res = await remuxOne(key, tmpDir);
      if (res.status === 'already') already++;
      else {
        fixed++;
        bytesIn += res.inSize || 0;
        bytesOut += res.outSize || 0;
        if (DRY_RUN) log(`would fix ${key} (${res.inSize} -> ${res.outSize})`);
      }
    } catch (err) {
      failed++;
      log(`remux failed for ${key}: ${err.message}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  log(
    `${new Date().toISOString()} days=${DAYS} scanned=${seen.size} fixed=${fixed} already=${already} ` +
    `tooNew=${tooNew} missing=${missing} failed=${failed} ` +
    `moved=${mb(bytesIn)}MB->${mb(bytesOut)}MB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
    `${budgetHit ? ' (time budget reached — more left for the next run)' : ''}` +
    `${DRY_RUN ? ' [DRY RUN]' : ''}`,
  );

  await prisma.$disconnect();
};

main().catch(async (err) => {
  log(`run failed: ${err.stack || err.message}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
