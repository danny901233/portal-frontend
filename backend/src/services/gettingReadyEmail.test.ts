import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGettingReadyEmail } from './gettingReadyEmail.js';

// ── The "getting ready" email, which now carries the Garage Link Advanced steps ──────────────
//
// Caller recognition and service history come from Business Central, and the one part only the
// garage can do is register ReceptionMate as an Entra application in their own Garage Hive and
// grant it consent. Nothing in the product can do that for them, so the email has to carry the
// actual steps — client ID, the three permission sets, Grant Consent — rather than "ask Garage
// Hive".
//
// Two things these tests exist for, both of which would reach a customer unnoticed:
//
//   1. An unsubstituted placeholder. The copy came from a hand-built HTML file with
//      {{FIRST_NAME}} and {{GROUP_PARAGRAPH}} in it. "Hi {{FIRST_NAME}}," landing in a
//      garage's inbox is the kind of thing nobody notices until a customer mentions it.
//   2. A client ID that drifts from the one we actually authenticate with. The email tells the
//      garage which application to approve; if that string stops matching
//      GARAGEHIVE_CLIENT_ID, they grant consent to nothing and the connection fails with no
//      obvious cause. It is passed in from env for exactly that reason, never written twice.
//
// The permission names are asserted verbatim because they are typed into Business Central by
// hand. "GHV PHONEBOOK API" is the one that matters most — without it an incoming call cannot
// be matched to a customer, which is the entire point of the email.

const BASE = {
  garageName: 'IC Garage LTD',
  firstName: 'Marek',
  branchCount: 1,
  clientId: '22d76535-0c33-43d2-99bf-2da58c4ff246',
};

test('no placeholder survives into the email', () => {
  const { html, text, subject } = buildGettingReadyEmail(BASE);
  for (const [label, body] of [['html', html], ['text', text], ['subject', subject]] as const) {
    assert.ok(!body.includes('{{'), `${label} still contains a {{placeholder}}`);
    assert.ok(!body.includes('}}'), `${label} still contains a placeholder closer`);
  }
});

test('the client ID is the one passed in, not a copy baked into the copy', () => {
  const { html, text } = buildGettingReadyEmail({ ...BASE, clientId: 'changed-id-0000' });
  assert.ok(html.includes('changed-id-0000'));
  assert.ok(text.includes('changed-id-0000'));
  assert.ok(!html.includes('22d76535'), 'a hardcoded client ID is still in the HTML');
  assert.ok(!text.includes('22d76535'), 'a hardcoded client ID is still in the text');
});

test('all three permission sets are named, in both formats', () => {
  const { html, text } = buildGettingReadyEmail(BASE);
  for (const perm of ['GHV PHONEBOOK API', 'D365 FULL ACCESS', 'GHV GH FULL ACCESS']) {
    assert.ok(html.includes(perm), `html is missing ${perm}`);
    assert.ok(text.includes(perm), `text is missing ${perm}`);
  }
});

test('a known first name is used, and an unknown one does not leave a gap', () => {
  assert.ok(buildGettingReadyEmail(BASE).html.includes('Hi Marek,'));
  const anon = buildGettingReadyEmail({ ...BASE, firstName: '' });
  assert.ok(anon.html.includes('Hi,'), 'a missing name must still greet them');
  assert.ok(!anon.html.includes('Hi ,'), 'a missing name left a dangling comma');
});

test('a single-site garage is not told about branches', () => {
  const { html } = buildGettingReadyEmail(BASE);
  assert.ok(!/branches/i.test(html), 'a one-branch garage was told about branches');
});

test('a group is told the one approval covers every branch', () => {
  // Otherwise the obvious reading is that somebody repeats all ten steps per branch.
  const { html, text } = buildGettingReadyEmail({ ...BASE, branchCount: 4 });
  assert.ok(/all 4 (of your )?branches/i.test(html), 'group paragraph missing from html');
  assert.ok(/all 4 (of your )?branches/i.test(text), 'group paragraph missing from text');
});

test('the steps the garage cannot skip are all present', () => {
  const { html } = buildGettingReadyEmail(BASE);
  for (const needle of [
    'Microsoft Entra applications',   // where they go
    'Grant Consent',                  // the step it stalls on
    'Enabled',                        // the State field
    'tenant ID',                      // what they send back
    'Environment name',
  ]) {
    assert.ok(html.includes(needle), `html is missing "${needle}"`);
  }
});

test('the Other service package ask is still in there', () => {
  // It was the whole of this email before the Advanced steps were added, and it is still
  // needed — without it the agent cannot book a job that matches no standard service.
  const { html, text } = buildGettingReadyEmail(BASE);
  assert.ok(/Other/.test(html) && /service package/i.test(html));
  assert.ok(/service package/i.test(text));
});

test('the text part is not just stripped HTML', () => {
  const { text } = buildGettingReadyEmail(BASE);
  assert.ok(!text.includes('<'), 'HTML leaked into the plain-text part');
  assert.ok(!text.includes('&mdash;'), 'an HTML entity leaked into the plain-text part');
  assert.ok(text.length > 400, 'the text part looks truncated');
});

test('an email that asks for a reply has somewhere for the reply to go', () => {
  // sendEmail defaults the reply address to noreply@. This email asks the reader to reply twice
  // — the tenant ID and environment name come back that way — so without a reply-to the two
  // values we are waiting on are silently lost and the connection just never happens.
  const { replyTo, text } = buildGettingReadyEmail(BASE);
  assert.match(text, /[Rr]eply to this email/, 'the copy no longer asks for a reply');
  assert.ok(replyTo && replyTo.includes('@'), 'the copy asks for a reply with nowhere to send it');
  assert.ok(!/noreply/i.test(replyTo));
});

test('the subject names the garage and frames the whole job', () => {
  // It covers caller recognition AND the "Other" service package, so a subject naming only one
  // of them undersells the email and makes the second task look like an afterthought.
  const { subject } = buildGettingReadyEmail(BASE);
  assert.equal(subject, 'Getting IC Garage LTD ready for ReceptionMate');
});

test('nothing claims the agent is already taking calls', () => {
  // This lands on signing, before the garage has even logged in, so any copy describing what
  // happens "at the moment" when a customer rings is describing something that has not started.
  // It read as though the agent were already live and getting it wrong.
  const { html, text } = buildGettingReadyEmail(BASE);
  for (const body of [html, text]) {
    assert.ok(!/at the moment/i.test(body), 'copy presumes a live agent');
    assert.ok(!/has to ask them/i.test(body), 'copy describes the agent already taking calls');
  }
});

test('the email asks them to do the steps', () => {
  const { html, text } = buildGettingReadyEmail(BASE);
  assert.match(html, /please follow the steps below/i);
  assert.match(text, /please follow the steps below/i);
});

// ── the name is not ours ────────────────────────────────────────────────────
//
// firstName comes from Agreement.signedByName, which is free text the signatory types on the
// sign page. It is not a severe XSS vector — mail clients do not run script, and this email
// goes to the garage's own manager — but it is unescaped data in an HTML document, and the
// everyday version of the bug is a garage called "Smith & Sons" rendering as mojibake or a
// stray quote breaking the layout. Escaped on the HTML side only; the plain-text part wants the
// characters as typed.

test('a name containing HTML is escaped in the html part', () => {
  const { html } = buildGettingReadyEmail({ ...BASE, firstName: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'), 'a raw <script> tag reached the HTML body');
  assert.ok(html.includes('&lt;script&gt;'), 'the name was not escaped');
});

test('an ampersand in a name is escaped, not left bare', () => {
  const { html, text } = buildGettingReadyEmail({ ...BASE, firstName: 'Smith & Sons' });
  assert.ok(html.includes('Hi Smith &amp; Sons,'), 'bare ampersand left in the HTML');
  assert.ok(text.includes('Hi Smith & Sons,'), 'the plain-text part should not be escaped');
});

test('a quote in a name cannot break out of an attribute or tag', () => {
  const { html } = buildGettingReadyEmail({ ...BASE, firstName: 'O\'Brien"' });
  assert.ok(!/Hi O'Brien"/.test(html), 'raw quotes reached the HTML body');
  assert.ok(html.includes('&#39;') && html.includes('&quot;'));
});

test('the client ID is escaped too', () => {
  const { html } = buildGettingReadyEmail({ ...BASE, clientId: '<b>not-an-id</b>' });
  assert.ok(!html.includes('<b>not-an-id</b>'), 'client ID interpolated unescaped');
});

test('a newline in the garage name cannot forge a mail header', () => {
  const { subject } = buildGettingReadyEmail({ ...BASE, garageName: 'IC Garage\nBcc: x@y.com' });
  assert.ok(!/[\r\n]/.test(subject), 'CR/LF survived into the subject line');
});
