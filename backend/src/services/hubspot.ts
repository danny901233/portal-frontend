import type { HubspotSettings } from '../utils/types.js';
import { sendEmail } from '../utils/email.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const SYNTHETIC_EMAIL_DOMAIN = 'receptionmate.co.uk';

// Call disposition GUIDs (HubSpot standard)
const DISPOSITION_CONNECTED = 'f240bbac-87c9-4f6e-bf70-924b57d47db7';

/** Generate a synthetic email from a phone number for HubSpot contact-to-inbox linking */
const syntheticEmail = (phone: string): string => {
  const clean = phone.replace(/[^0-9+]/g, '');
  return `caller-${clean}@${SYNTHETIC_EMAIL_DOMAIN}`;
};

export interface HubSpotCallData {
  customerPhone: string | null;
  fromNumber: string | null;
  customerName: string | null;
  registrationNumber: string | null;
  summary: string | null;
  bookingDetails: string | null;
  durationSeconds: number;
  callType: string;
  confirmedBooking: boolean;
  createdAt: Date;
  branchName: string;
  recordingUrl?: string | null;
  transcript?: Array<{ speaker: string; text: string }> | null;
}

const hubspotFetch = async (
  path: string,
  apiToken: string,
  options: RequestInit = {},
): Promise<Response> => {
  return fetch(`${HUBSPOT_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
};

interface ContactMatch {
  id: string;
  email: string | null;
}

const findContactByPhone = async (phone: string, apiToken: string): Promise<ContactMatch | null> => {
  try {
    const response = await hubspotFetch('/crm/v3/objects/contacts/search', apiToken, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [
          { filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] },
        ],
        properties: ['email'],
        limit: 1,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json() as { results?: Array<{ id: string; properties?: { email?: string } }> };
    const hit = data.results?.[0];
    if (!hit) return null;
    return { id: hit.id, email: hit.properties?.email || null };
  } catch {
    return null;
  }
};

const createContact = async (call: HubSpotCallData, apiToken: string): Promise<ContactMatch | null> => {
  try {
    const phone = call.customerPhone || call.fromNumber;
    const properties: Record<string, string> = {};
    if (phone) {
      properties.phone = phone;
      properties.email = syntheticEmail(phone);
    }
    if (call.customerName) {
      const parts = call.customerName.trim().split(/\s+/);
      properties.firstname = parts[0];
      if (parts.length > 1) properties.lastname = parts.slice(1).join(' ');
    }
    if (Object.keys(properties).length === 0) return null;

    const response = await hubspotFetch('/crm/v3/objects/contacts', apiToken, {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[HUBSPOT] Failed to create contact: ${response.status} ${text}`);
      return null;
    }
    const data = await response.json() as { id: string };
    console.log(`[HUBSPOT] Created new contact ${data.id} with email ${properties.email || 'none'}`);
    return { id: data.id, email: properties.email || null };
  } catch (err) {
    console.error('[HUBSPOT] Error creating contact:', err);
    return null;
  }
};

/** Update an existing contact to add a synthetic email (only if they have no email) */
const updateContactEmail = async (contactId: string, email: string, apiToken: string): Promise<boolean> => {
  try {
    const response = await hubspotFetch(`/crm/v3/objects/contacts/${contactId}`, apiToken, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { email } }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[HUBSPOT] Failed to update contact email: ${response.status} ${text}`);
      return false;
    }
    console.log(`[HUBSPOT] Updated contact ${contactId} with email ${email}`);
    return true;
  } catch (err) {
    console.error('[HUBSPOT] Error updating contact email:', err);
    return false;
  }
};

/**
 * Creates a HubSpot ticket linked to the caller's contact.
 * Appears in the Conversations inbox exactly like a form submission,
 * with the caller's contact shown on the right panel.
 * Requires: tickets scope
 */
const createTicket = async (
  call: HubSpotCallData,
  contactId: string | null,
  ownerId: string,
  apiToken: string,
): Promise<void> => {
  const phone = call.customerPhone || call.fromNumber || 'Unknown';
  const mins = Math.floor(call.durationSeconds / 60);
  const secs = call.durationSeconds % 60;

  const subject = call.confirmedBooking
    ? `Booking confirmed - ${call.customerName || phone} (${call.branchName})`
    : `Inbound call - ${call.customerName || phone} (${call.branchName})`;

  const lines: string[] = [];
  lines.push(`Branch: ${call.branchName}`);
  lines.push(`Phone: ${phone}`);
  if (call.customerName) lines.push(`Name: ${call.customerName}`);
  if (call.registrationNumber) lines.push(`Vehicle Registration: ${call.registrationNumber}`);
  lines.push(`Call Type: ${call.callType || 'Unknown'}`);
  lines.push(`Duration: ${mins}m ${secs}s`);
  if (call.confirmedBooking) lines.push(`Booking Confirmed: Yes`);
  if (call.bookingDetails) lines.push(`\nBooking Details:\n${call.bookingDetails}`);
  if (call.summary) lines.push(`\nCall Summary:\n${call.summary}`);

  const properties: Record<string, string> = {
    subject,
    content: lines.join('\n'),
    hs_pipeline: '0',
    hs_pipeline_stage: '1',
    hs_ticket_priority: 'MEDIUM',
  };
  if (ownerId) properties.hubspot_owner_id = ownerId;

  const associations = contactId
    ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }] }]
    : undefined;

  const response = await hubspotFetch('/crm/v3/objects/tickets', apiToken, {
    method: 'POST',
    body: JSON.stringify({ properties, ...(associations ? { associations } : {}) }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`[HUBSPOT] Failed to create ticket: ${response.status} ${text}`);
    return;
  }
  const data = await response.json() as { id: string };
  console.log(`[HUBSPOT] Ticket created: ${data.id}`);
};

/**
 * Sends an email to the garage's HubSpot inbox address.
 * HubSpot converts any inbound email to that address into a conversation thread
 * in the Conversations Inbox — the same way form submissions appear.
 */
const sendInboxEmail = async (call: HubSpotCallData, inboxEmail: string, contactEmail: string | null): Promise<void> => {
  const phone = call.customerPhone || call.fromNumber || 'Unknown';
  const subject = call.confirmedBooking
    ? `Booking confirmed - ${call.customerName || phone} (${call.branchName})`
    : `Inbound call - ${call.customerName || phone} (${call.branchName})`;

  const mins = Math.floor(call.durationSeconds / 60);
  const secs = call.durationSeconds % 60;

  // Plain text version (for non-HTML email clients)
  const lines: string[] = [];
  lines.push(`Branch: ${call.branchName}`);
  lines.push(`Phone: ${phone}`);
  if (call.customerName) lines.push(`Name: ${call.customerName}`);
  if (call.registrationNumber) lines.push(`Vehicle Registration: ${call.registrationNumber}`);
  lines.push(`Call Type: ${call.callType || 'Unknown'}`);
  lines.push(`Duration: ${mins}m ${secs}s`);
  if (call.confirmedBooking) lines.push(`Booking Confirmed: Yes`);
  if (call.bookingDetails) lines.push(`\nBooking Details:\n${call.bookingDetails}`);
  if (call.summary) lines.push(`\nCall Summary:\n${call.summary}`);
  if (call.transcript && call.transcript.length > 0) {
    lines.push(`\nCall Transcript:`);
    for (const entry of call.transcript) {
      lines.push(`${entry.speaker}: ${entry.text}`);
    }
  }
  const text = lines.join('\n');

  // HTML version — call details as plain text, transcript as styled table
  const isSynthetic = contactEmail?.includes(`@${SYNTHETIC_EMAIL_DOMAIN}`);
  const warningBanner = isSynthetic
    ? `⚠️ DO NOT REPLY BY EMAIL — this is a system-generated address. Call the customer on ${phone} instead.\n\n`
    : '';
  const warningHtml = isSynthetic
    ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#856404"><strong>⚠️ DO NOT REPLY BY EMAIL</strong> — this is a system-generated address. Call the customer on <strong>${phone}</strong> instead.</div>`
    : '';

  // Build call details (plain text with <br>)
  const detailLines: string[] = [];
  detailLines.push(`Branch: ${call.branchName}`);
  detailLines.push(`Phone: ${phone}`);
  if (call.customerName) detailLines.push(`Name: ${call.customerName}`);
  if (call.registrationNumber) detailLines.push(`Vehicle Registration: ${call.registrationNumber}`);
  detailLines.push(`Call Type: ${call.callType || 'Unknown'}`);
  detailLines.push(`Duration: ${mins}m ${secs}s`);
  if (call.confirmedBooking) detailLines.push(`Booking Confirmed: Yes`);
  if (call.bookingDetails) detailLines.push(`<br>Booking Details:<br>${call.bookingDetails}`);
  if (call.summary) detailLines.push(`<br>Call Summary:<br>${call.summary}`);
  const detailsHtml = detailLines.join('<br>');

  // Build transcript HTML table
  let transcriptHtml = '';
  if (call.transcript && call.transcript.length > 0) {
    const rows = call.transcript.map((entry, i) => {
      const isAgent = entry.speaker.toLowerCase().includes('agent');
      const bgColor = i % 2 === 1 ? ' style="background:#f8f9fa;"' : '';
      const nameColor = isAgent ? '#4f46e5' : '#0e7490';
      return `<tr${bgColor}><td style="padding:4px 8px;color:${nameColor};font-weight:600;white-space:nowrap;vertical-align:top;width:1%;">${entry.speaker}</td><td style="padding:4px 8px;">${entry.text}</td></tr>`;
    }).join('');
    transcriptHtml = `<br><div style="font-size:12px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Call Transcript</div><table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.4;">${rows}</table>`;
  }

  const html = `<div style="font-family:sans-serif">${warningHtml}${detailsHtml}${transcriptHtml}</div>`;

  // Send FROM the contact's email so HubSpot links the inbox thread to the contact
  const displayName = call.customerName || phone;
  const fromAddress = contactEmail
    ? `"${displayName}" <${contactEmail}>`
    : undefined;

  const sent = await sendEmail({
    to: [inboxEmail],
    subject,
    text: warningBanner + text,
    html,
    from: fromAddress,
  });

  if (sent) {
    console.log(`[HUBSPOT] Inbox email sent to ${inboxEmail} from ${contactEmail || 'default'} for call from ${phone}`);
  } else {
    console.warn(`[HUBSPOT] Failed to send inbox email to ${inboxEmail}`);
  }
};

const logCallEngagement = async (
  call: HubSpotCallData,
  contactId: string | null,
  ownerId: string,
  apiToken: string,
): Promise<void> => {
  const durationMs = call.durationSeconds * 1000;
  const phone = call.customerPhone || call.fromNumber;

  const properties: Record<string, string> = {
    hs_timestamp: call.createdAt.toISOString(),
    hs_call_title: `${call.branchName} - ${call.callType || 'Inbound call'}${call.confirmedBooking ? ' (booking confirmed)' : ''}`,
    hs_call_body: call.summary ?? '',
    hs_call_direction: 'INBOUND',
    hs_call_status: 'COMPLETED',
    hs_call_duration: String(durationMs),
    hs_call_from_number: phone ?? '',
    hs_call_disposition: DISPOSITION_CONNECTED,
    hs_call_source: 'INTEGRATIONS_PLATFORM',
  };

  if (ownerId) properties.hubspot_owner_id = ownerId;
  if (call.recordingUrl) properties.hs_call_recording_url = call.recordingUrl;

  const associations = contactId
    ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }] }]
    : undefined;

  const response = await hubspotFetch('/crm/v3/objects/calls', apiToken, {
    method: 'POST',
    body: JSON.stringify({ properties, ...(associations ? { associations } : {}) }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`[HUBSPOT] Failed to log call engagement: ${response.status} ${text}`);
  }
};

/**
 * Main entry point: upserts contact, creates inbox ticket, logs call engagement.
 *
 * Required Private App scopes:
 *   crm.objects.contacts.read
 *   crm.objects.contacts.write
 *   tickets
 */
export const logCallToHubSpot = async (
  call: HubSpotCallData,
  settings: HubspotSettings,
): Promise<void> => {
  const { apiToken, ownerId, inboxEmail } = settings;
  if (!apiToken) {
    console.error('[HUBSPOT] No API token configured - skipping');
    return;
  }

  const callerPhone = call.customerPhone || call.fromNumber;

  // 1. Find or create the contact, ensuring they have an email for inbox linking
  let contactId: string | null = null;
  let contactEmail: string | null = null;

  if (callerPhone) {
    const existing = await findContactByPhone(callerPhone, apiToken);
    if (existing) {
      contactId = existing.id;
      contactEmail = existing.email;
      console.log(`[HUBSPOT] Found existing contact ${contactId} for ${callerPhone} (email: ${contactEmail || 'none'})`);

      // If existing contact has no email, add synthetic email for inbox linking
      if (!contactEmail) {
        const synthetic = syntheticEmail(callerPhone);
        const updated = await updateContactEmail(contactId, synthetic, apiToken);
        if (updated) contactEmail = synthetic;
      }
    } else {
      console.log(`[HUBSPOT] No contact found for ${callerPhone} - creating new contact`);
      const created = await createContact(call, apiToken);
      if (created) {
        contactId = created.id;
        contactEmail = created.email;
      }
    }
  }

  // 2. Create ticket linked to the caller's contact (CRM → Tickets)
  await createTicket(call, contactId, ownerId, apiToken);

  // 3. Send inbox email FROM the contact's email so HubSpot links the thread to the contact
  if (inboxEmail) {
    await sendInboxEmail(call, inboxEmail, contactEmail);
  }

  // 4. Log call engagement on the contact timeline
  await logCallEngagement(call, contactId, ownerId, apiToken);
};
