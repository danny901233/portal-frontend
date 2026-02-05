# Recording Mix-Up Issue Analysis

## Problem
Recordings are getting muddled up between different calls in the portal.

## Root Cause
The portal uses **fuzzy matching** to find Twilio recordings, which causes mix-ups during concurrent calls.

### Location: `backend/src/routes/calls.ts` (lines 723-771)

```typescript
// Search for recent calls from this number
const callsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json?From=${encodeURIComponent(call.customerPhone)}&PageSize=10`;

// Find calls around the time of this call (within 5 minutes)
const callTime = call.createdAt.getTime();
const tolerance = 5 * 60 * 1000; // 5 minutes in milliseconds

for (const twilioCall of callsData.calls || []) {
  const twilioCallTime = new Date(twilioCall.start_time).getTime();
  if (Math.abs(twilioCallTime - callTime) < tolerance) {
    // Uses the FIRST matching call found
  }
}
```

### Why This Causes Mix-Ups

1. **Searches by customer phone number** - All calls from the same number are candidates
2. **5-minute time window** - Any call within ±5 minutes matches
3. **Takes first match** - If multiple calls match, it picks the first one (not necessarily the right one)
4. **Concurrent calls** - Two calls at the same time can grab each other's recordings

### Example Scenario

```
10:00:00 - Call A from +1234567890 starts
10:00:05 - Call B from +1234567890 starts  (same customer, 5 seconds later)
10:02:00 - Call A ends, portal searches for recording
          → Finds both Call A and Call B in Twilio (both within 5 minutes)
          → Picks the first one (could be Call B's recording!)
10:03:00 - Call B ends, portal searches for recording
          → Finds both recordings again
          → Might pick Call A's recording
```

Result: **Recordings are swapped!**

## The Agent is Correct

The agent sends:
- `roomName`: Unique per call (e.g., "garage-abc-123_+1234567890_xyz")
- `recordingUrl`: `{RECORDING_BASE_URL}/{roomName}.mp4`

This is stored correctly in the database (line 185):
```typescript
recordingUrl: finalRecordingUrl,
```

## Why Portal Falls Back to Fuzzy Matching

The portal has this fallback logic (lines 558-779):
1. Check if `call.recordingUrl` exists
2. If not, try to fetch from Twilio using `twilioCallSid`
3. If no `twilioCallSid`, **fall back to fuzzy matching by phone + time**

The fuzzy matching was meant as a backup, but it's causing the mix-ups.

## Solutions

### Option 1: Use Room Name for Recording Matching (Recommended)

Store the room name with Twilio recordings and match by that instead of phone/time.

### Option 2: Require Twilio CallSid

Make the agent send `twilioCallSid` for every call so the portal can match recordings precisely.

### Option 3: Remove Fuzzy Matching Fallback

If the agent is already sending correct `recordingUrl`, disable the fuzzy fallback entirely.

### Option 4: Improve Fuzzy Matching Logic

- Reduce time tolerance (5 minutes → 30 seconds)
- Match on call duration as well as time
- Use room name as additional matching criteria

## Recommended Fix

**Add room name to the Twilio recording matching:**

1. Store `roomName` in the `twilioRecording` table
2. When searching for recordings, match by:
   - `twilioCallSid` (primary)
   - OR `roomName` (secondary)
   - OR phone + time (last resort, with tighter tolerance)

This would eliminate almost all mix-ups while keeping the fallback for edge cases.
