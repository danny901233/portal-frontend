/**
 * The agent asserts a garage's opening hours as fact, so a wrong parse is worse than no parse.
 *
 * Binley Woods Service Centre, 2026-10-20: the demo-prospect config fell back to a generic
 * Mon-Fri 08:00-17:30 and the generated FAQ had their own receptionist saying "we are open Monday
 * to Friday from 08:00 to 17:30 and Saturday from 08:30 to 12:30". Their website says 08:30-17:30
 * and Saturday to 13:30. A garage hearing its own opening time wrong in the first minute of the
 * demo is the one impression that cannot be taken back.
 *
 * Every string below was scraped from a real garage website in the 500-prospect pilot run —
 * including the two junk lines, where the scraper's own regex matched page source because
 * "Monitoring" and "mons" begin with "Mon". Those must be refused, not parsed.
 *
 * The production change that would make these fail: trusting a parse that never established the
 * working week, letting one line's times leak onto another line's days, or reading page source as
 * opening hours.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOpeningHoursText } from './openingHoursText.js';

const open = (o: string, c: string) => ({ open: o, close: c, closed: false });
const shut = { open: null, close: null, closed: true };

test('the case that started it: 24h day range plus a separate Saturday line', () => {
  const r = parseOpeningHoursText([
    'Monday - Friday: 08:30 - 17:30',
    'Saturday: 09:00 - 13:30',
  ]);
  assert.ok(r, 'should parse');
  assert.deepEqual(r.hours.monday, open('08:30', '17:30'));
  assert.deepEqual(r.hours.friday, open('08:30', '17:30'));
  assert.deepEqual(r.hours.saturday, open('09:00', '13:30'));
  assert.deepEqual(r.hours.sunday, shut, 'a day never mentioned stays closed');
  assert.equal(r.daysResolved, 6);
});

test('bare am/pm hours with "to" and "until"', () => {
  const r = parseOpeningHoursText(['Monday to Friday 8am until 6pm']);
  assert.ok(r);
  assert.deepEqual(r.hours.wednesday, open('08:00', '18:00'));
  assert.deepEqual(r.hours.saturday, shut);
});

test('a dot as the minute separator, and a 12.30pm close', () => {
  const r = parseOpeningHoursText(['Monday to Friday 9am - 12.30pm']);
  assert.ok(r);
  assert.deepEqual(r.hours.monday, open('09:00', '12:30'));
});

test('dotted 24h times written one day per line', () => {
  const r = parseOpeningHoursText([
    'Monday : 08.00 - 17.30',
    'Tuesday : 08.00 - 17.30',
    'Wednesday : 08.00 - 17.30',
    'Thursday : 08.00 - 17.30',
    'Friday : 08.00 - 17.30',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.thursday, open('08:00', '17:30'));
  assert.equal(r.daysResolved, 5);
});

test('three-letter abbreviations, lowercase, en dash', () => {
  const r = parseOpeningHoursText([
    'mon 8:30 – 17:00', 'tue 8:30 – 17:00', 'wed 8:30 – 17:00',
    'thu 8:30 – 17:00', 'fri 8:30 – 17:00',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.tuesday, open('08:30', '17:00'));
});

test('"Mon - Sat" spans six days', () => {
  const r = parseOpeningHoursText(['Mon - Sat: 09:00 - 18:00']);
  assert.ok(r);
  assert.deepEqual(r.hours.saturday, open('09:00', '18:00'));
  assert.deepEqual(r.hours.sunday, shut);
  assert.equal(r.daysResolved, 6);
});

test('two day groups on one line keep their own times', () => {
  // The weekdays here have NO times of their own — "appointment only" — so only Saturday is set.
  const r = parseOpeningHoursText([
    'Monday - Friday 8:30am - 5:00pm',
    'Monday - Friday Appointment only Saturday 09:00 - 16:00',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.monday, open('08:30', '17:00'), 'weekdays keep the real line');
  assert.deepEqual(r.hours.saturday, open('09:00', '16:00'), 'Saturday is not given 8:30-17:00');
});

test('noise between the day and its times is ignored, not fatal', () => {
  const r = parseOpeningHoursText([
    'Mon - Fri: 8am - 5pm',
    'sat BY APPOINTMENT 9:00 – 16:00',
    'sun (Sales) BY APPOINTMENT 11:00 - 16:00',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.monday, open('08:00', '17:00'));
  assert.deepEqual(r.hours.saturday, open('09:00', '16:00'), 'by appointment is still open');
  assert.deepEqual(r.hours.sunday, open('11:00', '16:00'));
});

test('an unmarked afternoon close is read as pm, not as 5am', () => {
  const r = parseOpeningHoursText(['Monday - Friday 8:30 - 5:00']);
  assert.ok(r);
  assert.deepEqual(r.hours.monday, open('08:30', '17:00'));
});

test('a stated closure is honoured', () => {
  const r = parseOpeningHoursText([
    'Monday - Friday 08:00 - 17:30',
    'Saturday 08:30 - 12:30',
    'Sunday closed',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.sunday, shut);
});

test('an undecoded HTML entity does not hide the day range', () => {
  // Fast Track MOT Centre: the scraper left "&ndash;" in place and the whole line was discarded.
  const r = parseOpeningHoursText([
    'Monday &ndash; Friday: 08:30 - 18:00',
    'Saturday: 08:30 - 15:00',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.monday, open('08:30', '18:00'));
  assert.deepEqual(r.hours.saturday, open('08:30', '15:00'));
});

test('a colon typed where a dash belongs still reads as a day range', () => {
  // W M Snell Ltd publishes "Monday: Friday:" — plainly meaning Monday to Friday.
  const r = parseOpeningHoursText([
    'Monday: Friday: 8.00am - 5.00pm',
    'Saturday: 9am - 4.00pm',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.wednesday, open('08:00', '17:00'));
  assert.deepEqual(r.hours.saturday, open('09:00', '16:00'));
});

test('a colon between a day and its own times is not a range', () => {
  // The guard for the tweak above: these must stay two separate days, not Monday-through-Tuesday.
  const r = parseOpeningHoursText([
    'Monday: 08:00 - 17:00 Tuesday: 09:00 - 13:00',
    'Wednesday: 08:00 - 17:00',
    'Thursday: 08:00 - 17:00',
    'Friday: 08:00 - 17:00',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.monday, open('08:00', '17:00'));
  assert.deepEqual(r.hours.tuesday, open('09:00', '13:00'), 'Tuesday keeps its own shorter day');
});

test('page source that merely contains a day name is refused', () => {
  // Both scraped verbatim; the scraper matched them on "Mon".
  const r = parseOpeningHoursText([
    'Monitoring":{"appsWithMonitoring":[{"appId":"13d21c63-b5ec-5912-83',
    'mons":{"widgetsClientSpecMapData":{"141995eb-c700-84',
  ]);
  assert.equal(r, null, 'JSON fragments must never become opening hours');
});

test('a weekend-only line is not enough to invent a working week', () => {
  assert.equal(parseOpeningHoursText(['Saturday: 09:00 - 13:30']), null);
});

test('nothing usable returns null so the caller can fall back', () => {
  assert.equal(parseOpeningHoursText([]), null);
  assert.equal(parseOpeningHoursText(['Call us for our opening times']), null);
  assert.equal(parseOpeningHoursText(['Monday - Friday appointment only']), null);
});

test('junk alongside good lines does not poison the good lines', () => {
  const r = parseOpeningHoursText([
    'mons":{"widgetsClientSpecMapData":{"141995eb-c700-84',
    'Monday - Friday: 08:30 - 17:30',
  ]);
  assert.ok(r);
  assert.deepEqual(r.hours.monday, open('08:30', '17:30'));
});
