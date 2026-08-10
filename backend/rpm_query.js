const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const garages = await prisma.garage.findMany({
      where: {
        OR: [
          { name: { contains: 'RPM', mode: 'insensitive' } },
          { name: { contains: 'Malvern', mode: 'insensitive' } }
        ]
      },
      select: { id: true, name: true }
    });
    console.log('RPM garages:', JSON.stringify(garages));

    for (const g of garages) {
      const calls = await prisma.call.findMany({
        where: {
          garageId: g.id,
          feedback: { isNot: null }
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, callId: true, customerName: true, summary: true,
          feedback: true, createdAt: true, transcript: true
        }
      });

      const negatives = calls.filter(c => {
        const fb = c.feedback;
        return fb && typeof fb === 'object' && fb.rating === 'down';
      });

      console.log('Negatives:', negatives.length);
      for (const c of negatives) {
        const fb = c.feedback;
        console.log('---');
        console.log('Call ID:', c.callId);
        console.log('Date:', c.createdAt);
        console.log('Customer:', c.customerName || 'null');
        console.log('Notes:', fb.notes || 'NONE');
        console.log('Reasons:', JSON.stringify(fb.reasons || []));
        console.log('Summary:', (c.summary || '').substring(0, 400));
        const t = c.transcript;
        if (t && typeof t === 'string') {
          console.log('TRANSCRIPT_START');
          console.log(t.substring(0, 3000));
          console.log('TRANSCRIPT_END');
        } else if (t && Array.isArray(t)) {
          console.log('TRANSCRIPT_START');
          console.log(JSON.stringify(t).substring(0, 3000));
          console.log('TRANSCRIPT_END');
        } else {
          console.log('No transcript');
        }
      }
    }

    await prisma.$disconnect();
  } catch(e) {
    console.error(e.message);
    await prisma.$disconnect();
  }
})();
