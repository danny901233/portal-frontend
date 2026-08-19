import type { Request, Response, NextFunction } from 'express';
import { sendEmail } from '../utils/email.js';

/**
 * Where production errors go.
 *
 * This used to log only when NODE_ENV !== 'production', so on the live box a 500 produced no
 * stack trace anywhere — not in pm2, not in an inbox. The only way to learn the portal was broken
 * was a customer saying so. Log always, and tell someone the first time each distinct fault
 * appears.
 *
 * Deliberately email rather than adding an error-tracking service: it reuses Mailgun, costs
 * nothing per month, and there is no new account to own.
 */

const ALERT_TO = (process.env.ERROR_ALERT_EMAILS || '')
  .split(',').map((x) => x.trim()).filter(Boolean);

// One email per distinct fault per hour, and a hard ceiling per hour overall — a failing
// dependency can throw thousands of times a minute, and burying the inbox helps nobody.
const SIGNATURE_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_ALERTS_PER_HOUR = 10;
const lastAlerted = new Map<string, number>();
let windowStart = Date.now();
let sentThisWindow = 0;

function shouldAlert(signature: string): boolean {
  if (!ALERT_TO.length) return false;
  const now = Date.now();
  if (now - windowStart > 60 * 60 * 1000) {
    windowStart = now;
    sentThisWindow = 0;
  }
  if (sentThisWindow >= MAX_ALERTS_PER_HOUR) return false;
  const last = lastAlerted.get(signature);
  if (last && now - last < SIGNATURE_COOLDOWN_MS) return false;
  lastAlerted.set(signature, now);
  sentThisWindow += 1;
  return true;
}

export function reportError(context: string, err: unknown, detail?: string): void {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error(`[ERROR] ${context}: ${error.message}`, error.stack || '');
  const signature = `${context}:${error.message}`.slice(0, 200);
  if (!shouldAlert(signature)) return;
  const body = [
    `Where: ${context}`,
    detail ? `Detail: ${detail}` : '',
    `Message: ${error.message}`,
    '',
    error.stack || '(no stack)',
    '',
    'Further occurrences of this same error are suppressed for an hour.',
  ].filter(Boolean).join('\n');
  const escape = (x: string) =>
    x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  void sendEmail({
    to: ALERT_TO,
    subject: `Portal error — ${error.message.slice(0, 90)}`,
    text: body,
    html: `<pre style="font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap">${escape(body)}</pre>`,
  }).catch((mailErr) => console.error('[ERROR] could not send error alert:', mailErr));
}

/** Catch what escapes a request handler. */
export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const status = err instanceof Error && 'status' in err ? (err as { status: number }).status : 500;
  const message = err instanceof Error ? err.message : 'Unexpected error processing request';

  if (status >= 500) {
    reportError(`${req.method} ${req.path}`, err);
  } else {
    console.warn(`[${status}] ${req.method} ${req.path}: ${message}`);
  }

  // A 4xx message is meant for the caller and is safe to pass on. A 500 message is ours — it can
  // carry a query, a column name or a file path, so it does not leave the building.
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong. Please try again.' : message,
  });
};

/**
 * Faults with no request behind them — a rejected promise nobody awaited, a throw in a timer.
 * These are the ones that used to vanish completely.
 */
export function installProcessErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    reportError('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    reportError('uncaughtException', err);
    // Deliberately not exiting: pm2 would restart us, and dropping every in-flight request for
    // one bad code path is usually worse than carrying on with a logged fault.
  });
}
