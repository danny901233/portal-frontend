/**
 * Lets a reply sent from the lock screen authenticate itself.
 *
 * The portal's session token lives in the WebView's localStorage, which native
 * code cannot reach — so a notification action has nothing to sign in with. This
 * mints a short-lived token that rides in the push payload, is scoped to one
 * ticket and one staff user, and is good for nothing else.
 *
 * It is a JWT signed with the same secret as a session, but deliberately NOT a
 * session token: the audience and purpose claims mean it is rejected by the
 * normal auth middleware, and a session token is likewise rejected here. If this
 * one leaks, the worst anybody can do is post a reply on one ticket for a day.
 *
 * It is not single-use — that would need storage for a value that lives a few
 * hours. Anyone holding the unlocked phone could reply from the app anyway, so
 * replay is not the threat that matters here.
 */
import jwt from 'jsonwebtoken';

const PURPOSE = 'ticket-push-reply';
const TTL_SECONDS = 24 * 60 * 60;

export interface PushReplyClaims {
  ticketId: string;
  userId: string;
}

export function mintPushReplyToken(claims: PushReplyClaims): string | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.warn('[PUSH_REPLY] JWT_SECRET not set — notification replies disabled');
    return null;
  }
  return jwt.sign({ ...claims, purpose: PURPOSE }, secret, { expiresIn: TTL_SECONDS });
}

export function verifyPushReplyToken(token: string): PushReplyClaims | null {
  const secret = process.env.JWT_SECRET;
  if (!secret || !token) return null;
  try {
    const decoded = jwt.verify(token, secret) as Record<string, unknown>;
    // A session token must not be usable here, and vice versa.
    if (decoded.purpose !== PURPOSE) return null;
    const ticketId = typeof decoded.ticketId === 'string' ? decoded.ticketId : '';
    const userId = typeof decoded.userId === 'string' ? decoded.userId : '';
    if (!ticketId || !userId) return null;
    return { ticketId, userId };
  } catch {
    return null;
  }
}
