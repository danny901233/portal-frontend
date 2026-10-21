/**
 * After a prospect has talked to their own AI receptionist, email them what it just did.
 *
 * This is the close. The demo is persuasive while they are on the call and forgotten twenty
 * minutes later, so the follow-up turns it into something they can read, forward to a partner, and
 * act on — evidence rather than a pitch. It is also the only message in the sequence they have
 * genuinely asked for: they pressed the button, so this is solicited mail to someone who just used
 * the product, not cold outreach.
 *
 * Sent once per prospect. The first one lands as proof; the third reads as spam, and someone who
 * rings it again to show a colleague should not be punished for the enthusiasm.
 *
 * Best-effort throughout: a failure here must never cost us the call record it describes.
 */

import { prisma } from '../db.js';
import { sendEmail, brandedEmailShell, SUPPORT_REPLY_TO } from '../utils/email.js';

/** Where the email sends them to buy. Overridable so the link can be campaign-tagged. */
const SIGNUP_BASE = process.env.DEMO_SIGNUP_URL || 'https://www.receptionmate.co.uk/get-started';

/**
 * Deep-link straight into Assist self-serve, with their garage name already filled in.
 *
 * Assist is the right product to put in front of a cold garage: it is the instant-signup path and
 * needs no GMS credentials, which we do not have for any of these prospects — Automate cannot
 * answer a call until the provider returns API keys. The flow reads `tier` and `name` off the
 * query string (marketing-site/src/pages/get-started.astro), so one click lands them on the Assist
 * branch with step one already done.
 *
 * The price IS stated now, and taken from ASSIST_DEFAULTS in routes/public-signup.ts rather than
 * from marketing copy, because that constant is what the signup actually bills on. Anything quoted
 * here has to match what they are charged, or the first invoice is an argument.
 */
const signupUrl = (spokenName: string): string => {
  try {
    const u = new URL(SIGNUP_BASE);
    u.searchParams.set('tier', 'assist');
    u.searchParams.set('name', spokenName);
    return u.toString();
  } catch {
    return SIGNUP_BASE;
  }
};

/**
 * Below this, there was no demo worth describing — a mis-tap, an immediate hang-up, or a page
 * left open. Emailing someone about a four-second call they do not remember making is worse than
 * staying quiet.
 */
const MIN_SECONDS = 25;
const MIN_TRANSCRIPT_TURNS = 4;

/**
 * What Assist actually costs, mirroring ASSIST_DEFAULTS in routes/public-signup.ts — the constant
 * the signup bills on — and STRIPE_TRIAL_DAYS, which production sets explicitly to 14.
 *
 * Kept as named values so a quote in this email cannot drift from what the card is charged. The
 * per-minute rate and the included allowance matter as much as the headline: a garage told only
 * "£200 a month" has not been told what a busy month costs.
 *
 * The public pricing page's FAQ still answers "do you offer a free trial?" with "no", which
 * contradicts both this and the signup's own behaviour. That page needs fixing; this email states
 * what the code does.
 */
const PRICING = {
  monthlyGbp: 200,
  includedMinutes: 400,
  perMinutePence: 25,
  trialDays: 14,
};

const esc = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

type DemoCallFacts = {
  durationSeconds: number;
  summary?: string | null;
  customerName?: string | null;
  registrationNumber?: string | null;
  bookingDetails?: string | null;
  confirmedBooking?: boolean | null;
  transcriptTurns: number;
};

export type DemoProspectForSummary = {
  id: string;
  spokenName: string;
  email: string | null;
  summaryEmailedAt: Date | null;
  /** HighLevel contact, so the same call can raise the Hot opportunity. */
  contactId?: string | null;
};

const mmss = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} min ${s} sec` : `${s} seconds`;
};

/**
 * What the receptionist actually got hold of. Only facts that are present are listed — an empty
 * row would advertise what it failed to do, and on a demo the caller often hangs up mid-flow
 * because they have heard enough, which is not a failure.
 */
const capturedRows = (f: DemoCallFacts): string[] => {
  const rows: string[] = [];
  if (f.customerName) rows.push(`Caller name: <strong>${esc(f.customerName)}</strong>`);
  if (f.registrationNumber) rows.push(`Registration: <strong>${esc(f.registrationNumber)}</strong>`);
  if (f.bookingDetails) rows.push(`Job: <strong>${esc(f.bookingDetails)}</strong>`);
  if (f.confirmedBooking) rows.push('Booking: <strong>confirmed in the diary</strong>');
  return rows;
};

const buildEmail = (name: string, f: DemoCallFacts) => {
  const booked = Boolean(f.confirmedBooking);
  const signup = signupUrl(name);
  const subject = booked
    ? `${name} — your receptionist just took a booking`
    : `${name} — here's the call your receptionist just handled`;

  const rows = capturedRows(f);
  const capturedHtml = rows.length
    ? `<p style="margin:0 0 8px"><strong>What it picked up</strong></p>
       <ul style="margin:0 0 20px;padding-left:20px;line-height:1.7">
         ${rows.map((r) => `<li>${r}</li>`).join('')}
       </ul>`
    : '';

  const summaryHtml = f.summary
    ? `<p style="margin:0 0 8px"><strong>What happened on the call</strong></p>
       <p style="margin:0 0 20px;line-height:1.6">${esc(f.summary)}</p>`
    : '';

  const body = `
    <p style="margin:0 0 16px;line-height:1.6">
      Thanks for giving it a go. That call lasted ${mmss(f.durationSeconds)} — here's what your
      receptionist did while you were on it.
    </p>
    ${summaryHtml}
    ${capturedHtml}
    <p style="margin:0 0 22px;line-height:1.6">
      Nothing was really booked — that was a practice diary, so yours is untouched.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 22px;background:#f6f7fb;border-radius:12px">
      <tr><td style="padding:20px">
        <p style="margin:0 0 4px;font-size:19px;font-weight:700;color:#1d1a72">
          ${PRICING.trialDays} days free
        </p>
        <p style="margin:0 0 16px;line-height:1.5;color:#44474f">
          Add a card to start. Nothing is charged for ${PRICING.trialDays} days, and if you stop
          before then you pay nothing at all.
        </p>
        <p style="margin:0 0 4px;font-size:17px;font-weight:700;color:#1d1a72">
          Then £${PRICING.monthlyGbp} a month + VAT
        </p>
        <p style="margin:0;line-height:1.5;color:#44474f">
          Includes ${PRICING.includedMinutes} minutes of answered calls, then
          ${PRICING.perMinutePence}p a minute. No setup fee. Cancel at the end of any month.
        </p>
      </td></tr>
    </table>

    <p style="margin:0 0 22px;line-height:1.6">
      <strong>It gets better over the first few weeks.</strong> It answers from day one, then spends
      two to three weeks learning your garage — from the calls coming in, and from what you give it
      to read: your price list, the jobs you take, how you word things.
    </p>

    <p style="margin:0 0 8px">
      <a href="${signup}" style="background:#3426cf;color:#fff;text-decoration:none;padding:14px 24px;border-radius:9px;font-weight:600;display:inline-block">
        Start ${esc(name)}'s ${PRICING.trialDays}-day free trial
      </a>
    </p>
    <p style="margin:0 0 22px;line-height:1.6;color:#55585f;font-size:14px">
      Takes a couple of minutes. Nothing to connect to your diary first.
    </p>
    <p style="margin:0;line-height:1.6;color:#55585f">
      Want to hear the recording, or have it answer differently? Just reply to this email — it
      comes to me.
    </p>`;

  const text =
    `Thanks for giving it a go. That call lasted ${mmss(f.durationSeconds)}.\n\n` +
    (f.summary ? `What happened: ${f.summary}\n\n` : '') +
    (rows.length
      ? `What it picked up:\n${rows.map((r) => `- ${r.replace(/<[^>]+>/g, '')}`).join('\n')}\n\n`
      : '') +
    'Nothing was really booked — that was a practice diary, so yours is untouched.\n\n' +
    `${PRICING.trialDays} DAYS FREE\n` +
    `Add a card to start. Nothing is charged for ${PRICING.trialDays} days, and if you stop before ` +
    'then you pay nothing at all.\n\n' +
    `THEN £${PRICING.monthlyGbp} A MONTH + VAT\n` +
    `Includes ${PRICING.includedMinutes} minutes of answered calls, then ` +
    `${PRICING.perMinutePence}p a minute. No setup fee. Cancel at the end of any month.\n\n` +
    'It gets better over the first few weeks: it answers from day one, then spends two to three ' +
    'weeks learning your garage — from the calls coming in, and from what you give it to read: ' +
    'your price list, the jobs you take, how you word things.\n\n' +
    `Start ${name}'s ${PRICING.trialDays}-day free trial: ${signup}\n` +
    'Takes a couple of minutes. Nothing to connect to your diary first.\n\n' +
    'Want to hear the recording, or have it answer differently? Just reply to this email.';

  return { subject, html: brandedEmailShell(body), text };
};

/**
 * Email a prospect the summary of their own demo call, at most once.
 *
 * Returns true only when a message was actually sent, so the caller can stamp summaryEmailedAt
 * without claiming a send that silently failed.
 */
export const sendDemoCallSummary = async (
  prospect: DemoProspectForSummary,
  facts: DemoCallFacts,
): Promise<boolean> => {
  try {
    if (!prospect.email) return false;
    if (prospect.summaryEmailedAt) return false;
    if (facts.durationSeconds < MIN_SECONDS) {
      console.log(`[DEMO_SUMMARY] ${prospect.spokenName}: ${facts.durationSeconds}s call, too short to describe`);
      return false;
    }
    if (facts.transcriptTurns < MIN_TRANSCRIPT_TURNS) {
      console.log(`[DEMO_SUMMARY] ${prospect.spokenName}: only ${facts.transcriptTurns} turn(s), not a conversation`);
      return false;
    }

    const mail = buildEmail(prospect.spokenName, facts);
    const sent = await sendEmail({
      to: [prospect.email],
      replyTo: SUPPORT_REPLY_TO,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (!sent) {
      console.error(`[DEMO_SUMMARY] send failed for ${prospect.spokenName} <${prospect.email}>`);
      return false;
    }

    await prisma.demoProspect.update({
      where: { id: prospect.id },
      data: { summaryEmailedAt: new Date() },
    });
    console.log(`[DEMO_SUMMARY] sent to ${prospect.spokenName} <${prospect.email}>`);
    return true;
  } catch (err) {
    console.error('[DEMO_SUMMARY] failed', err);
    return false;
  }
};
