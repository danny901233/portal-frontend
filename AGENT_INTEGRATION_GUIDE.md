# Agent Integration Guide - Connecting New Agents to ReceptionMate Portal

This guide explains what details a developer needs to connect a new AI agent to the ReceptionMate portal backend.

---

## Overview

The agent sends call data to the portal via webhooks. The portal stores call records, generates invoices, and provides the dashboard interface for customers.

---

## Required Information

### 1. Portal Backend URL

**Environment Variable:** `PORTAL_API_URL`  
**Production Value:** `http://18.171.230.217:4000/api/calls`  
**Local/Test Value:** `http://localhost:4000/api/calls`

**What it does:** The agent POSTs call data to this endpoint after each call completes.

---

### 2. Webhook Secret (Authentication)

**Environment Variable:** `WEBHOOK_SECRET`  
**Purpose:** Authenticates agent → portal communication

**Example:** `"your-shared-secret-here"`

**Usage:**
- Agent includes this in request header: `X-Webhook-Secret: your-secret`
- Portal validates the secret before accepting call data
- Prevents unauthorized systems from logging fake calls

**Important:** Keep this secret! Don't commit it to git. Use environment variables or secrets manager.

---

### 3. Recording Base URL (Optional)

**Environment Variable:** `RECORDING_BASE_URL`  
**Example:** `https://storage.example.com/recordings`

**What it does:** If your agent stores call recordings in cloud storage (S3, Azure Blob, etc.), provide the base URL. The portal will construct full recording URLs like:
```
{RECORDING_BASE_URL}/{roomName}.mp4
```

**Note:** If not provided, recordings won't be linked in the portal (calls will still log without recordings).

---

## Agent Configuration Webhook (Optional)

If your agent needs to fetch configuration dynamically during calls:

**Endpoint:** `http://18.171.230.217:4000/webhooks/agent-config`  
**Method:** `POST`  
**Authentication Header:** `X-Agent-Config-Secret` (separate from webhook secret)

**Request Body:**
```json
{
  "garageId": "garage-uuid-here"
}
```

**Response:**
```json
{
  "agentConfig": {
    "branchName": "Manchester Motors",
    "phoneNumber": "01234567890",
    "emailAddress": "info@manchestermotors.com",
    "branchAddress": "123 Main St, Manchester",
    "weeklyOpeningHours": {
      "monday": { "open": "09:00", "close": "17:00" }
    },
    "greetingLine": "Good afternoon, Manchester Motors, Leah speaking, how can I help?",
    "tonePreference": "upbeat",
    "responseSpeed": "fast",
    "agentType": "assist",
    "websiteUrl": "https://manchestermotors.com"
  }
}
```

---

## Call Logging Payload

When a call completes, the agent POSTs this data to `PORTAL_API_URL`:

### Required Fields

```json
{
  "garageId": "string (UUID)",
  "roomName": "string (unique call identifier)",
  "durationSeconds": "number (must be ≥55 to log)",
  "transcript": [
    {
      "speaker": "agent | customer",
      "text": "string",
      "timestamp": "ISO8601 (optional)"
    }
  ],
  "summary": "string (human-readable call summary)",
  "callType": "confirmed booking | enquiry | complaint | wrong number | unknown"
}
```

### Optional Fields

```json
{
  "customerName": "string (e.g., 'John Smith')",
  "customerPhone": "string (e.g., '+447976500282')",
  "fromNumber": "string (caller ID)",
  "registrationNumber": "string (vehicle VRN)",
  "confirmedBooking": "boolean (true if booking was made)",
  "bookingDetails": "string (date/time/service info)",
  "twilioCallSid": "string (Twilio call SID for recording linkage)",
  "recordingUrl": "string (full URL or just SID)"
}
```

### Headers

```
Content-Type: application/json
X-Webhook-Secret: {your-webhook-secret}
```

---

## Call Duration Rules

**Important:** The portal only logs calls that are **55 seconds or longer**.

- Calls under 55 seconds are ignored (dropped calls, wrong numbers, etc.)
- The agent should also filter calls under 55 seconds before sending
- Duration is measured from call start to call end (excluding ring time)

---

## Call Types

The agent should classify each call into one of these types:

| Call Type | Description |
|-----------|-------------|
| `confirmed booking` | Customer made a booking (always use this if `confirmedBooking: true`) |
| `enquiry` | Customer asked questions but didn't book |
| `complaint` | Customer complaint or issue |
| `quote` | Customer requested pricing information |
| `wrong number` | Wrong number / misdial |
| `unknown` | Unable to determine type |

---

## Example Agent Code (Python)

```python
import os
import aiohttp

PORTAL_API_URL = os.getenv("PORTAL_API_URL", "http://18.171.230.217:4000/api/calls")
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "optional-shared-secret")
RECORDING_BASE_URL = os.getenv("RECORDING_BASE_URL", "")

async def log_call_to_portal(
    garage_id: str,
    room_name: str,
    duration_seconds: int,
    transcript: list,
    summary: str,
    customer_name: str = "",
    customer_phone: str = "",
    registration_number: str = "",
    confirmed_booking: bool = False,
    call_type: str = "unknown",
    twilio_call_sid: str = "",
):
    """Log call data to the portal backend."""
    
    # Only log calls 55 seconds or longer
    if duration_seconds < 55:
        print(f"Skipping call log - duration {duration_seconds}s under threshold")
        return
    
    payload = {
        "garageId": garage_id,
        "roomName": room_name,
        "durationSeconds": duration_seconds,
        "transcript": transcript,
        "summary": summary,
        "callType": call_type,
    }
    
    # Add optional fields
    if customer_name:
        payload["customerName"] = customer_name
    if customer_phone:
        payload["customerPhone"] = customer_phone
    if registration_number:
        payload["registrationNumber"] = registration_number
    if confirmed_booking:
        payload["confirmedBooking"] = confirmed_booking
    if twilio_call_sid:
        payload["twilioCallSid"] = twilio_call_sid
    
    # Add recording URL if configured
    if RECORDING_BASE_URL:
        payload["recordingUrl"] = f"{RECORDING_BASE_URL}/{room_name}.mp4"
    
    headers = {
        "Content-Type": "application/json",
        "X-Webhook-Secret": WEBHOOK_SECRET,
    }
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(PORTAL_API_URL, json=payload, headers=headers) as response:
                if response.status == 201:
                    data = await response.json()
                    print(f"Call logged: {data.get('callId')}")
                else:
                    text = await response.text()
                    print(f"Failed to log call: {response.status} - {text}")
    except Exception as e:
        print(f"Error logging call: {e}")
```

---

## Environment Variables Summary

Create a `.env` file with these variables:

```bash
# Portal Backend URL
PORTAL_API_URL=http://18.171.230.217:4000/api/calls

# Webhook authentication secret (must match backend)
WEBHOOK_SECRET=your-shared-secret-here

# Optional: Recording storage base URL
RECORDING_BASE_URL=https://storage.example.com/recordings

# Optional: Agent config webhook secret (different from WEBHOOK_SECRET)
AGENT_CONFIG_WEBHOOK_SECRET=different-secret-for-config
```

---

## Database Connection (Advanced)

**Not usually needed** - the agent communicates via HTTP webhooks, not direct database access.

However, if your agent needs direct database access for advanced features:

**Environment Variable:** `DATABASE_URL`  
**Format:** `postgresql://user:password@host:5432/database`  
**Example:** `postgresql://receptionmate:password@localhost:5432/portal_db`

**Warning:** Direct database access bypasses the API layer and can cause data inconsistencies. Only use if absolutely necessary and coordinate with the backend team.

---

## Testing the Integration

### 1. Health Check

First, verify the portal backend is accessible:

```bash
curl http://18.171.230.217:4000/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-21T15:30:00.000Z"
}
```

---

### 2. Test Call Logging

Send a test call with the correct secret:

```bash
curl -X POST http://18.171.230.217:4000/api/calls \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret-here" \
  -d '{
    "garageId": "test-garage-id",
    "roomName": "test-call-123",
    "durationSeconds": 120,
    "transcript": [
      {"speaker": "agent", "text": "Hello, test garage"},
      {"speaker": "customer", "text": "Hi, I need an MOT"}
    ],
    "summary": "Test call for integration testing",
    "callType": "enquiry",
    "customerName": "Test Customer",
    "customerPhone": "+447700900000"
  }'
```

**Success Response (201):**
```json
{
  "success": true,
  "callId": "uuid-here"
}
```

**Error Responses:**
- `401 Unauthorized` - Wrong webhook secret
- `400 Bad Request` - Invalid payload (check JSON structure)
- `500 Internal Server Error` - Backend error (check logs)

---

### 3. Test with Wrong Secret

Verify authentication is working:

```bash
curl -X POST http://18.171.230.217:4000/api/calls \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: wrong-secret" \
  -d '{"garageId": "test"}'
```

**Expected:** `401 Unauthorized`

---

## Common Issues & Troubleshooting

### Issue: Calls Not Appearing in Portal

**Possible Causes:**
1. **Duration under 55 seconds** - Check `durationSeconds` value
2. **Wrong webhook secret** - Verify `WEBHOOK_SECRET` matches backend
3. **Invalid garageId** - Garage must exist in database
4. **Wrong URL** - Ensure using `/api/calls` endpoint

**Debugging:**
```bash
# Check agent logs for HTTP response codes
# 201 = success
# 401 = wrong secret
# 400 = invalid payload
```

---

### Issue: Recording Links Not Working

**Possible Causes:**
1. **RECORDING_BASE_URL not set** - Set the environment variable
2. **Recording file doesn't exist** - Verify file is uploaded to storage
3. **Wrong file path** - Recording URLs must match: `{BASE_URL}/{roomName}.mp4`

**Solution:**
- Ensure recordings are uploaded BEFORE sending webhook
- Use signed URLs for cloud storage (S3, Azure, GCS)
- Or set `recordingUrl` to Twilio Recording SID for automatic retrieval

---

### Issue: Authentication Errors

**Solution:**
1. Verify environment variable is set: `echo $WEBHOOK_SECRET`
2. Check for trailing whitespace in secret
3. Ensure header name is exactly `X-Webhook-Secret` (case-sensitive)
4. Try URL-encoding special characters if secret contains them

---

### Issue: Transcript Not Displaying Correctly

**Solution:**
- Ensure transcript is an array of objects
- Each entry needs `speaker` and `text` fields
- `speaker` must be either "agent" or "customer"
- Format:
  ```json
  [
    {"speaker": "agent", "text": "Hello"},
    {"speaker": "customer", "text": "Hi"}
  ]
  ```

---

## Security Best Practices

1. **Never commit secrets to git**
   - Use `.env` files (add to `.gitignore`)
   - Use secrets manager (AWS Secrets Manager, Azure Key Vault, etc.)

2. **Rotate secrets regularly**
   - Change `WEBHOOK_SECRET` every 90 days
   - Update in both agent and backend simultaneously

3. **Use HTTPS in production**
   - Current setup uses HTTP (development)
   - Production should use HTTPS with SSL certificate

4. **Validate all data**
   - Agent should validate input before sending
   - Don't trust user input blindly

5. **Log security events**
   - Log failed authentication attempts
   - Monitor for unusual patterns (too many calls, wrong secrets)

---

## Advanced: Recording Storage Options

### Option 1: Cloud Storage (Recommended)

**AWS S3 Example:**
```python
RECORDING_BASE_URL = "https://receptionmate-recordings.s3.eu-west-2.amazonaws.com"
recording_url = f"{RECORDING_BASE_URL}/{room_name}.mp4"
```

**Azure Blob Storage Example:**
```python
RECORDING_BASE_URL = "https://receptionmate.blob.core.windows.net/recordings"
recording_url = f"{RECORDING_BASE_URL}/{room_name}.mp4"
```

**Google Cloud Storage Example:**
```python
RECORDING_BASE_URL = "https://storage.googleapis.com/receptionmate-recordings"
recording_url = f"{RECORDING_BASE_URL}/{room_name}.mp4"
```

---

### Option 2: Twilio Recording SID

If using Twilio for recording, just pass the Recording SID:

```json
{
  "recordingUrl": "RE1234567890abcdef1234567890abcdef",
  "twilioCallSid": "CA1234567890abcdef1234567890abcdef"
}
```

The portal will automatically fetch the recording from Twilio's API.

---

## Support

If you encounter issues:

1. Check portal backend logs:
   ```bash
   ssh -i ~/Downloads/ReceptionMatebackend.pem ec2-user@18.171.230.217
   pm2 logs backend
   ```

2. Check agent logs for HTTP response codes

3. Test with curl commands above to isolate the issue

4. Verify all environment variables are set correctly

5. Contact the backend team with:
   - Error messages
   - HTTP status codes
   - Example request payload
   - Agent logs

---

## Quick Reference

| What | Value |
|------|-------|
| **Portal API URL** | `http://18.171.230.217:4000/api/calls` |
| **Method** | `POST` |
| **Auth Header** | `X-Webhook-Secret: {your-secret}` |
| **Content Type** | `application/json` |
| **Min Call Duration** | 55 seconds |
| **Success Response** | `201 Created` |
| **Agent Config URL** | `http://18.171.230.217:4000/webhooks/agent-config` |

---

## Checklist for New Agent Integration

- [ ] Set `PORTAL_API_URL` environment variable
- [ ] Set `WEBHOOK_SECRET` environment variable (get from backend team)
- [ ] Set `RECORDING_BASE_URL` (optional)
- [ ] Implement call logging webhook POST request
- [ ] Filter calls under 55 seconds
- [ ] Include all required fields in payload
- [ ] Add optional fields (customer name, phone, VRN, etc.)
- [ ] Test with curl command
- [ ] Verify call appears in portal dashboard
- [ ] Test recording playback (if applicable)
- [ ] Monitor logs for errors
- [ ] Document your implementation

---

## Version History

**v1.0** (February 2026)
- Initial integration guide
- Current production endpoint: `18.171.230.217:4000`
- 55-second minimum call duration requirement
