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

/** CLI entry: iterate every Tyresoft-integrated garage with recognition enabled. */
export async function runAll() {
  // branchName lives on AgentConfiguration, not Garage — same lookup the tyre-stock
  // route uses to resolve the SFTP folder (routes/agentWebhook.ts).
  const garages = await prisma.agentConfiguration.findMany({
    where: {
      integrationProvider: 'tyresoft',
      callerRecognitionEnabled: true,
    },
    select: { garageId: true, branchName: true },
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
