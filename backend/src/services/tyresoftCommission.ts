import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';

/**
 * Quarterly commission statement for Tyresoft.
 *
 * Tyresoft take 7.5% of what we invoice garages that run on their integration. This works that
 * out from what customers actually PAID in the quarter — not what was invoiced — because
 * commission on money we never collected would have to be clawed back later.
 *
 * Revenue is ex-VAT (the invoice subtotal). VAT is not ours and is not income.
 */

const COMMISSION_RATE = 0.075;
// Tyresoft are VAT registered, so the commission is invoiced to us plus VAT.
const VAT_RATE = 0.20;
const LOGO = 'https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png';
const BRAND = '#3426cf';

export interface CommissionLine {
  garage: string;
  invoices: number;
  exVat: number;      // pounds
}

export interface CommissionStatement {
  label: string;      // e.g. "Q2 2026"
  from: Date;
  to: Date;
  lines: CommissionLine[];
  totalExVat: number;
  commission: number;
  vat: number;
  gross: number;
}

/** The quarter that has just finished, relative to `when`. */
export function previousQuarter(when = new Date()): { from: Date; to: Date; label: string } {
  const q = Math.floor(when.getUTCMonth() / 3);          // 0-3, the quarter `when` is in
  const from = new Date(Date.UTC(when.getUTCFullYear(), (q - 1) * 3, 1));
  const to = new Date(Date.UTC(when.getUTCFullYear(), q * 3, 1));
  return { from, to, label: `Q${from.getUTCMonth() / 3 + 1} ${from.getUTCFullYear()}` };
}

export async function buildStatement(from: Date, to: Date, label: string): Promise<CommissionStatement> {
  // Test accounts are excluded: they are ours, nobody pays for them, and including a £0 line
  // would only invite a question about why it is there.
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; n: number; subtotal: bigint | null }>>(
    `SELECT g.name, COUNT(i.id)::int AS n, COALESCE(SUM(i.subtotal), 0)::bigint AS subtotal
     FROM "Garage" g
     JOIN "AgentConfiguration" ac ON ac."garageId" = g.id
     LEFT JOIN "Invoice" i ON i."garageId" = g.id
          AND i.status = 'paid'
          AND COALESCE(i."paidAt", i."createdAt") >= $1
          AND COALESCE(i."paidAt", i."createdAt") <  $2
     WHERE ac."agentScript" = 'tyresoft-agent' AND g."isTestAccount" = false
     GROUP BY g.name
     ORDER BY 3 DESC`,
    from, to,
  );

  const lines = rows
    .map((r) => ({ garage: r.name, invoices: Number(r.n), exVat: Number(r.subtotal ?? 0) / 100 }))
    .filter((l) => l.invoices > 0);
  const totalExVat = lines.reduce((s, l) => s + l.exVat, 0);
  return {
    label, from, to, lines,
    totalExVat,
    commission: round2(totalExVat * COMMISSION_RATE),
    vat: round2(totalExVat * COMMISSION_RATE * VAT_RATE),
    gross: round2(totalExVat * COMMISSION_RATE * (1 + VAT_RATE)),
  };
}

const money = (n: number) => `£${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
// Our registered identity — Tyresoft raise their invoice against these details.
const RM_LEGAL = {
  name: 'ReceptionMate Ltd',
  address: "Studio 9, 50–54 St. Paul's Square, Birmingham B3 1QS",
  companyNo: '16839506',
  vat: '494543753',
  email: 'hello@receptionmate.co.uk',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const day = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function statementHtml(s: CommissionStatement): string {
  const end = new Date(s.to.getTime() - 864e5);          // the `to` bound is exclusive
  const rows = s.lines.map((l) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${l.garage}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right">${l.invoices}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right">${money(l.exVat)}</td>
    </tr>`).join('');

  return `
<div style="margin:0;padding:24px 12px;background:#f8fafc;font-family:Inter,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
    <div style="background:${BRAND};padding:26px 32px;">
      <img src="${LOGO}" alt="ReceptionMate" style="height:90px;display:block;border:0;" />
    </div>
    <div style="padding:26px 32px 32px;color:#0f172a;">
      <h1 style="margin:0 0 4px;font-size:20px;color:${BRAND};">Tyresoft commission — ${s.label}</h1>
      <p style="margin:0 0 20px;color:#475569;font-size:14px;">${day(s.from)} to ${day(end)}</p>

      ${s.lines.length ? `
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="text-align:left;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.04em">
          <th style="padding:0 12px 8px">Garage</th>
          <th style="padding:0 12px 8px;text-align:right">Invoices paid</th>
          <th style="padding:0 12px 8px;text-align:right">Revenue (ex VAT)</th>
        </tr>
        ${rows}
        <tr>
          <td style="padding:10px 12px;font-weight:600">Total</td>
          <td></td>
          <td style="padding:10px 12px;text-align:right;font-weight:600">${money(s.totalExVat)}</td>
        </tr>
      </table>

      <div style="margin-top:22px;padding:16px 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;">Commission due at 7.5%</div>
        <div style="font-size:24px;font-weight:700;color:#0f172a;margin-top:4px;">${money(s.commission)}</div>
        <table style="margin-top:12px;font-size:14px;color:#475569;border-collapse:collapse;">
          <tr><td style="padding:2px 16px 2px 0;">VAT at 20%</td><td style="text-align:right;">${money(s.vat)}</td></tr>
          <tr><td style="padding:2px 16px 2px 0;font-weight:600;color:#0f172a;">Total to invoice</td><td style="text-align:right;font-weight:600;color:#0f172a;">${money(s.gross)}</td></tr>
        </table>
      </div>` : `
      <p style="color:#475569;font-size:14px;">No payments were received from Tyresoft-integrated garages in this quarter, so no commission is due.</p>`}

      <div style="margin-top:22px;padding:16px 18px;border:1px solid #e2e8f0;border-radius:10px;">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin-bottom:8px;">Please address your invoice to</div>
        <div style="font-size:14px;color:#0f172a;line-height:1.7;">
          <strong>${RM_LEGAL.name}</strong><br/>
          ${RM_LEGAL.address}<br/>
          Company no. ${RM_LEGAL.companyNo} &nbsp;·&nbsp; VAT no. ${RM_LEGAL.vat}<br/>
          <a href="mailto:${RM_LEGAL.email}" style="color:${BRAND};text-decoration:none;">${RM_LEGAL.email}</a>
        </div>
      </div>

      <p style="margin:22px 0 0;color:#64748b;font-size:13px;line-height:1.6;">
        Revenue is what the garage actually paid in the quarter, excluding VAT. Invoices raised but
        not yet settled are not included — they will appear in the quarter they are paid.
      </p>
      <p style="margin:14px 0 0;color:#64748b;font-size:13px;">
        Any questions, reply to this email or contact
        <a href="mailto:hello@receptionmate.co.uk" style="color:${BRAND};text-decoration:none;font-weight:600;">hello@receptionmate.co.uk</a>.
      </p>
      <p style="margin:16px 0 0;color:#64748b;font-size:13px;">— The ReceptionMate team</p>
    </div>
  </div>
</div>`;
}

export function statementText(s: CommissionStatement): string {
  const end = new Date(s.to.getTime() - 864e5);
  return [
    `Tyresoft commission — ${s.label}`,
    `${day(s.from)} to ${day(end)}`,
    '',
    ...s.lines.map((l) => `${l.garage}: ${l.invoices} invoice(s), ${money(l.exVat)} ex VAT`),
    '',
    `Total revenue (ex VAT): ${money(s.totalExVat)}`,
    `Commission due at 7.5%: ${money(s.commission)}`,
    `VAT at 20%: ${money(s.vat)}`,
    `Total to invoice: ${money(s.gross)}`,
    '',
    'Please address your invoice to:',
    `  ${RM_LEGAL.name}`,
    `  ${RM_LEGAL.address}`,
    `  Company no. ${RM_LEGAL.companyNo}  ·  VAT no. ${RM_LEGAL.vat}`,
    `  ${RM_LEGAL.email}`,
    '',
    'Revenue is what the garage actually paid in the quarter, excluding VAT.',
    `Questions: ${RM_LEGAL.email}`,
  ].join('\n');
}

/**
 * Send the statement for the quarter that has just ended.
 *
 * Recipients come from TYRESOFT_COMMISSION_EMAILS. With it unset the statement is NOT sent
 * anywhere — this goes to a third party and quotes a figure they will invoice against, so it
 * should never start emailing out because a cron happened to fire.
 */
export async function sendQuarterlyCommission(when = new Date()): Promise<CommissionStatement | null> {
  const { from, to, label } = previousQuarter(when);
  const statement = await buildStatement(from, to, label);

  const to_ = (process.env.TYRESOFT_COMMISSION_EMAILS || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  if (!to_.length) {
    console.warn(`[TYRESOFT_COMMISSION] ${label}: ${money(statement.totalExVat)} ex VAT, ` +
      `${money(statement.commission)} due — NOT SENT, TYRESOFT_COMMISSION_EMAILS is unset`);
    return statement;
  }

  const cc = (process.env.TYRESOFT_COMMISSION_CC || RM_LEGAL.email)
    .split(',').map((x) => x.trim()).filter(Boolean);

  await sendEmail({
    to: to_,
    cc,
    subject: `ReceptionMate — Tyresoft commission statement, ${label}`,
    html: statementHtml(statement),
    text: statementText(statement),
  });
  console.log(`[TYRESOFT_COMMISSION] ${label} sent to ${to_.join(', ')} — ${money(statement.commission)} due`);
  return statement;
}
