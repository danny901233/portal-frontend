/**
 * Meta Template Token Service
 *
 * Manages the long-lived user token that has whatsapp_business_management scope.
 * This token is required for template CRUD operations (submit/sync/delete).
 * Sending messages uses the per-garage system user token (whatsapp_business_messaging).
 *
 * Token lifecycle:
 *   - Initial token stored in META_TEMPLATE_TOKEN env var
 *   - Refreshed weekly by scheduler (see utils/scheduler.ts)
 *   - Refreshed token persisted to meta-token-state.json at backend root
 *   - getTemplateToken() reads state file first, falls back to env var
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, '../../meta-token-state.json');

interface TokenState {
  token: string;
  refreshedAt: string;
}

function readState(): TokenState | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw) as TokenState;
    }
  } catch {
    // ignore — fall back to env
  }
  return null;
}

function writeState(token: string): void {
  const state: TokenState = { token, refreshedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** Returns the best available template management token. */
export function getTemplateToken(): string | null {
  const state = readState();
  if (state?.token) return state.token;
  return process.env.META_TEMPLATE_TOKEN || null;
}

/**
 * Exchanges the current token for a fresh 60-day long-lived token.
 * Called weekly by the scheduler.
 */
export async function refreshTemplateToken(): Promise<void> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const currentToken = getTemplateToken();

  if (!appId || !appSecret) {
    throw new Error('[META-TOKEN] META_APP_ID or META_APP_SECRET not set');
  }
  if (!currentToken) {
    throw new Error('[META-TOKEN] No token available to refresh — set META_TEMPLATE_TOKEN in .env');
  }

  const url = new URL('https://graph.facebook.com/oauth/access_token');
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', currentToken);

  const res = await fetch(url.toString());
  const data = await res.json() as any;

  if (!res.ok || !data.access_token) {
    throw new Error(`[META-TOKEN] Refresh failed: ${JSON.stringify(data)}`);
  }

  writeState(data.access_token);
  console.log('[META-TOKEN] Token refreshed successfully');
}
