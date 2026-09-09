// Thin client for HighLevel V2 (Private Integration Token). Used by both
// the lead-capture route (Automate/Connect enquiries) and the public-signup
// route (Assist accounts) to push contacts + opportunities into HL.
//
// The pipeline + stage IDs aren't in env vars because the team thinks in
// names ("Onboarding Newest", "Live and £££££"). We resolve names → IDs on
// first use and cache them for the process lifetime; if names change in HL,
// restart pm2 to pick up the new IDs.

const GHL_PIT = process.env.GHL_API_KEY ?? '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? '';
const GHL_BASE_URL = (process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/$/, '');

// HighLevel pipeline IDs. Pinned via env so a rename in HL doesn't break our
// CRM sync (and so we don't pay an API roundtrip on every opportunity create).
//   GHL_PIPELINE_ID       — "Onboarding Newest"
//   GHL_SIGNUP_STAGE_ID   — "Live and £££..." (converted/paid accounts land here)
//   GHL_LEAD_STAGE_ID     — "Enquiry Received & Demo Links sent" (new leads)
//   GHL_TRIAL_STAGE_ID    — "Free trial live" (new 14-day Assist trials land here)
const PIPELINE_ID     = process.env.GHL_PIPELINE_ID     ?? '';
const SIGNUP_STAGE_ID = process.env.GHL_SIGNUP_STAGE_ID ?? '';
const LEAD_STAGE_ID   = process.env.GHL_LEAD_STAGE_ID   ?? '';
const TRIAL_STAGE_ID  = process.env.GHL_TRIAL_STAGE_ID  ?? '';
// New self-serve signups land here on details-submit (before they sign + pay), then move
// to "Free trial live" once the account is created. Defaults to the live stage id.
const ABANDONED_STAGE_ID = process.env.GHL_ABANDONED_STAGE_ID ?? '81307e40-9210-47e4-9898-7f1a18ce8ee7';
// The "Live and £££" stage an opportunity is promoted to once the trial converts.
export const LIVE_STAGE_ID = SIGNUP_STAGE_ID;
// The "Free trial live" stage a signup moves to once it becomes a real trial account.
export const TRIAL_LIVE_STAGE_ID = TRIAL_STAGE_ID;
// The "Enquiry Received & Demo Links sent" stage a non-Assist lead moves to (it passes
// through Abandoned checkout first, per the get-started flow).
export const ENQUIRY_STAGE_ID = LEAD_STAGE_ID;
// Sales-led onboarding pipeline stages. These three, and the two lookup functions at the bottom
// of this file, were lost with the rest of the pipeline feature in August — the stage IDs
// survived only because they live in .env, which is not in git.
export const HL_AWAITING_CREDENTIALS_STAGE_ID = process.env.GHL_AWAITING_CREDENTIALS_STAGE_ID ?? '';
export const HL_AGENT_BUILT_STAGE_ID = process.env.GHL_AGENT_BUILT_STAGE_ID ?? '';
export const HL_INVITED_STAGE_ID = process.env.GHL_INVITED_STAGE_ID ?? '';
// "Contract Sent". Not one of our onboarding stages — internally a deal sits at
// awaiting_agreement from the moment it is created until it is signed — but sending the
// contract is exactly the event sales want reflected in the CRM, so the send endpoint moves it
// directly rather than pretending we changed stage.
export const HL_CONTRACT_SENT_STAGE_ID = process.env.GHL_CONTRACT_SENT_STAGE_ID ?? '';

const HEADERS = {
  Authorization: `Bearer ${GHL_PIT}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Version: '2021-07-28',
};

export function highlevelConfigured(): boolean {
  return Boolean(GHL_PIT && GHL_LOCATION_ID);
}

function pipelineConfigured(): boolean {
  return Boolean(PIPELINE_ID && SIGNUP_STAGE_ID && LEAD_STAGE_ID);
}

export interface UpsertContactArgs {
  name: string;
  // Email OR phone must be present — HL needs at least one identifier. At the garage-search
  // step of the funnel we only have the garage's Google phone (no user email yet).
  email?: string;
  phone?: string;
  // Optional: the name+email CTAs (e.g. "Hear Leah answer a call") collect no company,
  // so callers may omit it rather than inventing a placeholder.
  companyName?: string;
  website?: string;
  source?: string;
  tags?: string[];
}

export interface ContactResult {
  contactId: string | null;
  raw: unknown;
}

export async function upsertContact(args: UpsertContactArgs): Promise<ContactResult> {
  if (!highlevelConfigured()) return { contactId: null, raw: null };

  const parts = args.name.trim().split(/\s+/);
  const firstName = parts[0] ?? '';
  const lastName  = parts.slice(1).join(' ');

  const body: Record<string, unknown> = {
    locationId: GHL_LOCATION_ID,
    firstName,
    lastName,
    name: args.name,
    ...(args.companyName ? { companyName: args.companyName } : {}),
    source: args.source || 'website',
    tags: args.tags ?? ['website-lead'],
  };
  if (args.email) body.email = args.email;
  if (args.phone) body.phone = args.phone;
  if (args.website) body.website = args.website;

  try {
    const res = await fetch(`${GHL_BASE_URL}/contacts/upsert`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[HL] contact upsert failed ${res.status}:`, text.slice(0, 300));
      return { contactId: null, raw: null };
    }
    const json = (await res.json()) as { contact?: { id?: string }; id?: string };
    return { contactId: json.contact?.id ?? json.id ?? null, raw: json };
  } catch (err) {
    console.error('[HL] contact upsert threw:', err);
    return { contactId: null, raw: null };
  }
}

// Update an existing contact by id (PUT) — used to replace a placeholder identifier with the
// real name/email/phone as a prospect progresses, without creating a duplicate. Tolerant.
export async function updateContact(
  contactId: string,
  fields: { name?: string; email?: string; phone?: string; website?: string },
): Promise<boolean> {
  if (!highlevelConfigured() || !contactId) return false;
  const body: Record<string, unknown> = {};
  if (fields.name) {
    const parts = fields.name.trim().split(/\s+/);
    body.firstName = parts[0] ?? '';
    body.lastName = parts.slice(1).join(' ');
    body.name = fields.name;
  }
  if (fields.email) body.email = fields.email;
  if (fields.phone) body.phone = fields.phone;
  if (fields.website) body.website = fields.website;
  if (Object.keys(body).length === 0) return false;
  try {
    const res = await fetch(`${GHL_BASE_URL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[HL] contact update failed ${res.status}:`, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[HL] contact update threw:', err);
    return false;
  }
}

export type OpportunityKind = 'signup' | 'lead' | 'trial' | 'abandoned';

export interface CreateOpportunityArgs {
  contactId: string;
  name: string;
  monetaryValueGbp?: number;
  monthlyCostPerBranchGbp?: number; // → opportunity custom field monthly_cost_per_branch
  packageName?: string;             // → opportunity custom field package (e.g. "Assist")
  kind: OpportunityKind;
}

export async function createOpportunity(args: CreateOpportunityArgs): Promise<{ id: string | null }> {
  if (!highlevelConfigured()) return { id: null };
  if (!pipelineConfigured()) {
    console.warn('[HL] skipping opportunity — set GHL_PIPELINE_ID / GHL_SIGNUP_STAGE_ID / GHL_LEAD_STAGE_ID in env.');
    return { id: null };
  }
  const stageId =
    args.kind === 'signup'    ? SIGNUP_STAGE_ID :
    args.kind === 'trial'     ? (TRIAL_STAGE_ID || SIGNUP_STAGE_ID) :
    args.kind === 'abandoned' ? (ABANDONED_STAGE_ID || LEAD_STAGE_ID) :
    LEAD_STAGE_ID;

  const body: Record<string, unknown> = {
    pipelineId: PIPELINE_ID,
    pipelineStageId: stageId,
    locationId: GHL_LOCATION_ID,
    contactId: args.contactId,
    name: args.name,
    status: 'open',
  };
  if (typeof args.monetaryValueGbp === 'number') body.monetaryValue = args.monetaryValueGbp;
  const customFields: Array<{ key: string; field_value: string }> = [];
  if (typeof args.monthlyCostPerBranchGbp === 'number') {
    customFields.push({ key: 'monthly_cost_per_branch', field_value: String(args.monthlyCostPerBranchGbp) });
  }
  if (args.packageName) {
    customFields.push({ key: 'package', field_value: args.packageName });
  }
  if (customFields.length) body.customFields = customFields;

  try {
    const res = await fetch(`${GHL_BASE_URL}/opportunities/`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[HL] opportunity create failed ${res.status}:`, text.slice(0, 300));
      return { id: null };
    }
    const json = (await res.json()) as { opportunity?: { id?: string }; id?: string };
    return { id: json.opportunity?.id ?? json.id ?? null };
  } catch (err) {
    console.error('[HL] opportunity create threw:', err);
    return { id: null };
  }
}

// Move an existing opportunity to a different stage (and optionally update its
// value). Used to promote a trial opportunity to "Live and £££" on conversion.
// Tolerant: logs + returns false on failure, never throws.
export async function updateOpportunity(
  opportunityId: string,
  args: { stageId?: string; monetaryValueGbp?: number; status?: string },
): Promise<boolean> {
  if (!highlevelConfigured() || !opportunityId) return false;
  const body: Record<string, unknown> = {};
  if (args.stageId) body.pipelineStageId = args.stageId;
  if (typeof args.monetaryValueGbp === 'number') body.monetaryValue = args.monetaryValueGbp;
  if (args.status) body.status = args.status;
  if (Object.keys(body).length === 0) return false;
  try {
    const res = await fetch(`${GHL_BASE_URL}/opportunities/${opportunityId}`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[HL] opportunity update failed ${res.status}:`, text.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[HL] opportunity update threw:', err);
    return false;
  }
}

// Convenience helper: upsert a contact and create an opportunity in one go.
// Both calls are tolerant — failures log + return null but never throw.
// Returns the created opportunity id (so callers can store it and promote the
// opportunity later, e.g. when a trial converts to paid).
export async function pushSignupToHighlevel(args: {
  name: string;
  email: string;
  phone?: string;
  companyName: string;
  website?: string;
  source: string;
  tags?: string[];
  opportunityName: string;
  monetaryValueGbp?: number;
  monthlyCostPerBranchGbp?: number;
  packageName?: string;
  kind: OpportunityKind;
}): Promise<{ opportunityId: string | null; contactId: string | null }> {
  const contact = await upsertContact({
    name: args.name,
    email: args.email,
    phone: args.phone,
    companyName: args.companyName,
    website: args.website,
    source: args.source,
    tags: args.tags,
  });
  if (!contact.contactId) return { opportunityId: null, contactId: null };
  const opp = await createOpportunity({
    contactId: contact.contactId,
    name: args.opportunityName,
    monetaryValueGbp: args.monetaryValueGbp,
    monthlyCostPerBranchGbp: args.monthlyCostPerBranchGbp,
    packageName: args.packageName,
    kind: args.kind,
  });
  return { opportunityId: opp.id, contactId: contact.contactId };
}


// ---- Opportunity lookup for the onboarding pipeline ------------------------
// Staff pick their deal from a list rather than pasting an id (there is nowhere in the HL UI to
// copy one) or us matching on email (which silently picks the wrong opportunity — customers
// routinely have several, and the portal's own contact often has no email on it at all).
//
// REBUILT 2026-09-09: the originals did not survive anywhere, including the pre-loss backup, so
// these are written against the HighLevel API rather than recovered. Both are tolerant by
// design — a CRM lookup failing must never break onboarding.

export type OpportunityCandidate = {
  id: string;
  name: string;
  stageName: string | null;
  status: string | null;
  monetaryValue: number | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  updatedAt: string | null;
};

// The search response carries pipelineStageId but NO stage name, so give staff something
// readable by mapping the ids we already configure. Anything unmapped falls back to the id.
const STAGE_NAMES: Record<string, string> = {
  [process.env.GHL_LEAD_STAGE_ID ?? '']: 'Enquiry received & demo links sent',
  [process.env.GHL_ABANDONED_STAGE_ID ?? '']: 'Abandoned checkout',
  [process.env.GHL_TRIAL_STAGE_ID ?? '']: 'Free trial live',
  [process.env.GHL_AWAITING_CREDENTIALS_STAGE_ID ?? '']: 'Awaiting integration credentials',
  [process.env.GHL_AGENT_BUILT_STAGE_ID ?? '']: 'Agent set up, awaiting go-live',
  [process.env.GHL_INVITED_STAGE_ID ?? '']: 'Invited — awaiting DD mandate',
  [process.env.GHL_SIGNUP_STAGE_ID ?? '']: 'Live and £££',
};

const asCandidate = (o: unknown): OpportunityCandidate | null => {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, any>;
  if (typeof r.id !== 'string') return null;
  const c = (r.contact && typeof r.contact === 'object' ? r.contact : {}) as Record<string, any>;
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : '(unnamed opportunity)',
    stageName:
      (typeof r.pipelineStageId === 'string' && STAGE_NAMES[r.pipelineStageId]) ||
      (typeof r.pipelineStageId === 'string' ? r.pipelineStageId : null),
    status: typeof r.status === 'string' ? r.status : null,
    monetaryValue: typeof r.monetaryValue === 'number' ? r.monetaryValue : null,
    contactName: typeof c.name === 'string' ? c.name : null,
    contactEmail: typeof c.email === 'string' ? c.email : null,
    contactPhone: typeof c.phone === 'string' ? c.phone : null,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
  };
};

/** Opportunities matching an email and/or phone, newest first. Never throws. */
export async function findOpportunityCandidates(args: {
  email?: string | null;
  phone?: string | null;
}): Promise<OpportunityCandidate[]> {
  if (!highlevelConfigured()) return [];
  const found = new Map<string, OpportunityCandidate>();
  // Search each identifier separately and merge: HL treats multiple params as AND, and a
  // customer whose contact carries only a phone would vanish from an email+phone query.
  for (const [key, value] of [
    ['email', args.email],
    ['phone', args.phone],
  ] as const) {
    const v = (value || '').trim();
    if (!v) continue;
    // `q`, not `email`/`phone`: HighLevel answers those two with a 422 and no explanation,
    // which is why every search came back empty. `q` is the free-text search the API accepts,
    // and it matches on the contact's email and phone as well as the opportunity name.
    const qs = new URLSearchParams({ location_id: GHL_LOCATION_ID, q: v, limit: '20' });
    if (PIPELINE_ID) qs.set('pipeline_id', PIPELINE_ID);
    try {
      const res = await fetch(`${GHL_BASE_URL}/opportunities/search?${qs.toString()}`, {
        headers: HEADERS,
      });
      if (!res.ok) {
        console.error(`[HL] opportunity search by ${key} failed ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { opportunities?: unknown };
      for (const raw of Array.isArray(body.opportunities) ? body.opportunities : []) {
        const c = asCandidate(raw);
        if (c && !found.has(c.id)) found.set(c.id, c);
      }
    } catch (err) {
      console.error(`[HL] opportunity search by ${key} threw:`, err);
    }
  }
  return [...found.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/** One opportunity by id, or null if it no longer exists. Never throws. */
export async function fetchOpportunity(
  opportunityId: string,
): Promise<OpportunityCandidate | null> {
  if (!highlevelConfigured() || !opportunityId) return null;
  try {
    const res = await fetch(`${GHL_BASE_URL}/opportunities/${opportunityId}`, { headers: HEADERS });
    if (!res.ok) {
      // 404 is a real answer here — the pipeline uses it to tell "deleted in HL" apart from
      // "our contact is phone-only so the email search missed it".
      if (res.status !== 404) console.error(`[HL] opportunity fetch failed ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { opportunity?: unknown };
    return asCandidate(body.opportunity ?? body);
  } catch (err) {
    console.error('[HL] opportunity fetch threw:', err);
    return null;
  }
}
