# Call Duration & Spam Filter Status

## ✅ ALREADY IMPLEMENTED

Good news! The features you requested have already been implemented in your portal:

### 1. ✅ Twilio Recording Duration (Actual Call Time)

**Status**: COMPLETE

**Implementation Details**:
- **Database Field**: `Call.recordingDurationSeconds` stores the actual Twilio call duration
- **Database Field**: `Call.durationSeconds` is updated with the recording duration when available
- **Location**: `backend/src/routes/voice.ts` (lines 111-150)
- **Location**: `backend/src/routes/calls.ts` (lines 159-181)

**How It Works**:
1. When a call completes, LiveKit/agent reports initial duration (room time)
2. Twilio sends a recording callback to `/api/voice/recording-status` with actual call duration
3. The callback updates the `Call` record with `recordingDurationSeconds` (actual Twilio time)
4. Portal uses `recordingDurationSeconds` if available, otherwise falls back to agent-reported duration

**Code Reference** (`calls.ts` line 176):
```typescript
// Use recording duration if available (actual call time), otherwise use agent-reported duration
const actualDuration = finalRecordingDuration ?? payload.durationSeconds;
```

### 2. ✅ 30-Second Minimum Duration Filter

**Status**: COMPLETE

**Implementation Details**:
- **Threshold**: 30 seconds minimum
- **Action**: Calls under 30 seconds are either skipped or deleted
- **Location**: `backend/src/routes/calls.ts` (lines 179-182)
- **Location**: `backend/src/routes/voice.ts` (lines 114-126)

**How It Works**:

**Option A - During Call Creation** (`calls.ts`):
```typescript
// Skip calls under 30 seconds (dropped calls, wrong numbers, etc.)
if (actualDuration < 30) {
  console.log(`[CALL] Skipping short call (${actualDuration}s) - under 30 second threshold`);
  return res.status(201).json({ success: true, callId: 'skipped', reason: 'Call duration under 30 seconds' });
}
```

**Option B - After Recording Callback** (`voice.ts`):
```typescript
// If recording duration is under 30 seconds, delete the call from portal
if (durationSeconds < 30) {
  const deletedCalls = await prisma.call.deleteMany({
    where: {
      twilioCallSid: CallSid,
    },
  });
  
  if (deletedCalls.count > 0) {
    console.log(`[RECORDING] 🗑️ Deleted ${deletedCalls.count} call(s) - recording duration ${durationSeconds}s is under 30s threshold`);
  }
}
```

**Email Notifications**: 
- Email notifications are now sent ONLY after recording callback confirms duration >= 30s
- This prevents sending emails for calls that will be deleted
- Location: `voice.ts` lines 142-175

### 3. ✅ Database Schema

**Call Model**:
```prisma
model Call {
  id           String   @id @default(cuid())
  garageId     String
  roomName     String
  recordingUrl String?
  recordingDurationSeconds Int?        // ← Actual Twilio call duration
  recordingCompletedAt DateTime?
  twilioCallSid String?
  durationSeconds Int    @default(0)  // ← Updated with recording duration when available
  // ... other fields
}
```

**TwilioRecording Model**:
```prisma
model TwilioRecording {
  id        String   @id @default(cuid())
  callSid   String   @unique
  recordingSid String?
  recordingUrl String
  recordingDurationSeconds Int?  // ← Stores actual Twilio recording duration
  completedAt DateTime?
  roomName  String?
  // ... timestamps
}
```

## How to Verify It's Working

### Check Logs
```bash
ssh ec2-user@18.171.230.217
pm2 logs backend --lines 100 | grep -E "\[RECORDING\]|\[CALL\]"
```

**Look for**:
```
[RECORDING] ✅ Recording completed:
[RECORDING]    Duration: 45s
[RECORDING] ✅ Updated 1 call(s) with recording duration: 45s
```

Or for short calls:
```
[CALL] Skipping short call (12s) for garage xxx - under 30 second threshold
[RECORDING] 🗑️ Deleted 1 call(s) - recording duration 18s is under 30s threshold
```

### Check Database
```sql
-- View calls with recording durations
SELECT 
  id,
  "customerName",
  "durationSeconds",
  "recordingDurationSeconds",
  "createdAt"
FROM "Call"
ORDER BY "createdAt" DESC
LIMIT 10;

-- Check for any calls under 30 seconds (should be none or very few)
SELECT COUNT(*) 
FROM "Call" 
WHERE "durationSeconds" < 30;

-- View recording callback data
SELECT 
  "callSid",
  "recordingDurationSeconds",
  "completedAt"
FROM "TwilioRecording"
ORDER BY "createdAt" DESC
LIMIT 10;
```

### Test Scenarios

**Scenario 1: Normal Call (>30s)**
1. Make a test call that lasts 45 seconds
2. Check portal - call should appear with 45s duration
3. Check logs - should see `[RECORDING] ✅ Updated 1 call(s) with recording duration: 45s`

**Scenario 2: Short Call (<30s)**
1. Make a test call that lasts 15 seconds
2. Check portal - call should NOT appear
3. Check logs - should see `[CALL] Skipping short call (15s)` or `[RECORDING] 🗑️ Deleted 1 call(s)`

**Scenario 3: Email Notifications**
1. Make a call >30 seconds
2. Email should be sent AFTER recording callback confirms duration
3. Calls <30s should NOT trigger emails

## Configuration

No configuration needed - the 30-second threshold is hardcoded:

**To change threshold** (if needed):
1. Edit `backend/src/routes/calls.ts` line 179: `if (actualDuration < 30)`
2. Edit `backend/src/routes/voice.ts` line 115: `if (durationSeconds < 30)`
3. Rebuild and redeploy

## Current Flow Diagram

```
Incoming Call
    ↓
Twilio receives call
    ↓
Dials LiveKit SIP (records from answer)
    ↓
Agent handles call (reports room duration)
    ↓
Agent webhook → POST /api/calls
    ↓
Check if recording duration available from TwilioRecording table
    ↓
Use recording duration if exists, otherwise use agent duration
    ↓
Is duration >= 30s?
    ├─ YES → Create call in portal
    └─ NO  → Skip (return "skipped")
    ↓
[Later] Twilio recording completes
    ↓
Twilio webhook → POST /api/voice/recording-status
    ↓
Store recording data in TwilioRecording table
    ↓
Is duration >= 30s?
    ├─ YES → Update call with actual duration + Send email
    └─ NO  → Delete call from portal (if it somehow got created)
```

## Summary

✅ **Portal shows Twilio recording duration** (actual call time, not room time)  
✅ **Calls under 30 seconds are filtered out** (spam/drop call prevention)  
✅ **Email notifications sent only for valid calls** (>= 30s)  
✅ **Database tracks both durations** (agent-reported and Twilio-confirmed)

**No action needed** - these features are already live in production!

If you're seeing calls with incorrect durations or calls under 30 seconds still appearing, that would indicate a different issue (e.g., Twilio callbacks not reaching the server, recording not being enabled, etc.). Let me know if you're experiencing that and we can debug.
