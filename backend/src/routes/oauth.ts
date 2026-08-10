import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI || 'http://localhost:4000/api/oauth/meta/callback';
const INSTAGRAM_REDIRECT_URI = META_REDIRECT_URI;

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
      instagram: 'instagram_basic,instagram_manage_messages,pages_messaging,pages_show_list,business_management',
    };

    const scope = scopes[platform];
    if (!scope) {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    // Store state to verify callback
    const state = Buffer.from(JSON.stringify({ garageId, platform })).toString('base64');

    // All platforms use Facebook Login
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

// POST /api/oauth/whatsapp/embedded-signup - finish WhatsApp Embedded Signup (JS SDK flow)
// The portal launches FB.login() with the WhatsApp config_id; on completion it receives an auth
// `code` plus (usually) the WABA id + phone number id from the WA_EMBEDDED_SIGNUP message event.
// That browser event doesn't always arrive, so we also discover the WABA + number from the granted
// token. This lets garages CREATE a new WhatsApp Business account inline if they don't have one.
router.post('/oauth/whatsapp/embedded-signup', authenticate, async (req: Request, res: Response) => {
  try {
    const { code, wabaId, phoneNumberId, garageId, configId, pageUrl } = req.body;
    if (!META_APP_ID || !META_APP_SECRET) {
      return res.status(500).json({ error: 'Meta app not configured (META_APP_ID / META_APP_SECRET)' });
    }
    if (!code || !garageId) {
      return res.status(400).json({ error: 'Missing code or garageId' });
    }
    console.log(`[WA-Signup] start: garage=${garageId} configId=${configId ?? '(none)'} wabaId=${wabaId ?? '(none)'} phoneNumberId=${phoneNumberId ?? '(none)'}`);

    // 1) Exchange the embedded-signup code for a business token. Depending on the Login config, the
    //    popup code is swapped either WITHOUT a redirect_uri or WITH the one the SDK used. Try the
    //    known whitelisted candidates in order until one succeeds, and log which worked.
    const redirectCandidates: (string | undefined)[] = [
      undefined,
      '',
      pageUrl,
      'https://portal.receptionmate.co.uk/',
      'https://portal.receptionmate.co.uk',
      'https://portal.receptionmate.co.uk/api/oauth/meta/callback',
    ].filter((v, i, a) => a.indexOf(v) === i);
    let accessToken: string | undefined;
    let lastExchangeErr: any;
    for (const rc of redirectCandidates) {
      try {
        const params: any = { client_id: META_APP_ID, client_secret: META_APP_SECRET, code };
        if (rc !== undefined) params.redirect_uri = rc;
        const tokenRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', { params });
        accessToken = tokenRes.data?.access_token;
        if (accessToken) {
          console.log(`[WA-Signup] code exchanged OK (redirect_uri=${rc === undefined ? '(omitted)' : `"${rc}"`})`);
          break;
        }
      } catch (e: any) {
        lastExchangeErr = e?.response?.data ?? e?.message;
        console.log(`[WA-Signup] exchange FAILED (redirect_uri=${rc === undefined ? '(omitted)' : `"${rc}"`}): ${JSON.stringify(lastExchangeErr)}`);
      }
    }
    if (!accessToken) {
      console.error('[WA-Signup] all code exchanges failed:', JSON.stringify(lastExchangeErr));
      return res.status(502).json({ error: 'Token exchange failed', detail: lastExchangeErr });
    }

    // 1b) Resolve the WABA + phone id. Prefer what the message event gave us; otherwise read them
    //     from the token's granular scopes (debug_token) and the WABA's phone numbers.
    let resolvedWabaId: string | undefined = wabaId;
    let resolvedPhoneId: string | undefined = phoneNumberId;
    if (!resolvedWabaId) {
      try {
        const dbg = await axios.get('https://graph.facebook.com/v21.0/debug_token', {
          params: { input_token: accessToken, access_token: `${META_APP_ID}|${META_APP_SECRET}` },
        });
        const scopes: any[] = dbg.data?.data?.granular_scopes || [];
        const wa = scopes.find((s) => s.scope === 'whatsapp_business_management') ||
                   scopes.find((s) => s.scope === 'whatsapp_business_messaging');
        resolvedWabaId = wa?.target_ids?.[0];
        console.log(`[WA-Signup] discovered WABA from token: ${resolvedWabaId ?? '(none)'}`);
      } catch (e: any) {
        console.log('[WA-Signup] debug_token failed:', JSON.stringify(e?.response?.data ?? e?.message));
      }
    }
    if (resolvedWabaId && !resolvedPhoneId) {
      try {
        const ph = await axios.get(`https://graph.facebook.com/v21.0/${resolvedWabaId}/phone_numbers`, {
          params: { access_token: accessToken },
        });
        resolvedPhoneId = ph.data?.data?.[0]?.id;
        console.log(`[WA-Signup] discovered phone on WABA ${resolvedWabaId}: ${resolvedPhoneId ?? '(none)'}`);
      } catch (e: any) {
        console.log('[WA-Signup] phone_numbers lookup failed:', JSON.stringify(e?.response?.data ?? e?.message));
      }
    }
    if (!resolvedWabaId || !resolvedPhoneId) {
      return res.status(422).json({
        error: 'Could not resolve the WhatsApp account from the sign-up. The number may not be fully set up yet.',
        wabaId: resolvedWabaId ?? null, phoneNumberId: resolvedPhoneId ?? null,
      });
    }

    // 2) Register the number (required for freshly-created numbers; harmless if already registered).
    const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit 2-step-verification PIN
    try {
      await axios.post(
        `https://graph.facebook.com/v21.0/${resolvedPhoneId}/register`,
        { messaging_product: 'whatsapp', pin },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
      );
      console.log(`[WA-Signup] Registered phone ${resolvedPhoneId}`);
    } catch (regErr: any) {
      console.log('[WA-Signup] register skipped/failed:', JSON.stringify(regErr?.response?.data ?? regErr?.message));
    }

    // 3) Subscribe the WABA to our app's webhooks so inbound messages reach us.
    try {
      await axios.post(`https://graph.facebook.com/v21.0/${resolvedWabaId}/subscribed_apps`, null, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      console.log(`[WA-Signup] Subscribed WABA ${resolvedWabaId} to webhooks`);
    } catch (subErr: any) {
      console.error('[WA-Signup] subscribe failed:', JSON.stringify(subErr?.response?.data ?? subErr?.message));
    }

    // 4) Resolve a display name for the number.
    let accountName = 'WhatsApp';
    try {
      const phoneRes = await axios.get(`https://graph.facebook.com/v21.0/${resolvedPhoneId}`, {
        params: { fields: 'display_phone_number,verified_name', access_token: accessToken },
      });
      accountName = phoneRes.data?.display_phone_number || phoneRes.data?.verified_name || accountName;
    } catch { /* non-fatal */ }

    // 5) Store the connection — same shape as the redirect flow (WABA id in pageId, phone id in
    //    whatsappPhoneNumberId), so the existing webhook/send code works unchanged.
    const connectionData: any = {
      garageId,
      platform: 'whatsapp',
      whatsappPhoneNumberId: resolvedPhoneId,
      pageId: resolvedWabaId,
      accessToken,
      accountName,
      isActive: true,
    };
    const existing = await prisma.socialMediaConnection.findFirst({ where: { garageId, platform: 'whatsapp' } });
    if (existing) {
      await prisma.socialMediaConnection.update({ where: { id: existing.id }, data: connectionData });
    } else {
      await prisma.socialMediaConnection.create({ data: connectionData });
    }
    console.log(`[WA-Signup] Stored WhatsApp connection for garage ${garageId} (WABA ${resolvedWabaId}, phone ${resolvedPhoneId}, ${accountName})`);
    return res.json({ success: true, phoneNumberId: resolvedPhoneId, wabaId: resolvedWabaId, accountName });
  } catch (err: any) {
    console.error('[WA-Signup] error:', JSON.stringify(err?.response?.data ?? err?.message));
    return res.status(500).json({ error: 'Embedded signup failed', detail: err?.response?.data ?? err?.message });
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

    // Decode state
    const { garageId, platform } = JSON.parse(Buffer.from(state as string, 'base64').toString());

    // Exchange code for access token
    let accessToken: string;

    // All platforms use Facebook OAuth token exchange
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
      // Instagram connects via Facebook Page
      const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
        params: { access_token: accessToken },
      });
      const page = pagesResponse.data.data[0];
      if (!page) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/integrations?error=no_page_found`);
      }
      connectionData.pageId = page.id;
      connectionData.accessToken = page.access_token;
      connectionData.accountName = page.name;
      // Get the linked Instagram Business Account
      try {
        const igResponse = await axios.get(`https://graph.facebook.com/v18.0/${page.id}`, {
          params: { fields: 'instagram_business_account', access_token: page.access_token },
        });
        const igAccountId = igResponse.data.instagram_business_account?.id;
        if (igAccountId) {
          connectionData.instagramAccountId = igAccountId;
          const igDetail = await axios.get(`https://graph.facebook.com/v18.0/${igAccountId}`, {
            params: { fields: 'username', access_token: page.access_token },
          });
          if (igDetail.data.username) connectionData.accountName = `@${igDetail.data.username}`;
        }
      } catch (igErr) {
        console.log('[OAuth] No IG Business Account linked to page');
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

// GET /api/oauth/instagram/callback - Instagram Business Login callback (redirects to shared handler)
router.get('/oauth/instagram/callback', (req: Request, res: Response) => {
  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  res.redirect(`/api/oauth/meta/callback${qs}`);
});

export default router;
