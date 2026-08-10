// Direct backend query for booking intent analysis
const https = require('https');
const http = require('http');

const GARAGE_ID = 'd51dfa55-15d0-4d60-ad81-c675579d16f6';

// Calculate 7 days ago
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

// Query the backend directly (no auth needed for garage calls query)
const options = {
  hostname: '18.171.230.217',
  port: 4000,
  path: `/api/calls?garageId=${GARAGE_ID}&startDate=${sevenDaysAgo.toISOString()}`,
  method: 'GET',
  headers: {
    'Content-Type': 'application/json'
  }
};

console.log('Fetching calls from the last 7 days...');
console.log(`Query URL: http://${options.hostname}:${options.port}${options.path}\n`);

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      const calls = response.calls || response;
      
      if (!Array.isArray(calls)) {
        console.error('Unexpected response format:', response);
        return;
      }

      console.log(`Total calls retrieved: ${calls.length}\n`);

      // Apply the same booking intent logic as the dashboard
      let bookingIntentCount = 0;
      let completedBookingsCount = 0;
      const bookingIntentCalls = [];
      
      // Track abandonment reasons
      const abandonmentReasons = {
        noTimeslots: 0,
        cost: 0,
        noMatchingService: 0,
        other: 0
      };

      calls.forEach(call => {
        // Check for booking intent using the same logic as the dashboard
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
          
          let abandonmentReason = null;
          
          if (!hasSuccessfulBooking) {
            // Analyze transcript for abandonment reason
            const transcript = JSON.stringify(call.transcript || '').toLowerCase();
            
            if (transcript.includes('no available') || 
                transcript.includes('no slots') || 
                transcript.includes('fully booked') ||
                transcript.includes('no appointment')) {
              abandonmentReason = 'noTimeslots';
              abandonmentReasons.noTimeslots++;
            } else if (transcript.includes('too expensive') || 
                       transcript.includes('cost') || 
                       transcript.includes('price') ||
                       transcript.includes('afford')) {
              abandonmentReason = 'cost';
              abandonmentReasons.cost++;
            } else if (transcript.includes('don\'t do') || 
                       transcript.includes('don\'t offer') || 
                       transcript.includes('no service') ||
                       transcript.includes('not available')) {
              abandonmentReason = 'noMatchingService';
              abandonmentReasons.noMatchingService++;
            } else {
              abandonmentReason = 'other';
              abandonmentReasons.other++;
            }
          } else {
            completedBookingsCount++;
          }

          bookingIntentCalls.push({
            id: call.id,
            created_at: call.created_at,
            phone_number: call.phone_number,
            intent: call.intent,
            hasCreateJobAttempt,
            hasSuccessfulBooking,
            abandonmentReason,
            duration: call.duration
          });
        }
      });

      console.log('═══════════════════════════════════════════════');
      console.log('  BOOKING INTENT ANALYSIS (Last 7 Days)');
      console.log('═══════════════════════════════════════════════\n');
      
      console.log(`📊 Total Calls: ${calls.length}`);
      console.log(`🎯 Calls with Booking Intent: ${bookingIntentCount}`);
      console.log(`✅ Completed Bookings: ${completedBookingsCount}`);
      console.log(`❌ Abandoned Bookings: ${bookingIntentCount - completedBookingsCount}`);
      
      if (bookingIntentCount > 0) {
        const conversionRate = (completedBookingsCount / bookingIntentCount * 100).toFixed(1);
        console.log(`📈 Conversion Rate: ${conversionRate}%\n`);
        
        if (bookingIntentCount - completedBookingsCount > 0) {
          console.log('ABANDONMENT BREAKDOWN:');
          console.log('─────────────────────');
          console.log(`  🕒 No Timeslots Available: ${abandonmentReasons.noTimeslots}`);
          console.log(`  💰 Cost Concerns: ${abandonmentReasons.cost}`);
          console.log(`  🔧 No Matching Service: ${abandonmentReasons.noMatchingService}`);
          console.log(`  ❓ Other Reasons: ${abandonmentReasons.other}\n`);
        }
        
        console.log('═══════════════════════════════════════════════');
        console.log('  DETAILED CALL LIST');
        console.log('═══════════════════════════════════════════════\n');
        
        bookingIntentCalls.forEach((call, idx) => {
          console.log(`Call ${idx + 1}/${bookingIntentCount}`);
          console.log(`─────────────────────`);
          console.log(`  ID: ${call.id}`);
          console.log(`  Date: ${new Date(call.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}`);
          console.log(`  Phone: ${call.phone_number || 'N/A'}`);
          console.log(`  Intent: ${call.intent || 'N/A'}`);
          console.log(`  Duration: ${call.duration}s`);
          console.log(`  Had create_job attempt: ${call.hasCreateJobAttempt ? 'Yes' : 'No'}`);
          console.log(`  Status: ${call.hasSuccessfulBooking ? '✅ COMPLETED' : '❌ ABANDONED'}`);
          if (call.abandonmentReason) {
            const reasons = {
              noTimeslots: 'No Timeslots Available',
              cost: 'Cost Concerns',
              noMatchingService: 'No Matching Service',
              other: 'Other Reason'
            };
            console.log(`  Abandonment Reason: ${reasons[call.abandonmentReason]}`);
          }
          console.log('');
        });
        
      } else {
        console.log('\n❌ No calls with booking intent found in the last 7 days.');
        console.log('\nThis could mean:');
        console.log('  • No customers attempted to make bookings');
        console.log('  • The intent field was not set correctly');
        console.log('  • The create_job tool was never called\n');
      }

    } catch (error) {
      console.error('Error parsing response:', error.message);
      console.log('Raw response (first 500 chars):', data.substring(0, 500));
    }
  });
});

req.on('error', (error) => {
  console.error('Request error:', error.message);
});

req.end();
