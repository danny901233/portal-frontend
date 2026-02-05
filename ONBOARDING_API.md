# Automated Onboarding API

## Setup

Add this to your `.env` file:

```bash
ONBOARDING_API_KEY=your-secret-api-key-here
```

Generate a secure key:
```bash
openssl rand -base64 32
```

## API Endpoints

### 1. Complete Onboarding (All-in-One)

**Endpoint**: `POST /admin/onboard`

**Headers**:
```
X-API-Key: your-secret-api-key-here
Content-Type: application/json
```

**Request Body**:
```json
{
  "businessName": "Acme Garage Ltd",
  "branchName": "Main Branch",
  "twilioNumber": "+447700900123",
  "userEmail": "manager@acmegarage.com",
  "userPassword": "temporary123!",
  "userRole": "USER"
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "business": {
    "id": "uuid-here",
    "name": "Acme Garage Ltd"
  },
  "branch": {
    "id": "uuid-here",
    "name": "Main Branch",
    "twilioNumber": "+447700900123"
  },
  "user": {
    "id": "uuid-here",
    "email": "manager@acmegarage.com"
  }
}
```

**What it does**:
1. ✅ Creates business
2. ✅ Creates branch/garage
3. ✅ Creates agent configuration
4. ✅ Provisions SIP trunk via onboarding-service
5. ✅ Creates user account with branch access
6. ✅ Grants admin users access to new branch

---

### 2. Individual Endpoints (Step-by-Step)

#### Create Business
**Endpoint**: `POST /admin/businesses`

**Headers**:
```
X-API-Key: your-secret-api-key-here
Content-Type: application/json
```

**Body**:
```json
{
  "name": "Acme Garage Ltd"
}
```

**Response**:
```json
{
  "business": {
    "id": "uuid-here",
    "name": "Acme Garage Ltd",
    "branches": []
  }
}
```

---

#### Create Branch
**Endpoint**: `POST /admin/businesses/:businessId/branches`

**Body**:
```json
{
  "name": "Main Branch"
}
```

**Response**:
```json
{
  "branch": {
    "id": "uuid-here",
    "name": "Main Branch",
    "businessId": "business-uuid",
    "twilioNumber": "",
    "agentConfiguration": {
      "branchName": "Main Branch",
      "phoneNumber": "",
      "emailAddress": "",
      "callSummaryEmail": "",
      "notificationEmails": []
    }
  }
}
```

---

#### Activate Branch (Provision Phone Number)
**Endpoint**: `POST /admin/garages/:garageId/activate`

**Body**:
```json
{
  "twilioNumber": "+447700900123"
}
```

**Response**:
```json
{
  "success": true,
  "garageId": "uuid-here",
  "twilioNumber": "+447700900123"
}
```

---

#### Create User
**Endpoint**: `POST /admin/users`

**Body**:
```json
{
  "email": "manager@acmegarage.com",
  "password": "temporary123!",
  "role": "USER",
  "garageAccessIds": ["garage-uuid"],
  "branchRoles": {
    "garage-uuid": "MANAGER"
  }
}
```

**Response**:
```json
{
  "user": {
    "id": "uuid-here",
    "email": "manager@acmegarage.com",
    "garageAccessIds": ["garage-uuid"],
    "role": "USER",
    "branchRoles": {
      "garage-uuid": "MANAGER"
    }
  }
}
```

---

## Example Usage

### cURL (Complete Onboarding)
```bash
curl -X POST https://your-domain.com/admin/onboard \
  -H "X-API-Key: your-secret-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Acme Garage Ltd",
    "branchName": "Main Branch",
    "twilioNumber": "+447700900123",
    "userEmail": "manager@acmegarage.com",
    "userPassword": "temporary123!",
    "userRole": "USER"
  }'
```

### JavaScript/TypeScript
```typescript
const response = await fetch('https://your-domain.com/admin/onboard', {
  method: 'POST',
  headers: {
    'X-API-Key': process.env.ONBOARDING_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    businessName: 'Acme Garage Ltd',
    branchName: 'Main Branch',
    twilioNumber: '+447700900123',
    userEmail: 'manager@acmegarage.com',
    userPassword: 'temporary123!',
    userRole: 'USER',
  }),
});

const result = await response.json();
console.log('Onboarding complete:', result);
```

### Python
```python
import requests

response = requests.post(
    'https://your-domain.com/admin/onboard',
    headers={
        'X-API-Key': 'your-secret-api-key-here',
        'Content-Type': 'application/json',
    },
    json={
        'businessName': 'Acme Garage Ltd',
        'branchName': 'Main Branch',
        'twilioNumber': '+447700900123',
        'userEmail': 'manager@acmegarage.com',
        'userPassword': 'temporary123!',
        'userRole': 'USER',
    }
)

result = response.json()
print('Onboarding complete:', result)
```

---

## Security Notes

1. **API Key**: Store in environment variables, never commit to Git
2. **HTTPS Only**: Always use HTTPS in production
3. **Rate Limiting**: Consider adding rate limiting to prevent abuse
4. **IP Whitelisting**: Optionally restrict to known IPs
5. **Audit Logging**: All API key requests are logged

---

## Fallback to JWT

If `X-API-Key` header is not provided or invalid, the endpoints will fall back to standard JWT authentication. This means existing admin users can still use these endpoints with their login tokens.

---

## Error Responses

**401 Unauthorized** - Missing or invalid API key:
```json
{
  "error": "Authorization header missing"
}
```

**400 Bad Request** - Invalid input:
```json
{
  "error": {
    "formErrors": [],
    "fieldErrors": {
      "businessName": ["String must contain at least 1 character(s)"]
    }
  }
}
```

**500 Internal Server Error** - Onboarding failed:
```json
{
  "error": "Onboarding failed",
  "details": "Onboarding service failed: Connection refused"
}
```
