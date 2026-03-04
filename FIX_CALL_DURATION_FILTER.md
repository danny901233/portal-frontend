# Fix Call Duration and 30-Second Filter Issues

## Problem Statement

The ReceptionMate portal is not correctly:
1. Displaying Twilio recording duration (actual call time) instead of LiveKit room duration
2. Filtering out calls under 30 seconds (spam/drop calls still appearing)

The code appears to be implemented, but the features are not working in production.

## Project Access

### Repository Information
- **Repository**: danny901233/portal-frontend
- **Branch**: receptionmate-demo-branch-2
- **Location**: `/Users/dan/projects/portal-frontend`
- **Production**: https://portal.receptionmate.co.uk (EC2: 18.171.230.217)

### Critical Files
```
portal-frontend/
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── calls.ts          # Line 159-230: Call creation with duration logic
│   │   │   └── voice.ts          # Line 69-150: Twilio recording callback
│   │   └── server.ts             # Route mounting
│   └── .env                      # Environment variables
├── prisma/
│   └── schema.prisma             # Call and TwilioRecording models
└── app/
    └── calls/[id]/page.tsx       # Frontend call display
```

## Required Debugging & Fixes

### Step 1: Verify Twilio Recording Callback is Reaching Server

**Check if webhook URL is configured in Twilio:**

1. Log into Twilio Console: https://console.twilio.com
2. Go to Phone Numbers → Manage → Active numbers
3. Check your ReceptionMate numbers
4. Look for "Recording Status Callback" field
5. **Expected**: `https://portal.receptionmate.co.uk/api/voice/recording-status`
6. **If missing or incorrect**: This is the root cause - callbacks aren't reaching the server

**Alternative: Check in code** (`backend/src/routes/voice.ts` line ~57):
```typescript
const recordingCallbackUrl = `https://portal.receptionmate.co.uk/api/voice/recording-status`;
```

**If this URL is wrong or not being set in TwiML**, Twilio won't send callbacks.

### Step 2: Check Production Logs for Recording Callbacks

SSH into EC2 and check if callbacks are being received:

```bash
ssh ec2-user@18.171.230.217
cd /home/ec2-user/portal-frontend

# Check recent logs for recording callbacks
pm2 logs backend --lines 500 | grep -i "recording"

# Look for these specific patterns:
pm2 logs backend --lines 500 | grep "\[RECORDING\]"
```

**Expected Output (if working)**:
```
[RECORDING] Twilio recording status callback: { RecordingSid: '...', RecordingDuration: '45', ... }
[RECORDING] ✅ Recording completed:
[RECORDING]    CallSid: CA...
[RECORDING]    RecordingSid: RE...
[RECORDING]    Duration: 45s
[RECORDING] Stored recording for CallSid CA...
[RECORDING] ✅ Updated 1 call(s) with recording duration: 45s
```

**If you see NOTHING with `[RECORDING]`**: Callbacks are not reaching the server.

**If you see the callback received but no update**: Logic issue in the code.

### Step 3: Check Database State

Verify if Twilio recording data is being stored:

```bash
# Connect to database
psql $DATABASE_URL
```

```sql
-- Check if TwilioRecording table has any data
SELECT COUNT(*) FROM "TwilioRecording";

-- If count > 0, check recent recordings
SELECT 
  "callSid",
  "recordingSid",
  "recordingDurationSeconds",
  "completedAt",
  "createdAt"
FROM "TwilioRecording"
ORDER BY "createdAt" DESC
LIMIT 10;

-- Check if calls have recording durations populated
SELECT 
  id,
  "customerName",
  "twilioCallSid",
  "durationSeconds",
  "recordingDurationSeconds",
  "recordingUrl",
  "createdAt"
FROM "Call"
ORDER BY "createdAt" DESC
LIMIT 10;

-- Count calls under 30 seconds (should be 0 or very few)
SELECT COUNT(*) FROM "Call" WHERE "durationSeconds" < 30;

-- List calls under 30 seconds (should not exist if filter working)
SELECT 
  id,
  "customerName",
  "durationSeconds",
  "recordingDurationSeconds",
  "createdAt"
FROM "Call"
WHERE "durationSeconds" < 30
ORDER BY "createdAt" DESC;
```

**Diagnostic Analysis**:

| TwilioRecording Count | recordingDurationSeconds in Call | Diagnosis |
|----------------------|----------------------------------|-----------|
| 0 | All NULL | Twilio callbacks not reaching server OR not being stored |
| > 0 | All NULL | Callbacks received but not updating Call records |
| > 0 | Some populated | Partial success - may be timing issue |

### Step 4: Verify TwiML Configuration

Check that recording is actually being enabled in the TwiML:

```bash
# View current TwiML generation code
cat backend/src/routes/voice.ts | grep -A 10 "record="
```

**Expected**:
```xml
<Dial record="record-from-answer" recordingStatusCallback="..." recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed">
```

**Common Issues**:
- `record="record-from-answer"` missing → No recording created
- `recordingStatusCallback` empty or wrong URL → Callbacks go nowhere
- `recordingStatusCallbackEvent="completed"` missing → Callback fires at wrong time

### Step 5: Test Recording Callback Manually

Create a test script to simulate Twilio callback:

```bash
# From your local machine or EC2
curl -X POST https://portal.receptionmate.co.uk/api/voice/recording-status \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "RecordingSid=RE123test" \
  -d "RecordingUrl=https://api.twilio.com/test.mp3" \
  -d "RecordingStatus=completed" \
  -d "CallSid=CA123test" \
  -d "RecordingDuration=45"
```

Then check logs:
```bash
pm2 logs backend --lines 50
```

**If you see the callback logged**: Server endpoint is working, issue is Twilio not calling it.

**If you see nothing**: Routing issue or server not responding.

### Step 6: Check Route Mounting

Verify the voice router is properly mounted:

```bash
# Check server.ts
cat backend/src/server.ts | grep -B 2 -A 2 "voiceRouter"
```

**Expected**:
```typescript
import voiceRouter from './routes/voice.js';
// ...
app.use('/api/voice', voiceRouter);
```

**If missing or commented out**: Route not mounted, callbacks return 404.

### Step 7: Fix Common Issues

#### Issue A: Recording Callback URL Not in TwiML

**File**: `backend/src/routes/voice.ts` (around line 50-65)

Check if this line exists and has correct URL:
```typescript
const recordingCallbackUrl = `https://portal.receptionmate.co.uk/api/voice/recording-status`;
```

And it's used in TwiML:
```typescript
<Dial record="record-from-answer" recordingStatusCallback="${recordingCallbackUrl}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed">
```

**If missing**: Add it.

#### Issue B: roomName Not Being Passed to TwilioRecording

**File**: `backend/src/routes/voice.ts` (line 89-107)

The code stores recording by `callSid`, but looks up by `roomName` in calls.ts.

**Check if this field is being set**:
```typescript
await prisma.twilioRecording.upsert({
  where: { callSid: CallSid },
  update: {
    recordingSid: RecordingSid,
    recordingUrl: RecordingUrl,
    recordingDurationSeconds: durationSeconds,
    completedAt,
    roomName: /* THIS MIGHT BE MISSING */
  },
  // ...
```

**Problem**: If `roomName` is not stored in TwilioRecording, the lookup in calls.ts fails:
```typescript
const storedRecording = await prisma.twilioRecording.findFirst({
  where: { roomName: payload.roomName },  // ← Will fail if roomName is null
});
```

**Fix**: Need to pass roomName from somewhere. Options:
1. Store roomName during TwiML generation (associate CallSid with roomName)
2. Look up by CallSid instead of roomName
3. Add roomName to callback parameters

#### Issue C: Timing Issue - Call Created Before Recording Callback

**Current flow might be**:
1. Agent sends call data to `/api/calls` immediately after call ends
2. Call gets created with LiveKit duration
3. Twilio recording callback arrives 5-30 seconds later
4. Lookup fails because roomName not in TwilioRecording yet

**Solution**: Change lookup logic to use `twilioCallSid` instead of `roomName`:

**In calls.ts** (around line 161):
```typescript
// OLD (might not work):
const storedRecording = await prisma.twilioRecording.findFirst({
  where: { roomName: payload.roomName },
});

// NEW (more reliable):
const storedRecording = await prisma.twilioRecording.findFirst({
  where: { callSid: payload.twilioCallSid },
});
```

**In voice.ts** (make sure callSid is the primary key, which it already is).

### Step 8: Verify twilioCallSid is Being Sent by Agent

Check agent code to ensure it's sending `twilioCallSid` in the webhook payload:

```bash
# Check recent webhook payloads in logs
pm2 logs backend --lines 500 | grep "Incoming webhook payload"
```

**Expected**:
```json
{
  "garageId": "...",
  "durationSeconds": 45,
  "roomName": "...",
  "twilioCallSid": "CA1234567890abcdef1234567890abcdef",
  "customerName": "..."
}
```

**If `twilioCallSid` is null or missing**: Agent isn't sending it. Need to update agent code.

### Step 9: Check for Race Condition

The 30-second filter might not work if:
1. Call is created with LiveKit duration (e.g., 12 seconds)
2. Recording callback arrives later with 45 seconds
3. But call was already created with 12s and not updated

**Check update logic** in `voice.ts` (line 128-141):

```typescript
const updatedCalls = await prisma.call.updateMany({
  where: {
    twilioCallSid: CallSid,
    recordingDurationSeconds: null, // ← This condition might prevent update
  },
  data: {
    durationSeconds,
    recordingDurationSeconds: durationSeconds,
    recordingUrl: RecordingSid,
    recordingCompletedAt: completedAt,
  },
});
```

**Issue**: If `recordingDurationSeconds` is somehow already set, this won't update.

**Fix**: Remove the condition:
```typescript
const updatedCalls = await prisma.call.updateMany({
  where: {
    twilioCallSid: CallSid,
  },
  data: {
    durationSeconds,
    recordingDurationSeconds: durationSeconds,
    recordingUrl: RecordingSid,
    recordingCompletedAt: completedAt,
  },
});
```

## Recommended Fix Implementation

Based on most common issues:

### Fix 1: Change Lookup from roomName to twilioCallSid

**File**: `backend/src/routes/calls.ts` (line 161-172)

**REPLACE**:
```typescript
if (payload.roomName) {
  const storedRecording = await prisma.twilioRecording.findFirst({
    where: { roomName: payload.roomName },
  });
```

**WITH**:
```typescript
if (payload.twilioCallSid) {
  const storedRecording = await prisma.twilioRecording.findFirst({
    where: { callSid: payload.twilioCallSid },
  });
```

### Fix 2: Remove Update Condition That Might Block Updates

**File**: `backend/src/routes/voice.ts` (line 128-141)

**REPLACE**:
```typescript
const updatedCalls = await prisma.call.updateMany({
  where: {
    twilioCallSid: CallSid,
    recordingDurationSeconds: null,
  },
```

**WITH**:
```typescript
const updatedCalls = await prisma.call.updateMany({
  where: {
    twilioCallSid: CallSid,
  },
```

### Fix 3: Ensure Recording Callback URL is in TwiML

**File**: `backend/src/routes/voice.ts` (line 50-65)

**VERIFY THIS EXISTS**:
```typescript
const recordingCallbackUrl = `https://portal.receptionmate.co.uk/api/voice/recording-status`;

const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer" recordingStatusCallback="${recordingCallbackUrl}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed">
    <Sip>sip:${garageId}@${livekitSipDomain}</Sip>
  </Dial>
</Response>`;
```

### Fix 4: Add Logging to Track the Issue

**File**: `backend/src/routes/calls.ts` (after line 172)

**ADD**:
```typescript
if (storedRecording?.recordingSid) {
  console.log(`[RECORDING] Found stored recording for callSid ${payload.twilioCallSid}: ${storedRecording.recordingSid}`);
  console.log(`[RECORDING] Duration from Twilio: ${storedRecording.recordingDurationSeconds}s`);
  finalRecordingUrl = storedRecording.recordingSid;
  finalRecordingDuration = storedRecording.recordingDurationSeconds ?? null;
  finalRecordingCompletedAt = storedRecording.completedAt ?? null;
} else {
  console.log(`[RECORDING] No stored recording found for callSid ${payload.twilioCallSid}`);
  console.log(`[RECORDING] TwilioCallSid from payload: ${payload.twilioCallSid}`);
  console.log(`[RECORDING] Will use agent-reported duration: ${payload.durationSeconds}s`);
}
```

## Testing After Fixes

1. **Rebuild backend**:
```bash
cd /Users/dan/projects/portal-frontend/backend
npm run build
```

2. **Deploy to EC2** (or restart locally):
```bash
pm2 restart backend
```

3. **Make a test call**:
   - Call duration: 45 seconds (should appear in portal)
   - Call duration: 15 seconds (should NOT appear in portal)

4. **Check logs immediately**:
```bash
pm2 logs backend --lines 100 | grep -E "\[RECORDING\]|\[CALL\]"
```

5. **Check database**:
```sql
-- Should see recording duration populated
SELECT 
  "twilioCallSid",
  "durationSeconds",
  "recordingDurationSeconds"
FROM "Call"
ORDER BY "createdAt" DESC
LIMIT 5;
```

## Expected Behavior After Fix

### For 45-second call:
```
[CALL] Incoming webhook payload: { garageId: '...', durationSeconds: 45, twilioCallSid: 'CA123...', ... }
[RECORDING] Found stored recording for callSid CA123...: RE456...
[RECORDING] Duration from Twilio: 45s
[CALL] Creating call with actual duration: 45s
[RECORDING] ✅ Recording completed: CallSid CA123..., Duration: 45s
[RECORDING] ✅ Updated 1 call(s) with recording duration: 45s
```

### For 15-second call:
```
[CALL] Incoming webhook payload: { garageId: '...', durationSeconds: 15, twilioCallSid: 'CA789...', ... }
[RECORDING] No stored recording found for callSid CA789...
[CALL] Skipping short call (15s) for garage ... - under 30 second threshold
[RECORDING] ✅ Recording completed: CallSid CA789..., Duration: 15s
[RECORDING] 🗑️ Deleted 1 call(s) - recording duration 15s is under 30s threshold
```

## Priority Actions

1. ✅ Check production logs for `[RECORDING]` messages (Step 2)
2. ✅ Check database for TwilioRecording data (Step 3)
3. ✅ Apply Fix 1: Change lookup to use twilioCallSid (most likely fix)
4. ✅ Apply Fix 2: Remove blocking update condition
5. ✅ Deploy and test

If none of these work, the issue is likely that Twilio recordings aren't being created at all (TwiML issue) or callbacks aren't reaching the server (webhook URL issue).
