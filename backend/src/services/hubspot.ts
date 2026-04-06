import type { HubspotSettings } from '../utils/types.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

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
 * Creates a HubSpot deal to track the inbound call / potential booking.
 * Associates it with the contact if contactId is provided.
 *
 * Required scope: crm.objects.deals.write
 */
const createDeal = async (
  call: HubSpotCallData,
  contactId: string | null,
  ownerId: string,
  apiToken: string,
): Promise<string | null> => {
  const phone = call.customerPhone || call.fromNumber || 'Unknown';
  const dealName = call.confirmedBooking
    ? `Booking confirmed — ${call.customerName || phone} (${call.branchName})`
    : `Inbound call — ${call.customerName || phone} (${call.branchName})`;

  const lines: string[] = [];
  lines.push(`Branch: ${call.branchName}`);
  lines.push(`Phone: ${phone}`);
  if (call.customerName) lines.push(`Name: ${call.customerName}`);
  if (call.registrationNumber) lines.push(`Vehicle Registration: ${call.registrationNumber}`);
  lines.push(`Call Type: ${call.callType || 'Unknown'}`);
  lines.push(`Duration: ${Math.round(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s`);
  if (call.confirmedBooking) lines.push(`Booking Confirmed: Yes`);
  if (call.bookingDetails) lines.push(`\nBooking Details:\n${call.bookingDetails}`);
  if (call.summary) lines.push(`\nCall Summary:\n${call.summary}`);

  const properties: Record<string, string> = {
    dealname: dealName,
    description: lines.join('\n'),
    dealstage: call.confirmedBooking ? 'closedwon' : 'appointmentscheduled',
    pipeline: 'default',
    closedate: call.createdAt.toISOString(),
  };

  if (ownerId) properties.hubspot_owner_id = ownerId;

  const associations = contactId
    ? [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }], // Deal → Contact
        },
      ]
    : undefined;

  try {
    const response = await hubspotFetch('/crm/v3/objects/deals', apiToken, {
      method: 'POST',
      body: JSON.stringify({ properties, ...(associations ? { associations } : {}) }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`[HUBSPOT] Failed to create deal: ${response.status} ${text}`);
      return null;
    }

    const result = await response.json() as { id: string };
    console.log(`[HUBSPOT] Deal created: ${result.id}`);
    return result.id;
  } catch (err) {
    console.error('[HUBSPOT] Error creating deal:', err);
    return null;
  }
};

/**
 * Main entry point: upserts a contact and creates a deal for the inbound call.
 *
 * Required Private App scopes:
 *   crm.objects.contacts.read
 *   crm.objects.contacts.write
 *   crm.objects.deals.write
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

  // 2. Create a deal to track the call / booking
  await createDeal(call, contactId, ownerId, apiToken);
};
