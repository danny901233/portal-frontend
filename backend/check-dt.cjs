const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  // Find ALL users with this email or close to it (might be multiple attempts)
  const users = await p.user.findMany({
    where: { email: { contains: 'dantyldesley', mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`Found ${users.length} user(s):`);
  for (const u of users) {
    console.log(`  id=${u.id} email=${u.email} createdAt=${u.createdAt.toISOString()}`);
  }

  // Find agreements signed/unsigned for this email
  const agreements = await p.agreement.findMany({
    where: { recipientEmail: { contains: 'dantyldesley', mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, recipientEmail: true, createdAt: true, signedAt: true, businessName: true },
  });
  console.log(`\nFound ${agreements.length} agreement(s):`);
  for (const a of agreements) {
    console.log(`  ${a.id}  status=${a.status}  business="${a.businessName}"  created=${a.createdAt.toISOString()}  signed=${a.signedAt?.toISOString() ?? '—'}`);
  }
  await p.$disconnect();
})();
