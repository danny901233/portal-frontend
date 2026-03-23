import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

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
      instagram: 'instagram_business_basic,instagram_business_manage_messages',
    };

    const scope = scopes[platform];
    if (!scope) {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    // Store state to verify callback
    const state = Buffer.from(JSON.stringify({ garageId, platform })).toString('base64');

    // Instagram Business Login uses instagram.com, others use facebook.com
    let authUrl: URL;
    if (platform === 'instagram') {
      authUrl = new URL('https://www.instagram.com/oauth/authorize');
      authUrl.searchParams.set('client_id', INSTAGRAM_APP_ID!);
    } else {
      authUrl = new URL('https://www.facebook.com/v18.0/dialog/oauth');
      authUrl.searchParams.set('client_id', META_APP_ID!);
    }
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

    // Decode state
    const { garageId, platform } = JSON.parse(Buffer.from(state as string, 'base64').toString());

    // Exchange code for access token — Instagram Business Login uses a different endpoint
    let accessToken: string;

    if (platform === 'instagram') {
      // Instagram Business Login token exchange
      // Instagram requires params in POST body as form data, not query string
      const tokenBody = new URLSearchParams({
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: META_REDIRECT_URI,
        code: code as string,
      });
      const tokenResponse = await axios.post('https://api.instagram.com/oauth/access_token', tokenBody, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const shortLivedToken = tokenResponse.data.access_token;

      // Exchange short-lived token for long-lived token (60 days)
      const longLivedResponse = await axios.get('https://graph.instagram.com/access_token', {
        params: {
          grant_type: 'ig_exchange_token',
          client_id: INSTAGRAM_APP_ID,
          client_secret: INSTAGRAM_APP_SECRET,
          access_token: shortLivedToken,
        },
      });
      accessToken = longLivedResponse.data.access_token;
    } else {
      const tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
        params: {
          client_id: META_APP_ID,
          client_secret: META_APP_SECRET,
          redirect_uri: META_REDIRECT_URI,
          code,
        },
      });
      accessToken = tokenResponse.data.access_token;
    }

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
    } else if (platform === 'instagram') {
      // Instagram Business Login — get IG user ID and username directly
      const igMeResponse = await axios.get('https://graph.instagram.com/v21.0/me', {
        params: {
          fields: 'user_id,username,name',
          access_token: accessToken,
        },
      });
      console.log('[OAuth] Instagram user info:', JSON.stringify(igMeResponse.data, null, 2));

      const igUserId = igMeResponse.data.user_id;
      const igUsername = igMeResponse.data.username || igMeResponse.data.name;

      if (!igUserId) {
        console.error('[OAuth] No Instagram user_id returned!');
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/integrations?error=no_ig_user_found`);
      }

      connectionData.instagramAccountId = igUserId;
      connectionData.accountName = igUsername ? `@${igUsername}` : igUserId;
      console.log('[OAuth] Instagram account ID:', igUserId, 'Username:', igUsername);

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
