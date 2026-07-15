import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { getStripeClient } from '../services/stripe.js';

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

export default router;
