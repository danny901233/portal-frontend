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

function reportHtml(r: DailyReportPayload): string {
  const esc = (s: string) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const pretty = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(`${r.reportDate}T12:00:00Z`));

  const perPerson = Object.entries(r.totals.byPerson)
    .map(([n, c]) => `${esc(n)} ${c}`).join(' &middot; ') || 'nobody';

  const completedRows = r.completed.length
    ? r.completed.map((c) => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(c.title)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666">${esc(c.cadence)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(c.by)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666">${esc(c.at)}</td>
        </tr>${c.notes ? `<tr><td colspan="4" style="padding:2px 10px 8px;color:#555;font-style:italic">${esc(c.notes)}</td></tr>` : ''}`).join('')
    : `<tr><td colspan="4" style="padding:10px;color:#888">Nothing was ticked off today.</td></tr>`;

  const outstandingRows = r.outstanding.length
    ? r.outstanding.map((o) => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(o.title)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666">${esc(o.cadence)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(o.assignees)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666">${o.dueDate ? esc(o.dueDate) : ''}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="padding:10px;color:#888">Nothing outstanding.</td></tr>`;

  const notesBlock = r.notes.length
    ? `<h3 style="margin:22px 0 6px;font-size:15px">Notes added today</h3>
       ${r.notes.map((n) => `<p style="margin:0 0 8px"><strong>${esc(n.title)}</strong><br><span style="color:#555">${esc(n.note)}</span></p>`).join('')}`
    : '';

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;max-width:720px">
    <h2 style="margin:0 0 2px;font-size:18px">Ops board — ${esc(pretty)}</h2>
    <p style="margin:0 0 18px;color:#666;font-size:13px">
      ${r.totals.completed} completed (${perPerson}) &middot; ${r.totals.outstanding} still open
    </p>
    <h3 style="margin:0 0 6px;font-size:15px">Completed</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">${completedRows}</table>
    <h3 style="margin:22px 0 6px;font-size:15px">Still outstanding</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">${outstandingRows}</table>
    ${notesBlock}
    <p style="margin:24px 0 0;color:#888;font-size:12px">
      Past reports: https://portal.receptionmate.co.uk/admin/reports
    </p>
  </div>`;
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

  const staff = await prisma.user.findMany({
    where: { role: 'RECEPTIONMATE_STAFF' },
    select: { email: true },
  });
  const to = staff.map((s) => s.email).filter(Boolean);
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
