// Script to check booking intent calls in the last 7 days
// This analyzes the same data that the observability dashboard uses

const https = require('https');

// Garage ID provided
const GARAGE_ID = 'd51dfa55-15d0-4d60-ad81-c675579d16f6';
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''; // Will need to be provided

const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

const options = {
  hostname: 'portal.receptionmate.ai',
  path: `/api/calls?garageId=${GARAGE_ID}&startDate=${sevenDaysAgo.toISOString()}`,
  method: 'GET',
  headers: {
    'Cookie': `session-token=${SESSION_TOKEN}`,
    'Content-Type': 'application/json'
  }
};

console.log('Fetching calls from the last 7 days...\n');

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const calls = JSON.parse(data);
      console.log(`Total calls retrieved: ${calls.length}\n`);

      // Apply the same booking intent logic as the dashboard
      let bookingIntentCount = 0;
      let completedBookingsCount = 0;
      const bookingIntentCalls = [];

      calls.forEach(call => {
        const callToolCalls = call.metrics?.tool_calls || [];
        const hasCreateJobAttempt = callToolCalls.some(tc => tc.tool_name === 'create_job');
        const hasBookingIntent = hasCreateJobAttempt ||
                                 call.intent?.toLowerCase().includes('book') || 
                                 call.intent?.toLowerCase().includes('appointment') ||
                                 call.intent?.toLowerCase().includes('schedule');

        if (hasBookingIntent) {
          bookingIntentCount++;
          
          // Check if booking was completed
          const createJobCalls = callToolCalls.filter(tc => tc.tool_name === 'create_job');
          const hasSuccessfulBooking = createJobCalls.some(tc => 
            tc.result && tc.result.success === true
          );
          
          if (hasSuccessfulBooking) {
            completedBookingsCount++;
          }

          bookingIntentCalls.push({
            id: call.id,
            created_at: call.created_at,
            phone_number: call.phone_number,
            intent: call.intent,
            hasCreateJobAttempt,
            hasSuccessfulBooking,
            duration: call.duration
          });
        }
      });

      console.log('BOOKING INTENT ANALYSIS (Last 7 Days)');
      console.log('=====================================');
      console.log(`Calls with booking intent: ${bookingIntentCount}`);
      console.log(`Completed bookings: ${completedBookingsCount}`);
      console.log(`Abandoned bookings: ${bookingIntentCount - completedBookingsCount}`);
      
      if (bookingIntentCount > 0) {
        const conversionRate = (completedBookingsCount / bookingIntentCount * 100).toFixed(1);
        console.log(`Conversion rate: ${conversionRate}%\n`);
        
        console.log('BOOKING INTENT CALLS:');
        console.log('====================');
        bookingIntentCalls.forEach((call, idx) => {
          console.log(`${idx + 1}. Call ID: ${call.id}`);
          console.log(`   Date: ${new Date(call.created_at).toLocaleString()}`);
          console.log(`   Phone: ${call.phone_number || 'N/A'}`);
          console.log(`   Intent: ${call.intent || 'N/A'}`);
          console.log(`   Had create_job attempt: ${call.hasCreateJobAttempt}`);
          console.log(`   Booking completed: ${call.hasSuccessfulBooking}`);
          console.log(`   Duration: ${call.duration}s\n`);
        });
      } else {
        console.log('\nNo calls with booking intent found in the last 7 days.');
      }

    } catch (error) {
      console.error('Error parsing response:', error.message);
      console.log('Raw response:', data.substring(0, 500));
    }
  });
});

req.on('error', (error) => {
  console.error('Request error:', error.message);
});

req.end();
