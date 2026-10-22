import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliverReply } from './replyDelivery.js';

// ---------------------------------------------------------------------------
// A staff reply is recorded only once it has actually gone out
//
// 21 Oct 2026, 19:54:25. Dan typed "Or alternatively I can help?" to Mark Kettle at EAC Telford.
// The row was written, the thread showed it, and the send then failed — EAC's WABA had been
// blocked by Meta since 20 Oct 07:15. He believed he had replied; Mark had received nothing.
// Six customers and eight replies went the same way over 38 hours, every one of them displayed
// to staff as sent.
//
// The route wrote the ChatMessage row BEFORE calling sendMessage, so a failed send left a
// perfect-looking record of a message that never left the building. The order is the fix: send
// first, record only on success, and flag the conversation so an undelivered reply surfaces
// instead of looking answered.
//
// Widget and livechat threads are the exception and must not be reordered — they have no
// external connection and the row IS the delivery, which the browser picks up.
// ---------------------------------------------------------------------------

function deps(overrides: Partial<Parameters<typeof deliverReply>[3]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      send: async () => { calls.push('send'); },
      record: async () => { calls.push('record'); return { id: 'msg-1' }; },
      touchConversation: async () => { calls.push('touch'); },
      flagUndelivered: async () => { calls.push('flag'); },
      ...overrides,
    },
  };
}

test('a WhatsApp reply that fails to send is never recorded', async () => {
  const { calls, d } = deps({
    send: async () => { throw new Error('An unknown error has occurred.'); },
  });
  const res = await deliverReply('whatsapp', 'hello', true, d);

  assert.equal(res.ok, false);
  assert.ok(!calls.includes('record'), 'the row must not exist for a message that never went out');
  assert.ok(calls.includes('flag'), 'an undelivered reply has to surface somewhere');
});

test('a WhatsApp reply that sends is recorded afterwards, in that order', async () => {
  const { calls, d } = deps();
  const res = await deliverReply('whatsapp', 'hello', true, d);

  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['send', 'record', 'touch'],
    'send must come first — recording first is what made a failure invisible');
});

test('no connection for a Meta platform is a failure, not a silent no-op', async () => {
  // The old code wrote the row and simply skipped the send when no connection was found.
  const { calls, d } = deps();
  const res = await deliverReply('whatsapp', 'hello', false, d);

  assert.equal(res.ok, false);
  assert.ok(!calls.includes('send'));
  assert.ok(!calls.includes('record'));
  assert.ok(calls.includes('flag'));
});

test('a widget reply is recorded without any external send', async () => {
  const { calls, d } = deps();
  const res = await deliverReply('widget', 'hello', false, d);

  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['record', 'touch'], 'the row is the delivery for a widget thread');
});

test('an expired 24-hour window still answers 400, not 502', async () => {
  // Preserved from the original handler: this one is the customer going quiet for a day, which
  // the garage can understand and act on, not an outage.
  const { d } = deps({
    send: async () => { throw new Error('Cannot send message: 24-hour messaging window has expired.'); },
  });
  const res = await deliverReply('whatsapp', 'hello', true, d);

  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.status, 400);
    assert.match(res.error, /24-hour messaging window/);
  }
});

test('a genuine send failure answers 502 and says the reply did not go out', async () => {
  const { d } = deps({ send: async () => { throw new Error('An unknown error has occurred.'); } });
  const res = await deliverReply('whatsapp', 'hello', true, d);

  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.status, 502);
    assert.match(res.error, /not.*sent|could not|failed/i,
      'the staff member must be told plainly that it did not go');
  }
});

// ---------------------------------------------------------------------------
// The provider's message id must survive the send
//
// Meta returns messages[0].id (a wamid) on every accepted send, and that id is the only handle a
// later delivered/read/failed status webhook has to find the message again. Every send path threw
// the response away, so the status handler — which has existed all along for campaigns — had
// nothing to join conversation replies to.
//
// It matters beyond reporting: a `failed` status can arrive AFTER Meta has returned 200 OK, which
// is a class of failure the send/record ordering above cannot see at all.
// ---------------------------------------------------------------------------

test('the wamid from an accepted send is handed to record()', async () => {
  const seen: Array<string | null> = [];
  const res = await deliverReply('whatsapp', 'hello', true, {
    send: async () => ({ providerMessageId: 'wamid.ABC123' }),
    record: async (_c, id) => { seen.push(id); return { id: 'msg-1' }; },
    touchConversation: async () => {},
    flagUndelivered: async () => {},
  });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, ['wamid.ABC123']);
});

test('a send that returns no id records null rather than undefined', async () => {
  // Facebook and Instagram do not answer in the same shape, and a widget reply never sends at
  // all. metaMid is a nullable unique column — undefined would be a Prisma type error, and more
  // than one row holding undefined would collide.
  const seen: Array<string | null> = [];
  await deliverReply('facebook', 'hello', true, {
    send: async () => {},
    record: async (_c, id) => { seen.push(id); return { id: 'msg-1' }; },
    touchConversation: async () => {},
    flagUndelivered: async () => {},
  });
  await deliverReply('widget', 'hello', false, {
    send: async () => { throw new Error('must not be called'); },
    record: async (_c, id) => { seen.push(id); return { id: 'msg-2' }; },
    touchConversation: async () => {},
    flagUndelivered: async () => {},
  });
  assert.deepEqual(seen, [null, null]);
});

// ---------------------------------------------------------------------------
// The reason has to be the provider's, not axios's
//
// First live failure after this shipped logged "Request failed with status code 500" — axios's
// generic message. The code it replaced logged e.response.data, which carried Meta's actual
// error: code 1, OAuthException, and an fbtrace_id you can quote at support. Losing that made
// the log strictly worse than what was there before, on the one path whose whole purpose is
// making failures visible.
// ---------------------------------------------------------------------------

function axiosLikeError(status: number, body: unknown) {
  const e: any = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: body };
  return e;
}

test('a Graph error body is preferred over the axios message', async () => {
  const reasons: string[] = [];
  const res = await deliverReply('whatsapp', 'hello', true, {
    send: async () => {
      throw axiosLikeError(500, {
        error: { message: 'An unknown error has occurred.', code: 1, type: 'OAuthException', fbtrace_id: 'AJhL' },
      });
    },
    record: async () => { throw new Error('must not record'); },
    touchConversation: async () => {},
    flagUndelivered: async (r) => { reasons.push(r); },
  });

  assert.equal(res.ok, false);
  const reason = reasons[0];
  assert.match(reason, /An unknown error has occurred/);
  assert.match(reason, /\b1\b/, 'the Meta error code is what makes it searchable');
  assert.match(reason, /AJhL/, 'the fbtrace_id is what Meta support asks for');
  assert.doesNotMatch(reason, /Request failed with status code/, 'axios noise, not the cause');
});

test('an error with no provider body still reports something useful', async () => {
  const reasons: string[] = [];
  await deliverReply('whatsapp', 'hello', true, {
    send: async () => { throw new Error('socket hang up'); },
    record: async () => { throw new Error('must not record'); },
    touchConversation: async () => {},
    flagUndelivered: async (r) => { reasons.push(r); },
  });
  assert.match(reasons[0], /socket hang up/);
});

test('the 24-hour window is still detected when it arrives in a provider body', async () => {
  // Meta reports this as error 131047 rather than the string our own pre-check throws, so the
  // classification must survive reading the body instead of the message.
  const res = await deliverReply('whatsapp', 'hello', true, {
    send: async () => {
      throw axiosLikeError(400, {
        error: { message: 'Message failed to send because more than 24 hours have passed since the customer last replied.', code: 131047 },
      });
    },
    record: async () => { throw new Error('must not record'); },
    touchConversation: async () => {},
    flagUndelivered: async () => {},
  });
  assert.equal(res.ok, false);
  if (res.ok === false) assert.equal(res.status, 400, '131047 is the customer going quiet, not an outage');
});
