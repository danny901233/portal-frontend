/**
 * Keep the hello@ mailbox in step with the ticket queue.
 *
 * Every ticket that arrived by email has a twin sitting in Outlook: the
 * original message, which our Microsoft 365 rule copied to Mailgun on its way
 * past. Working the queue did nothing to it, so the inbox kept filling with
 * mail that had already been dealt with and the two views of the same work
 * drifted apart.
 *
 * So: close a ticket and its mail is archived, reopen one and it comes back to
 * the inbox, mark one as spam and it goes to junk.
 *
 * The handle is the message's own Internet Message-Id, which the inbound
 * webhook stores on each entry (`meta.inboundMessageId`). It survives the
 * forward, so the copy sitting in the mailbox carries the same one, and Graph
 * will filter on it. A ticket can have several messages; all of them move.
 *
 * Everything here is best-effort and fire-and-forget. Nobody's ticket should
 * fail to close because Microsoft was slow, so every path swallows its errors
 * and says so in the log. Unconfigured (no Graph credentials) is silent.
 *
 * Needs Mail.ReadWrite (application) on the app registration, granted
 * 2026-09-29. Without it Graph answers 403 and the mailbox simply never moves.
 */
import { prisma } from '../db.js';

/** Where a ticket's mail should sit. Graph well-known folder names. */
export type MailboxFolder = 'archive' | 'inbox' | 'junkemail';

const GRAPH = 'https://graph.microsoft.com/v1.0';

function getConfig() {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  // The support mailbox. Falls back to the address the OneDrive sync already
  // uses, which is the same account.
  const mailbox = process.env.MS_SUPPORT_MAILBOX
    || process.env.SUPPORT_FROM_EMAIL
    || process.env.MS_ONEDRIVE_USER;
  if (!tenantId || !clientId || !clientSecret || !mailbox) return null;
  return { tenantId, clientId, clientSecret, mailbox };
}

// A client-credentials token lasts an hour. Cache it rather than paying for a
// round trip on every ticket someone closes.
let cached: { token: string; expiresAt: number } | null = null;

async function getAccessToken(cfg: NonNullable<ReturnType<typeof getConfig>>): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const resp = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!resp.ok) throw new Error(`token ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { access_token: string; expires_in?: number };
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Every Message-Id we hold for this ticket's inbound mail. */
async function inboundMessageIds(ticketId: string): Promise<string[]> {
  const entries = await prisma.ticketEntry.findMany({
    where: { ticketId, authorContactId: { not: null } },
    select: { meta: true },
  });
  const ids = entries
    .map((e) => {
      const m = e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta)
        ? (e.meta as Record<string, unknown>)
        : null;
      return m && typeof m.inboundMessageId === 'string' ? m.inboundMessageId : null;
    })
    .filter((v): v is string => !!v);
  return [...new Set(ids)];
}

/** Find a message in the mailbox by its Internet Message-Id. Returns graph ids. */
async function findByMessageId(token: string, mailbox: string, messageId: string): Promise<string[]> {
  // Graph wants it bracketed and single-quoted; a quote inside is doubled.
  const bracketed = messageId.startsWith('<') ? messageId : `<${messageId}>`;
  const filter = `internetMessageId eq '${bracketed.replace(/'/g, "''")}'`;
  const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/messages`
    + `?$filter=${encodeURIComponent(filter)}&$select=id&$top=10`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`search ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  const data = (await resp.json()) as { value?: { id: string }[] };
  return (data.value ?? []).map((m) => m.id);
}

async function move(token: string, mailbox: string, graphId: string, folder: MailboxFolder): Promise<void> {
  const resp = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${graphId}/move`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinationId: folder }),
  });
  if (!resp.ok) throw new Error(`move ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
}

/**
 * Move this ticket's original mail to `folder`. Safe to call for any ticket:
 * one raised from a call or a thumbs-down has no mail to move and does nothing.
 */
export async function fileTicketMail(ticketId: string, folder: MailboxFolder): Promise<void> {
  const cfg = getConfig();
  if (!cfg) return;
  try {
    const messageIds = await inboundMessageIds(ticketId);
    if (!messageIds.length) return;

    const token = await getAccessToken(cfg);
    let moved = 0;
    let missing = 0;
    for (const messageId of messageIds) {
      try {
        const found = await findByMessageId(token, cfg.mailbox, messageId);
        // Not an error: mail older than the ticket system, or something a
        // person already filed by hand.
        if (!found.length) { missing += 1; continue; }
        for (const graphId of found) {
          await move(token, cfg.mailbox, graphId, folder);
          moved += 1;
        }
      } catch (err) {
        console.error(`[OUTLOOK] ${messageId} → ${folder} failed:`, err instanceof Error ? err.message : err);
      }
    }
    if (moved || missing) {
      console.log(`[OUTLOOK] ticket ${ticketId} → ${folder}: ${moved} moved${missing ? `, ${missing} not in the mailbox` : ''}`);
    }
  } catch (err) {
    // A mailbox that will not co-operate must never fail the ticket action.
    console.error('[OUTLOOK] filing failed:', err instanceof Error ? err.message : err);
  }
}
