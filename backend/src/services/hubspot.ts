import type { HubspotSettings } from '../utils/types.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

// Call disposition GUIDs (HubSpot standard)
const DISPOSITION_CONNECTED = 'f240bbac-87c9-4f6e-bf70-924b57d47db7';

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

/**
 * Finds a HubSpot contact ID by phone number.
 * Returns null if not found or on error.
 */
const findContactByPhone = async (phone: string, apiToken: string): Promise<string | null> => {
  try {
    const response = await hubspotFetch('/crm/v3/objects/contacts/search', apiToken, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [
          { filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] },
        ],
        properties: ['id'],
        limit: 1,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { results?: Array<{ id: string }> };
    return data.results?.[0]?.id ?? null;
  } catch {
    return null;
  }
};

/**
 * Creates a new HubSpot contact with available caller details.
 * Returns the new contact ID, or null on failure.
 */
const createContact = async (call: HubSpotCallData, apiToken: string): Promise<string | null> => {
  try {
    const phone = call.customerPhone || call.fromNumber;
    const properties: Record<string, string> = {};

    if (phone) properties.phone = phone;

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
    console.log(`[HUBSPOT] Created new contact ${data.id}`);
    return data.id;
  } catch (err) {
    console.error('[HUBSPOT] Error creating contact:', err);
    return null;
  }
};

/**
 * Creates a HubSpot ticket associated with the caller's contact.
 * Tickets appear in the HubSpot Conversations inbox exactly like form submissions.
 * Requires crm.objects.tickets.write scope.
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
    ? `Booking confirmed — ${call.customerName || phone} (${call.branchName})`
    : `Inbound call — ${call.customerName || phone} (${call.branchName})`;

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
    ? [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }], // Ticket → Contact
        },
      ]
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
 * Logs a call engagement on the contact's timeline.
 */
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
    hs_call_title: `${call.branchName} — ${call.callType || 'Inbound call'}${call.confirmedBooking ? ' (booking confirmed)' : ''}`,
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
    ? [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }], // Call → Contact
        },
      ]
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
 * Main entry point: upserts a contact, creates a ticket in the inbox, and logs a call engagement.
 *
 * Required Private App scopes:
 *   crm.objects.contacts.read
 *   crm.objects.contacts.write
 *   crm.objects.tickets.write
 */
export const logCallToHubSpot = async (
  call: HubSpotCallData,
  settings: HubspotSettings,
): Promise<void> => {
  const { apiToken, ownerId } = settings;
  if (!apiToken) {
    console.error('[HUBSPOT] No API token configured — skipping');
    return;
  }

  const callerPhone = call.customerPhone || call.fromNumber;

  // 1. Find or create the contact
  let contactId: string | null = null;
  if (callerPhone) {
    contactId = await findContactByPhone(callerPhone, apiToken);
    if (contactId) {
      console.log(`[HUBSPOT] Found existing contact ${contactId} for ${callerPhone}`);
    } else {
      console.log(`[HUBSPOT] No contact found for ${callerPhone} — creating new contact`);
      contactId = await createContact(call, apiToken);
    }
  }

  // 2. Create a ticket linked to the contact (appears in inbox like a form submission)
  await createTicket(call, contactId, ownerId, apiToken);

  // 3. Log call engagement on the contact timeline
  await logCallEngagement(call, contactId, ownerId, apiToken);
};
