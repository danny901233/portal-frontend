import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI || 'http://localhost:4000/api/oauth/meta/callback';

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
      instagram: 'instagram_basic,instagram_manage_comments,pages_messaging,pages_show_list,business_management',
    };

    const scope = scopes[platform];
    if (!scope) {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    // Store state to verify callback
    const state = Buffer.from(JSON.stringify({ garageId, platform })).toString('base64');

    // Build OAuth URL
    const authUrl = new URL('https://www.facebook.com/v18.0/dialog/oauth');
    authUrl.searchParams.set('client_id', META_APP_ID);
    authUrl.searchParams.set('redirect_uri', META_REDIRECT_URI);
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

    // Decode state
    const { garageId, platform } = JSON.parse(Buffer.from(state as string, 'base64').toString());

    // Exchange code for access token
    const tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: META_REDIRECT_URI,
        code,
      },
    });

    const accessToken = tokenResponse.data.access_token;

    // Get platform-specific IDs
    let connectionData: any = {
      garageId,
      platform,
      accessToken,
      isActive: true,
    };

    if (platform === 'whatsapp') {
      // Get WhatsApp Business Account and Phone Number ID
      try {
        const wabResponse = await axios.get('https://graph.facebook.com/v18.0/me/businesses', {
          params: { access_token: accessToken },
        });

        const business = wabResponse.data.data[0];
        if (business) {
          connectionData.accountName = business.name;
          try {
            const phoneResponse = await axios.get(`https://graph.facebook.com/v18.0/${business.id}/phone_numbers`, {
              params: { access_token: accessToken },
            });
            const phone = phoneResponse.data.data[0];
            connectionData.whatsappPhoneNumberId = phone?.id;
            if (phone?.display_phone_number) {
              connectionData.accountName = phone.display_phone_number;
            }
          } catch (phoneError) {
            console.log('[OAuth] No WhatsApp phone numbers found - this is OK for initial setup');
            connectionData.whatsappPhoneNumberId = 'pending_setup';
          }
        } else {
          console.log('[OAuth] No business account found - storing connection for future setup');
          connectionData.whatsappPhoneNumberId = 'pending_setup';
        }
      } catch (wabError) {
        console.log('[OAuth] WhatsApp Business not yet configured - this is expected for new apps');
        connectionData.whatsappPhoneNumberId = 'pending_setup';
      }
    } else if (platform === 'facebook' || platform === 'instagram') {
      // Get Facebook Pages
      console.log('[OAuth] Access token (first 20 chars):', accessToken?.substring(0, 20));

      // Check what user this token belongs to
      const meResponse = await axios.get('https://graph.facebook.com/v18.0/me', {
        params: {
          access_token: accessToken,
          fields: 'id,name,email'
        },
      });
      console.log('[OAuth] User info:', JSON.stringify(meResponse.data, null, 2));

      // Check permissions
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
        connectionData.accessToken = page.access_token; // Use page access token
        connectionData.accountName = page.name;
        console.log('[OAuth] Page found:', page.id, 'Name:', page.name);

        if (platform === 'instagram') {
          // Get Instagram account connected to the page
          const igResponse = await axios.get(`https://graph.facebook.com/v18.0/${page.id}`, {
            params: {
              fields: 'instagram_business_account',
              access_token: page.access_token,
            },
          });
          const igAccountId = igResponse.data.instagram_business_account?.id;
          connectionData.instagramAccountId = igAccountId;

          // Fetch Instagram username to display in portal
          if (igAccountId) {
            try {
              const igProfileResponse = await axios.get(`https://graph.facebook.com/v18.0/${igAccountId}`, {
                params: {
                  fields: 'username,name',
                  access_token: page.access_token,
                },
              });
              const igUsername = igProfileResponse.data.username || igProfileResponse.data.name;
              if (igUsername) connectionData.accountName = `@${igUsername}`;
            } catch (igProfileError) {
              console.log('[OAuth] Could not fetch Instagram username, using page name');
            }
          }
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
