/**
 * Repair local template rows from Meta, which is the source of truth.
 *
 * Editing a template nulls metaTemplateId and sets status draft, on the assumption it will be
 * resubmitted. For a template Meta has already approved, resubmission is refused ("Content in
 * this language already exists") and the error handler marks it rejected — so the row ends up
 * rejected with no Meta id, while the real template is still live and approved. Sync cannot fix
 * it because sync looks the template up BY id.
 *
 * This looks them up by name instead and puts the id and status back.
 *
 * Dry run by default. Pass --apply to write.
 */
import { PrismaClient } from '@prisma/client';
import { getTemplateToken } from '../dist/services/metaTemplateToken.js';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

const garage = await prisma.garage.findFirst({
  where: { name: { contains: 'Great Hollands', mode: 'insensitive' } },
  select: { id: true, name: true },
});
const connection = await prisma.socialMediaConnection.findFirst({
  where: { garageId: garage.id, platform: 'whatsapp', isActive: true },
  select: { accessToken: true, pageId: true, whatsappPhoneNumberId: true },
});
const wabaId = connection?.pageId;
const token = getTemplateToken() || connection?.accessToken;
if (!wabaId || !token) {
  console.error('  no WABA id or token available');
  process.exit(1);
}
console.log(`  garage: ${garage.name}\n  waba:   ${wabaId}\n  mode:   ${APPLY ? 'APPLY' : 'dry run'}\n`);

const templates = await prisma.messageTemplate.findMany({
  where: { garageId: garage.id },
  select: { id: true, name: true, language: true, status: true, metaTemplateId: true },
  orderBy: { name: 'asc' },
});

for (const t of templates) {
  const url = `https://graph.facebook.com/v18.0/${wabaId}/message_templates?name=${encodeURIComponent(t.name)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) {
    console.log(`  ${t.name.padEnd(46)} META ERROR ${j?.error?.message || r.status}`);
    continue;
  }
  // Meta name-filters loosely, so match exactly on name and language.
  const match = (j.data || []).find(
    (m) => m.name === t.name && (!t.language || m.language === t.language),
  );
  if (!match) {
    console.log(`  ${t.name.padEnd(46)} not at Meta — leaving as ${t.status}`);
    continue;
  }
  const metaStatus = String(match.status || '').toLowerCase();
  const needsFix = t.metaTemplateId !== match.id || t.status !== metaStatus;
  console.log(
    `  ${t.name.padEnd(46)} local=${t.status.padEnd(8)} meta=${metaStatus.padEnd(8)}` +
      `${needsFix ? `  → FIX (id ${match.id})` : '  ok'}`,
  );
  if (needsFix && APPLY) {
    await prisma.messageTemplate.update({
      where: { id: t.id },
      data: {
        metaTemplateId: match.id,
        status: metaStatus,
        rejectionReason: metaStatus === 'rejected' ? match.rejected_reason || 'Rejected by Meta' : null,
      },
    });
  }
}

console.log(APPLY ? '\n  applied.' : '\n  dry run — pass --apply to write.');
await prisma.$disconnect();
