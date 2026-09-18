/**
 * Abandoned-checkout follow-up.
 *
 * Someone types their garage into the Google Places box on the website, gets as far as giving us
 * an email, and stops. Until now the only follow-up was a phone call from the team, and the
 * opportunity simply sat in "Abandoned checkout" in HighLevel.
 *
 * Two touches, then we stop: one an hour after they go quiet, one three days later. The team are
 * phoning these people as well, so a third email stops being helpful and starts being pursuit.
 *
 * WHY THE PORTAL AND NOT A HIGHLEVEL WORKFLOW: "abandoned" is only really knowable here. HighLevel
 * sees the pipeline stage we push it, so a workflow there would infer the state from a transition
 * we control anyway — and would fire on someone who had just moved on to booking a demo. This row
 * has the timestamps and the status, so "still pending, never completed" is a fact rather than an
 * inference.
 *
 * WHY AN HOUR IS ENOUGH: measured over 60 days, of 46 prospects who never completed, every single
 * one went quiet within 30 minutes and the longest gap between first touch and last activity was
 * 9 minutes. Nobody has ever come back after that. An hour is already far beyond the longest real
 * pause, so the email cannot land on someone who is merely mid-form.
 */
import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';

const HOUR = 60 * 60 * 1000;
const FIRST_AFTER_MS = 1 * HOUR;
const SECOND_AFTER_MS = 3 * 24 * HOUR;
// Nothing older than this is emailed. Two reasons: "you started setting things up earlier" is
// absurd two months on, and without a cap the first armed run empties the whole backlog at once —
// which is a mailing list, not a follow-up. Past a week the team's phone call is the right move.
const MAX_AGE_MS = 7 * 24 * HOUR;

/** Placeholder addresses exist so an opportunity can be created before we know anyone's email. */
const isRealEmail = (e: string | null | undefined): boolean =>
  !!e && !/@pending\.receptionmate\.co\.uk$/i.test(e) && /@/.test(e);

// Our own test rows. Narrow on purpose: a real garage could have "test" inside a longer domain,
// and skipping a genuine prospect is the worse of the two mistakes.
const isOurTestAddress = (e: string): boolean =>
  /@(test|testerer|example)\.(com|co\.uk)$/i.test(e.trim());

const firstNameOf = (name: string | null, business: string): string => {
  const n = (name || '').trim().split(/\s+/)[0];
  return n && n.length > 1 ? n : '';
};

function shell(bodyHtml: string): string {
  // Plain, narrow, and readable in a dark client. No hero image: this is a note from a person,
  // and dressing it up as a campaign is what gets it treated as one.
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;padding:32px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d2430;font-size:15px;line-height:1.6;">
    <tr><td>
      ${bodyHtml}
      <p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e6e8ec;font-size:13px;color:#68707d;">
        ReceptionMate &middot; <a href="https://receptionmate.co.uk" style="color:#3426cf;text-decoration:none;">receptionmate.co.uk</a><br>
        Not looking for this? Just reply and we'll leave you be.
      </p>
    </td></tr>
  </table></body></html>`;
}

function firstEmail(business: string, first: string) {
  const hi = first ? `Hi ${first},` : 'Hello,';
  return {
    subject: `Your ReceptionMate setup for ${business}`,
    html: shell(`
      <p style="margin:0 0 16px;">${hi}</p>
      <p style="margin:0 0 16px;">Thanks for looking at ReceptionMate for <strong>${business}</strong>.
      You started setting things up earlier and didn't finish — no problem at all, the details you
      entered are saved and you can pick up where you left off.</p>
      <p style="margin:0 0 16px;">In case it's useful while you're deciding, here's what it actually does:</p>
      <ul style="margin:0 0 16px;padding-left:20px;">
        <li style="margin-bottom:6px;">Answers the calls your team can't get to — evenings and weekends included</li>
        <li style="margin-bottom:6px;">Books MOTs, services and repairs straight into your diary</li>
        <li style="margin-bottom:6px;">Takes a proper message when it can't help, so nothing goes to voicemail</li>
      </ul>
      <p style="margin:0 0 16px;">It works by call forwarding, so your number doesn't change and
      your phones ring first — it only picks up when nobody does.</p>
      <p style="margin:0 0 20px;"><a href="https://receptionmate.co.uk" style="display:inline-block;background:#3426cf;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:7px;font-weight:600;">Finish setting up</a></p>
      <p style="margin:0;">If you'd rather see it working first, reply to this email and we'll set
      up a short demo on your own number.</p>`),
    text: `${hi}\n\nThanks for looking at ReceptionMate for ${business}. You started setting things `
      + `up earlier and didn't finish — the details you entered are saved and you can pick up where `
      + `you left off.\n\nWhat it does: answers the calls your team can't get to, including evenings `
      + `and weekends; books MOTs, services and repairs into your diary; and takes a proper message `
      + `when it can't help.\n\nIt works by call forwarding, so your number doesn't change and your `
      + `phones ring first.\n\nFinish setting up: https://receptionmate.co.uk\n\nIf you'd rather see `
      + `it working first, reply and we'll set up a short demo on your own number.\n\nReceptionMate`,
  };
}

function secondEmail(business: string, first: string) {
  const hi = first ? `Hi ${first},` : 'Hello,';
  return {
    subject: `Still thinking it over, ${business}?`,
    html: shell(`
      <p style="margin:0 0 16px;">${hi}</p>
      <p style="margin:0 0 16px;">I dropped you a note a few days ago about setting ReceptionMate up
      for <strong>${business}</strong>. I won't keep chasing — this is the last one from me.</p>
      <p style="margin:0 0 16px;">The question most garages ask is what happens to the calls they're
      missing now. If that's worth ten minutes, reply to this email and we'll put it on your own
      number so you can ring in and hear it for yourself.</p>
      <p style="margin:0 0 20px;"><a href="https://receptionmate.co.uk" style="display:inline-block;background:#3426cf;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:7px;font-weight:600;">Pick up where you left off</a></p>
      <p style="margin:0;">And if the timing's wrong, that's completely fine — just say and I'll close it off.</p>`),
    text: `${hi}\n\nI dropped you a note a few days ago about setting ReceptionMate up for `
      + `${business}. I won't keep chasing — this is the last one from me.\n\nThe question most `
      + `garages ask is what happens to the calls they're missing now. If that's worth ten minutes, `
      + `reply and we'll put it on your own number so you can ring in and hear it.\n\n`
      + `https://receptionmate.co.uk\n\nAnd if the timing's wrong, that's completely fine — just say `
      + `and I'll close it off.\n\nReceptionMate`,
  };
}

export interface SweepResult { considered: number; first: number; second: number; skipped: number; }

/**
 * Send whatever is due. Safe to call repeatedly: each send is recorded on the row before the next
 * candidate is considered, so an overlapping run or a restart cannot double-send.
 */
export async function sweepAbandonedCheckouts(opts: { dryRun?: boolean } = {}): Promise<SweepResult> {
  const now = Date.now();
  const out: SweepResult = { considered: 0, first: 0, second: 0, skipped: 0 };

  const candidates = await prisma.pendingSignup.findMany({
    where: {
      status: { not: 'completed' },
      OR: [{ abandonedEmail1At: null }, { abandonedEmail2At: null }],
    },
    select: {
      id: true, businessName: true, email: true, name: true, status: true,
      createdAt: true, updatedAt: true, abandonedEmail1At: true, abandonedEmail2At: true,
    },
  });

  // One email per ADDRESS, not per row. A prospect who restarts the form produces a second row,
  // and ben@thejcgroup.co.uk duly appeared twice in the first dry run. Seeded with every address
  // already emailed, so a later run cannot repeat what an earlier one sent on a different row.
  const alreadyEmailed = new Set(
    (await prisma.pendingSignup.findMany({
      where: { abandonedEmail1At: { not: null } },
      select: { email: true },
    })).map((r) => (r.email || '').trim().toLowerCase()),
  );

  for (const p of candidates) {
    out.considered++;
    if (!isRealEmail(p.email)) { out.skipped++; continue; }   // two thirds of them, and the phone is the channel there
    if (isOurTestAddress(p.email)) { out.skipped++; continue; }
    // Past a week this stops being a follow-up. It also stops the first armed run emptying the
    // whole backlog in one go.
    if (now - p.createdAt.getTime() > MAX_AGE_MS) { out.skipped++; continue; }

    // Measured from the LAST activity, not the first: someone who came back and got further has
    // not abandoned anything, and the clock should start from where they actually stopped.
    const quietFor = now - p.updatedAt.getTime();
    const first = firstNameOf(p.name, p.businessName);

    if (!p.abandonedEmail1At) {
      if (quietFor < FIRST_AFTER_MS) { out.skipped++; continue; }
      const key = p.email.trim().toLowerCase();
      if (alreadyEmailed.has(key)) { out.skipped++; continue; }
      alreadyEmailed.add(key);   // claim it before sending, so a second row in THIS run is skipped
      const mail = firstEmail(p.businessName, first);
      if (opts.dryRun) { out.first++; console.log(`[ABANDONED] would send #1 to ${p.email} (${p.businessName})`); continue; }
      const sent = await sendEmail({ to: [p.email], subject: mail.subject, html: mail.html, text: mail.text });
      if (!sent) { console.warn(`[ABANDONED] send #1 FAILED for ${p.businessName}`); continue; }
      await prisma.pendingSignup.update({ where: { id: p.id }, data: { abandonedEmail1At: new Date() } });
      out.first++;
      console.log(`[ABANDONED] #1 sent to ${p.email} (${p.businessName})`);
      continue;   // never both in one pass
    }

    if (!p.abandonedEmail2At) {
      if (now - p.abandonedEmail1At.getTime() < SECOND_AFTER_MS) { out.skipped++; continue; }
      const mail = secondEmail(p.businessName, first);
      if (opts.dryRun) { out.second++; console.log(`[ABANDONED] would send #2 to ${p.email} (${p.businessName})`); continue; }
      const sent = await sendEmail({ to: [p.email], subject: mail.subject, html: mail.html, text: mail.text });
      if (!sent) { console.warn(`[ABANDONED] send #2 FAILED for ${p.businessName}`); continue; }
      await prisma.pendingSignup.update({ where: { id: p.id }, data: { abandonedEmail2At: new Date() } });
      out.second++;
      console.log(`[ABANDONED] #2 sent to ${p.email} (${p.businessName})`);
    }
  }
  return out;
}

export const _test = { firstEmail, secondEmail, isRealEmail, isOurTestAddress, FIRST_AFTER_MS, SECOND_AFTER_MS, MAX_AGE_MS };
