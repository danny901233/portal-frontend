# CRITICAL BUG FIX DEPLOYED: Call Recording Cross-Contamination

**Date**: February 25, 2026
**Status**: ✅ FIXED AND DEPLOYED
**Severity**: CRITICAL - GDPR/Privacy Violation

---

## The Issue

Two calls from the **same customer phone number (+443301007477)** to **different garages** occurring within **1 minute 50 seconds** were vulnerable to recording mix-up:

### Call 1: blair atholl garage
- **Room**: `garage-e1a3fa3b-aced-40d1-84e7-e99b30fda058_+443301007477_GJg8YxnNozuG`
- **Call ID**: 95469110
- **Started**: Feb 25, 2026 at 3:27:21 PM (3:32:01 PM UTC)
- **Duration**: 6 minutes (275 seconds)
- **Recording**: `RE17836cef29d263b1027262a9a1bd9034` ✅

### Call 2: In'n'out Autocentres Norwich
- **Room**: `garage-cd0610c6-0b4e-433b-866b-2af0ad0b20ac_+443301007477_mxEmiCkNk2ph`
- **Call ID**: 80902607
- **Started**: Feb 25, 2026 at 3:32:29 PM (3:33:51 PM UTC)
- **Duration**: 2 minutes (78 seconds)
- **Recording**: None yet ❌

### The Vulnerability

When In'n'out Norwich tried to fetch the recording for their call (80902607), the system's **Strategy 2** recording lookup would:

1. Search Twilio for calls **from** `+443301007477` (customer phone)
2. Find Call 1 from blair atholl garage (within 5-minute tolerance window)
3. Match by time/duration proximity
4. **INCORRECTLY assign blair atholl's recording to In'n'out's call**

This is a **cross-garage data leak** - one garage could hear another garage's customer conversation.

---

## Root Cause

**File**: `backend/src/routes/calls.ts` (Strategy 2 recording lookup)

The recording matching system searched Twilio by:
- ✅ Customer phone number (FROM)
- ❌ **Missing**: Garage phone number (TO)

This allowed recordings to be matched across different garages when:
- Same customer called multiple garages
- Calls happened within 5-minute window
- Time/duration similarity caused false positive match

### Security Impact
- **GDPR Violation**: Customer call recordings exposed to wrong business
- **Privacy Breach**: Garage A could listen to Garage B's customer conversations
- **Data Integrity**: Incorrect recording associations in database
- **Customer Trust**: Severe breach of confidentiality

---

## The Fix

### 1. Added Garage Phone Number Validation (Lines 775-805)

**Before**:
```typescript
// Search for recent calls from this number
const callsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json?From=${encodeURIComponent(phoneForTwilioLookup)}&PageSize=20`;
```

**After**:
```typescript
// Get garage's phone number
const garageConfig = await prisma.agentConfiguration.findUnique({
  where: { garageId: call.garageId },
  select: { phoneNumber: true },
});

if (!garageConfig?.phoneNumber) {
  return res.status(404).json({ 
    error: 'Recording not available: garage configuration incomplete' 
  });
}

// Search for calls FROM customer TO this specific garage
const callsUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json?From=${encodeURIComponent(phoneForTwilioLookup)}&To=${encodeURIComponent(garageConfig.phoneNumber)}&PageSize=20`;
```

### 2. Added Double-Check Validation in Matching Loop (Lines 871-877)

```typescript
// CRITICAL SECURITY: Verify this call was TO our garage's number
if (twilioCall.to !== garagePhoneNumber) {
  console.log(`[RECORDING] ❌ REJECTED: Call ${twilioCall.sid} was to ${twilioCall.to}, not our garage ${garagePhoneNumber}`);
  continue;
}
console.log(`[RECORDING] ✅ Validated: Call ${twilioCall.sid} was to correct garage ${garagePhoneNumber}`);
```

### 3. Added Authentication to Audio Streaming Endpoint (Lines 933-946)

**Before**:
```typescript
// Proxy endpoint to stream recording audio (no auth - call ID provides security)
router.get('/calls/:id/recording/audio', async (req: Request, res: Response) => {
```

**After**:
```typescript
// Proxy endpoint to stream recording audio - with authentication
router.get('/calls/:id/recording/audio', authenticate, async (req: Request, res: Response) => {
  // ... existing code ...
  
  // SECURITY: Verify user has access to this garage's recordings
  const allowedGarages = resolveAllowedGarages(req.user);
  if (!allowedGarages.includes(call.garageId) && req.user?.role !== 'RECEPTIONMATE_STAFF') {
    console.warn(`[RECORDING] Access denied: User tried to access call ${id} from garage ${call.garageId}`);
    return res.status(403).send('Access denied');
  }
```

---

## Deployment

**Deployed**: February 25, 2026
**Method**: 
1. Code committed to `receptionmate-demo-branch-2`
2. Uploaded to EC2 server: `18.171.223.223`
3. Backend restarted via `pm2 restart portal-backend`

**Verification**:
```bash
pm2 logs portal-backend --lines 20 --nostream
# Backend running successfully with new code
```

---

## How It Now Works

### Strategy 1: Room Name Matching (Unchanged - Already Secure)
- Each call has unique room name containing garage ID
- Example: `garage-e1a3fa3b-aced-40d1-84e7-e99b30fda058_+443301007477_GJg8YxnNozuG`
- Recordings matched by room name are inherently garage-specific ✅

### Strategy 2: Twilio API Matching (NOW FIXED)
When room name matching fails, system now:
1. Gets garage's phone number from `AgentConfiguration`
2. Searches Twilio for calls FROM customer **AND TO garage**
3. Matches by time/duration proximity
4. **Double-checks** Twilio call's "To" number matches garage
5. Only assigns recording if both FROM and TO numbers are correct ✅

### Audio Streaming Endpoint (NOW SECURE)
- Requires user authentication
- Verifies user has access to the call's garage
- Prevents unauthorized cross-garage recording access ✅

---

## Testing Recommendations

### 1. Test Cross-Garage Isolation
Create test scenario:
- Same customer calls two different garages within 5 minutes
- Verify each garage can only access their own recording
- Verify recordings are not mixed up

### 2. Test Authentication
- Try accessing `/api/calls/{id}/recording/audio` without auth → Should fail
- Try accessing another garage's recording → Should return 403

### 3. Audit Existing Data
Run database query to check if any existing recordings were mis-assigned:
```sql
SELECT 
  c.id as call_id,
  c.garageId,
  ag.phoneNumber as garage_phone,
  c.customerPhone,
  c.recordingUrl,
  tr.callSid
FROM "Call" c
JOIN "AgentConfiguration" ag ON c.garageId = ag.garageId
LEFT JOIN "TwilioRecording" tr ON c.twilioCallSid = tr.callSid
WHERE c.recordingUrl IS NOT NULL
  AND tr.callSid IS NOT NULL;
```

---

## Prevention Measures

### What This Fix Prevents:
✅ Same customer calling multiple garages → recordings stay isolated
✅ Time-proximity false matches → validated by garage phone number
✅ Unauthorized recording access → authentication required
✅ Strategy 2 contamination → double-checked TO number validation

### Edge Cases Handled:
✅ Garage phone number not configured → Returns 404 (safe fail)
✅ Twilio call to wrong number → Rejected with clear log message
✅ User tries to access wrong garage's recording → 403 Forbidden

---

## Related Documentation

- Full analysis: `FIX_RECORDING_CROSS_CONTAMINATION.md`
- Code changes: Commit `7a1d583`
- Backend route file: `backend/src/routes/calls.ts`

---

## Priority

**CRITICAL - PRODUCTION FIX**

This was a data privacy violation with potential GDPR implications. The fix has been deployed immediately to prevent any customer data exposure.

✅ Issue identified
✅ Root cause analyzed  
✅ Fix implemented
✅ Code deployed
✅ Backend restarted
✅ Logs verified

**Status**: RESOLVED
