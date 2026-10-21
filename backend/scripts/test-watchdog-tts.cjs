/**
 * Mute-fleet check for agent-watchdog.cjs.
 *
 * Run from the backend dir:  node scripts/test-watchdog-tts.cjs
 *
 * Same discipline as test-watchdog-cadence.cjs: points the state file at a temp dir, opts out
 * of the auto-run, and never calls main(), so it touches neither live state nor the database
 * nor the real alert channels.
 *
 * WHY THIS CHECK EXISTS. 21 Oct 2026, 11:44-11:53: the ElevenLabs character quota ran out and
 * seven callers across six garages got a completely silent agent. Every one of those calls
 * recorded sixteen tts_errors in metrics.provider_errors and nothing read them. We found out
 * twenty minutes later because a garage left feedback saying "agent just keeps typing and
 * taking no details". The existing response-health check did not fire: the LLM ran fine and
 * answered, so the calls looked responsive — only the AUDIO was missing.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-tts-'));
process.env.WATCHDOG_LASTRUN_FILE = path.join(tmp, 'lastrun.json');
delete process.env.HC_PING_URL;
process.env.WATCHDOG_NO_AUTORUN = '1';

const { ttsIssues, TTS_MIN_SILENT, TTS_WINDOW_MIN } = require('../agent-watchdog.cjs');

const NOW = new Date('2026-10-21T12:00:00Z');
const at = (min) => new Date(NOW.getTime() - min * 60000);
const call = (o) => ({ id: o.id || 'x', garage: o.garage || 'A Garage', createdAt: o.at || at(1),
                       hasAudio: o.hasAudio !== false, ttsErrors: o.errs || 0 });

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('ttsIssues');

t('the real outage fires one alert naming the scale', () => {
  // The seven real calls at their real times, 11:44:39 to 11:53:26 — an 8.8 minute outage,
  // judged at 11:55. The first draft of this fixture spread them over 16 minutes and the
  // check correctly counted only six, which is the window doing its job on bad test data.
  const calls = [
    call({ id: '50802899', garage: 'Bee Cool ACS',        at: at(11), hasAudio: false, errs: 0 }),
    call({ id: '34580340', garage: 'VRS Midlands',        at: at(10), hasAudio: false, errs: 16 }),
    call({ id: '07671991', garage: 'Speedy Spanners',     at: at(10), hasAudio: false, errs: 16 }),
    call({ id: '34576041', garage: 'Speedy Spanners',     at: at(10), hasAudio: false, errs: 16 }),
    call({ id: '39173480', garage: "In'n'out Norwich",    at: at(9),  hasAudio: false, errs: 11 }),
    call({ id: '76271204', garage: 'Speedy Spanners',     at: at(7),  hasAudio: false, errs: 16 }),
    call({ id: '58190225', garage: 'EAC Telford',         at: at(2),  hasAudio: false, errs: 15 }),
  ];
  const out = ttsIssues(calls, NOW);
  assert.equal(out.length, 1, 'one alert, not seven');
  assert.match(out[0].key, /^tts:/);
  assert.match(out[0].msg, /7/, 'the message does not say how many calls');
  assert.match(out[0].msg, /garage/i);
});

t('a single silent call is not an alert', () => {
  assert.deepEqual(ttsIssues([call({ hasAudio: false, errs: 4 })], NOW), []);
});

t('two silent calls are', () => {
  const out = ttsIssues([call({ id: 'a', hasAudio: false, errs: 4 }),
                         call({ id: 'b', hasAudio: false, errs: 4 })], NOW);
  assert.equal(out.length, 1);
});

t('a call that RECOVERED mid-call is not silent', () => {
  // call 06267466, 21 Oct: 31 tts_errors and audio still played. Alerting on error COUNT
  // rather than on missing audio would have paged about a call the caller heard fine.
  const out = ttsIssues([call({ id: 'a', hasAudio: true, errs: 31 }),
                         call({ id: 'b', hasAudio: true, errs: 31 })], NOW);
  assert.deepEqual(out, []);
});

t('healthy traffic is silent', () => {
  assert.deepEqual(ttsIssues([call({}), call({}), call({})], NOW), []);
});

t('silent calls older than the window are ignored', () => {
  const old = TTS_WINDOW_MIN + 10;
  assert.deepEqual(ttsIssues([call({ id: 'a', at: at(old), hasAudio: false, errs: 9 }),
                              call({ id: 'b', at: at(old), hasAudio: false, errs: 9 })], NOW), []);
});

t('no calls at all is not an alert', () => {
  // Absence of traffic is the heartbeat check's job, not this one.
  assert.deepEqual(ttsIssues([], NOW), []);
});

t('the threshold is the documented one', () => {
  assert.equal(TTS_MIN_SILENT, 2);
});

console.log(`\n${pass} passed`);
