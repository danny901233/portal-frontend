import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function getCall(callId: string) {
  try {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      include: {
        feedback: true,
        garage: true,
      },
    });

    if (!call) {
      console.log(`Call ${callId} not found`);
      return;
    }

    console.log('\n=== CALL LOG ===');
    console.log('Call ID:', call.id);
    console.log('Garage:', call.garage.name);
    console.log('Room Name:', call.roomName);
    console.log('Duration:', call.durationSeconds, 'seconds');
    console.log('Call Type:', call.callType);
    console.log('Customer Name:', call.customerName || 'N/A');
    console.log('Customer Phone:', call.customerPhone || 'N/A');
    console.log('Registration:', call.registrationNumber || 'N/A');
    console.log('Confirmed Booking:', call.confirmedBooking);
    console.log('Booking Category:', call.confirmedBookingCategory || 'N/A');
    console.log('Revenue:', call.capturedRevenue ? `£${call.capturedRevenue.toFixed(2)}` : 'N/A');
    console.log('Created:', call.createdAt.toISOString());
    console.log('Recording URL:', call.recordingUrl || 'N/A');

    console.log('\n=== SUMMARY ===');
    console.log(call.summary);

    console.log('\n=== METRICS ===');
    console.log(JSON.stringify(call.metrics, null, 2));

    console.log('\n=== TRANSCRIPT ===');
    const transcript = Array.isArray(call.transcript) ? call.transcript : [];
    transcript.forEach((entry: any, i: number) => {
      console.log(`${i + 1}. [${entry.speaker || 'Unknown'}] ${entry.text || ''}`);
    });

    if (call.emotionData) {
      console.log('\n=== EMOTION DATA ===');
      console.log(JSON.stringify(call.emotionData, null, 2));
    }

    if (call.feedback) {
      console.log('\n=== FEEDBACK ===');
      console.log('Rating:', call.feedback.rating);
      console.log('Reasons:', call.feedback.reasons);
      console.log('Notes:', call.feedback.notes || 'N/A');
    }

  } catch (error) {
    console.error('Error fetching call:', error);
  } finally {
    await prisma.$disconnect();
  }
}

const callId = process.argv[2];
if (!callId) {
  console.error('Please provide a call ID');
  process.exit(1);
}

getCall(callId);
