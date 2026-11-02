import { test } from 'node:test';
import assert from 'node:assert/strict';

import { humaniseSource } from './public-lead.js';

// The opportunity name is the one line the team reads in the pipeline. A demo request off the
// Tyresoft e-shot page has to say so there, not only in the notes of the alert email.
test('a demo request from the Tyresoft page is named for the partner', () => {
  assert.equal(humaniseSource('tyresoft-eshot-demo'), 'Book a demo (Tyresoft)');
});

test('an ordinary demo request keeps its plain name', () => {
  assert.equal(humaniseSource('website-hero-demo'), 'Book a demo');
  assert.equal(humaniseSource('website-nav-demo'), 'Book a demo');
});

test('the existing source names are unchanged', () => {
  assert.equal(humaniseSource(undefined), 'Website enquiry');
  assert.equal(humaniseSource('website-getstarted-automate-tyresoft'), 'Automate (Tyresoft)');
  assert.equal(humaniseSource('website-getstarted-connect-garagehive'), 'Connect (Garage Hive)');
  assert.equal(humaniseSource('website-getstarted-multibranch'), 'Multi-branch enquiry');
});
