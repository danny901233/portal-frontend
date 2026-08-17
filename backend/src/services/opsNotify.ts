// Alerts to staff that a task needs doing.
//
// DELIBERATELY CONTENT-FREE. These go to personal addresses — Gab is a VA on a personal Gmail —
// so they carry the task title and a link, and nothing else. No customer name, no phone number,
// no licence number, no hire dates. The detail stays behind a portal login, which is where it
// belongs: emailing a driving licence number to a Gmail account is the kind of thing the ICO
// registration on the board exists to take seriously.
//
// Address used is User.notificationEmail, falling back to User.email. That separation matters —
// the login stays a receptionmate address while alerts reach wherever the person actually reads.

import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';

const PORTAL = process.env.PORTAL_BASE_URL || 'https://portal.receptionmate.co.uk';

/**
 * Tell everyone assigned to a task that it needs doing.
 * Never throws — a failed alert must not roll back the work that triggered it.
 */
export async function notifyTaskAssignees(taskId: string): Promise<void> {
  try {
    const task = await prisma.opsTask.findUnique({ where: { id: taskId } });
    if (!task) return;

    const ids = task.assigneeIds?.length ? task.assigneeIds : task.assigneeId ? [task.assigneeId] : [];
    if (!ids.length) {
      console.log(`[OPS_NOTIFY] task ${taskId} has no assignee — nobody to tell`);
      return;
    }

    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, notificationEmail: true },
    });
    const to = users.map((u) => u.notificationEmail || u.email).filter(Boolean);
    if (!to.length) return;

    const urgent = task.priority === 'urgent';
    const link = `${PORTAL}/admin/tasks`;

    // Everything below is task metadata only. Do not add anything from the thing that triggered it.
    const subject = `${urgent ? '[URGENT] ' : ''}Task for you: ${task.title}`;
    const text = [
      urgent ? 'A task needs doing now.' : 'A task has been assigned to you.',
      '',
      task.title,
      '',
      `Open the board for the details: ${link}`,
      '',
      'Details are not included in this email on purpose — they may contain customer information.',
    ].join('\n');

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
      <p style="margin:0 0 12px">${urgent ? '<strong style="color:#b42318">A task needs doing now.</strong>' : 'A task has been assigned to you.'}</p>
      <p style="margin:0 0 16px;font-size:16px"><strong>${escapeHtml(task.title)}</strong></p>
      <p style="margin:0 0 16px"><a href="${link}" style="background:#1f6b3a;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Open the board</a></p>
      <p style="margin:0;color:#888;font-size:12px">Details are not included in this email on purpose — they may contain customer information.</p>
    </div>`;

    const sent = await sendEmail({ to, subject, text, html });
    console.log(`[OPS_NOTIFY] ${sent ? 'sent' : 'FAILED'} → ${to.join(', ')} — ${task.title}`);
  } catch (e: any) {
    console.error('[OPS_NOTIFY] failed:', e?.message);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}
