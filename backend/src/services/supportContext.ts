// Builds a compact Markdown snapshot of a portal user's account + agent
// configuration. Fed to the support AI as context so it can give
// personalised, factual answers instead of generic ones.

import { prisma } from '../db.js';

// One-line summary of weekly opening hours — terse so the AI can reason
// without burning tokens on JSON.
function summariseHours(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not set';
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const parts: string[] = [];
  for (const day of days) {
    const v = (raw as Record<string, unknown>)[day] as
      | { open?: string | null; close?: string | null; closed?: boolean }
      | undefined;
    if (!v) continue;
    if (v.closed || !v.open || !v.close) {
      parts.push(`${day[0].toUpperCase()}${day.slice(1, 3)}: closed`);
    } else {
      parts.push(`${day[0].toUpperCase()}${day.slice(1, 3)}: ${v.open}–${v.close}`);
    }
  }
  return parts.length ? parts.join(', ') : 'not set';
}

function fmtBool(b: boolean | null | undefined, yes = 'yes', no = 'no'): string {
  return b ? yes : no;
}

export async function buildUserContext(userId: string, selectedGarageId?: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      role: true,
      mustSetupPayment: true,
      gocardlessMandateId: true,
      nextBillingDate: true,
      garageAccessIds: true,
      setupWizardCompleted: true,
      mustSignAgreement: true,
      createdAt: true,
    },
  });
  if (!user) return '';

  // Resolve garage list. Priority:
  //   1. If the user has selected a specific branch in the portal, use that (always).
  //   2. Otherwise, list the branches in their garageAccessIds (up to 5).
  // We pull regardless of role so internal staff testing also see a snapshot.
  const isStaff = user.role === 'RECEPTIONMATE_STAFF';
  const garageIds = selectedGarageId
    ? [selectedGarageId]
    : (user.garageAccessIds ?? []);
  const garages = garageIds.length
    ? await prisma.garage.findMany({
        where: { id: { in: garageIds } },
        include: { agentConfiguration: true },
        orderBy: { name: 'asc' },
        take: 5,
      })
    : [];

  // Latest agreement state — they care about it during onboarding.
  const latestAgreement = await prisma.agreement.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { status: true, licences: true, licenceFeeGbp: true, centresCount: true },
  });

  // Tally calls in the last 7 days — useful for "how many calls did we handle?"
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const callsLast7d = garageIds.length
    ? await prisma.call.count({
        where: {
          garageId: { in: garageIds },
          createdAt: { gte: sevenDaysAgo },
        },
      })
    : 0;

  // -- Render --
  const lines: string[] = [];
  lines.push('## Account');
  lines.push(`- Email: ${user.email}`);
  lines.push(`- Role: ${user.role}${isStaff ? ' (internal RM staff)' : ''}`);
  lines.push(`- Account created: ${user.createdAt.toISOString().slice(0, 10)}`);
  lines.push(`- Direct Debit set up: ${user.gocardlessMandateId ? 'yes' : 'no — pending /setup-payment'}`);
  if (user.nextBillingDate) {
    lines.push(`- Next billing date: ${user.nextBillingDate.toISOString().slice(0, 10)}`);
  }
  lines.push(`- Setup wizard completed: ${fmtBool(user.setupWizardCompleted)}`);
  lines.push(
    `- Number of branches they manage: ${
      isStaff ? 'all (staff)' : String((user.garageAccessIds ?? []).length)
    }`,
  );
  if (selectedGarageId) {
    lines.push(`- Currently viewing branch ID: ${selectedGarageId}`);
  }

  if (latestAgreement) {
    lines.push('');
    lines.push('## Service agreement');
    lines.push(`- Status: ${latestAgreement.status}`);
    lines.push(`- Licences: ${latestAgreement.licences.join(', ')}`);
    lines.push(`- Licence fee: £${latestAgreement.licenceFeeGbp}/centre/mo`);
    lines.push(`- Centres on this agreement: ${latestAgreement.centresCount}`);
  }

  if (garages.length) {
    lines.push('');
    lines.push(`## Recent activity`);
    lines.push(`- Calls in the last 7 days (across all their branches): ${callsLast7d}`);

    lines.push('');
    lines.push('## Branches (with agent setup)');
    for (const g of garages) {
      const c = g.agentConfiguration;
      lines.push('');
      lines.push(`### ${g.name}`);
      lines.push(`- Garage ID: ${g.id}`);
      lines.push(`- Twilio number: ${g.twilioNumber ?? 'not set'}`);
      if (!c) {
        lines.push(`- Agent configuration: NOT SET UP YET — they haven't been through agent-setup`);
        continue;
      }
      lines.push(`- Agent type: ${c.agentType} (${c.agentScript})`);
      lines.push(`- Voice: ${c.voice}, tone: ${c.tonePreference}`);
      lines.push(`- Greeting line: ${c.greetingLine ? `"${c.greetingLine.slice(0, 200)}"` : 'NOT SET (uses default greeting)'}`);
      lines.push(`- Opening hours: ${summariseHours(c.weeklyOpeningHours)}`);
      lines.push(`- Holiday closures noted: ${c.holidayClosures ? 'yes' : 'no'}`);
      lines.push(`- Bookings allowed: ${fmtBool(c.allowBookings)}; lead time: ${c.bookingLeadTimeDays} day(s)`);
      lines.push(`- Drop-off bookings: ${fmtBool(c.enableDropOffBookings)}`);
      lines.push(`- Fast-fit only: ${fmtBool(c.allowFastFitOnly)}`);
      lines.push(`- Transfer / escalation number: ${c.transferNumber ? c.transferNumber : 'NOT SET (no fallback for calls the agent can\'t handle)'}`);
      lines.push(`- Human escalation enabled: ${fmtBool(c.humanEscalation, 'yes', 'no')}`);
      lines.push(`- SMS booking links: ${fmtBool(c.enableSmsBookingLinks)}`);
      lines.push(`- Integration provider: ${c.integrationProvider}`);
      lines.push(`- Notification emails: ${(c.notificationEmails ?? []).length} recipient(s)${(c.notificationEmails ?? []).length === 0 ? ' — NO-ONE WILL GET CALL SUMMARIES' : ''}`);
    }
  }

  return lines.join('\n');
}
