/**
 * Tyresoft customer + vehicle ingestion — nightly cron.
 *
 * Tyresoft sends two CSVs per garage via SFTP (same mechanism as the tyre-stock
 * list already wired in agentWebhook.ts):
 *
 *   /home/tyresoft-uploads/uploads/<branch_slug>/<slug>_customers_<YYYY-MM-DD>.csv
 *   /home/tyresoft-uploads/uploads/<branch_slug>/<slug>_vehicles_<YYYY-MM-DD>.csv
 *
 * Each file is treated as a FULL SNAPSHOT (Tyresoft dumps the complete list every
 * day — the Elite sample is 29K customer rows). Rows absent from today's file are
 * removed from our DB so a customer deleted on Tyresoft's side doesn't linger
 * forever in caller recognition.
 *
 * Phone numbers are normalised to E.164 (+44…) via utils/normalisePhone so they
 * match whatever Twilio hands us at call time. Garbage like "1111111111111"
 * normalises to '' and is NOT stored — a bogus match would be worse than no match
 * (we'd greet the wrong caller by name).
 *
 * This is a BATCH job (prisma upserts over 29K rows aren't fast). Run it off-peak
 * — set up as a cron entry on EC2, not called from the request path. The
 * caller-recognition endpoint reads from the DB table, not the CSV, so lookup
 * stays sub-millisecond even on big tenants.
 */

import cron from 'node-cron';
import path from 'path';
import { readdir, access } from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import { pathToFileURL } from 'url';

import { prisma } from '../db.js';
import { normalisePhone } from '../utils/normalisePhone.js';

const SFTP_BASE = process.env.SFTP_UPLOAD_BASE_PATH || '/home/tyresoft-uploads/uploads';
const CHUNK = 500;

// Mirror of the agentWebhook.ts helper, inlined to keep this file self-contained.
// The source helper lives in a file that may be touched by other work; copying 20
// lines of CSV parsing is cheaper than cross-file coupling for a nightly cron.
const parseCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i += 1; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

const readCsvAsRecords = (filePath: string): Promise<Record<string, string>[]> =>
  new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    let headers: string[] = [];
    let lineNum = 0;
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      const fields = parseCsvLine(line);
      if (lineNum === 0) {
        headers = fields.map((h) => h.replace(/^"|"$/g, '').trim());
      } else if (line.trim()) {
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h] = (fields[i] ?? '').replace(/^"|"$/g, '').trim(); });
        rows.push(row);
      }
      lineNum += 1;
    });
    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
  });

const slugifyBranchName = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Find the newest file whose basename matches the given regex in the folder. */
async function findLatest(folder: string, pattern: RegExp): Promise<string | null> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && pattern.test(e.name))
      .map((e) => e.name)
      .sort(); // lexical sort — if the filename contains YYYY-MM-DD this gives latest last
    return files.length ? path.join(folder, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

/** Parse "DD/MM/YYYY" from Tyresoft CSVs. Returns null on empty / malformed. */
function parseDmy(s: string | undefined | null): Date | null {
  const t = (s || '').trim();
  if (!t) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

interface CustomerRow {
  customerAccountNumber: string;
  name: string;
  salutation: string | null;
  contact: string | null;
  telephone: string;  // normalised
  mobile: string;     // normalised
  email: string | null;
}

interface VehicleRow {
  vrm: string;
  customerAccountNumber: string;
  make: string | null;
  model: string | null;
  motDueDate: Date | null;
  tyreCheckDate: Date | null;
  serviceDueDate: Date | null;
  nextInspectionDate: Date | null;
}

function mapCustomer(raw: Record<string, string>): CustomerRow | null {
  const customerAccountNumber = (raw['Customer Account Number'] || '').trim();
  if (!customerAccountNumber) return null;
  const telephone = normalisePhone(raw['Customer Telephone']);
  const mobile = normalisePhone(raw['Customer Mobile']);
  // A customer with neither a telephone nor a mobile can't be matched on an incoming
  // call. We still ingest them (future vehicle lookups by VRM might want them), but
  // skipping would be defensible. Keep for now.
  return {
    customerAccountNumber,
    name: (raw['Customer Name'] || '').trim(),
    salutation: (raw['Customer Salutation'] || '').trim() || null,
    contact: (raw['Customer Contact'] || '').trim() || null,
    telephone,
    mobile,
    email: (raw['Customer Email Address'] || '').trim() || null,
  };
}

function mapVehicle(raw: Record<string, string>): VehicleRow | null {
  const vrm = (raw['Vehicle VRM'] || '').replace(/\s+/g, '').toUpperCase();
  const customerAccountNumber = (raw['Customer Account Number'] || '').trim();
  if (!vrm || !customerAccountNumber) return null;
  return {
    vrm,
    customerAccountNumber,
    make: (raw['Vehicle Make'] || '').trim() || null,
    model: (raw['Vehicle Model'] || '').trim() || null,
    motDueDate: parseDmy(raw['Vehicle MOT Due Date']),
    tyreCheckDate: parseDmy(raw['Vehicle Tyre Check Date']),
    serviceDueDate: parseDmy(raw['Vehicle Service Due Date']),
    nextInspectionDate: parseDmy(raw['Vehicle Next Inspection Date']),
  };
}

/** Ingest a single Tyresoft garage: swap in the latest customer + vehicle snapshots. */
/**
 * Should this import be refused? Returns the reason, or null to proceed.
 *
 * Pure and exported so the decision can be tested without a database — the thing it guards
 * against is rare and destructive, which is exactly the combination that never gets exercised
 * by hand.
 */
export function refuseImport(
  { incoming, existing, floor, force }:
  { incoming: number; existing: number; floor: number; force: boolean },
): string | null {
  if (existing === 0) return null;                 // first run — nothing to lose
  if (incoming === 0) return 'empty customer file.';   // never legitimate, force or not
  if (force) return null;
  if (incoming < existing * floor) {
    return `incoming file has ${incoming} customers against ${existing} already stored `
      + `(floor ${Math.round(floor * 100)}%). Keeping the existing snapshot. If this shrink is `
      + `real, re-run with TYRESOFT_INGEST_FORCE=1.`;
  }
  return null;
}

export async function ingestTyresoftGarage(garageId: string, branchName: string) {
  const folder = path.join(SFTP_BASE, slugifyBranchName(branchName));
  try { await access(folder); }
  catch { console.warn(`[tyresoft-ingest] folder missing for ${branchName}: ${folder}`); return; }

  const customersPath = await findLatest(folder, /_customers.*\.csv$/i);
  const vehiclesPath = await findLatest(folder, /_vehicles.*\.csv$/i);
  if (!customersPath || !vehiclesPath) {
    console.warn(`[tyresoft-ingest] missing files for ${branchName}: customers=${!!customersPath} vehicles=${!!vehiclesPath}`);
    return;
  }

  const customerRaw = await readCsvAsRecords(customersPath);
  const vehicleRaw = await readCsvAsRecords(vehiclesPath);
  const customers = customerRaw.map(mapCustomer).filter((c): c is CustomerRow => !!c);
  const vehicles = vehicleRaw.map(mapVehicle).filter((v): v is VehicleRow => !!v);
  console.log(`[tyresoft-ingest] ${branchName}: ${customers.length} customers, ${vehicles.length} vehicles`);

  // ── Refuse an import that would gut the table ────────────────────────────
  //
  // This job DELETES everything for the garage and re-inserts from the file, which is correct
  // only if every file really is a full snapshot. Nobody has confirmed that with Tyresoft yet,
  // and the same shape of accident happens anyway: a half-written SFTP upload, a failed export,
  // a truncated transfer. Elite's real file is 29,646 customers — a 200-row file arriving on a
  // Sunday night would silently leave caller recognition answering NO_MATCH for everyone, and
  // the only clue would be that it stopped working.
  //
  // So: if we hold rows and the incoming file is less than SHRINK_FLOOR of them, keep what we
  // have and log loudly. A stale snapshot is wrong by a day. An empty one is wrong until
  // somebody notices.
  //
  // A genuine shrink past the floor — a garage really did lose most of its customers — needs
  // TYRESOFT_INGEST_FORCE=1 for one run. Deliberately manual: it should take a person deciding.
  const existing = await prisma.tyresoftCustomer.count({ where: { garageId } });
  const refusal = refuseImport({
    incoming: customers.length,
    existing,
    floor: Number(process.env.TYRESOFT_SHRINK_FLOOR || 0.5),
    force: process.env.TYRESOFT_INGEST_FORCE === '1',
  });
  if (refusal) {
    console.error(`[tyresoft-ingest] ${branchName}: REFUSED — ${refusal}`);
    return;
  }

  // Full-snapshot replace: delete-then-insert in a transaction so the endpoint never
  // sees a half-replaced table. For 29K rows this is tolerable at off-peak.
  await prisma.$transaction(async (tx: any) => {
    await tx.tyresoftVehicle.deleteMany({ where: { garageId } });
    await tx.tyresoftCustomer.deleteMany({ where: { garageId } });

    for (let i = 0; i < customers.length; i += CHUNK) {
      await tx.tyresoftCustomer.createMany({
        data: customers.slice(i, i + CHUNK).map((c) => ({ garageId, ...c })),
        skipDuplicates: true,
      });
    }
    for (let i = 0; i < vehicles.length; i += CHUNK) {
      await tx.tyresoftVehicle.createMany({
        data: vehicles.slice(i, i + CHUNK).map((v) => ({ garageId, ...v })),
        skipDuplicates: true,
      });
    }
  }, { timeout: 120_000 });
  console.log(`[tyresoft-ingest] ${branchName}: snapshot committed`);
}

/**
 * Every Tyresoft garage with recognition on. CLI entry, and what the nightly cron calls.
 *
 * NOT a strict `integrationProvider: 'tyresoft'` filter, for the same reason the caller
 * endpoint does not use one: Elite Autocare and Lurgan Tyre Centre both still read "none"
 * while carrying full Tyresoft credentials, because the config validator rejected the real
 * value for months. The agent infers the provider from the credentials (build_diary in
 * diaries/__init__.py) and so does routes/tyresoft.ts — a strict filter here would quietly
 * skip the only two real Tyresoft garages and leave their tables empty for ever.
 */
export async function runAll() {
  // branchName lives on AgentConfiguration, not Garage — same lookup the tyre-stock
  // route uses to resolve the SFTP folder (routes/agentWebhook.ts).
  const all = await prisma.agentConfiguration.findMany({
    where: { callerRecognitionEnabled: true },
    select: {
      garageId: true,
      branchName: true,
      integrationProvider: true,
      integrationProviderConfig: true,
    },
  });
  const garages = all.filter((g: any) => {
    if (g.integrationProvider === 'tyresoft') return true;
    if (g.integrationProvider && g.integrationProvider !== 'none') return false;
    const c = (g.integrationProviderConfig ?? {}) as Record<string, unknown>;
    return Boolean(c.tsApiKey || c.tsWorkspace);
  });
  console.log(`[tyresoft-ingest] starting: ${garages.length} garage(s)`);
  for (const g of garages) {
    try { await ingestTyresoftGarage(g.garageId, g.branchName || ''); }
    catch (e) { console.error(`[tyresoft-ingest] ${g.garageId} failed:`, e); }
  }
  console.log('[tyresoft-ingest] done');
}

// ESM has no `require.main === module`; compare this module's URL to argv[1].
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runAll().then(() => prisma.$disconnect()).catch((e) => {
    console.error('[tyresoft-ingest] fatal:', e);
    prisma.$disconnect().finally(() => process.exit(1));
  });
}

/**
 * Nightly, 03:20 UK.
 *
 * Off-peak on purpose: the job deletes and re-inserts ~30K rows per garage inside one
 * transaction, and the caller endpoint reads the same table. 03:20 rather than 03:00 so it is
 * not racing whatever else fires on the hour.
 *
 * Dormant unless TYRESOFT_INGEST=on. Nothing scheduled this job until 30 Oct 2026 — it existed
 * only as a CLI entry, which meant that on deploy the table would have stayed empty for ever
 * and caller recognition would have answered NO_MATCH to everyone, with nothing in the logs
 * saying why. The flag is so turning it on is a decision rather than a side effect of a deploy.
 */
export function initTyresoftIngestCron() {
  if (process.env.TYRESOFT_INGEST !== 'on') {
    console.log('[tyresoft-ingest] cron dormant (set TYRESOFT_INGEST=on to enable)');
    return;
  }
  cron.schedule('20 3 * * *', async () => {
    try { await runAll(); }
    catch (e) { console.error('[tyresoft-ingest] nightly run failed:', e); }
  }, { timezone: 'Europe/London' });
  console.log('[tyresoft-ingest] cron scheduled: 03:20 Europe/London');
}
