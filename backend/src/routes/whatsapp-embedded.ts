import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

// ---------------------------------------------------------------------------
// WhatsApp Embedded Signup — the true Meta flow (create-new OR connect-existing
// WABA), as used by GHL/Twilio. This is ADDITIVE and isolated: it lives beside
// the legacy oauth.ts (untouched, still used by Facebook/Instagram) and only ever
// writes the SocialMediaConnection for the ONE garage doing the signup. It never
// reads or mutates other garages' connections, so the 5 live WhatsApp garages are
// unaffected.
//
// The frontend runs FB.login({ config_id }) (config 888785980261763) and a
// sessionInfo listener; on success it POSTs { garageId, code, wabaId, phoneNumberId }
// here. The critical fix vs the old flow: the code is exchanged WITHOUT a
// redirect_uri (embedded-signup codes are business-scoped), which is what caused
// the old 36008 error.
// ---------------------------------------------------------------------------

const router = Router();

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}`;

router.post('/oauth/whatsapp/embedded-exchange', authenticate, async (req: Request, res: Response) => {
  const { garageId, code, wabaId, phoneNumberId } = req.body || {};

  if (!META_APP_ID || !META_APP_SECRET) {
    return res.status(500).json({ error: 'meta_not_configured' });
  }
  if (!garageId || !code || !wabaId || !phoneNumberId) {
    return res.status(400).json({ error: 'missing_params', message: 'garageId, code, wabaId and phoneNumberId are required.' });
  }

  // Garage-scope check — only a manager/staff for this garage can connect it.
  const user = req.user;
  const allowed = user?.role === 'RECEPTIONMATE_STAFF' || (Array.isArray(user?.garageIds) && user!.garageIds!.includes(garageId));
  if (!allowed) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    // 1. Exchange the embedded-signup code for a business access token.
    //    NOTE: no redirect_uri — this is the fix for the old 36008 failure.
    const tokenResp = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, code },
    });
    const accessToken: string = tokenResp.data.access_token;
    if (!accessToken) {
      return res.status(502).json({ error: 'token_exchange_failed' });
    }

    // 2. Subscribe our app to the customer's WABA so we receive their messages.
    try {
      await axios.post(`${GRAPH}/${wabaId}/subscribed_apps`, null, { params: { access_token: accessToken } });
    } catch (e: any) {
      console.error('[WA_EMBEDDED] subscribed_apps failed:', e?.response?.data ?? e?.message);
    }

    // 3. Register the phone number for Cloud API sending (best-effort; a fresh
    //    number from embedded signup needs this, an already-registered one 400s harmlessly).
    let displayNumber: string | undefined;
    try {
      const pin = String(Math.floor(100000 + Math.random() * 900000));
      await axios.post(`${GRAPH}/${phoneNumberId}/register`, { messaging_product: 'whatsapp', pin }, {
        params: { access_token: accessToken },
      });
      console.log(`[WA_EMBEDDED] registered phone ${phoneNumberId} for garage ${garageId} (pin ${pin})`);
    } catch (e: any) {
      console.log('[WA_EMBEDDED] register skipped/failed (often already registered):', e?.response?.data?.error?.message ?? e?.message);
    }
    // Fetch the display number for a friendly connection label.
    try {
      const pn = await axios.get(`${GRAPH}/${phoneNumberId}`, { params: { fields: 'display_phone_number,verified_name', access_token: accessToken } });
      displayNumber = pn.data.display_phone_number || pn.data.verified_name;
    } catch { /* non-fatal */ }

    // 4. Upsert the SocialMediaConnection for THIS garage only.
    const data = {
      garageId,
      platform: 'whatsapp',
      whatsappPhoneNumberId: phoneNumberId,
      accessToken,
      accountName: displayNumber || `WhatsApp (${wabaId})`,
      isActive: true,
    };
    const existing = await prisma.socialMediaConnection.findFirst({ where: { garageId, platform: 'whatsapp' } });
    if (existing) {
      await prisma.socialMediaConnection.update({ where: { id: existing.id }, data });
    } else {
      await prisma.socialMediaConnection.create({ data });
    }

    console.log(`[WA_EMBEDDED] connected garage=${garageId} waba=${wabaId} phone=${phoneNumberId}`);
    return res.json({ success: true, phoneNumberId, displayNumber: displayNumber || null });
  } catch (error: any) {
    console.error('[WA_EMBEDDED] exchange failed:', error?.response?.data ?? error?.message);
    return res.status(500).json({ error: 'exchange_failed' });
  }
});

export default router;
