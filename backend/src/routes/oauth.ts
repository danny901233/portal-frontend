import type { Request, Response } from 'express';
import { Router } from 'express';
import { createHmac } from 'node:crypto';
import axios from 'axios';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function signOAuthState(payload: Record<string, unknown>): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const withTimestamp = { ...payload, ts: Date.now() };
  const data = JSON.stringify(withTimestamp);
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ d: withTimestamp, s: sig })).toString('base64');
}

function verifyOAuthState(state: string): Record<string, unknown> {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const parsed = JSON.parse(Buffer.from(state, 'base64').toString());
  const { d, s } = parsed;
  const expected = createHmac('sha256', secret).update(JSON.stringify(d)).digest('hex');
  if (s !== expected) throw new Error('Invalid OAuth state signature');
  if (Date.now() - d.ts > OAUTH_STATE_MAX_AGE_MS) throw new Error('OAuth state expired');
  return d;
}

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI || 'http://localhost:4000/api/oauth/meta/callback';

// Instagram Business Login uses a separate app
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET;

// POST /api/oauth/meta/initiate - Start OAuth flow
router.post('/oauth/meta/initiate', authenticate, async (req: Request, res: Response) => {
  try {
    const { platform, garageId } = req.body;

    if (!META_APP_ID) {
      return res.status(500).json({
        error: 'Meta App not configured',
        message: 'Please add META_APP_ID to your environment variables'
      });
    }

    // Define scopes for each platform
    const scopes: Record<string, string> = {
      whatsapp: 'whatsapp_business_management,whatsapp_business_messaging',
      facebook: 'pages_messaging,pages_manage_metadata,pages_show_list,business_management',
      instagram: 'instagram_basic,pages_messaging,pages_show_list,business_management',
    };

    const scope = scopes[platform];
    if (!scope) {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    // Store state to verify callback — signed to prevent forgery
    const state = signOAuthState({ garageId, platform });

    // All platforms use facebook.com OAuth dialog (Instagram connects via Facebook Page)
    const authUrl = new URL('https://www.facebook.com/v18.0/dialog/oauth');
    authUrl.searchParams.set('client_id', META_APP_ID!);
    authUrl.searchParams.set('redirect_uri', META_REDIRECT_URI!);
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('response_type', 'code');

    res.json({ success: true, authUrl: authUrl.toString() });
  } catch (error) {
    console.error('OAuth initiate error:', error);
    res.status(500).json({ error: 'Failed to initiate OAuth' });
  }
});

// GET /api/oauth/meta/callback - Handle OAuth callback
router.get('/oauth/meta/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error, error_description } = req.query;

    // Handle OAuth errors
    if (error) {
      console.error('OAuth error:', error, error_description);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/integrations?error=${error}`);
    }

    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/integrations?error=missing_params`);
    }

    // Verify and decode state — rejects tampered or expired states
    const { garageId, platform } = verifyOAuthState(state as string) as { garageId: string; platform: string };

    // Exchange code for access token — Instagram Business Login uses a different endpoint
    let accessToken: string;

    // All platforms (including instagram) use Facebook OAuth token exchange
    const tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: META_REDIRECT_URI,
        code,
      },
    });
    accessToken = tokenResponse.data.access_token;

    // Get platform-specific IDs
    let connectionData: any = {
      garageId,
      platform,
      accessToken,
      isActive: true,
    };

    if (platform === 'whatsapp') {
      // Get WhatsApp Business Account and Phone Number ID
      // Iterate ALL businesses to find the one with a WABA + phone number
      try {
        const wabResponse = await axios.get('https://graph.facebook.com/v18.0/me/businesses', {
          params: { access_token: accessToken },
        });

        const businesses: any[] = wabResponse.data.data || [];
        console.log(`[OAuth] Found ${businesses.length} businesses:`, businesses.map((b: any) => `${b.name} (${b.id})`));

        let found = false;
        for (const business of businesses) {
          try {
            const wabaResponse = await axios.get(`https://graph.facebook.com/v18.0/${business.id}/owned_whatsapp_business_accounts`, {
              params: { access_token: accessToken },
            });
            const wabaList: any[] = wabaResponse.data.data || [];
            console.log(`[OAuth] Business "${business.name}" has ${wabaList.length} WABA(s)`);

            for (const waba of wabaList) {
              try {
                const phoneResponse = await axios.get(`https://graph.facebook.com/v18.0/${waba.id}/phone_numbers`, {
                  params: { access_token: accessToken },
                });
                const phones: any[] = phoneResponse.data.data || [];
                console.log(`[OAuth] WABA ${waba.id} has ${phones.length} phone number(s)`);

                if (phones.length > 0) {
                  const phone = phones[0];
                  connectionData.whatsappPhoneNumberId = phone.id;
                  connectionData.pageId = waba.id; // store WABA ID in pageId field
                  connectionData.accountName = phone.display_phone_number || business.name;
                  console.log(`[OAuth] Using business "${business.name}", WABA ${waba.id}, phone ${phone.id} (${connectionData.accountName})`);

                  // Subscribe this WABA to webhook events
                  try {
                    await axios.post(`https://graph.facebook.com/v18.0/${waba.id}/subscribed_apps`, null, {
                      params: { access_token: accessToken },
                    });
                    console.log(`[OAuth] Subscribed WABA ${waba.id} to app webhooks`);
                  } catch (subErr: any) {
                    console.error('[OAuth] Failed to subscribe WABA to webhooks:', subErr?.response?.data ?? subErr?.message);
                  }

                  found = true;
                  break;
                }
              } catch (phoneErr) {
                console.log(`[OAuth] Could not fetch phones for WABA ${waba.id}`);
              }
            }
            if (found) break;
          } catch (wabaErr) {
            console.log(`[OAuth] Could not fetch WABAs for business "${business.name}"`);
          }
        }

        if (!found) {
          console.log('[OAuth] No WhatsApp phone numbers found across any business - pending_setup');
          connectionData.whatsappPhoneNumberId = 'pending_setup';
        }
      } catch (wabError) {
        console.log('[OAuth] WhatsApp Business not yet configured - this is expected for new apps');
        connectionData.whatsappPhoneNumberId = 'pending_setup';
      }
    } else if (platform === 'instagram') {
      // Instagram connects via Facebook Page — get the linked Page and its Instagram Business Account
      const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
        params: { access_token: accessToken },
      });
      console.log('[OAuth] Pages response:', JSON.stringify(pagesResponse.data, null, 2));

      const page = pagesResponse.data.data[0];
      if (!page) {
        console.error('[OAuth] No Facebook page found for Instagram connection!');
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/integrations?error=no_page_found`);
      }

      connectionData.pageId = page.id;
      connectionData.accessToken = page.access_token;
      connectionData.accountName = page.name;

      // Get the Instagram Business Account linked to this Facebook Page
      try {
        const igResponse = await axios.get(`https://graph.facebook.com/v18.0/${page.id}`, {
          params: { fields: 'instagram_business_account', access_token: page.access_token },
        });
        const igAccountId = igResponse.data.instagram_business_account?.id;
        if (igAccountId) {
          connectionData.instagramAccountId = igAccountId;
          // Get Instagram username
          const igDetailResponse = await axios.get(`https://graph.facebook.com/v18.0/${igAccountId}`, {
            params: { fields: 'username', access_token: page.access_token },
          });
          if (igDetailResponse.data.username) {
            connectionData.accountName = `@${igDetailResponse.data.username}`;
          }
          console.log('[OAuth] Instagram Business Account ID:', igAccountId);
        }
      } catch (igErr) {
        console.log('[OAuth] No Instagram Business Account linked to page — continuing with page only');
      }

    } else if (platform === 'facebook') {
      // Get Facebook Pages
      console.log('[OAuth] Access token (first 20 chars):', accessToken?.substring(0, 20));

      const meResponse = await axios.get('https://graph.facebook.com/v18.0/me', {
        params: { access_token: accessToken, fields: 'id,name,email' },
      });
      console.log('[OAuth] User info:', JSON.stringify(meResponse.data, null, 2));

      const permissionsResponse = await axios.get('https://graph.facebook.com/v18.0/me/permissions', {
        params: { access_token: accessToken },
      });
      console.log('[OAuth] Permissions:', JSON.stringify(permissionsResponse.data, null, 2));

      const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
        params: { access_token: accessToken },
      });
      console.log('[OAuth] Full pages response:', JSON.stringify(pagesResponse.data, null, 2));

      const page = pagesResponse.data.data[0];
      if (page) {
        connectionData.pageId = page.id;
        connectionData.accessToken = page.access_token;
        connectionData.accountName = page.name;
        console.log('[OAuth] Page found:', page.id, 'Name:', page.name);

        // Subscribe page to webhook events
        try {
          await axios.post(
            `https://graph.facebook.com/v18.0/${page.id}/subscribed_apps`,
            null,
            {
              params: {
                access_token: page.access_token,
                subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads',
              },
            }
          );
          console.log('[OAuth] Facebook page subscribed to webhook events:', page.id);
        } catch (subErr: any) {
          console.error('[OAuth] Failed to subscribe Facebook page to webhooks:', subErr?.response?.data ?? subErr?.message);
        }
      } else {
        console.error('[OAuth] No Facebook page found in response!');
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/integrations?error=no_page_found`);
      }
    }

    console.log('[OAuth] Saving connection data:', {
      garageId,
      platform,
      hasPageId: !!connectionData.pageId,
      hasAccessToken: !!connectionData.accessToken
    });

    // Check if connection already exists
    const existing = await prisma.socialMediaConnection.findFirst({
      where: { garageId, platform },
    });

    if (existing) {
      // Update existing connection
      console.log('[OAuth] Updating existing connection:', existing.id);
      await prisma.socialMediaConnection.update({
        where: { id: existing.id },
        data: connectionData,
      });
    } else {
      // Create new connection
      console.log('[OAuth] Creating new connection');
      const newConnection = await prisma.socialMediaConnection.create({
        data: connectionData,
      });
      console.log('[OAuth] Connection created with ID:', newConnection.id);
    }

    // Redirect back to integrations page
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/integrations?success=true&platform=${platform}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    if (axios.isAxiosError(error)) {
      console.error('Response data:', error.response?.data);
      console.error('Response status:', error.response?.status);
    }
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/integrations?error=callback_failed`);
  }
});

export default router;
