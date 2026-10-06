import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectLanguage,
  isEnglish,
  messagesNeedingTranslation,
  translateTexts,
} from './translate.js';

test('treats the English variants a garage will see as English', () => {
  assert.equal(isEnglish('en'), true);
  assert.equal(isEnglish('en-GB'), true);
  assert.equal(isEnglish('EN_gb'), true);
  assert.equal(isEnglish('english'), true);
});

test('treats Polish as not English', () => {
  assert.equal(isEnglish('pl'), false);
});

test('treats an undetected language as English so no translate button appears', () => {
  assert.equal(isEnglish(null), true);
  assert.equal(isEnglish(undefined), true);
  assert.equal(isEnglish(''), true);
});

const msg = (over: Partial<{ id: string; content: string; translatedContent: string | null }> = {}) => ({
  id: over.id ?? 'm1',
  content: over.content ?? 'dzien dobry',
  translatedContent: over.translatedContent ?? null,
});

test('picks out the messages that still need translating', () => {
  const rows = [msg({ id: 'a' }), msg({ id: 'b', content: 'chce zabukowac servis' })];
  assert.deepEqual(messagesNeedingTranslation(rows).map((m) => m.id), ['a', 'b']);
});

test('skips a message that is already cached', () => {
  const rows = [msg({ id: 'a', translatedContent: 'good morning' }), msg({ id: 'b' })];
  assert.deepEqual(messagesNeedingTranslation(rows).map((m) => m.id), ['b']);
});

test('skips image placeholders and blank content so we never pay to translate nothing', () => {
  const rows = [
    msg({ id: 'img', content: '[Image]' }),
    msg({ id: 'blank', content: '   ' }),
    msg({ id: 'real' }),
  ];
  assert.deepEqual(messagesNeedingTranslation(rows).map((m) => m.id), ['real']);
});

test('skips the agent context preamble the inbox already hides', () => {
  const rows = [msg({ id: 'ctx', content: '[Context: customer replied to reminder]' }), msg({ id: 'real' })];
  assert.deepEqual(messagesNeedingTranslation(rows).map((m) => m.id), ['real']);
});

test('returns one translation per input, in order', async () => {
  const complete = async () => JSON.stringify({ translations: ['good morning', 'I want to book a service'] });
  const out = await translateTexts(['dzien dobry', 'chce zabukowac servis'], 'English', complete);
  assert.deepEqual(out, ['good morning', 'I want to book a service']);
});

test('throws rather than mis-align when the model returns the wrong count', async () => {
  const complete = async () => JSON.stringify({ translations: ['good morning'] });
  await assert.rejects(
    () => translateTexts(['dzien dobry', 'chce zabukowac servis'], 'English', complete),
    /2 translations.*got 1/i,
  );
});

test('throws rather than mis-align when the model returns unparseable output', async () => {
  const complete = async () => 'Sure! Here are your translations:';
  await assert.rejects(() => translateTexts(['dzien dobry'], 'English', complete), /could not parse/i);
});

test('never calls the model for an empty batch', async () => {
  let called = false;
  const complete = async () => { called = true; return '{}'; };
  const out = await translateTexts([], 'English', complete);
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('passes the target language to the model', async () => {
  let seen = '';
  const complete = async (system: string) => { seen = system; return JSON.stringify({ translations: ['x'] }); };
  await translateTexts(['dzien dobry'], 'Polish', complete);
  assert.match(seen, /Polish/);
});

test('stores the detected language name', async () => {
  const out = await detectLanguage('dzien dobry chce zabukowac servis', async () => 'Polish');
  assert.equal(out, 'Polish');
});

test('tolerates the model padding its answer with whitespace or a full stop', async () => {
  assert.equal(await detectLanguage('bonjour', async () => '  French.\n'), 'French');
});

test('returns null rather than store a sentence the model waffled out', async () => {
  const out = await detectLanguage('dzien dobry', async () => 'It looks like this message is in Polish!');
  assert.equal(out, null);
});

test('never calls the model for blank text', async () => {
  let called = false;
  const out = await detectLanguage('   ', async () => { called = true; return 'Polish'; });
  assert.equal(out, null);
  assert.equal(called, false);
});
