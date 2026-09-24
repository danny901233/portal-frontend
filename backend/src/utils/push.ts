// Mobile push notifications via Apple Push Notification service (APNs).
//
// Token-based auth (.p8 key) — set these env vars to activate. Until they're
// present, every function here is a safe no-op, so the feature can ship dormant
// and light up the moment the credentials land.
//
//   APNS_KEY_P8    — full contents of the AuthKey_XXXX.p8 file (PEM, multiline)
//   APNS_KEY_ID    — the 10-char Key ID from the Apple Developer portal
//   APNS_TEAM_ID   — your 10-char Apple Team ID
//   APNS_BUNDLE_ID — app bundle id (default: uk.co.receptionmate.portal)
//   APNS_PRODUCTION — 'true' for TestFlight/App Store builds, 'false' for dev
//
// node-apn manages a single persistent HTTP/2 connection to Apple; we lazily
// build one Provider and reuse it.

import { readFileSync } from 'node:fs';
import apn from '@parse/node-apn';
import { prisma } from '../db.js';

export interface PushPayload {
  title: string;
  // Second line on the lock screen, above the body. This is where the branch name goes: staff
  // with more than one garage were getting "Sophie handled a call for you" with nothing to say
  // WHICH garage, so the notification could not be acted on without opening the app.
  subtitle?: string;
  body: string;
  // Arbitrary extra data delivered to the app (e.g. { type: 'call', callId }).
  data?: Record<string, unknown>;
  // iOS badge count to display on the app icon (optional).
  badge?: number;
}

let provider: apn.Provider | null = null;
let providerFailed = false;

function getProvider(): apn.Provider | null {
  if (provider) return provider;
  if (providerFailed) return null;

  // Key material: either inline PEM (APNS_KEY_P8) or a path to the .p8
  // (APNS_KEY_PATH). The path form is preferred on the server — keeps the
  // private key out of .env / process listings.
  let key = process.env.APNS_KEY_P8;
  if (!key && process.env.APNS_KEY_PATH) {
    try {
      key = readFileSync(process.env.APNS_KEY_PATH, 'utf8');
    } catch (error) {
      console.error('[PUSH] Could not read APNS_KEY_PATH:', error);
    }
  }
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;

  if (!key || !keyId || !teamId) {
    // Credentials not configured yet — stay dormant.
    providerFailed = true;
    console.log('[PUSH] APNs credentials not set (APNS_KEY_P8/APNS_KEY_PATH + APNS_KEY_ID + APNS_TEAM_ID) — push disabled.');
    return null;
  }

  try {
    provider = new apn.Provider({
      token: {
        // The .p8 may arrive with literal "\n" sequences via env — normalise.
        key: key.replace(/\\n/g, '\n'),
        keyId,
        teamId,
      },
      production: process.env.APNS_PRODUCTION === 'true',
    });
    return provider;
  } catch (error) {
    providerFailed = true;
    console.error('[PUSH] Failed to initialise APNs provider:', error);
    return null;
  }
}

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'uk.co.receptionmate.portal';

/**
 * Send a notification to a set of raw device tokens. Returns the list of tokens
 * Apple rejected as permanently invalid (410 Unregistered / BadDeviceToken) so
 * callers can prune them.
 */
export async function sendPushToTokens(
  tokens: string[],
  payload: PushPayload,
): Promise<string[]> {
  const p = getProvider();
  if (!p) return [];
  const unique = [...new Set(tokens.filter(Boolean))];
  if (unique.length === 0) return [];

  const note = new apn.Notification();
  note.topic = BUNDLE_ID;
  note.alert = {
    title: payload.title,
    ...(payload.subtitle ? { subtitle: payload.subtitle } : {}),
    body: payload.body,
  };
  note.sound = 'default';
  note.contentAvailable = false;
  if (typeof payload.badge === 'number') note.badge = payload.badge;
  note.payload = payload.data ?? {};
  // Keep it deliverable for a while if the phone is offline.
  note.expiry = Math.floor(Date.now() / 1000) + 3600;

  const invalid: string[] = [];
  try {
    const result = await p.send(note, unique);
    for (const failure of result.failed) {
      const status = failure.status ? Number(failure.status) : undefined;
      // 410 = token no longer valid; 400 BadDeviceToken = malformed/wrong env.
      if (status === 410 || failure.response?.reason === 'BadDeviceToken') {
        if (failure.device) invalid.push(failure.device);
      } else {
        console.error('[PUSH] Delivery failure:', failure.status, failure.response?.reason);
      }
    }
  } catch (error) {
    console.error('[PUSH] send threw:', error);
  }
  return invalid;
}

/**
 * Notify a single user. Used for direct-address pushes like "you've been
 * assigned a conversation" where only one recipient should be tapped.
 * Fire-and-forget friendly — never throws.
 */
export async function notifyUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    if (!getProvider()) return;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { deviceTokens: true, pushEnabled: true },
    });
    if (!user || !user.pushEnabled || user.deviceTokens.length === 0) return;

    const dead = await sendPushToTokens(user.deviceTokens, payload);
    if (dead.length === 0) return;

    await prisma.user.update({
      where: { id: userId },
      data: { deviceTokens: user.deviceTokens.filter((t) => !dead.includes(t)) },
    });
  } catch (error) {
    console.error('[PUSH] notifyUser failed:', error);
  }
}

/**
 * Notify every user who has access to a garage. Collects their registered
 * device tokens, sends the push, and prunes any tokens Apple reports dead.
 * Fire-and-forget friendly — never throws.
 */
export async function notifyGarageUsers(
  garageId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    if (!getProvider()) return; // skip the DB query entirely when dormant

    // Who gets this: anyone with push on who has either picked this garage explicitly, or picked
    // nothing at all and can see it.
    //
    // An explicit pick stands on its own rather than narrowing garageAccessIds, because the two
    // lists answer different questions. Access is granted wholesale — staff are added to every
    // garage as it is onboarded — so a staff phone buzzed for twenty-odd customers, and a staff
    // member wanting alerts for a garage that happens not to be on their list (it is authorised
    // separately, when the pick is saved) would otherwise tick it and hear nothing.
    //
    // Empty is the default and means "every garage I can see" — what a single-branch customer
    // wants, and what everyone had before this field existed.
    const users = await prisma.user.findMany({
      where: {
        pushEnabled: true,
        OR: [
          { pushGarageIds: { has: garageId } },
          { pushGarageIds: { isEmpty: true }, garageAccessIds: { has: garageId } },
        ],
      },
      select: { id: true, deviceTokens: true },
    });

    const tokenToUsers = new Map<string, string[]>();
    for (const u of users) {
      for (const t of u.deviceTokens) {
        const list = tokenToUsers.get(t) ?? [];
        list.push(u.id);
        tokenToUsers.set(t, list);
      }
    }

    const allTokens = [...tokenToUsers.keys()];
    if (allTokens.length === 0) return;

    const dead = await sendPushToTokens(allTokens, payload);
    if (dead.length === 0) return;

    // Prune dead tokens from every user that held them.
    const affected = new Set<string>();
    for (const t of dead) for (const uid of tokenToUsers.get(t) ?? []) affected.add(uid);
    await Promise.all(
      [...affected].map(async (uid) => {
        const u = users.find((x) => x.id === uid);
        if (!u) return;
        await prisma.user.update({
          where: { id: uid },
          data: { deviceTokens: u.deviceTokens.filter((t) => !dead.includes(t)) },
        });
      }),
    );
  } catch (error) {
    console.error('[PUSH] notifyGarageUsers failed:', error);
  }
}

/**
 * Notify the ReceptionMate team, not a garage's staff.
 *
 * Every other push here is addressed by garage, because every other push is
 * about a garage's own calls or messages. Support tickets are ours: they arrive
 * at hello@ from anyone, often from somebody we cannot match to a garage at all,
 * so there is no garage to address them by.
 *
 * Targets the RECEPTIONMATE_STAFF role directly and ignores pushGarageIds —
 * that field answers "which customers do I want buzzing my phone", which is not
 * the question here.
 *
 * Fire-and-forget friendly — never throws.
 */
export async function notifyReceptionMateStaff(payload: PushPayload): Promise<void> {
  try {
    if (!getProvider()) return; // skip the DB query entirely when dormant

    const users = await prisma.user.findMany({
      where: { role: 'RECEPTIONMATE_STAFF', pushEnabled: true },
      select: { id: true, deviceTokens: true },
    });

    const tokenToUsers = new Map<string, string[]>();
    for (const u of users) {
      for (const t of u.deviceTokens) {
        const list = tokenToUsers.get(t) ?? [];
        list.push(u.id);
        tokenToUsers.set(t, list);
      }
    }

    const allTokens = [...tokenToUsers.keys()];
    if (allTokens.length === 0) return;

    const dead = await sendPushToTokens(allTokens, payload);
    if (dead.length === 0) return;

    const affected = new Set<string>();
    for (const t of dead) for (const uid of tokenToUsers.get(t) ?? []) affected.add(uid);
    await Promise.all(
      [...affected].map(async (uid) => {
        const u = users.find((x) => x.id === uid);
        if (!u) return;
        await prisma.user.update({
          where: { id: uid },
          data: { deviceTokens: u.deviceTokens.filter((t) => !dead.includes(t)) },
        });
      }),
    );
  } catch (error) {
    console.error('[PUSH] notifyReceptionMateStaff failed:', error);
  }
}

/**
 * Notify each member of the team with a payload built for THEM.
 *
 * `notifyReceptionMateStaff` sends one identical payload to every device, which
 * is right for "a ticket arrived". It is wrong the moment the payload carries a
 * credential: a reply token is scoped to one user, so whoever it was minted for
 * would be recorded as the author no matter whose phone actually replied.
 *
 * Costs one send per staff member instead of one for everybody. With a team this
 * size that is a rounding error, and it keeps the audit trail honest.
 */
export async function notifyStaffIndividually(
  build: (userId: string) => PushPayload,
): Promise<void> {
  try {
    if (!getProvider()) return;
    const users = await prisma.user.findMany({
      where: { role: 'RECEPTIONMATE_STAFF', pushEnabled: true },
      select: { id: true },
    });
    await Promise.all(users.map((u) => notifyUser(u.id, build(u.id))));
  } catch (error) {
    console.error('[PUSH] notifyStaffIndividually failed:', error);
  }
}

/**
 * Approximate app-icon badge for a garage: calls not yet opened + unread chat messages.
 * Sent with call/message pushes so the icon badge is roughly right while the app is closed;
 * the in-app poll corrects it to the user's exact total (across all their garages) on open.
 */
export async function garageUnreadBadge(garageId: string): Promise<number> {
  try {
    const since = new Date(process.env.CALL_BADGE_SINCE || '2026-07-06T20:00:00Z');
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Call"
      WHERE "garageId" = ${garageId} AND "createdAt" >= ${since} AND ("metrics"->>'viewedAt') IS NULL`;
    const calls = Number(rows[0]?.n ?? 0);
    const agg = await prisma.chatConversation.aggregate({
      where: { garageId },
      _sum: { unreadCount: true },
    });
    return calls + (agg._sum.unreadCount ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Notify a garage's users that a conversation has been flagged / handed to the
 * team (the agent escalated and paused itself). Only fires for genuine
 * needs-attention moments, never on ordinary inbound messages. Fire-and-forget.
 */
export async function notifyFlaggedConversation(conversationId: string): Promise<void> {
  try {
    if (!getProvider()) return;
    const convo = await prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { garageId: true, customerName: true, customerPhone: true, platform: true },
    });
    if (!convo) return;

    const who = convo.customerName?.trim() || convo.customerPhone?.trim() || 'A customer';
    const badge = await garageUnreadBadge(convo.garageId);
    await notifyGarageUsers(convo.garageId, {
      title: `${who} needs a reply`,
      body: 'Your AI handed this chat to the team — tap to take over.',
      data: { type: 'message', conversationId, garageId: convo.garageId },
      badge,
    });
  } catch (error) {
    console.error('[PUSH] notifyFlaggedConversation failed:', error);
  }
}
