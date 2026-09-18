// Diary onboarding for every GMS provider EXCEPT GarageHive.
//
// GarageHive has its own flow (services/garageHiveConnect.ts) and keeps it: there, the provider
// gives us one instance and we resolve every branch ourselves by matching names to locations.
// No other provider has that — Tyresoft, Poole and Bookar credentials are supplied directly, and
// some of them differ per branch (Elite Autocare is depot 6; Poole issues a branch key per site).
// So this module mirrors the SHAPE of the GarageHive flow — email the provider a token link,
// they fill a form, submitting connects the agent — over a per-provider field schema.
//
// The field lists below mirror each adapter's own config_schema in the unified agent
// (receptionmate-agents/unified-agent/diaries/*.py). Keep them in step: a field named here that
// the adapter does not read is a field the garage fills in for nothing.
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '../db.js';
import { sendEmail, brandedEmailShell } from '../utils/email.js';
import { sendAgentConfigWebhook } from '../routes/config.js';
import { slugifyBranchName } from '../routes/agentWebhook.js';

const PORTAL_URL = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');
const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Every garage connected through here runs the unified agent — it is the only one with adapters
// for these diaries.
const DIARY_AGENT_SCRIPT = 'unified-agent';

export type ProviderKey = 'bookar' | 'poole' | 'tyresoft';
export const PROVIDER_KEYS: ProviderKey[] = ['bookar', 'poole', 'tyresoft'];

export type FieldSpec = {
  key: string;
  label: string;
  required: boolean;
  secret?: boolean;
  help?: string;
  placeholder?: string;
};

type ProviderSpec = {
  label: string;
  /** Asked once and written to every branch of the business. */
  shared: FieldSpec[];
  /** Asked per branch — these genuinely differ between sites. */
  perBranch: FieldSpec[];
  /** Env var holding the provider's onboarding address. No default, on purpose. */
  envTo: string;
  envCc: string;
  /** What the garage is told to get ready while we build their agent. */
  gettingReady: { heading: (garage: string) => string; html: string; text: string };
};

export const PROVIDERS: Record<ProviderKey, ProviderSpec> = {
  tyresoft: {
    label: 'Tyresoft',
    shared: [
      { key: 'tsWorkspace', label: 'Workspace', required: true, placeholder: 'e.g. eliteautocare' },
      { key: 'tsUsername', label: 'API username', required: true },
      { key: 'tsPassword', label: 'API password', required: true, secret: true },
      { key: 'tsApiKey', label: 'API key', required: true, secret: true },
    ],
    perBranch: [
      { key: 'tsDepotId', label: 'Depot ID', required: true, help: "Which depot's diary this branch books into." },
      { key: 'tsChannelId', label: 'Channel ID', required: false, help: 'Optional. Used on the booking record.' },
    ],
    envTo: 'TYRESOFT_CONNECT_EMAIL_TO',
    envCc: 'TYRESOFT_CONNECT_EMAIL_CC',
    gettingReady: {
      heading: (g) => `Getting ${g} ready`,
      // Two real tasks, the way the GarageHive note gives one. Vague encouragement to "have a
      // think about your services" produced nothing actionable; these are the two things that
      // actually gate the agent booking properly.
      html:
        'Your ReceptionMate agent books straight into your existing <strong>Tyresoft</strong> diary, so nothing changes about how you work day to day.' +
        '</p><p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">Two things to set up while we finish your agent:' +
        '</p><p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;"><strong>1. Add a &ldquo;Misc&rdquo; service in Tyresoft.</strong> ' +
        'It lets the agent book jobs that don\u2019t match one of your standard services, instead of turning the caller away. ' +
        'Without one, anything unusual becomes a callback.' +
        '</p><p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;"><strong>2. Upload your services and prices.</strong> ' +
        'In the portal, go to Agent setup &rarr; Training and upload your services CSV. The agent quotes only these figures and never invents one, ' +
        'so replace the file whenever your prices change.' +
        '</p><p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">Your tyre stock and pricing come straight from Tyresoft automatically \u2014 nothing to do there.',
      text:
        'Your ReceptionMate agent books straight into your existing Tyresoft diary, so nothing changes about how you work day to day.\n\n' +
        'Two things to set up while we finish your agent:\n\n' +
        '1. Add a "Misc" service in Tyresoft. It lets the agent book jobs that do not match one of your standard services, instead of turning the caller away.\n\n' +
        '2. Upload your services and prices. In the portal, go to Agent setup > Training and upload your services CSV. The agent quotes only these figures and never invents one.\n\n' +
        'Your tyre stock and pricing come straight from Tyresoft automatically - nothing to do there.',
    },
  },
  poole: {
    // The provider key stays 'poole' (it is the integrationProvider enum value and the adapter
    // name), but everything a human reads says AutoSage — that is the product the garage and the
    // provider both know it by. "Poole" is only ever our internal shorthand.
    label: 'AutoSage',
    shared: [
      { key: 'pooleTenant', label: 'Tenant', required: true },
      { key: 'pooleBaseUrl', label: 'Base URL', required: false, help: 'Leave blank for the default (https://alpha.autosage.co.uk).' },
    ],
    perBranch: [
      { key: 'pooleBranchKey', label: 'Branch key', required: true, secret: true },
      { key: 'pooleBranchCode', label: 'Branch code', required: false, help: 'Optional; if given it must match the key’s branch.' },
    ],
    envTo: 'POOLE_CONNECT_EMAIL_TO',
    envCc: 'POOLE_CONNECT_EMAIL_CC',
    gettingReady: {
      heading: (g) => `Getting ${g} ready`,
      html:
        'Your ReceptionMate agent books straight into your existing <strong>AutoSage</strong> diary, so your diary stays exactly as it is.' +
        ' Nothing to set up at your end while we build your agent.',
      text:
        'Your ReceptionMate agent books straight into your existing AutoSage diary, so your diary stays exactly as it is. ' +
        'Nothing to set up at your end while we build your agent.',
    },
  },
  bookar: {
    label: 'Bookar',
    shared: [
      { key: 'bookarApiBase', label: 'API base URL', required: true, placeholder: 'https://api.bookar.example' },
      { key: 'bookarClientId', label: 'Client ID', required: true },
      { key: 'bookarClientSecret', label: 'Client secret', required: true, secret: true },
    ],
    perBranch: [],
    envTo: 'BOOKAR_CONNECT_EMAIL_TO',
    envCc: 'BOOKAR_CONNECT_EMAIL_CC',
    gettingReady: {
      heading: (g) => `Getting ${g} ready`,
      html:
        'Your ReceptionMate agent books straight into your existing <strong>Bookar</strong> diary, so nothing changes about how you work day to day.' +
        ' Nothing to set up at your end while we build your agent.',
      text:
        'Your ReceptionMate agent books straight into your existing Bookar diary, so nothing changes about how you work day to day.',
    },
  },
};

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const envList = (name: string): string[] =>
  (process.env[name] || '').split(',').map((x) => x.trim()).filter(Boolean);

// ---- token ----------------------------------------------------------------
// Same shape as the GarageHive connect token, with the provider carried alongside so the form
// knows which fields to render without trusting anything the browser sends.
export const signDiaryToken = (businessId: string, provider: ProviderKey): string => {
  const secret = process.env.JWT_SECRET || '';
  const payload = Buffer.from(
    JSON.stringify({ b: businessId, p: provider, exp: Date.now() + TOKEN_TTL_MS }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};

export const verifyDiaryToken = (
  token: string,
): { businessId: string; provider: ProviderKey } | null => {
  const secret = process.env.JWT_SECRET || '';
  const [payload, sig] = (token || '').split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const { b: businessId, p, exp } = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { b?: unknown; p?: unknown; exp?: unknown };
    if (typeof businessId !== 'string' || typeof exp !== 'number' || Date.now() > exp) return null;
    if (typeof p !== 'string' || !PROVIDER_KEYS.includes(p as ProviderKey)) return null;
    return { businessId, provider: p as ProviderKey };
  } catch {
    return null;
  }
};

// ---- which provider is this business on? ----------------------------------
/** The provider every garage of this business is on, or null when it is GarageHive / unset / mixed. */
export const businessProvider = async (businessId: string): Promise<ProviderKey | null> => {
  const garages = await prisma.garage.findMany({
    where: { businessId, archivedAt: null },
    select: { agentConfiguration: { select: { integrationProvider: true } } },
  });
  const provs = new Set(
    garages.map((g) => String(g.agentConfiguration?.integrationProvider || 'none')),
  );
  provs.delete('none');
  if (provs.size !== 1) return null;
  const only = [...provs][0];
  return PROVIDER_KEYS.includes(only as ProviderKey) ? (only as ProviderKey) : null;
};

export const businessBranches = async (businessId: string) =>
  prisma.garage.findMany({
    where: { businessId, archivedAt: null },
    select: { id: true, name: true, agentConfiguration: { select: { branchAddress: true } } },
    orderBy: { name: 'asc' },
  });

// ---- live checks ----------------------------------------------------------
// Read-only where possible, and ALWAYS before anything is written: a typo in an API key should
// surface while the provider still has the form open, not on a customer call three days later.
export type CheckResult = { ok: boolean; detail: string };

const TS_HOST = 'https://api.tyresoft.co.uk';

const checkTyresoft = async (c: Record<string, string>): Promise<CheckResult> => {
  // vrmLookup is a GET and changes nothing. A known-good plate keeps the check honest: an empty
  // result means the credentials work but the plate is unknown, which is still a pass.
  const url = `${TS_HOST}/${encodeURIComponent(c.tsWorkspace)}/vrmLookup/GO55BKG`;
  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.tsUsername}:${c.tsPassword}`).toString('base64')}`,
        'X-Api-Key': c.tsApiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || r.status === 403)
      return { ok: false, detail: 'Tyresoft rejected those credentials (401/403). Check the username, password and API key.' };
    if (r.status === 404)
      return { ok: false, detail: `Tyresoft does not recognise the workspace "${c.tsWorkspace}".` };
    if (!r.ok) return { ok: false, detail: `Tyresoft returned HTTP ${r.status}.` };
    return { ok: true, detail: 'Tyresoft accepted the credentials.' };
  } catch (e) {
    return { ok: false, detail: `Could not reach Tyresoft: ${(e as Error).message}` };
  }
};

const checkBookar = async (c: Record<string, string>): Promise<CheckResult> => {
  const base = String(c.bookarApiBase || '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, detail: 'The API base URL must start with https://' };
  try {
    const r = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: c.bookarClientId,
        client_secret: c.bookarClientSecret,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || r.status === 403)
      return { ok: false, detail: 'Bookar rejected that client id / secret.' };
    if (!r.ok) return { ok: false, detail: `Bookar returned HTTP ${r.status} from the token endpoint.` };
    return { ok: true, detail: 'Bookar issued a token.' };
  } catch (e) {
    return { ok: false, detail: `Could not reach Bookar: ${(e as Error).message}` };
  }
};

const checkPoole = async (c: Record<string, string>): Promise<CheckResult> => {
  const base = String(c.pooleBaseUrl || 'https://alpha.autosage.co.uk').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/api/branch`, {
      headers: {
        'X-Branch-Key': c.pooleBranchKey,
        'X-Tenant': c.pooleTenant,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || r.status === 403)
      return { ok: false, detail: 'AutoSage rejected that branch key / tenant.' };
    if (!r.ok) return { ok: false, detail: `AutoSage returned HTTP ${r.status}.` };
    return { ok: true, detail: 'AutoSage accepted the branch key.' };
  } catch (e) {
    return { ok: false, detail: `Could not reach AutoSage: ${(e as Error).message}` };
  }
};

const CHECKS: Record<ProviderKey, (c: Record<string, string>) => Promise<CheckResult>> = {
  tyresoft: checkTyresoft,
  bookar: checkBookar,
  poole: checkPoole,
};

/** Credentials for one branch: the shared values plus that branch's own. */
const credsFor = (
  provider: ProviderKey,
  shared: Record<string, string>,
  branch: Record<string, string>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of PROVIDERS[provider].shared) if (shared[f.key]) out[f.key] = shared[f.key];
  for (const f of PROVIDERS[provider].perBranch) if (branch[f.key]) out[f.key] = branch[f.key];
  return out;
};

const missingFields = (
  provider: ProviderKey,
  shared: Record<string, string>,
  branches: Record<string, Record<string, string>>,
  branchNames: Record<string, string>,
): string[] => {
  const spec = PROVIDERS[provider];
  const missing: string[] = [];
  for (const f of spec.shared) if (f.required && !String(shared[f.key] || '').trim()) missing.push(f.label);
  for (const [gid, vals] of Object.entries(branches))
    for (const f of spec.perBranch)
      if (f.required && !String(vals[f.key] || '').trim())
        missing.push(`${f.label} for ${branchNames[gid] || 'a branch'}`);
  return missing;
};

// ---- connect --------------------------------------------------------------
export type ConnectedBranch = { garageId: string; garageName: string; check: string; testBooking: string | null };
export type ConnectResult =
  | { ok: true; provider: ProviderKey; connected: ConnectedBranch[] }
  | { ok: false; error: string };

/**
 * Write the credentials, put the garage on the unified agent and push the config to the agent.
 * Mirrors what garageHiveConnect.connectGarageToLocation does for GarageHive.
 *
 * integrationProvider IS set here, unlike the older Tyresoft garages which sit on 'none' and are
 * inferred from their keys. Explicit is better, and build_diary() takes the provider directly.
 */
const writeBranch = async (
  garageId: string,
  provider: ProviderKey,
  creds: Record<string, string>,
): Promise<void> => {
  const existing = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: { integrationProviderConfig: true },
  });
  const ipc = asObject(existing?.integrationProviderConfig);
  await prisma.agentConfiguration.update({
    where: { garageId },
    data: {
      // Merge: a garage may already carry hubspot ids or an uploaded catalogue, and the provider
      // filling this form must not wipe them.
      integrationProviderConfig: { ...ipc, ...creds, connectedAt: new Date().toISOString() },
      integrationProvider: provider,
      agentScript: DIARY_AGENT_SCRIPT,
    },
  });
  await sendAgentConfigWebhook(garageId);
};

/** A marked test booking, so the connection is proven end to end before anyone relies on it. */
const placeTestBooking = async (
  provider: ProviderKey,
  creds: Record<string, string>,
): Promise<string | null> => {
  if (provider !== 'tyresoft') return null; // only Tyresoft has a safe, documented create path here
  try {
    const root = `${TS_HOST}/${encodeURIComponent(creds.tsWorkspace)}`;
    const headers = {
      Authorization: `Basic ${Buffer.from(`${creds.tsUsername}:${creds.tsPassword}`).toString('base64')}`,
      'X-Api-Key': creds.tsApiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const r = await fetch(`${root}/createSale`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        depotID: Number(creds.tsDepotId || 1),
        saleDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        saleStatus: 'Order',
        notes: 'RECEPTIONMATE TEST BOOKING - PLEASE CANCEL',
        flag: 1,
        flagNotes: 'ReceptionMate connection test',
        poNumber: `RM-TEST-${Date.now()}`,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { saleNumber?: unknown; saleID?: unknown };
    const ref = j.saleNumber ?? j.saleID;
    return ref != null ? String(ref) : null;
  } catch {
    return null;
  }
};

export const connectBusinessDiary = async (
  businessId: string,
  provider: ProviderKey,
  shared: Record<string, string>,
  branches: Record<string, Record<string, string>>,
): Promise<ConnectResult> => {
  const garages = await businessBranches(businessId);
  if (!garages.length) return { ok: false, error: 'No branches found for this business.' };
  const names: Record<string, string> = Object.fromEntries(garages.map((g) => [g.id, g.name]));

  const missing = missingFields(provider, shared, branches, names);
  if (missing.length) return { ok: false, error: `Still needed: ${missing.join(', ')}.` };

  // Check EVERY branch before writing ANY of them. A half-connected business is worse than one
  // that is not connected: some branches would take live calls while others silently fail.
  const checked: { garageId: string; creds: Record<string, string>; detail: string }[] = [];
  for (const g of garages) {
    const creds = credsFor(provider, shared, branches[g.id] || {});
    const res = await CHECKS[provider](creds);
    if (!res.ok) return { ok: false, error: `${g.name}: ${res.detail}` };
    checked.push({ garageId: g.id, creds, detail: res.detail });
  }

  const connected: ConnectedBranch[] = [];
  for (const c of checked) {
    await writeBranch(c.garageId, provider, c.creds);
    const testBooking = await placeTestBooking(provider, c.creds);
    connected.push({
      garageId: c.garageId,
      garageName: names[c.garageId],
      check: c.detail,
      testBooking,
    });
  }
  console.log(`[DIARY-CONNECT] ${provider} connected ${connected.length} branch(es) for ${businessId}`);
  return { ok: true, provider, connected };
};

// ---- emails ---------------------------------------------------------------
/**
 * The email to the GMS provider asking them to connect the diary. Mirrors the GarageHive one.
 *
 * Recipient comes from the provider's env var with NO default: sending an onboarding request to
 * a guessed address is worse than not sending it, so a missing value is logged loudly instead.
 */
export const sendDiaryConnectRequest = async (businessId: string): Promise<boolean> => {
  const provider = await businessProvider(businessId);
  if (!provider) {
    // Silence here is how onboarding stalls without anybody noticing. GarageHive is genuinely
    // not ours and says nothing, but a business sitting on the unified agent with no provider
    // set has simply not had integrationProvider filled in at garage creation — nobody will be
    // emailed, no diary will be connected, and the first sign is the garage asking why their
    // agent cannot book. Say so.
    const garages = await prisma.garage.findMany({
      where: { businessId, archivedAt: null },
      select: { name: true, agentConfiguration: { select: { agentScript: true, integrationProvider: true } } },
    });
    const unified = garages.filter((g) => g.agentConfiguration?.agentScript === DIARY_AGENT_SCRIPT);
    const anyProvider = garages.some((g) => {
      const p = String(g.agentConfiguration?.integrationProvider || 'none');
      return p !== 'none';
    });
    if (unified.length && !anyProvider)
      console.warn(
        `[DIARY-CONNECT] ${businessId} has ${unified.length} unified-agent branch(es) but no ` +
          'integrationProvider set — NO connect request sent. Set the provider on the garage ' +
          '(Admin > garage > integration) or the diary will never be connected.',
      );
    return false;
  }
  const spec = PROVIDERS[provider];
  const to = envList(spec.envTo);
  const cc = envList(spec.envCc);
  if (!to.length) {
    console.warn(
      `[DIARY-CONNECT] ${spec.envTo} is not set — NOT sending the ${spec.label} connect request for`,
      businessId,
    );
    return false;
  }
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  const branches = await businessBranches(businessId);
  const name = business?.name || 'This garage';
  const link = `${PORTAL_URL}/connect-diary?token=${signDiaryToken(businessId, provider)}`;
  const { html, text } = buildConnectRequestEmail(provider, name, branches.map((b) => b.name), link);
  void sendEmail({
    to,
    ...(cc.length ? { cc } : {}),
    subject: 'New ReceptionMate onboard',
    text,
    html,
  });
  console.log(
    `[DIARY-CONNECT] ${spec.label} connect request sent to ${to.join(', ')}${cc.length ? ` (cc ${cc.join(', ')})` : ''} for ${name}`,
  );
  return true;
};

/**
 * The provider-request email, as a pure function so a preview renders EXACTLY what sends.
 * Built inline once and drifted from every preview written by hand, which is the usual way
 * wording gets checked against something that is no longer true.
 */
export const buildConnectRequestEmail = (
  provider: ProviderKey,
  businessName: string,
  branchNames: string[],
  link: string,
): { html: string; text: string } => {
  const spec = PROVIDERS[provider];
  const name = businessName;
  const branches = branchNames;
  // Tyresoft is the one provider with a second track: the tyre stock CSV, pushed over SFTP to a
  // folder whose name must match slugifyBranchName(branchName) EXACTLY. The webhook 404s silently
  // when it does not, which is how Lurgan Tyre Centre came to have a folder called "lurgan-tyre"
  // against an expected "lurgan-tyre-centre" and would have served no tyres at all. Naming the
  // folder here is the difference between that being obvious and being invisible.
  const folders = branchNames.map((b) => slugifyBranchName(b));
  const stockBlock =
    provider === 'tyresoft'
      ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">Separately, their tyre stock CSV goes to the usual ReceptionMate SFTP account (the same login as your other garages), in ` +
        (folders.length > 1
          ? `these folders: ${folders.map((x) => `<strong>${x}/</strong>`).join(', ')}`
          : `a folder named exactly <strong>${folders[0]}/</strong>`) +
        `, as <strong>Products Branch 1.csv</strong>. The folder name has to match exactly — we look it up by that name, and find nothing if it differs.</p>`
      : '';
  const branchLine =
    branches.length > 1
      ? `<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#475569;">There are <strong>${branches.length} branches</strong> on the form: ${branches.join(', ')}.</p>`
      : '';
  const body =
    `<tr><td style="padding: 32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">New ReceptionMate onboard</h1>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;"><strong>${name}</strong> is being onboarded to ReceptionMate and books into ${spec.label}.</p>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">Open the link below and fill in their ${spec.label} details. Submitting the form connects the diary.</p>` +
    branchLine +
    stockBlock +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 18px;"><tr>` +
    `<td style="background:#3426cf;border-radius:10px;"><a href="${link}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;">Connect ${spec.label} diary</a></td>` +
    `</tr></table>` +
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#94a3b8;text-align:center;">Or paste this link: <a href="${link}" style="color:#3426cf;word-break:break-all;">${link}</a><br>Link valid 14 days.</p>` +
    `</td></tr>`;
  return {
    html: brandedEmailShell(body),
    text:
      `${name} is being onboarded to ReceptionMate and books into ${spec.label}.\n\n` +
      `Open the link below and fill in their ${spec.label} details. Submitting the form connects the diary.\n\n` +
      `${link}\n\nLink valid 14 days.` +
      (provider === 'tyresoft'
        ? `\n\nSeparately, their tyre stock CSV goes to the usual ReceptionMate SFTP account (the same ` +
          `login as your other garages), in ${folders.length > 1 ? `these folders: ${folders.map((x) => x + '/').join(', ')}` : `a folder named exactly ${folders[0]}/`}, ` +
          `as "Products Branch 1.csv". The folder name has to match exactly.`
        : ''),
  };
};

/** The customer-facing "we're building your agent" note, in that provider's own words. Once only. */
export const sendDiaryGettingReady = async (garageId: string): Promise<boolean> => {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      id: true,
      name: true,
      agentConfiguration: { select: { integrationProvider: true, integrationProviderConfig: true } },
    },
  });
  const prov = String(garage?.agentConfiguration?.integrationProvider || '');
  if (!garage || !PROVIDER_KEYS.includes(prov as ProviderKey)) return false;
  const spec = PROVIDERS[prov as ProviderKey];
  const ipc = asObject(garage.agentConfiguration?.integrationProviderConfig);
  if (ipc.connectedAt) return false; // already connected — the "you're live" email covers it
  if (ipc.gettingReadyEmailedAt) return false; // once only
  const users = await prisma.user.findMany({
    where: { garageAccessIds: { has: garageId }, role: { not: 'RECEPTIONMATE_STAFF' } },
    select: { email: true, branchRoles: true },
  });
  const manager = users.find((u) => asObject(u.branchRoles)[garageId] === 'MANAGER') || users[0];
  if (!manager?.email) return false;
  await prisma.agentConfiguration.update({
    where: { garageId },
    data: { integrationProviderConfig: { ...ipc, gettingReadyEmailedAt: new Date().toISOString() } },
  });
  const body =
    `<tr><td style="padding: 32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">${spec.gettingReady.heading(garage.name)}</h1>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">Thanks for signing. ${spec.gettingReady.html}</p>` +
    `<p style="margin:0;font-size:15px;line-height:1.55;color:#475569;">We’ll email you again the moment your agent is live.</p>` +
    `</td></tr>`;
  const built = buildGettingReadyEmail(prov as ProviderKey, garage.name);
  void sendEmail({
    to: [manager.email],
    subject: `Getting ${garage.name} ready on ReceptionMate`,
    text: built.text,
    html: built.html,
  });
  return true;
};

/** The customer's getting-ready email, pure so a preview renders exactly what sends. */
export const buildGettingReadyEmail = (
  provider: ProviderKey,
  garageName: string,
): { html: string; text: string } => {
  const spec = PROVIDERS[provider];
  const body =
    `<tr><td style="padding: 32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">${spec.gettingReady.heading(garageName)}</h1>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">Thanks for signing. ${spec.gettingReady.html}</p>` +
    `<p style="margin:0;font-size:15px;line-height:1.55;color:#475569;">We’ll email you again the moment your agent is live.</p>` +
    `</td></tr>`;
  return {
    html: brandedEmailShell(body),
    text: `Thanks for signing. ${spec.gettingReady.text}\n\nWe'll email you again the moment your agent is live.`,
  };
};
