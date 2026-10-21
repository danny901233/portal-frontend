import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { whatsappToken, whatsappTokens } from './whatsappToken.js';

// ---------------------------------------------------------------------------
// Which credential a send actually uses
//
// The shared system-user token has no expiry and reaches every WABA a customer shares with us.
// A garage's stored token is whatever Embedded Signup handed back, which Meta issues with a
// SIXTY DAY expiry — so it is the fallback, never the first choice.
// ---------------------------------------------------------------------------

test('the shared token wins, and the stored one is the fallback', () => {
  const prev = process.env.META_SYSTEM_USER_TOKEN;
  try {
    process.env.META_SYSTEM_USER_TOKEN = 'shared-tok';
    assert.equal(whatsappToken('stored-tok'), 'shared-tok');
    assert.deepEqual(whatsappTokens('stored-tok'), ['shared-tok', 'stored-tok']);

    // No shared token configured — fall back rather than send nothing.
    process.env.META_SYSTEM_USER_TOKEN = '';
    assert.equal(whatsappToken('stored-tok'), 'stored-tok');

    // Same value on both: one entry, not a pointless retry of the identical credential.
    process.env.META_SYSTEM_USER_TOKEN = 'same';
    assert.deepEqual(whatsappTokens('same'), ['same']);
  } finally {
    process.env.META_SYSTEM_USER_TOKEN = prev;
  }
});

// ---------------------------------------------------------------------------
// Every WhatsApp send path must resolve through the helper
//
// It did not, and the split went unnoticed because the two halves fail at different times.
// Great Hollands' stored token expired on 2026-10-11; their AGENT kept replying perfectly
// (meta-whatsapp.ts resolves through whatsappToken, so it used the shared token) while the
// staff reply route in messages.ts sent with the raw stored token and would have failed
// silently. Nobody at that garage happened to type a reply for ten days, which is the only
// reason no customer was lost to it.
//
// A structural assertion, because this is not something a unit test of one route would catch:
// the bug is a path that forgot to ask. Also broken at the time: ReceptionMate Branch (token
// invalidated by a password change) and ReceptionMate Demo (expired 13 Sep).
// ---------------------------------------------------------------------------

const SEND_PATHS = [
  'routes/messages.ts',
  'routes/conversations.ts',
  'routes/webhooks/meta-whatsapp.ts',
  'services/outboundSend.ts',
  'services/reminderScheduler.ts',
];

// Two patterns are correct, and both must be allowed or the test just invites a workaround:
//   - call whatsappToken() at the send site, or
//   - resolve ONCE at the source and overwrite connection.accessToken, which is what
//     meta-whatsapp.ts does at the top of the webhook so everything downstream inherits it.
const RESOLVES_AT_SOURCE = /accessToken:\s*whatsappToken\(/;

test('no WhatsApp send puts a stored token straight into an Authorization header', () => {
  const offenders: string[] = [];
  for (const rel of SEND_PATHS) {
    const src = readFileSync(join(import.meta.dirname, '..', rel), 'utf8');
    if (RESOLVES_AT_SOURCE.test(src)) continue;
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // `Bearer ${connection.accessToken}` — the stored credential, unresolved.
      if (!/Bearer \$\{\s*(connection|conn|c)\.accessToken\s*\}/.test(line)) return;
      // Only WhatsApp. Facebook, Instagram and livechat sends use a PAGE token, where the
      // shared WhatsApp system-user token has no authority at all — pointing those at
      // whatsappToken() would break three working channels to fix one. The request shape is a
      // dozen lines above the header, so look back for what is being called.
      const ctx = lines.slice(Math.max(0, i - 14), i).join('\n');
      if (/messaging_product|whatsappPhoneNumberId/.test(ctx) && !/pageId/.test(ctx)) {
        offenders.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `these WhatsApp sends use the stored token instead of whatsappToken(): ${offenders.join(', ')}`);
});
