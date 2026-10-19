import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escalationFacts } from './messagingNotifications.js';

const session = {
  customerNameFirst: 'Aliciyurr',
  contactPhone: '447376478024',
  vehicleMake: 'Kia',
  vehicleModel: 'Picanto',
  vrn: 'RE19ZVS',
};

// The whole point of the alert is that the garage can act without opening the portal. When the
// customer asked to be emailed, the address was the one thing it did not say.
test('the email address the customer gave is in the facts', () => {
  const facts = escalationFacts({ ...session, contactEmail: 'licigrant4@gmail.com' });
  assert.deepEqual(facts.find(([k]) => k === 'Email'), ['Email', 'licigrant4@gmail.com']);
});

test('no email on the session means no Email line', () => {
  const facts = escalationFacts(session);
  assert.equal(facts.some(([k]) => k === 'Email'), false);
});

test('the customer, their number and the vehicle still come first', () => {
  const facts = escalationFacts({ ...session, contactEmail: 'licigrant4@gmail.com' });
  assert.deepEqual(facts.map(([k]) => k), ['Customer', 'Best number', 'Email', 'Vehicle']);
});
