const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({
  datasources: { db: { url: 'postgresql://dan@localhost:15432/receptionmate?schema=public' } }
});

async function main() {
  const fb = await p.callFeedback.findUnique({
    where: { callId: '10921350' },
    include: {
      call: {
        select: {
          createdAt: true, customerName: true, customerPhone: true,
          registrationNumber: true, summary: true, callType: true,
          durationSeconds: true, transcript: true,
          garageId: true, garage: { select: { name: true } }
        }
      }
    }
  });
  if (!fb) { console.log('Feedback not found'); return; }
  const c = fb.call;
  console.log('Garage: ' + c?.garage?.name);
  console.log('Customer: ' + (c?.customerName || 'N/A') + ' | Phone: ' + (c?.customerPhone || 'N/A') + ' | Duration: ' + c?.durationSeconds + 's');
  console.log('Rating: ' + fb.rating + ' | Reasons: ' + JSON.stringify(fb.reasons));
  console.log('Notes: ' + (fb.notes || '(none)'));
  console.log('Summary: ' + (c?.summary || 'N/A'));
  let t = c?.transcript;
  if (t && typeof t === 'object') t = JSON.stringify(t, null, 2);
  console.log('\nFull Transcript:\n' + String(t || ''));
  await p.$disconnect();
}
main();
