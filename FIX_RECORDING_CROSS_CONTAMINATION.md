# CRITICAL BUG FIX: Call Recording Cross-Contamination

## Issue Summary
Call ID 95469110 (blair atholl garage) and Call ID 80902607 (In'n'out Autocentres Norwich) both involve the same customer phone number (+443301007477). The recording lookup system's Strategy 2 can incorrectly match recordings across different garages when customers call multiple garages.

## Root Cause
**File**: `backend/src/routes/calls.ts` (lines 770-910)

**Problem**: Strategy 2 searches Twilio by phone number and uses time/duration proximity matching WITHOUT validating that the matched Twilio call belongs to the same garage. This allows recordings from one garage to be served to another garage's customers.

### Current Flawed Logic:
1. Search Twilio for calls from customer phone number
2. Match by timestamp proximity (within 5 minutes)
3. Match by duration similarity
4. Return first matching recording
5. **MISSING**: Verify the matched call's phone number (To Number) matches the garage's phone number

## Security Impact
- ⚠️ **GDPR Violation**: Customer call recordings exposed to wrong businesses
- ⚠️ **Privacy Breach**: Garage A can hear Garage B's customer conversations
- ⚠️ **Data Integrity**: Incorrect data associations in database

## Affected Code
`backend/src/routes/calls.ts` lines 795-905 (Strategy 2 recording lookup)

## The Fix
Add garage phone number validation to Strategy 2 matching:

### Step 1: Get garage's phone number
```typescript
const garagePhoneNumber = await prisma.agentConfiguration.findUnique({
  where: { garageId: call.garageId },
  select: { phoneNumber: true }
});

if (!garagePhoneNumber?.phoneNumber) {
  return res.status(404).json({ 
    error: 'Cannot fetch recording: garage phone number not configured' 
  });
}
```

### Step 2: Filter Twilio calls by To Number
```typescript
// When searching Twilio, use both From and To numbers
const callsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json?From=${encodeURIComponent(phoneForTwilioLookup)}&To=${encodeURIComponent(garagePhoneNumber.phoneNumber)}&PageSize=20`;
```

### Step 3: Verify matched calls
```typescript
// Additional validation in matching loop
for (const { twilioCall, timeDiff, durationDiff, score } of scoredCalls) {
  // Verify this call was TO our garage's number
  if (twilioCall.to !== garagePhoneNumber.phoneNumber) {
    console.log(`[RECORDING] REJECTED: Call ${twilioCall.sid} was to ${twilioCall.to}, not our garage ${garagePhoneNumber.phoneNumber}`);
    continue;
  }
  
  // ... rest of matching logic
}
```

## Additional Improvements

### 1. Add garage validation to audio streaming endpoint
**File**: `backend/src/routes/calls.ts` lines 910-994

**Current Issue**: `/api/calls/:id/recording/audio` doesn't verify user has access to the call's garage

**Fix**: Add authentication check
```typescript
router.get('/calls/:id/recording/audio', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const call = await prisma.call.findUnique({
      where: { id },
      include: { garage: true },
    });

    if (!call) {
      return res.status(404).send('Recording not found');
    }

    // SECURITY: Verify user has access to this garage
    const allowedGarages = resolveAllowedGarages(req.user);
    if (!allowedGarages.includes(call.garageId) && req.user?.role !== 'RECEPTIONMATE_STAFF') {
      return res.status(403).send('Access denied');
    }

    // ... rest of streaming logic
  }
}
```

### 2. Database constraint to prevent assignment errors
Add unique constraint on `TwilioRecording.callSid` to prevent duplicate associations (likely already exists but verify)

### 3. Audit existing recordings
Run script to find and fix any existing cross-contamination:
```sql
-- Find calls with recordings that don't match garage phone
SELECT 
  c.id as call_id,
  c.garageId,
  ag.phoneNumber as garage_phone,
  c.customerPhone,
  c.recordingUrl,
  tr.callSid,
  tr.recordingUrl as twilio_recording_url
FROM "Call" c
JOIN "AgentConfiguration" ag ON c.garageId = ag.garageId
LEFT JOIN "TwilioRecording" tr ON c.twilioCallSid = tr.callSid
WHERE c.recordingUrl IS NOT NULL
  AND tr.callSid IS NOT NULL;
```

## Testing Plan
1. Create test calls from same customer to different garages
2. Verify recordings are correctly isolated
3. Verify users can only access recordings from their garages
4. Test Strategy 1 (roomName) continues to work
5. Test Strategy 2 with garage phone validation
6. Audit existing production data for contamination

## Deployment Priority
**CRITICAL - IMMEDIATE DEPLOYMENT REQUIRED**

This is a data privacy violation affecting customer trust and legal compliance.

## Files to Modify
1. `/backend/src/routes/calls.ts` (main fix)
2. Add audit script to identify existing contamination
3. Add integration tests for recording isolation

