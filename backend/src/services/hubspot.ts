import axios from 'axios';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

export interface HubSpotConfig {
  apiToken: string;
  ownerId?: string;
}

export interface CallData {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  summary: string;
  registrationNumber?: string;
  callDuration: number;
  confirmedBooking: boolean;
  bookingDetails?: string;
  transcript?: Array<{ speaker: string; text: string }>;
  recordingUrl?: string;
}

/**
 * HubSpot CRM Integration Service
 * Handles contact creation, ticket creation, and call engagement logging
 */

async function createOrUpdateContact(config: HubSpotConfig, callData: CallData): Promise<string | null> {
  try {
    if (!callData.customerPhone && !callData.customerEmail) {
      console.log('[HubSpot] Skipping contact creation - no phone or email provided');
      return null;
    }

    const properties: Array<{ name: string; value: string }> = [];

    if (callData.customerName) {
      const nameParts = callData.customerName.trim().split(/\s+/);
      properties.push({ name: 'firstname', value: nameParts[0] });
      if (nameParts.length > 1) {
        properties.push({ name: 'lastname', value: nameParts.slice(1).join(' ') });
      }
    }

    if (callData.customerPhone) {
      properties.push({ name: 'phone', value: callData.customerPhone });
    }

    if (callData.customerEmail) {
      properties.push({ name: 'email', value: callData.customerEmail });
    }

    if (callData.registrationNumber) {
      properties.push({ name: 'vehicle_registration_number', value: callData.registrationNumber });
    }

    console.log('[HubSpot] Creating/updating contact:', {
      name: callData.customerName,
      phone: callData.customerPhone ? '***' + callData.customerPhone.slice(-4) : undefined,
      email: callData.customerEmail
    });

    // Try to find existing contact by email or phone
    let contactId: string | null = null;

    if (callData.customerEmail) {
      try {
        const searchResponse = await axios.get(
          `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`,
          {
            headers: {
              'Authorization': `Bearer ${config.apiToken}`,
              'Content-Type': 'application/json'
            },
            data: {
              filterGroups: [
                {
                  filters: [
                    {
                      propertyName: 'email',
                      operator: 'EQ',
                      value: callData.customerEmail
                    }
                  ]
                }
              ],
              limit: 1
            }
          }
        );

        if (searchResponse.data?.results?.length > 0) {
          contactId = searchResponse.data.results[0].id;
          console.log('[HubSpot] Found existing contact by email:', contactId);
        }
      } catch (searchError: any) {
        if (searchError.response?.status !== 404) {
          console.warn('[HubSpot] Search error (non-fatal):', searchError.message);
        }
      }
    }

    // Create or update contact
    let response;
    if (contactId) {
      // Update existing contact
      response = await axios.patch(
        `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`,
        { properties },
        {
          headers: {
            'Authorization': `Bearer ${config.apiToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log('[HubSpot] Contact updated:', contactId);
    } else {
      // Create new contact
      response = await axios.post(
        `${HUBSPOT_API_BASE}/crm/v3/objects/contacts`,
        { properties },
        {
          headers: {
            'Authorization': `Bearer ${config.apiToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      contactId = response.data.id;
      console.log('[HubSpot] Contact created:', contactId);
    }

    return contactId;
  } catch (error: any) {
    console.error('[HubSpot] Contact creation/update failed:', {
      status: error.response?.status,
      message: error.response?.data?.message || error.message
    });
    throw error;
  }
}

async function createTicket(
  config: HubSpotConfig,
  contactId: string,
  callData: CallData
): Promise<string | null> {
  try {
    const ticketTitle = `Call from ${callData.customerName || 'Unknown'} - ${new Date().toLocaleString()}`;

    const formatTranscript = (transcript?: Array<{ speaker: string; text: string }>): string => {
      if (!transcript || transcript.length === 0) return '';
      return transcript.map((entry) => `${entry.speaker}: ${entry.text}`).join('\n');
    };

    const ticketDescription = [
      `Customer: ${callData.customerName || 'Unknown'}`,
      `Phone: ${callData.customerPhone || 'N/A'}`,
      `Email: ${callData.customerEmail || 'N/A'}`,
      `Registration: ${callData.registrationNumber || 'N/A'}`,
      `Duration: ${callData.callDuration} seconds`,
      `Confirmed Booking: ${callData.confirmedBooking ? 'Yes' : 'No'}`,
      `Booking Details: ${callData.bookingDetails || 'N/A'}`,
      callData.recordingUrl ? `Recording: ${callData.recordingUrl}` : '',
      '',
      'Call Summary:',
      callData.summary,
      callData.transcript && callData.transcript.length > 0 ? '\nCall Transcript:' : '',
      formatTranscript(callData.transcript)
    ].filter(Boolean).join('\n');

    console.log('[HubSpot] Creating ticket:', ticketTitle);

    const response = await axios.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/tickets`,
      {
        properties: [
          { name: 'subject', value: ticketTitle },
          { name: 'content', value: ticketDescription },
          { name: 'hs_pipeline', value: '0' }, // Default pipeline
          { name: 'hs_pipeline_stage', value: '1' } // Needs review stage
        ],
        associations: [
          {
            types: [{ associationType: 'contact_to_ticket' }],
            id: contactId
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[HubSpot] Ticket created:', response.data.id);
    return response.data.id;
  } catch (error: any) {
    console.error('[HubSpot] Ticket creation failed:', {
      status: error.response?.status,
      message: error.response?.data?.message || error.message
    });
    throw error;
  }
}

async function logCallEngagement(
  config: HubSpotConfig,
  contactId: string,
  callData: CallData
): Promise<void> {
  try {
    const engagementTitle = `Call: ${callData.customerName || 'Unknown'}`;

    const formatTranscript = (transcript?: Array<{ speaker: string; text: string }>): string => {
      if (!transcript || transcript.length === 0) return '';
      return transcript.map((entry) => `${entry.speaker}: ${entry.text}`).join('\n');
    };

    const engagementBody = [
      `Duration: ${callData.callDuration} seconds`,
      `Booking Confirmed: ${callData.confirmedBooking}`,
      '',
      'Call Summary:',
      callData.summary,
      callData.transcript && callData.transcript.length > 0 ? '\nCALL TRANSCRIPT:' : '',
      formatTranscript(callData.transcript)
    ].filter(Boolean).join('\n');

    console.log('[HubSpot] Logging call engagement:', engagementTitle);

    // Create engagement (note) object
    await axios.post(
      `${HUBSPOT_API_BASE}/crm/v3/objects/notes`,
      {
        properties: [
          { name: 'hs_note_body', value: engagementBody }
        ],
        associations: [
          {
            types: [{ associationType: 'contact_to_note' }],
            id: contactId
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[HubSpot] Call engagement note created');
  } catch (error: any) {
    console.warn('[HubSpot] Engagement logging failed (non-critical):', error.message);
    // Don't throw - this is non-critical
  }
}

export async function logCallToHubSpot(config: HubSpotConfig, callData: CallData): Promise<boolean> {
  try {
    if (!config.apiToken) {
      console.log('[HubSpot] No API token configured, skipping');
      return false;
    }

    console.log('[HubSpot] Starting call logging process...');
    console.log('[HubSpot] Transcript entries:', callData.transcript?.length || 0);
    console.log('[HubSpot] Recording URL:', callData.recordingUrl || 'none');

    // Step 1: Create or update contact
    const contactId = await createOrUpdateContact(config, callData);
    if (!contactId) {
      console.log('[HubSpot] No contact ID, skipping ticket/engagement creation');
      return false;
    }

    // Step 2: Create ticket
    try {
      await createTicket(config, contactId, callData);
    } catch (ticketError) {
      console.warn('[HubSpot] Ticket creation failed, continuing with engagement logging');
    }

    // Step 3: Log engagement
    await logCallEngagement(config, contactId, callData);

    console.log('[HubSpot] Call logging completed successfully');
    return true;
  } catch (error: any) {
    console.error('[HubSpot] Call logging failed:', error.message);
    return false;
  }
}

export async function testHubSpotConnection(config: HubSpotConfig): Promise<{ success: boolean; message: string }> {
  try {
    console.log('[HubSpot] Testing connection...');
    
    const response = await axios.get(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts?limit=1`,
      {
        headers: {
          'Authorization': `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('[HubSpot] Connection test successful');
    return {
      success: true,
      message: 'HubSpot API connection successful'
    };
  } catch (error: any) {
    console.error('[HubSpot] Connection test failed:', error.message);
    
    if (error.response?.status === 401) {
      return {
        success: false,
        message: 'Invalid HubSpot API token - authentication failed'
      };
    }

    return {
      success: false,
      message: `HubSpot connection error: ${error.message}`
    };
  }
}
