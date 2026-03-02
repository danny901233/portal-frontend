import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function updateCall() {
  const callId = '28780021';
  
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: {
      id: true,
      confirmedBooking: true,
      confirmedBookingCategory: true,
      summary: true,
      garage: {
        select: {
          name: true
        }
      }
    }
  });

  if (!call) {
    console.log('❌ Call not found');
    await prisma.$disconnect();
    return;
  }

  console.log('📞 Current call status:');
  console.log(`Garage: ${call.garage.name}`);
  console.log(`Confirmed Booking: ${call.confirmedBooking}`);
  console.log(`Category: ${call.confirmedBookingCategory || 'none'}`);
  console.log(`Summary: ${call.summary.substring(0, 100)}...\n`);

  const summary = call.summary.toLowerCase();
  let category: 'service' | 'mot' | 'diagnostic' | 'other' = 'service';
  
  if (summary.includes('mot')) {
    category = 'mot';
  } else if (summary.includes('diagnostic') || summary.includes('check')) {
    category = 'diagnostic';
  } else if (summary.includes('service')) {
    category = 'service';
  } else {
    category = 'other';
  }

  const updated = await prisma.call.update({
    where: { id: callId },
    data: {
      confirmedBooking: true,
      confirmedBookingCategory: category
    }
  });

  console.log('✅ Call updated to confirmed booking');
  console.log(`Category: ${updated.confirmedBookingCategory}`);

  await prisma.$disconnect();
}

updateCall();
