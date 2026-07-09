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
  companyName: string;
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
    companyName: args.companyName,
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
