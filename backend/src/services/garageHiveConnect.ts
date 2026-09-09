// GarageHive "connect the diary" flow.
//
// GarageHive gives us one thing: the online-booking INSTANCE (customerId, e.g. "inoplus").
// The API key is shared across all GarageHive garages, so we already hold it. The location id
// is NOT supplied — it's derived by calling the online-booking /init endpoint, which returns the
// instance's location(s). For a single-branch instance that's one location; for a multi-branch
// instance (e.g. In'n'out under "inoplus") it returns them all, and we pick the right branch for
// each Garage record by matching the garage's own name/address — because WE know which branch we
// onboarded (from the agreement + garage records) and GarageHive does not.
//
// RECOVERED 2026-09-09. This file and routes/garagehive-connect.ts existed only as compiled
// output in dist/ — the TypeScript was never committed, so the 24 Aug reconciliation to a clean
// checkout removed it and every rebuild since produced a server.js that no longer mounted the
// routes. Restored from dist/services/garageHiveConnect.js and committed this time.
import { createHmac, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { sendOpsSms } from '../utils/opsAlerts.js';
import { sendAgentConfigWebhook } from '../routes/config.js';
import { sendEmail, brandedEmailShell } from '../utils/email.js';

const GH_BASE = 'https://onlinebooking.garagehive.co.uk/api/external-booking';
const PORTAL_URL = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');
// GarageHive's own guide for adding the "Other" service package the agent needs to book custom jobs.
const GH_OTHER_GUIDE_URL = 'https://garagehive-co.slite.com/app/docs/YzHdXMeW8CwmE3/How-to-Set-Up-an-Other-Service-Package-for-Custom-Online-Bookings';

// The agent a newly connected GarageHive garage is put on. Was receptionmate-agent-v3; the
// unified agent now serves GarageHive garages, so new connections land there.
const GH_AGENT_SCRIPT = 'unified-agent';
// The standard starting password, same as admin.ts / public-signup.ts / onboarding.ts.
const DEFAULT_PASSWORD = 'Nomoremissedcalls';
// Garages connected before the switch still run v3, so anything ASKING "is this a GarageHive
// garage?" has to accept both — narrowing it would silently un-recognise every existing one.
const GH_AGENT_SCRIPTS = ['unified-agent', 'receptionmate-agent-v3'];

export type GhLocation = { id: number; name: string; address: string };
export type GhConfidence = 'auto' | 'high' | 'low' | 'none';
export type GhMatch = {
  locationId: number | null;
  confidence: GhConfidence;
  score: number;
  runnerUpScore: number;
};
export type GhInitResult =
  | { ok: true; status: number; locations: GhLocation[]; error?: undefined }
  | { ok: false; status: number; locations: GhLocation[]; error?: string };
export type TestBooking =
  | { ok: true; bookingId?: unknown; service?: string; when: string; error?: undefined }
  | { ok: false; error: string; bookingId?: undefined; service?: undefined; when?: undefined };
export type ConnectedBranch = {
  garageId: string;
  garageName: string;
  locationId: string;
  testBooking: TestBooking;
};
export type FlaggedBranch = {
  garageId: string;
  garageName: string;
  matchedLocationId: number | null;
  confidence: GhConfidence;
};
export type AutoConnectResult = {
  ok: boolean;
  error?: string;
  instance: string;
  connected: ConnectedBranch[];
  flagged: FlaggedBranch[];
};

/** Prisma JSON columns come back as JsonValue; every read here wants a plain object. */
const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---- Stateless connect-link token (no DB row / migration) ------------------
// A signed { businessId, exp } — the emailed link carries this so GarageHive can open the form
// without a login. HMAC over JWT_SECRET; single-use isn't enforced because re-submitting the same
// instance is idempotent (it re-derives and re-writes the same config).
const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const signConnectToken = (businessId: string): string => {
  const secret = process.env.JWT_SECRET || '';
  const payload = Buffer.from(
    JSON.stringify({ b: businessId, exp: Date.now() + TOKEN_TTL_MS }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};

export const verifyConnectToken = (token: string): string | null => {
  const secret = process.env.JWT_SECRET || '';
  const [payload, sig] = (token || '').split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const { b: businessId, exp } = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { b?: unknown; exp?: unknown };
    if (typeof businessId !== 'string' || typeof exp !== 'number' || Date.now() > exp) return null;
    return businessId;
  } catch {
    return null;
  }
};

// "Uses GarageHive" = at least one branch runs a GarageHive agent (selected at signup).
export const businessUsesGarageHive = async (businessId: string): Promise<boolean> => {
  const garages = await prisma.garage.findMany({ where: { businessId }, select: { id: true } });
  if (!garages.length) return false;
  const hit = await prisma.agentConfiguration.findFirst({
    where: { garageId: { in: garages.map((g) => g.id) }, agentScript: { in: GH_AGENT_SCRIPTS } },
    select: { garageId: true },
  });
  return !!hit;
};

// Ensure the garage's inbound calls reach the GarageHive agent on LiveKit Account 1. The config
// switch alone isn't enough: a garage migrating from Assist (Account 2) either has no Account-1
// trunk at all (→ calls ring out) or an Account-1 dispatch rule still pointing at the old agent.
// update-agent fixes an existing rule; a 404 means no rule yet, so provision creates the trunk+rule.
//
// NOT used for the unified agent: that runs in its own LiveKit project and is routed by the
// /voice webhook off agentScript, so it has no Account-1 dispatch rule. Writing one would point
// a rule at an agent that does not exist there. config.ts skips the same step for the same reason.
const ensureAccount1SipDispatch = async (
  garageId: string,
  garageName: string,
  twilioNumber: string | null,
  agentName: string,
): Promise<void> => {
  if (agentName === 'unified-agent') {
    console.log('[GH-CONNECT] unified-agent routes via /voice — skipping Account-1 dispatch for', garageId);
    return;
  }
  const onboardingUrl = process.env.ONBOARDING_SERVICE_URL;
  if (!onboardingUrl) {
    console.warn('[GH-CONNECT] ONBOARDING_SERVICE_URL not set — skipping SIP provisioning for', garageId);
    return;
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.ONBOARDING_SECRET) headers['x-onboarding-secret'] = process.env.ONBOARDING_SECRET;
  try {
    const upd = await fetch(`${onboardingUrl}/update-agent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ garageId, agentName, account: 'account1' }),
    });
    if (upd.ok) {
      console.log(`[GH-CONNECT] Account-1 dispatch rule updated -> ${agentName} for ${garageId}`);
      return;
    }
    if (upd.status !== 404) {
      console.error('[GH-CONNECT] update-agent failed', upd.status, await upd.text().catch(() => ''));
      return;
    }
    // 404 -> no Account-1 trunk/rule yet (fresh Assist migration). Create it.
    if (!twilioNumber) {
      console.error('[GH-CONNECT] no twilioNumber — cannot provision Account-1 SIP for', garageId);
      return;
    }
    const prov = await fetch(`${onboardingUrl}/provision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        garageId,
        garageName,
        twilioNumber,
        agentName,
        account: 'account1',
        triggeredAt: new Date().toISOString(),
      }),
    });
    console.log(`[GH-CONNECT] Account-1 SIP provisioned (${prov.status}) for ${garageId}`);
  } catch (err) {
    console.error('[GH-CONNECT] ensureAccount1SipDispatch failed for', garageId, err);
  }
};

// Write one branch's GarageHive config and push it to the agent (DynamoDB).
const connectGarageToLocation = async (
  garageId: string,
  instance: string,
  apiKey: string,
  locationId: string,
): Promise<void> => {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      name: true,
      twilioNumber: true,
      agentConfiguration: { select: { integrationProviderConfig: true } },
    },
  });
  if (!garage) throw new Error('garage not found');
  const existing = asObject(garage.agentConfiguration?.integrationProviderConfig);
  const integrationProviderConfig = { ...existing, apiKey, customerId: instance, locationId };
  await prisma.agentConfiguration.upsert({
    where: { garageId },
    update: {
      integrationProvider: 'garage_hive',
      integrationProviderConfig,
      agentType: 'automate',
      agentScript: GH_AGENT_SCRIPT,
    },
    create: {
      garageId,
      branchName: garage.name,
      integrationProvider: 'garage_hive',
      integrationProviderConfig,
      agentType: 'automate',
      agentScript: GH_AGENT_SCRIPT,
    },
  });
  await sendAgentConfigWebhook(garageId);
  // Make sure inbound calls actually reach the agent (see helper above).
  await ensureAccount1SipDispatch(garageId, garage.name, garage.twilioNumber, GH_AGENT_SCRIPT);
};

// Place a marked test booking to PROVE the diary connection works end-to-end (not just that the
// credentials were accepted). Reg V20ALA, the first bookable service, the first available slot, and
// a "please cancel" note. Mirrors the voice agent's proven set-contact-info payload (salutation/
// last_name/city are required by GarageHive even though contact_info_fields doesn't list them).
export const placeTestBooking = async (
  instance: string,
  apiKey: string,
  locationId: number | string,
): Promise<TestBooking> => {
  const H = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const base = `${GH_BASE}/${encodeURIComponent(instance)}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}/${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const get = async (path: string) => {
    const r = await fetch(`${base}/${path}`, { headers: H });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  try {
    const init = await post('init', { locationId });
    const sid = init.data?.booking?.session_id || init.data?.session_id;
    if (!sid) return { ok: false, error: 'init returned no session' };
    await post(`${sid}/set-vehicle-info`, {
      registration_no: 'V20ALA',
      reg_no_country: 'GB',
      location_id: locationId,
    });
    const svc = await get(`${sid}/list-services`);
    const first = svc.data?.services?.[0];
    if (!first?.service_price_id) return { ok: false, error: 'no bookable services returned' };
    await post(`${sid}/set-services`, { servicePriceIDs: [first.service_price_id] });
    const ts = await get(`${sid}/list-timeslots`);
    const slots: Record<string, string[]> =
      ts.data?.timeslots && typeof ts.data.timeslots === 'object' ? ts.data.timeslots : {};
    const date = Object.keys(slots)[0];
    const time = date ? slots[date]?.[0] : undefined;
    if (!date || !time) return { ok: false, error: 'no timeslots available' };
    await post(`${sid}/set-timeslot`, { bookingDate: date, bookingTime: time });
    const fin = await post(`${sid}/set-contact-info`, {
      contact_salutation: 10,
      contact_name: 'ReceptionMate',
      contact_last_name: 'Test',
      contact_number: '01234567890',
      contact_address: 'ReceptionMate test',
      contact_address2: '',
      contact_city: 'Test',
      contact_postcode: 'SW1A 1AA',
      vehicle_mileage: 10000,
      notes: 'receptionmate test booking please cancel',
    });
    if (fin.status < 200 || fin.status >= 300) {
      return { ok: false, error: `finalise HTTP ${fin.status}: ${JSON.stringify(fin.data).slice(0, 200)}` };
    }
    return { ok: true, bookingId: fin.data?.booking?.id, service: first.name, when: `${date} ${time}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'test booking failed' };
  }
};

// Getting-ready heads-up: sent to the garage when they SIGN (the earliest reliable touchpoint),
// so they have time to set up the GarageHive "Other" service package before they go live. Only
// while still waiting to connect — once connected they're going live and the "You're live" email
// carries the same instruction. Idempotent via a gettingReadyEmailedAt flag in the config JSON.
export const sendGarageHiveGettingReady = async (garageId: string): Promise<boolean> => {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      id: true,
      name: true,
      agentConfiguration: { select: { integrationProviderConfig: true, agentScript: true } },
    },
  });
  const script = garage?.agentConfiguration?.agentScript || '';
  if (!garage || !GH_AGENT_SCRIPTS.includes(script)) return false; // not a GarageHive garage
  const ipc = asObject(garage.agentConfiguration?.integrationProviderConfig);
  if (ipc.customerId) return false; // already connected — the "You're live" email covers it
  if (ipc.gettingReadyEmailedAt) return false; // once only
  const users = await prisma.user.findMany({
    where: { garageAccessIds: { has: garageId }, role: { not: 'RECEPTIONMATE_STAFF' } },
    select: { email: true, branchRoles: true },
  });
  const manager =
    users.find((u) => asObject(u.branchRoles)[garageId] === 'MANAGER') || users[0];
  if (!manager?.email) return false;
  await prisma.agentConfiguration.update({
    where: { garageId },
    data: { integrationProviderConfig: { ...ipc, gettingReadyEmailedAt: new Date().toISOString() } },
  });
  const body =
    `<tr><td style="padding: 32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">Getting ${garage.name} ready</h1>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">Thanks for signing. Your ReceptionMate agent books straight into your <strong>existing Garage Hive online booking system</strong> — nothing new to learn, and your diary stays exactly as it is.</p>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">One thing to set up in Garage Hive while we finish your agent: add an <strong>“Other”</strong> service package, so the agent can book custom jobs that don't match a standard service. Garage Hive's guide walks you through it — <a href="${GH_OTHER_GUIDE_URL}" style="color:#3426cf;font-weight:600;">How to set up an “Other” service package</a>.</p>` +
    `<p style="margin:0;font-size:15px;line-height:1.55;color:#475569;">Do this whenever suits — we'll email you again the moment your agent is live.</p>` +
    `</td></tr>`;
  void sendEmail({
    to: [manager.email],
    subject: `Getting ${garage.name} ready on ReceptionMate`,
    text:
      `Thanks for signing. Your ReceptionMate agent books straight into your existing Garage Hive online booking system.\n\n` +
      `One thing to set up in Garage Hive while we finish your agent: add an "Other" service package so the agent can book custom jobs. ` +
      `Garage Hive's guide: ${GH_OTHER_GUIDE_URL}\n\nDo this whenever suits — we'll email you again the moment your agent is live.`,
    html: brandedEmailShell(body),
  });
  return true;
};

// The email to GarageHive asking them to connect the diary. This is the one piece of the flow
// that had no surviving copy anywhere — not in dist, not in the 19 Aug pre-loss backup — so it
// is rebuilt from a sent copy (20 Jul, Mallory Performance Ltd) rather than recovered. The
// wording, the button and the "Link valid 14 days" line are reproduced from that email; the
// token is the same signConnectToken the restored /garagehive-connect endpoints verify.
//
// Recipient comes from GARAGEHIVE_CONNECT_EMAIL_TO. Deliberately no default: sending an
// onboarding request to a guessed address is worse than not sending it, and a missing value is
// logged loudly rather than swallowed.
export const sendGarageHiveConnectRequest = async (businessId: string): Promise<boolean> => {
  const to = (process.env.GARAGEHIVE_CONNECT_EMAIL_TO || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!to.length) {
    console.warn(
      '[GH-CONNECT] GARAGEHIVE_CONNECT_EMAIL_TO is not set — NOT sending the connect request for',
      businessId,
    );
    return false;
  }
  if (!(await businessUsesGarageHive(businessId))) return false;
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  const name = business?.name || 'This garage';
  const link = `${PORTAL_URL}/connect-garagehive?token=${signConnectToken(businessId)}`;
  const body =
    `<tr><td style="padding: 32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">New ReceptionMate onboard</h1>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;"><strong>${name}</strong> is being onboarded to ReceptionMate Automate.</p>` +
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#475569;">Open the link below and paste the garage's GarageHive <strong>instance</strong> — that's all that's needed.</p>` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 18px;"><tr>` +
    `<td style="background:#3426cf;border-radius:10px;"><a href="${link}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;">Connect GarageHive diary</a></td>` +
    `</tr></table>` +
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#94a3b8;text-align:center;">Or paste this link: <a href="${link}" style="color:#3426cf;word-break:break-all;">${link}</a><br>Link valid 14 days.</p>` +
    `</td></tr>`;
  void sendEmail({
    to,
    subject: 'New ReceptionMate onboard',
    text:
      `${name} is being onboarded to ReceptionMate Automate.\n\n` +
      `Open the link below and paste the garage's GarageHive instance — that's all that's needed.\n\n` +
      `${link}\n\nLink valid 14 days.`,
    html: brandedEmailShell(body),
  });
  console.log(`[GH-CONNECT] connect request sent to ${to.join(', ')} for ${name}`);
  return true;
};

// Auto go-live convergence: a GarageHive garage is "live" once BOTH tracks are done — the
// agreement is signed AND the diary is connected. Whichever finishes last calls this; the first
// time both are true we email the garage "you're live" and mark them live. Idempotent via a
// goLiveEmailedAt flag stored in the config JSON (no migration, no agent resync needed).
export const announceGoLiveIfReady = async (garageId: string): Promise<boolean> => {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      id: true,
      name: true,
      businessId: true,
      twilioNumber: true,
      welcomeEmailSentAt: true,
      agentConfiguration: { select: { integrationProviderConfig: true, agentScript: true } },
    },
  });
  if (!garage) return false;
  const ipc = asObject(garage.agentConfiguration?.integrationProviderConfig);
  const script = garage.agentConfiguration?.agentScript || '';
  const connected = !!ipc.customerId && !!ipc.locationId && GH_AGENT_SCRIPTS.includes(script);
  if (!connected || ipc.goLiveEmailedAt) return false;
  const signed = garage.businessId
    ? await prisma.agreement.findFirst({
        where: { businessId: garage.businessId, status: { in: ['signed', 'externally_signed'] } },
        select: { id: true },
      })
    : null;
  if (!signed) return false;
  // Mark announced (JSON flag only — the agent doesn't need it, so no DynamoDB resync) + go live.
  await prisma.agentConfiguration.update({
    where: { garageId },
    data: { integrationProviderConfig: { ...ipc, goLiveEmailedAt: new Date().toISOString() } },
  });
  // The original also set garage.onboardingStage = 'live' here. That column exists neither in
  // schema.prisma nor in the database, so the call threw on every run and its own .catch()
  // swallowed it — the flag above and the email below are what actually marked a garage live.
  // Dropped rather than carried forward as a no-op; add the column first if the stage is wanted.
  const users = await prisma.user.findMany({
    where: { garageAccessIds: { has: garageId }, role: { not: 'RECEPTIONMATE_STAFF' } },
    select: { id: true, email: true, branchRoles: true, mustChangePassword: true },
  });
  const manager = users.find((u) => asObject(u.branchRoles)[garageId] === 'MANAGER') || users[0];
  if (!manager?.email) return true;

  // Credentials ride along with go-live, because go-live IS the moment there is something to log
  // in to — which is exactly why the welcome email was deferred at onboarding in the first place.
  // Previously a human had to notice and press Invite; nothing joined the two facts up.
  //
  // Two guards, both carried over from that invite endpoint:
  //  - never rotate a password somebody is already using. mustChangePassword only goes false once
  //    they have logged in and chosen their own; reissuing would silently lock out a live user.
  //    They still get the go-live email, just without credentials.
  //  - welcomeEmailSentAt means they have already been sent a password. Don't mint another.
  const alreadyInvited = !!garage.welcomeEmailSentAt;
  const issueCredentials = manager.mustChangePassword && !alreadyInvited;
  let password = '';
  if (issueCredentials) {
    // We never keep plaintext, so the password has to be (re)set here to be able to send it.
    password = DEFAULT_PASSWORD;
    await prisma.user.update({
      where: { id: manager.id },
      data: { passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true },
    });
    await prisma.garage.update({
      where: { id: garageId },
      data: { welcomeEmailSentAt: new Date() },
    });
  }

  const number = garage.twilioNumber || 'your ReceptionMate number';
  const steps = issueCredentials
    ? `<ol style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.7;color:#475569;">` +
      `<li>Log in with the details above — you'll be asked to set your own password.</li>` +
      `<li>Set up your Direct Debit.</li>` +
      `<li>Finish your agent setup — greeting, opening hours, services.</li>` +
      `</ol>`
    : '';
  const creds = issueCredentials
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 18px;background:#f1f2f9;border-radius:10px;">` +
      `<tr><td style="padding:16px 20px;font-size:15px;line-height:1.7;color:#0f172a;">` +
      `<strong>Email:</strong> ${manager.email}<br><strong>Password:</strong> ${password}` +
      `</td></tr></table>`
    : '';
  const body =
    `<tr><td style="padding: 32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">You're live 🎉</h1>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;"><strong>${garage.name}</strong> is now connected to your GarageHive diary.</p>` +
    (issueCredentials
      ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#475569;">Here are your login details — there are three quick things to finish off:</p>${creds}${steps}`
      : `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#475569;">Log in to finish your agent setup.</p>`) +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 18px;"><tr>` +
    `<td style="background:#3426cf;border-radius:10px;"><a href="${PORTAL_URL}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;">Log in to finish setting up</a></td>` +
    `</tr></table>` +
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#475569;">Once that's done, set up call forwarding on your line to your ReceptionMate number:</p>` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 18px;"><tr><td style="background:#f1f2f9;border-radius:10px;padding:14px 26px;text-align:center;"><span style="font-size:22px;font-weight:800;color:#3426cf;letter-spacing:0.5px;">${number}</span></td></tr></table>` +
    `<p style="margin:0;font-size:15px;line-height:1.55;color:#475569;">One last thing in Garage Hive: add an <strong>“Other”</strong> service package so the agent can book custom jobs. Garage Hive's guide walks you through it — <a href="${GH_OTHER_GUIDE_URL}" style="color:#3426cf;font-weight:600;">How to set up an “Other” service package</a>.</p>` +
    `</td></tr>`;

  const sent = await sendEmail({
    to: [manager.email],
    subject: `${garage.name} is live on ReceptionMate`,
    text:
      `${garage.name} is now connected to your GarageHive diary.\n\n` +
      (issueCredentials
        ? `Log in at ${PORTAL_URL}\n  Email: ${manager.email}\n  Password: ${password}\n\n` +
          `Three quick things to finish off:\n  1. Log in — you'll be asked to set your own password.\n` +
          `  2. Set up your Direct Debit.\n  3. Finish your agent setup.\n\n`
        : `Log in at ${PORTAL_URL} to finish your agent setup.\n\n`) +
      `Then set up call forwarding on your line to your ReceptionMate number: ${number}.\n\n` +
      `One last thing in Garage Hive: add an "Other" service package so the agent can book custom jobs: ${GH_OTHER_GUIDE_URL}`,
    html: brandedEmailShell(body),
  }).catch(() => false);

  // A rotated password that never reached the customer locks them out of an account nobody has
  // the password for. There is no human in this flow to hand a 502 to, so undo the stamp — which
  // lets the next run retry — and make noise.
  if (!sent && issueCredentials) {
    await prisma.garage
      .update({ where: { id: garageId }, data: { welcomeEmailSentAt: null } })
      .catch(() => {});
    console.error('[GH-CONNECT] go-live email FAILED after rotating the password for', manager.email);
    void sendOpsSms(
      `ReceptionMate: go-live email failed for ${garage.name} (${manager.email}). Password was reset — re-send before they try to log in.`,
    ).catch(() => {});
  }
  return true;
};

// The public flow's workhorse: instance in → auto-match every branch → connect the confident ones,
// flag the ambiguous ones for a human. GarageHive never picks a branch.
export const autoConnectBusiness = async (
  businessId: string,
  instance: string,
): Promise<AutoConnectResult> => {
  const apiKey = await resolveSharedGhApiKey();
  if (!apiKey)
    return { ok: false, error: 'No shared GarageHive API key', instance, connected: [], flagged: [] };
  const garages = await prisma.garage.findMany({
    where: { businessId },
    select: { id: true, name: true, agentConfiguration: { select: { branchAddress: true } } },
    orderBy: { name: 'asc' },
  });
  if (!garages.length)
    return { ok: false, error: 'No garages for this business', instance, connected: [], flagged: [] };
  const init = await ghInit(instance, apiKey);
  if (!init.ok)
    return {
      ok: false,
      error: `GarageHive did not accept instance "${instance}"`,
      instance,
      connected: [],
      flagged: [],
    };
  const connected: ConnectedBranch[] = [];
  const flagged: FlaggedBranch[] = [];
  for (const g of garages) {
    const m = matchBranch(g.name, g.agentConfiguration?.branchAddress || '', init.locations);
    if (m.locationId != null && (m.confidence === 'auto' || m.confidence === 'high')) {
      await connectGarageToLocation(g.id, instance, apiKey, String(m.locationId));
      // Prove the diary works: place a marked test booking into this branch's location.
      const testBooking = await placeTestBooking(instance, apiKey, m.locationId);
      connected.push({
        garageId: g.id,
        garageName: g.name,
        locationId: String(m.locationId),
        testBooking,
      });
      // If they've already signed, this was the last piece — go live + email the garage.
      await announceGoLiveIfReady(g.id).catch(() => {});
    } else {
      flagged.push({
        garageId: g.id,
        garageName: g.name,
        matchedLocationId: m.locationId,
        confidence: m.confidence,
      });
    }
  }
  return { ok: true, instance, connected, flagged };
};

// The API key is identical across every GarageHive garage. Prefer an explicit env var; otherwise
// lift it from any garage already configured for GarageHive (that's where it lives today).
let cachedApiKey: string | null = null;
export const resolveSharedGhApiKey = async (): Promise<string | null> => {
  if (cachedApiKey) return cachedApiKey;
  const fromEnv = process.env.GARAGEHIVE_API_KEY || process.env.GH_API_KEY;
  if (fromEnv) {
    cachedApiKey = fromEnv;
    return cachedApiKey;
  }
  const existing = await prisma.agentConfiguration.findFirst({
    where: { integrationProvider: 'garage_hive' },
    select: { integrationProviderConfig: true },
  });
  const ipc = asObject(existing?.integrationProviderConfig);
  const key =
    (typeof ipc.apiKey === 'string' && ipc.apiKey) ||
    (typeof ipc.ghApiKey === 'string' && ipc.ghApiKey) ||
    null;
  cachedApiKey = key || null;
  return cachedApiKey;
};

// Call /init for an instance and return its location list. This both validates the instance
// (bad instance / bad key -> non-200) and yields the locations to match against. /init only
// starts a booking session — it writes nothing to the garage's diary.
export const ghInit = async (instance: string, apiKey: string): Promise<GhInitResult> => {
  const url = `${GH_BASE}/${encodeURIComponent(instance)}/init`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) {
      return { ok: false, status: r.status, locations: [], error: `init returned ${r.status}` };
    }
    const body = (await r.json()) as { locations?: unknown };
    const raw = Array.isArray(body.locations) ? body.locations : [];
    const locations = raw
      .map((l): GhLocation | null => {
        if (!l || typeof l !== 'object') return null;
        const o = l as Record<string, unknown>;
        if (typeof o.id !== 'number') return null;
        return {
          id: o.id,
          name: typeof o.name === 'string' ? o.name : '',
          address: typeof o.address === 'string' ? o.address : '',
        };
      })
      .filter((l): l is GhLocation => l !== null);
    return { ok: true, status: r.status, locations };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      locations: [],
      error: e instanceof Error ? e.message : 'init failed',
    };
  }
};

// ---- Branch matching -------------------------------------------------------
// Match a garage to a location by distinctive tokens (town names, postcodes) shared between the
// garage's name+address and the location's name+address. Generic words are stripped so "In'n'out
// Autocentres Norwich" vs "Norwich - In N Out Autocentres" scores on "norwich", not the chain name.
const STOP = new Set([
  'the', 'and', 'ltd', 'limited', 'garage', 'garages', 'autocentre', 'autocentres', 'auto', 'centre',
  'centres', 'center', 'motors', 'motor', 'services', 'service', 'ltd.', 'co', 'company', 'in', 'n',
  'out', 'car', 'cars', 'vehicle', 'repairs', 'repair', 'performance', 'automotive', 'tyres', 'tyre',
]);
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;

const tokens = (s: string): Set<string> => {
  const set = new Set<string>();
  for (const w of (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (w && w.length >= 3 && !STOP.has(w)) set.add(w);
  }
  return set;
};

const postcodes = (s: string): Set<string> => {
  const set = new Set<string>();
  for (const m of (s || '').toUpperCase().matchAll(POSTCODE_RE)) set.add(m[0].replace(/\s+/g, ''));
  return set;
};

// Score a garage against a location by asking: how many of the LOCATION's distinctive tokens
// (its town) appear in the garage? Dividing by the location's token count — not the garage's —
// keeps a long garage address from diluting the town signal. Matches in the garage NAME count
// full; address-only matches count less (a road named after another town is noise, not signal).
// A postcode match is decisive.
const scoreOne = (garageName: string, garageAddress: string, loc: GhLocation): number => {
  // The location's distinctive signal is the town in its NAME ("Basingstoke - In N Out
  // Autocentres"), not its street address — so score primarily on the location-name tokens.
  const lName = tokens(loc.name);
  if (lName.size === 0) return 0;
  const gName = tokens(garageName);
  const gAll = tokens(`${garageName} ${garageAddress}`);
  let hitInName = 0;
  let hitInAddr = 0;
  for (const t of lName) {
    if (gName.has(t)) hitInName += 1; // town in the garage NAME — strongest
    else if (gAll.has(t)) hitInAddr += 1; // only in the garage address — weaker
  }
  let score = (hitInName + hitInAddr * 0.5) / lName.size;
  // An exact postcode match (garage address vs location address) is decisive.
  const gP = postcodes(`${garageName} ${garageAddress}`);
  const lP = postcodes(`${loc.name} ${loc.address}`);
  for (const p of gP) if (lP.has(p)) score += 1;
  return score;
};

export const matchBranch = (
  garageName: string,
  garageAddress: string,
  locations: GhLocation[],
): GhMatch => {
  if (locations.length === 0)
    return { locationId: null, confidence: 'none', score: 0, runnerUpScore: 0 };
  if (locations.length === 1)
    return { locationId: locations[0].id, confidence: 'auto', score: 1, runnerUpScore: 0 };
  const scored = locations
    .map((l) => ({ id: l.id, s: scoreOne(garageName, garageAddress, l) }))
    .sort((a, b) => b.s - a.s);
  const [top, second] = scored;
  const runnerUp = second ? second.s : 0;
  // Confident when the best is a solid, clear win over the runner-up.
  const clear = top.s >= 0.5 && top.s - runnerUp >= 0.34;
  return {
    locationId: top.s > 0 ? top.id : null,
    confidence: clear ? 'high' : top.s > 0 ? 'low' : 'none',
    score: Number(top.s.toFixed(2)),
    runnerUpScore: Number(runnerUp.toFixed(2)),
  };
};
