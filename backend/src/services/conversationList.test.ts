import { strict as assert } from 'node:assert';
import test from 'node:test';

import { conversationFilters, mergeConversationsByCustomer, parseGarageIds } from './conversationList.js';

const row = (over: Record<string, unknown>) => ({
  id: 'c1', garageId: 'g1', platform: 'whatsapp', customerId: null, customerPhone: null,
  customerName: null, status: 'active', unreadCount: 0, enquiryType: null, assigneeId: null,
  assignee: null, lastMessageAt: new Date('2026-11-01T10:00:00Z'),
  messages: [{ createdAt: new Date('2026-11-01T10:00:00Z'), content: 'hi' }],
  customer: null, garage: { id: 'g1', name: 'Kent' },
  ...over,
});

test('the same customer id in two branches stays two cards', () => {
  const out = mergeConversationsByCustomer([
    row({ id: 'a', garageId: 'g1', customerId: 'cust', garage: { id: 'g1', name: 'Kent' } }),
    row({ id: 'b', garageId: 'g2', customerId: 'cust', garage: { id: 'g2', name: 'Essex' } }),
  ]);
  assert.equal(out.length, 2);
});

test('one customer on two platforms in one branch becomes one card that keeps its branch', () => {
  const out = mergeConversationsByCustomer([
    row({ id: 'a', customerId: 'cust', platform: 'whatsapp', unreadCount: 1 }),
    row({ id: 'b', customerId: 'cust', platform: 'facebook', unreadCount: 2,
      lastMessageAt: new Date('2026-11-02T10:00:00Z'),
      messages: [{ createdAt: new Date('2026-11-02T10:00:00Z'), content: 'later' }] }),
  ]);
  assert.equal(out.length, 1);
  const card = out[0] as Record<string, unknown>;
  assert.equal(card.id, 'b');
  assert.deepEqual(card.platforms, ['whatsapp', 'facebook']);
  assert.equal(card.unreadCount, 3);
  assert.deepEqual(card.garage, { id: 'g1', name: 'Kent' });
  assert.deepEqual(card.conversationIds, ['a', 'b']);
});

test('cards come newest first across branches', () => {
  const out = mergeConversationsByCustomer([
    row({ id: 'old', garageId: 'g1', lastMessageAt: new Date('2026-11-01T10:00:00Z') }),
    row({ id: 'new', garageId: 'g2', lastMessageAt: new Date('2026-11-03T10:00:00Z') }),
  ]);
  assert.deepEqual(out.map((c) => (c as { id: string }).id), ['new', 'old']);
});

test('garage ids parse from a comma list or repeats, dropping anything that is not an id', () => {
  const a = '8845b7ca-4807-467d-bc83-32d34b27b336';
  const b = '78697a53-915f-4773-a6ee-08703eefdfb9';
  assert.deepEqual(parseGarageIds(`${a},${b},${a}`), [a, b]);
  assert.deepEqual(parseGarageIds([a, b]), [a, b]);
  assert.deepEqual(parseGarageIds("' OR 1=1"), []);
  assert.deepEqual(parseGarageIds(undefined), []);
});

test('"mine" resolves to the caller and "all" means no filter', () => {
  assert.deepEqual(conversationFilters({ assigneeId: 'mine', platform: 'all', status: 'active' }, 'u1'),
    { assigneeId: 'u1', status: 'active' });
  assert.deepEqual(conversationFilters({ assigneeId: 'unassigned' }, 'u1'), { assigneeId: null });
});
