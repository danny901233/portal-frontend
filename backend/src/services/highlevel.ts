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
//   GHL_SIGNUP_STAGE_ID   — "Live and £££..." (paid signups land here)
//   GHL_LEAD_STAGE_ID     — "Enquiry Received & Demo Links sent" (new leads)
const PIPELINE_ID     = process.env.GHL_PIPELINE_ID     ?? '';
const SIGNUP_STAGE_ID = process.env.GHL_SIGNUP_STAGE_ID ?? '';
const LEAD_STAGE_ID   = process.env.GHL_LEAD_STAGE_ID   ?? '';

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
  email: string;
  phone?: string;
  companyName: string;
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
    email: args.email,
    companyName: args.companyName,
    source: args.source || 'website',
    tags: args.tags ?? ['website-lead'],
  };
  if (args.phone) body.phone = args.phone;

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

export type OpportunityKind = 'signup' | 'lead';

export interface CreateOpportunityArgs {
  contactId: string;
  name: string;
  monetaryValueGbp?: number;
  kind: OpportunityKind;
}

export async function createOpportunity(args: CreateOpportunityArgs): Promise<{ id: string | null }> {
  if (!highlevelConfigured()) return { id: null };
  if (!pipelineConfigured()) {
    console.warn('[HL] skipping opportunity — set GHL_PIPELINE_ID / GHL_SIGNUP_STAGE_ID / GHL_LEAD_STAGE_ID in env.');
    return { id: null };
  }
  const stageId = args.kind === 'signup' ? SIGNUP_STAGE_ID : LEAD_STAGE_ID;

  const body: Record<string, unknown> = {
    pipelineId: PIPELINE_ID,
    pipelineStageId: stageId,
    locationId: GHL_LOCATION_ID,
    contactId: args.contactId,
    name: args.name,
    status: 'open',
  };
  if (typeof args.monetaryValueGbp === 'number') body.monetaryValue = args.monetaryValueGbp;

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

// Convenience helper: upsert a contact and create an opportunity in one go.
// Both calls are tolerant — failures log + return null but never throw.
export async function pushSignupToHighlevel(args: {
  name: string;
  email: string;
  phone?: string;
  companyName: string;
  source: string;
  tags?: string[];
  opportunityName: string;
  monetaryValueGbp?: number;
  kind: OpportunityKind;
}): Promise<void> {
  const contact = await upsertContact({
    name: args.name,
    email: args.email,
    phone: args.phone,
    companyName: args.companyName,
    source: args.source,
    tags: args.tags,
  });
  if (!contact.contactId) return;
  await createOpportunity({
    contactId: contact.contactId,
    name: args.opportunityName,
    monetaryValueGbp: args.monetaryValueGbp,
    kind: args.kind,
  });
}
