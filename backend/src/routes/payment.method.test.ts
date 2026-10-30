/**
 * How a customer pays is a CHOICE, not an inference from what they bought.
 *
 * /payment/method decided card-versus-Direct-Debit from the product: Connect and Assist by
 * card, Automate by Direct Debit. That held while every Automate garage was British, and broke
 * the first time one was not.
 *
 * IC Garage LTD, Ireland, 30 Oct 2026. They signed up on Direct Debit, which gave them a SEPA
 * Core mandate, and GoCardless will only charge that in EUR:
 *
 *   [BILLING] FIRST-MONTH CHARGE FAILED for accounts@icgarage.net: £478.80 NOT collected,
 *   1 invoice(s) left in draft. must be EUR for a sepa_core mandate
 *
 * Business.billingMethod already carried the answer — the onboarding modal sets it and the
 * agreement flow reads it — and this route was the one place that ignored it. Setting a garage
 * to stripe_card therefore changed nothing on the only page where it mattered: they were still
 * offered Direct Debit, which is exactly what could not take their money.
 *
 * The product inference is kept as the fallback, so no existing garage moves.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

/** The decision under test, extracted exactly as payment.ts computes it. */
function isCard(g: {
  billingMethod?: string | null;
  hasVoiceAccess: boolean;
  agentType?: string | null;
}): boolean {
  const chosen = g.billingMethod ?? null;
  return chosen === 'stripe_card' ? true
    : chosen === 'directdebit' ? false
    : !g.hasVoiceAccess ? true
    : g.agentType === 'assist';
}

test('IC Garage: an Automate garage set to card is offered card', () => {
  assert.equal(
    isCard({ billingMethod: 'stripe_card', hasVoiceAccess: true, agentType: 'automate' }), true);
});

test('and an explicit Direct Debit choice is honoured even for Assist', () => {
  assert.equal(
    isCard({ billingMethod: 'directdebit', hasVoiceAccess: true, agentType: 'assist' }), false);
});

test('with no choice recorded, Automate still means Direct Debit', () => {
  assert.equal(isCard({ billingMethod: null, hasVoiceAccess: true, agentType: 'automate' }), false);
});

test('with no choice recorded, Assist still means card', () => {
  assert.equal(isCard({ billingMethod: null, hasVoiceAccess: true, agentType: 'assist' }), true);
});

test('with no choice recorded, Connect still means card', () => {
  assert.equal(isCard({ billingMethod: null, hasVoiceAccess: false, agentType: null }), true);
});

test('an invoice customer falls back rather than being forced either way', () => {
  // 'invoice' is neither card nor Direct Debit; they settle by bank transfer. The product
  // inference decides what the setup page would offer if they ever reached it.
  assert.equal(isCard({ billingMethod: 'invoice', hasVoiceAccess: true, agentType: 'automate' }), false);
  assert.equal(isCard({ billingMethod: 'invoice', hasVoiceAccess: false, agentType: null }), true);
});
