// End-of-day report for the ops task board.
//
// Snapshot, not a live query: the report is built once at 21:00 Europe/London and stored, so it
// stays true to that day even after tasks are renamed, reassigned, reset or deleted. The daily
// reset in particular clears completedAt on every daily task, which is why completions are read
// from OpsTaskCompletion rather than from the tasks themselves.
//
// Emailed to RM staff the same evening. Re-running for a date overwrites that date's row, which
// makes a manual re-run safe.

import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';

const TZ = 'Europe/London';

export interface DailyReportPayload {
  reportDate: string;
  completed: Array<{ title: string; cadence: string; by: string; at: string; notes?: string }>;
  outstanding: Array<{ title: string; cadence: string; assignees: string; dueDate: string | null }>;
  notes: Array<{ title: string; note: string }>;
  totals: { completed: number; outstanding: number; byPerson: Record<string, number> };
}

/** 'YYYY-MM-DD' for a moment, in UK local time rather than UTC. */
export function ukDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** The UTC instants bounding a UK calendar day — correct across BST/GMT. */
function ukDayBounds(dateStr: string): { start: Date; end: Date } {
  // Probe midday to find the day's UTC offset, then derive midnight from it.
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const local = new Date(probe.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = local.getTime() - utc.getTime();
  const start = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function timeOfDay(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit',
  }).format(d);
}

const DISPLAY_NAMES: Record<string, string> = {
  'admin@receptionmate.ai': 'Gab',
  'dan@receptionmate.co.uk': 'Dan',
};

function displayName(email: string): string {
  return DISPLAY_NAMES[email.toLowerCase()] ?? email.split('@')[0];
}

export async function buildDailyReport(dateStr: string): Promise<DailyReportPayload> {
  const { start, end } = ukDayBounds(dateStr);

  const staff = await prisma.user.findMany({
    where: { role: 'RECEPTIONMATE_STAFF' },
    select: { id: true, email: true },
  });
  const nameById = new Map(staff.map((s) => [s.id, displayName(s.email)]));

  const completions = await prisma.opsTaskCompletion.findMany({
    where: { completedAt: { gte: start, lt: end } },
    orderBy: { completedAt: 'asc' },
  });

  const completed = completions.map((c) => ({
    title: c.taskTitle,
    cadence: c.cadence,
    by: c.completedById ? (nameById.get(c.completedById) ?? 'Unknown') : 'Unknown',
    at: timeOfDay(c.completedAt),
    ...(c.notes ? { notes: c.notes } : {}),
  }));

  const byPerson: Record<string, number> = {};
  for (const c of completed) byPerson[c.by] = (byPerson[c.by] || 0) + 1;

  // Still open at the moment the report runs. Project tasks are excluded — they are long-running
  // by nature and would swamp the list every single night.
  const openTasks = await prisma.opsTask.findMany({
    where: { status: 'open', cadence: { in: ['daily', 'weekly', 'monthly'] } },
    orderBy: [{ cadence: 'asc' }, { sortOrder: 'asc' }],
  });

  const outstanding = openTasks.map((t) => ({
    title: t.title,
    cadence: t.cadence,
    assignees: (t.assigneeIds?.length ? t.assigneeIds : t.assigneeId ? [t.assigneeId] : [])
      .map((id) => nameById.get(id) ?? 'Unknown').join(' & ') || 'Unassigned',
    dueDate: t.dueDate ? ukDateString(t.dueDate) : null,
  }));

  // Notes on tasks touched today that are NOT already covered by a completion above — so context
  // Gab left on something still open doesn't get lost.
  const completedTaskIds = new Set(completions.map((c) => c.taskId).filter(Boolean) as string[]);
  const touched = await prisma.opsTask.findMany({
    where: { updatedAt: { gte: start, lt: end }, NOT: { notes: null } },
    select: { id: true, title: true, notes: true },
  });
  const notes = touched
    .filter((t) => !completedTaskIds.has(t.id) && (t.notes || '').trim().length > 0)
    .map((t) => ({ title: t.title, note: (t.notes || '').trim() }));

  return {
    reportDate: dateStr,
    completed,
    outstanding,
    notes,
    totals: { completed: completed.length, outstanding: outstanding.length, byPerson },
  };
}

function reportText(r: DailyReportPayload): string {
  const lines = [`Ops board — ${r.reportDate}`, ''];
  lines.push(`Completed (${r.totals.completed}):`);
  lines.push(...(r.completed.length
    ? r.completed.map((c) => `  - ${c.title} — ${c.by} at ${c.at}${c.notes ? ` — ${c.notes}` : ''}`)
    : ['  (nothing)']));
  lines.push('', `Still outstanding (${r.totals.outstanding}):`);
  lines.push(...(r.outstanding.length
    ? r.outstanding.map((o) => `  - ${o.title} (${o.cadence}) — ${o.assignees}${o.dueDate ? ` — due ${o.dueDate}` : ''}`)
    : ['  (nothing)']));
  if (r.notes.length) {
    lines.push('', 'Notes added today:');
    lines.push(...r.notes.map((n) => `  - ${n.title}: ${n.note}`));
  }
  lines.push('', 'Past reports: https://portal.receptionmate.co.uk/admin/reports');
  return lines.join('\n');
}

/** Exported so the rendered email can be previewed without sending one. */
export function reportHtml(r: DailyReportPayload): string {
  const esc = (s: string) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const pretty = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(`${r.reportDate}T12:00:00Z`));

  const perPerson = Object.entries(r.totals.byPerson)
    .map(([n, c]) => `${esc(n)} ${c}`).join(' &middot; ') || 'nobody';

  // One block per task rather than a row of four columns. A four-column table cannot shrink below
  // the width of its own content, so on a phone it either overflowed sideways or the client zoomed
  // the whole message out to fit. Stacked blocks reflow at any width, and need no media queries —
  // which matters because several clients strip <style> blocks entirely.
  const SEP = 'border-bottom:1px solid #eceff1';
  const TITLE = 'font-size:15px;line-height:1.4;color:#111827;word-break:break-word';
  const META = 'font-size:13px;line-height:1.4;color:#6b7280;margin-top:3px;word-break:break-word';
  const EMPTY = 'font-size:14px;color:#9ca3af;padding:10px 0;margin:0';
  const H3 = 'margin:26px 0 4px;font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em';

  const dot = ' &middot; ';

  const completedRows = r.completed.length
    ? r.completed.map((c) => `
        <div style="padding:11px 0;${SEP}">
          <div style="${TITLE}">${esc(c.title)}</div>
          <div style="${META}">${esc(c.by)}${dot}${esc(c.at)}${dot}${esc(c.cadence)}</div>
          ${c.notes ? `<div style="${META};font-style:italic;color:#4b5563">${esc(c.notes)}</div>` : ''}
        </div>`).join('')
    : `<p style="${EMPTY}">Nothing was ticked off today.</p>`;

  const outstandingRows = r.outstanding.length
    ? r.outstanding.map((o) => `
        <div style="padding:11px 0;${SEP}">
          <div style="${TITLE}">${esc(o.title)}</div>
          <div style="${META}">${esc(o.assignees)}${dot}${esc(o.cadence)}${o.dueDate ? `${dot}due ${esc(o.dueDate)}` : ''}</div>
        </div>`).join('')
    : `<p style="${EMPTY}">Nothing outstanding.</p>`;

  const notesBlock = r.notes.length
    ? `<h3 style="${H3}">Notes added today</h3>
       ${r.notes.map((n) => `
        <div style="padding:11px 0;${SEP}">
          <div style="${TITLE}">${esc(n.title)}</div>
          <div style="${META}">${esc(n.note)}</div>
        </div>`).join('')}`
    : '';

  // Full document with a viewport meta, matching every other template in utils/email.ts. Without
  // it iOS Mail and Gmail assume a desktop-width page and zoom the whole message out.
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f4f6f8;">
    <tr><td style="padding:16px 12px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:10px;">
        <tr><td style="padding:22px 20px;">
          <h2 style="margin:0 0 2px;font-size:18px;line-height:1.3;color:#111827;">Ops board</h2>
          <p style="margin:0;font-size:14px;color:#6b7280;">${esc(pretty)}</p>
          <p style="margin:14px 0 0;font-size:14px;line-height:1.5;color:#374151;">
            <strong style="color:#111827;">${r.totals.completed} completed</strong> (${perPerson})<br>
            <strong style="color:#111827;">${r.totals.outstanding} still open</strong>
          </p>

          <h3 style="${H3};margin-top:22px">Completed</h3>
          ${completedRows}

          <h3 style="${H3}">Still outstanding</h3>
          ${outstandingRows}

          ${notesBlock}

          <p style="margin:26px 0 0;font-size:13px;color:#9ca3af;">
            <a href="https://portal.receptionmate.co.uk/admin/reports" style="color:#6b7280;">View past reports</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Build, store and email the report for a date (defaults to today, UK).
 * Upsert keyed on the date, so a re-run replaces rather than duplicates.
 */
export async function runDailyReport(dateStr: string = ukDateString()): Promise<DailyReportPayload> {
  const payload = await buildDailyReport(dateStr);

  await prisma.opsDailyReport.upsert({
    where: { reportDate: dateStr },
    create: {
      reportDate: dateStr,
      completed: payload.completed as any,
      outstanding: payload.outstanding as any,
      notes: payload.notes as any,
      totals: payload.totals as any,
    },
    update: {
      completed: payload.completed as any,
      outstanding: payload.outstanding as any,
      notes: payload.notes as any,
      totals: payload.totals as any,
    },
  });
  console.log(`[OPS_REPORT] ${dateStr}: ${payload.totals.completed} completed, ${payload.totals.outstanding} outstanding`);

  // Named recipients rather than "everyone with a staff role" — same reasoning as the arrears
  // report: a role-derived list means anyone added as staff silently starts receiving internal
  // operational detail. Unset falls back to all staff and warns, so an unconfigured environment
  // still gets its report instead of quietly sending it nowhere.
  const configuredOps = (process.env.OPS_REPORT_EMAILS || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  let to: string[];
  if (configuredOps.length) {
    to = configuredOps;
  } else {
    const staff = await prisma.user.findMany({
      where: { role: 'RECEPTIONMATE_STAFF' },
      select: { email: true },
    });
    to = staff.map((s) => s.email).filter(Boolean) as string[];
    console.warn('[OPS_REPORT] OPS_REPORT_EMAILS is not set — falling back to all staff accounts');
  }
  if (to.length) {
    const sent = await sendEmail({
      to,
      subject: `Ops board — ${dateStr} — ${payload.totals.completed} done, ${payload.totals.outstanding} open`,
      html: reportHtml(payload),
      text: reportText(payload),
    });
    if (sent) {
      await prisma.opsDailyReport.update({
        where: { reportDate: dateStr },
        data: { emailedAt: new Date() },
      });
      console.log(`[OPS_REPORT] emailed to ${to.join(', ')}`);
    } else {
      console.warn('[OPS_REPORT] email not sent — check Mailgun/O365 config');
    }
  }

  return payload;
}
