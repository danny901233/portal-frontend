// Mailgun delivery webhooks. Turns an EmailLog row from "we handed it to Mailgun" into
// "it landed at 14:02" / "it bounced" — the difference between what we sent and what the
// customer actually received, which is the question people actually ask.
//
// Point Mailgun at POST /api/webhooks/mailgun for the delivered / failed (permanent and
// temporary) / complained / opened events.
import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../../db.js';

const router = Router();

/** Mailgun signs every webhook: HMAC-SHA256 of `timestamp + token` keyed by the signing key.
 *  Without this check anyone who learns the URL can rewrite our delivery history, so an
 *  unset key fails closed rather than trusting the payload. */
function signatureValid(timestamp?: string, token?: string, signature?: string): boolean {
  const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!key || !timestamp || !token || !signature) return false;

  // Mailgun replays are the documented abuse path; anything older than 15 minutes is stale.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 15 * 60) return false;

  const expected = crypto.createHmac('sha256', key).update(timestamp + token).digest('hex');
  // Lengths must match before timingSafeEqual, which throws on a mismatch.
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Mailgun's event names -> the status we store. */
const STATUS_BY_EVENT: Record<string, string> = {
  delivered: 'delivered',
  failed: 'bounced',
  rejected: 'bounced',
  complained: 'complained',
  opened: 'opened',
};

router.post('/mailgun', async (req: Request, res: Response) => {
  const sig = req.body?.signature ?? {};
  if (!signatureValid(sig.timestamp, sig.token, sig.signature)) {
    console.warn('[MAILGUN_WEBHOOK] rejected: bad or missing signature');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const data = req.body?.['event-data'] ?? {};
  const event: string = data.event ?? '';
  const messageId: string | undefined = data.message?.headers?.['message-id'];
  const status = STATUS_BY_EVENT[event];

  // Always 200 on anything we simply don't track — a 4xx makes Mailgun retry an event we
  // are never going to want.
  if (!status || !messageId) return res.status(200).json({ ignored: true });

  // Mailgun strips the angle brackets in webhook payloads but includes them on the send
  // response, so match either shape rather than losing the join over punctuation.
  const bare = messageId.replace(/^<|>$/g, '');

  try {
    const result = await prisma.emailLog.updateMany({
      where: { providerMessageId: { in: [bare, `<${bare}>`] } },
      data: {
        status,
        ...(status === 'delivered' ? { deliveredAt: new Date() } : {}),
        ...(status === 'bounced'
          ? { failedAt: new Date(), error: data['delivery-status']?.message ?? data.reason ?? null }
          : {}),
      },
    });

    if (result.count === 0) {
      // Expected for anything sent before this logging existed; noisy only once.
      console.log(`[MAILGUN_WEBHOOK] ${event} for unknown message ${bare}`);
    }
    return res.status(200).json({ ok: true, updated: result.count });
  } catch (error) {
    console.error('[MAILGUN_WEBHOOK] failed to record event:', error);
    // 500 so Mailgun retries — a dropped delivery event is a permanent hole in the trail.
    return res.status(500).json({ error: 'failed to record' });
  }
});

export default router;
