import { prisma } from '../db.js';

/**
 * "Your Assist agent is live" — the email a garage gets when their voice agent is set up and
 * answering, and what happens next.
 *
 * Written for Kestrels moving from Connect to Assist, but built from the garage's own record
 * rather than hard-coded, so it serves the next one too. Everything stated here is read from the
 * database — the number, the price, the trial date, the allowance — because a welcome email that
 * quotes the wrong figure is worse than no welcome email.
 */

const LOGO = 'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';
const BRAND = '#3426cf';
const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

function money(n: number): string {
  return n % 1 === 0 ? `£${n}` : `£${n.toFixed(2)}`;
}

/** +441787323885 -> 01787 323885, which is how a customer will actually read it. */
function prettyNumber(e164: string | null): string {
  if (!e164) return '';
  const digits = e164.replace(/[^\d]/g, '').replace(/^44/, '0');
  return digits.length === 11 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : e164;
}

/**
 * Trial end dates are stored as end-of-day UTC (23:59:59), so formatting them in London time
 * during BST rolls them to the next day — Kestrels' trial ending 2 September rendered as the 3rd.
 * Format in UTC so the customer is told the date the value actually means.
 */
function dateLong(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export async function buildAssistWelcomeEmail(garageId: string): Promise<{
  to: string | null; subject: string; html: string; text: string;
} | null> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT g.name, g."twilioNumber", g."trialEndDate", g."subscriptionCostGbp"::float AS cost,
           g."includedMinutes", g."costPerMinuteGbp"::float AS ppm,
           ac."emailAddress", b."contactEmail",
           COALESCE(jsonb_array_length(ac.faqs), 0)::int AS faqs
    FROM "Garage" g
    LEFT JOIN "AgentConfiguration" ac ON ac."garageId" = g.id
    LEFT JOIN "Business" b ON b.id = g."businessId"
    WHERE g.id = $1`, garageId);
  const g = rows[0];
  if (!g) return null;

  const name = String(g.name);
  const number = prettyNumber(g.twilioNumber as string | null);
  const trialEnd = g.trialEndDate ? dateLong(new Date(g.trialEndDate as string)) : null;
  const cost = Number(g.cost || 0);
  const minutes = Number(g.includedMinutes || 0);
  const ppm = Number(g.ppm || 0);
  const faqs = Number(g.faqs || 0);
  const to = (g.contactEmail || g.emailAddress) as string | null;

  const priceLine = cost > 0
    ? `${money(cost)} + VAT a month, including ${minutes} minutes of calls${ppm > 0 ? `, then ${money(ppm)} a minute` : ''}.`
    : '';

  const html = `
<div style="margin:0;padding:24px 12px;background:#f8fafc;font-family:Inter,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
    <div style="padding:28px 32px 0;">
      <img src="${LOGO}" alt="ReceptionMate" style="height:34px;display:block;" />
    </div>

    <div style="padding:24px 32px 32px;color:#0f172a;">
      <h1 style="margin:0 0 6px;font-size:21px;line-height:1.3;color:${BRAND};">Your Assist agent is live</h1>
      <p style="margin:0 0 18px;color:#475569;font-size:15px;line-height:1.6;">
        Hi ${name} — you're all set up on Assist. Your agent is answering now, so there's nothing
        else you need to do to get going.
      </p>

      ${number ? `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin:0 0 18px;background:#f8fafc;">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin-bottom:4px;">Your ReceptionMate number</div>
        <div style="font-size:19px;font-weight:600;color:#0f172a;">${number}</div>
        <div style="font-size:13px;color:#64748b;margin-top:6px;">Forward your garage line here when you can't get to the phone — after a few rings, or out of hours.</div>
      </div>` : ''}

      <h2 style="margin:22px 0 8px;font-size:15px;color:#0f172a;">What your agent does</h2>
      <p style="margin:0 0 6px;color:#475569;font-size:14px;line-height:1.65;">
        It answers in your name, takes the caller's details and what they need, and sends it
        straight to you — so a missed call becomes a message instead of a lost customer. It knows
        your opening hours, where you are${faqs > 0 ? `, and the ${faqs} questions we set up from your website — including your car sales, part-exchange and finance` : ''}.
      </p>
      <p style="margin:0 0 6px;color:#475569;font-size:14px;line-height:1.65;">
        It won't book into your diary or quote a price it isn't sure of. Anything like that comes
        to you to confirm.
      </p>

      <h2 style="margin:22px 0 8px;font-size:15px;color:#0f172a;">Your trial</h2>
      <p style="margin:0 0 6px;color:#475569;font-size:14px;line-height:1.65;">
        ${trialEnd ? `You're on a 14-day trial that runs until <strong>${trialEnd}</strong>. ` : ''}
        ${priceLine ? `After that it's ${priceLine} ` : ''}Add your card in the portal whenever
        suits and it'll carry on without a break — nothing is taken during the trial.
      </p>

      <p style="text-align:center;margin:26px 0 8px;">
        <a href="${PORTAL_URL}/dashboard" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:10px;font-weight:600;font-size:15px;">Open my portal</a>
      </p>
      <p style="margin:0 0 18px;color:#94a3b8;font-size:13px;text-align:center;">
        Listen back to every call, read the messages taken, and change what your agent says.
      </p>

      <div style="border-top:1px solid #e2e8f0;margin-top:22px;padding-top:16px;">
        <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">
          Anything not sounding right, or you'd like it to say something differently? Just reply to
          this email and we'll sort it.
        </p>
        <p style="margin:12px 0 0;color:#64748b;font-size:13px;">— The ReceptionMate team</p>
      </div>
    </div>
  </div>
</div>`;

  const text = [
    `Your Assist agent is live`,
    ``,
    `Hi ${name} — you're all set up on Assist. Your agent is answering now.`,
    number ? `\nYour ReceptionMate number: ${number}` : '',
    `Forward your garage line here when you can't get to the phone — after a few rings, or out of hours.`,
    ``,
    `It answers in your name, takes the caller's details and what they need, and sends it to you.`,
    faqs > 0 ? `It knows your hours, where you are, and the ${faqs} questions we set up from your website, including car sales, part-exchange and finance.` : '',
    `It won't book into your diary or quote a price it isn't sure of.`,
    ``,
    trialEnd ? `Your 14-day trial runs until ${trialEnd}.` : '',
    priceLine ? `After that it's ${priceLine}` : '',
    `Add your card in the portal whenever suits — nothing is taken during the trial.`,
    ``,
    `${PORTAL_URL}/dashboard`,
    ``,
    `Anything not sounding right? Just reply to this email.`,
    `— The ReceptionMate team`,
  ].filter(Boolean).join('\n');

  return { to, subject: `${name} — your ReceptionMate agent is live`, html, text };
}
