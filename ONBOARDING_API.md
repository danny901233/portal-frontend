# Onboarding API

Complete business onboarding endpoint.

## Endpoint

**POST** `/api/onboarding/create-business`

**Auth:** `X-API-Key` header required

## Request

```json
{
  "branchName": "Manchester Motors",
  "contactName": "John Smith",
  "contactEmail": "john@example.com",
  "websiteUrl": "https://example.com",
  "agentType": "assist",
  "subscriptionCostGbp": 400,
  "includedMinutes": 400,
  "trialType": "days",
  "trialDays": 14,
  "autoPurchaseTwilioNumber": true,
  "activateTwilio": true
}
```

## Auto-Configured Defaults

- Cost per minute: **£0.25** (always)
- VAT: **20%**
- Greeting: **[timeofday] {branchName}, Leah speaking, how can I help?**
- Tone: **Upbeat**
- Response Speed: **Fast**
- Auto-generated password sent via email

## Response

```json
{
  "success": true,
  "data": {
    "business": { "id": "...", "name": "..." },
    "branch": { "id": "...", "twilioNumber": "+44..." },
    "user": { "id": "...", "email": "...", "temporaryPassword": "..." },
    "billing": { "subscriptionCostGbp": 400, "costPerMinuteGbp": 0.25 }
  }
}
```

See backend logs for details.

## Standard Password

All new users are created with the password: **`Nomoremissedcalls`**

- User must change this on first login (enforced)
- Same password for all onboarded customers (simplifies communication)
- Always included in welcome email

