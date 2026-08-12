import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { getStripeClient, STRIPE_TRIAL_DAYS } from '../services/stripe.js';

// ---------------------------------------------------------------------------
// Connect trial → paid. When a Connect garage's free month ends without a card,
// the trial-end cron sets accessRestricted=true and the portal shows the card
// paywall. This endpoint powers the paywall's "Add payment details" button: it
// opens a Stripe Checkout for the Connect plan (£250 + VAT = £300/mo, no trial
// since the free month is over). On payment, the Stripe webhook unlocks the garage.
// Additive + isolated: does not touch the Assist billing flow.
// ---------------------------------------------------------------------------

const router = Router();
const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
const CONNECT_PRICE_ID = process.env.STRIPE_CONNECT_PRICE_ID;
const ASSIST_PRICE_ID = process.env.STRIPE_ASSIST_PRICE_ID;

// GET /api/connect/setup-status/:garageId — how far through Connect setup this garage is.
//
// Derived from real data every time rather than from a stored "completed" flag, so it cannot go
// stale: if a garage disconnects WhatsApp or deletes its campaign, the checklist reverts to
// incomplete on its own. The wizard is dismissible, so this is what the persistent reminder
// reads to know whether there is still something to nag about.
router.get('/connect/setup-status/:garageId', authenticate, async (req: Request, res: Response) => {
  const { garageId } = req.params;
  const user = req.user;
  const allowed = user?.role === 'RECEPTIONMATE_STAFF' || (Array.isArray(user?.garageIds) && user!.garageIds!.includes(garageId));
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  try {
    const [garage, whatsapp, templates, campaigns] = await Promise.all([
      prisma.garage.findUnique({ where: { id: garageId }, select: { hasMessagingAccess: true, hasVoiceAccess: true } }),
      prisma.socialMediaConnection.findFirst({
        where: { garageId, platform: 'whatsapp', isActive: true },
        select: { id: true, accountName: true, whatsappPhoneNumberId: true },
      }),
      prisma.messageTemplate.findMany({ where: { garageId }, select: { name: true, status: true } }),
      prisma.outboundCampaign.findMany({ where: { garageId }, select: { id: true, status: true } }),
    ]);
    if (!garage) return res.status(404).json({ error: 'garage_not_found' });

    // "Submitted" means it has left draft — pending counts, because the customer has done their
    // part and is waiting on Meta. Rejected does NOT count: it needs their attention again.
    const submitted = templates.filter((t) => t.status === 'pending' || t.status === 'approved');
    const rejected = templates.filter((t) => t.status === 'rejected');

    const steps = {
      whatsapp: {
        done: Boolean(whatsapp),
        label: whatsapp?.accountName || null,
      },
      template: {
        done: submitted.length > 0,
        submitted: submitted.length,
        approved: templates.filter((t) => t.status === 'approved').length,
        rejected: rejected.length,
        drafts: templates.filter((t) => t.status === 'draft').length,
      },
      contacts: {
        done: campaigns.length > 0,
        campaigns: campaigns.length,
      },
    };
    const remaining = Object.values(steps).filter((s) => !s.done).length;
    return res.json({
      applicable: garage.hasMessagingAccess === true,
      complete: remaining === 0,
      remaining,
      steps,
    });
  } catch (e: any) {
    console.error('[CONNECT_SETUP_STATUS] failed:', e?.message);
    return res.status(500).json({ error: 'setup_status_failed' });
  }
});

router.post('/connect/checkout', authenticate, async (req: Request, res: Response) => {
  const { garageId } = req.body || {};
  const user = req.user;
  if (!garageId) return res.status(400).json({ error: 'missing_garageId' });
  const allowed = user?.role === 'RECEPTIONMATE_STAFF' || (Array.isArray(user?.garageIds) && user!.garageIds!.includes(garageId));
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  if (!CONNECT_PRICE_ID) {
    console.error('[CONNECT_BILLING] STRIPE_CONNECT_PRICE_ID not configured');
    return res.status(500).json({ error: 'connect_price_not_configured' });
  }
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { id: true, name: true, stripeCustomerId: true },
    });
    if (!garage) return res.status(404).json({ error: 'garage_not_found' });

    const stripe = getStripeClient();
    const metadata: Record<string, string> = {
      kind: 'connect-billing',
      garageId: garage.id,
      userId: user!.userId,
      businessName: garage.name.slice(0, 100),
    };
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      // Reuse the Stripe customer if we already made one; else prefill their email.
      ...(garage.stripeCustomerId ? { customer: garage.stripeCustomerId } : { customer_email: user!.email }),
      line_items: [{ price: CONNECT_PRICE_ID, quantity: 1 }],
      payment_method_collection: 'always',
      subscription_data: { metadata },
      metadata,
      success_url: `${PORTAL_URL}/dashboard?connect_paid=1`,
      cancel_url: `${PORTAL_URL}/dashboard`,
    });
    return res.json({ url: session.url });
  } catch (e: any) {
    console.error('[CONNECT_BILLING] checkout failed:', e?.message);
    return res.status(500).json({ error: 'checkout_failed' });
  }
});

// Self-serve: a Connect garage in the SECOND HALF of its free trial adds voice (Assist).
// One subscription, two items (Connect + Assist), with trial_end aligned to the existing
// Connect trialEndDate — so both bill together on ONE invoice when the free month ends.
// On payment the Stripe webhook (kind='connect-add-voice') flips agentScript→Assist-agent,
// sets hasVoiceAccess, and provisions a number + the Assist agent on Account 2.
router.post('/connect/add-voice', authenticate, async (req: Request, res: Response) => {
  const { garageId } = req.body || {};
  const user = req.user;
  if (!garageId) return res.status(400).json({ error: 'missing_garageId' });
  const allowed = user?.role === 'RECEPTIONMATE_STAFF' || (Array.isArray(user?.garageIds) && user!.garageIds!.includes(garageId));
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  if (!CONNECT_PRICE_ID || !ASSIST_PRICE_ID) {
    console.error('[CONNECT_ADD_VOICE] price ids not configured');
    return res.status(500).json({ error: 'price_not_configured' });
  }
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { id: true, name: true, stripeCustomerId: true, trialEndDate: true, hasVoiceAccess: true },
    });
    if (!garage) return res.status(404).json({ error: 'garage_not_found' });
    if (garage.hasVoiceAccess) return res.status(400).json({ error: 'already_has_voice' });

    // ONE subscription, ONE trial end, so Connect and Assist always bill on the same date and
    // land on a single invoice — adding voice must never give a customer two billing dates.
    //
    // Take the LATER of the existing Connect trial end and a full Assist trial from today.
    // Aligning to the Connect date alone is what the customer expects for billing, but because
    // the upsell only appears in the trial's second half it would give a late upgrader just a
    // day or two of Assist. Taking the max guarantees a proper look at voice. The cost is that a
    // late upgrade extends the shared free period a little, which is the cheaper mistake.
    const assistTrialEndMs = Date.now() + STRIPE_TRIAL_DAYS * 24 * 60 * 60 * 1000;
    const connectTrialEndMs = garage.trialEndDate ? garage.trialEndDate.getTime() : 0;
    const trialEnd = Math.floor(Math.max(connectTrialEndMs, assistTrialEndMs) / 1000);
    console.log(`[CONNECT_ADD_VOICE] ${garage.name}: connect trial ends ${garage.trialEndDate?.toISOString() ?? 'n/a'}, shared trial_end -> ${new Date(trialEnd * 1000).toISOString()}`);

    const stripe = getStripeClient();
    const metadata: Record<string, string> = {
      kind: 'connect-add-voice',
      garageId: garage.id,
      userId: user!.userId,
      businessName: garage.name.slice(0, 100),
    };
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(garage.stripeCustomerId ? { customer: garage.stripeCustomerId } : { customer_email: user!.email }),
      line_items: [
        { price: CONNECT_PRICE_ID, quantity: 1 },
        { price: ASSIST_PRICE_ID, quantity: 1 },
      ],
      payment_method_collection: 'always',
      subscription_data: { metadata, trial_end: trialEnd },
      metadata,
      success_url: `${PORTAL_URL}/dashboard?voice_added=1`,
      cancel_url: `${PORTAL_URL}/dashboard`,
    });
    return res.json({ url: session.url });
  } catch (e: any) {
    console.error('[CONNECT_ADD_VOICE] checkout failed:', e?.message);
    return res.status(500).json({ error: 'checkout_failed' });
  }
});

export default router;
