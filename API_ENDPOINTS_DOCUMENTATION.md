# ReceptionMate Portal - Complete API Documentation

**Base URL (Production):** `http://18.171.230.217:4000`  
**Base URL (Local):** `http://localhost:4000`

---

## Table of Contents

1. [Authentication](#authentication)
2. [Calls Management](#calls-management)
3. [Agent Configuration](#agent-configuration)
4. [Admin - Business & Branch Management](#admin---business--branch-management)
5. [Admin - User Management](#admin---user-management)
6. [Admin - Onboarding](#admin---onboarding)
7. [Billing (Admin)](#billing-admin)
8. [Customer Billing](#customer-billing)
9. [Payment Setup](#payment-setup)
10. [Billing Activation](#billing-activation)
11. [Messages & Conversations](#messages--conversations)
12. [SMS Logging](#sms-logging)
13. [Twilio Management](#twilio-management)
14. [OAuth & Social Media](#oauth--social-media)
15. [Onboarding](#onboarding)
16. [Voice/Call Routing](#voicecall-routing)
17. [Agent Configuration Webhook](#agent-configuration-webhook)
18. [Social Connections](#social-connections)
19. [Admin - Facebook Connection](#admin---facebook-connection)
20. [Voice Preview](#voice-preview)
21. [Health Check](#health-check)

---

## Authentication Types

| Type | Description | Header |
|------|-------------|--------|
| **Public** | No authentication required | None |
| **authenticate** | Requires valid JWT token | `Authorization: Bearer <token>` |
| **authenticateApiKey** | Requires API key | `X-API-Key: <api-key>` |
| **requireAdmin** | Requires admin role | JWT + Admin role |
| **requireManager** | Requires manager role | JWT + Manager role |

---

## 1. Authentication

### POST `/api/auth/login`
**Auth:** Public  
**Description:** User login with email and password

**Request Body:**
```json
{
  "email": "string",
  "password": "string"
}
```

**Response:**
```json
{
  "token": "jwt-token",
  "user": {
    "id": "string",
    "email": "string",
    "role": "USER | ADMIN",
    "mustChangePassword": false,
    "mustSetupPayment": false
  }
}
```

---

### POST `/api/auth/request-password-reset`
**Auth:** Public  
**Description:** Request password reset email with magic link

**Request Body:**
```json
{
  "email": "string"
}
```

---

### POST `/api/auth/reset-password`
**Auth:** Public  
**Description:** Reset password using token from email

**Request Body:**
```json
{
  "token": "string",
  "newPassword": "string"
}
```

---

### POST `/api/auth/verify-magic-link`
**Auth:** Public  
**Description:** Verify magic link token and return JWT

**Request Body:**
```json
{
  "token": "string"
}
```

---

## 2. Calls Management

### POST `/api/calls`
**Auth:** Public (Webhook)  
**Description:** Create or update call record (used by agent webhook)

**Request Body:**
```json
{
  "garageId": "string",
  "callId": "string",
  "status": "in-progress | completed | failed",
  "startTime": "ISO8601",
  "endTime": "ISO8601",
  "duration": "number",
  "customerName": "string",
  "customerPhone": "string",
  "summary": "string",
  "transcript": "string"
}
```

---

### GET `/api/calls`
**Auth:** authenticate  
**Description:** Get all calls for user's accessible garages with filters

**Query Parameters:**
- `garageId` (optional) - Filter by garage
- `startDate` (optional) - Filter from date (ISO8601)
- `endDate` (optional) - Filter to date (ISO8601)
- `status` (optional) - Filter by status
- `page` (optional) - Page number (default: 1)
- `limit` (optional) - Items per page (default: 50)

**Response:**
```json
{
  "calls": [...],
  "total": 100,
  "page": 1,
  "limit": 50
}
```

---

### GET `/api/calls/:id`
**Auth:** authenticate  
**Description:** Get single call details by ID

**Response:**
```json
{
  "id": "string",
  "garageId": "string",
  "callId": "string",
  "status": "string",
  "startTime": "ISO8601",
  "endTime": "ISO8601",
  "duration": 120,
  "customerName": "string",
  "customerPhone": "string",
  "summary": "string",
  "transcript": "string",
  "recordingUrl": "string"
}
```

---

### GET `/api/calls-summary`
**Auth:** authenticate  
**Description:** Get call statistics summary for dashboard

**Query Parameters:**
- `garageId` (optional) - Filter by garage
- `startDate` (optional) - From date
- `endDate` (optional) - To date

**Response:**
```json
{
  "totalCalls": 150,
  "completedCalls": 120,
  "missedCalls": 30,
  "averageDuration": 180,
  "totalDuration": 21600,
  "bookingsMade": 45
}
```

---

### POST `/api/calls/:id/feedback`
**Auth:** authenticate  
**Description:** Submit feedback for a call

**Request Body:**
```json
{
  "rating": 1-5,
  "comment": "string (optional)"
}
```

---

### GET `/api/calls/:id/recording`
**Auth:** authenticate  
**Description:** Get call recording metadata

**Response:**
```json
{
  "callId": "string",
  "recordingUrl": "string",
  "duration": 120,
  "format": "mp3"
}
```

---

### GET `/api/calls/:id/recording/audio`
**Auth:** Public (signed URL)  
**Description:** Stream/download call recording audio file

**Response:** Audio file stream (audio/mpeg)

---

### GET `/api/calls/export/csv`
**Auth:** authenticate  
**Description:** Export calls to CSV file

**Query Parameters:**
- `garageId` (optional)
- `startDate` (optional)
- `endDate` (optional)

**Response:** CSV file download

---

### GET `/api/garages`
**Auth:** authenticate  
**Description:** Get all garages user has access to

**Response:**
```json
{
  "garages": [
    {
      "id": "string",
      "name": "string",
      "businessId": "string",
      "twilioNumber": "string",
      "subscriptionCostGbp": 400,
      "includedMinutes": 400
    }
  ]
}
```

---

## 3. Agent Configuration

### GET `/api/agent-config`
**Auth:** authenticate  
**Description:** Get agent configuration for user's garage

**Query Parameters:**
- `garageId` (required)

**Response:**
```json
{
  "id": "string",
  "garageId": "string",
  "branchName": "string",
  "phoneNumber": "string",
  "emailAddress": "string",
  "branchAddress": "string",
  "websiteUrl": "string",
  "weeklyOpeningHours": {},
  "greetingLine": "string",
  "tonePreference": "upbeat | standard | professional",
  "responseSpeed": "fast | normal | slow",
  "interruptionSensitivity": 0.3,
  "agentType": "assist | automate",
  "enableSmsBookingLinks": true
}
```

---

### PUT `/api/agent-config`
**Auth:** authenticate  
**Description:** Update agent configuration

**Request Body:** (any fields to update)
```json
{
  "garageId": "string (required)",
  "greetingLine": "string",
  "tonePreference": "upbeat | standard | professional",
  "responseSpeed": "fast | normal | slow",
  "agentType": "assist | automate",
  "notificationEmails": ["email1", "email2"]
}
```

---

### POST `/api/scan-website`
**Auth:** authenticate  
**Description:** Scan business website for contact info and opening hours

**Request Body:**
```json
{
  "garageId": "string",
  "websiteUrl": "string"
}
```

**Response:**
```json
{
  "phoneNumber": "string",
  "emailAddress": "string",
  "branchAddress": "string",
  "openingHours": {
    "monday": { "open": "09:00", "close": "17:00" }
  }
}
```

---

### POST `/api/voice/preview`
**Auth:** authenticate  
**Description:** Generate preview of agent voice with custom settings

**Request Body:**
```json
{
  "text": "string",
  "tonePreference": "upbeat | standard | professional",
  "responseSpeed": "fast | normal | slow"
}
```

**Response:**
```json
{
  "audioUrl": "string (signed URL)"
}
```

---

## 4. Admin - Business & Branch Management

### GET `/api/admin/businesses`
**Auth:** authenticate + requireAdmin  
**Description:** Get all businesses

**Response:**
```json
{
  "businesses": [
    {
      "id": "string",
      "name": "string",
      "contactName": "string",
      "contactEmail": "string",
      "contactPhone": "string",
      "contactRole": "Owner",
      "garages": [...]
    }
  ]
}
```

---

### POST `/api/admin/businesses`
**Auth:** authenticateApiKey + requireAdmin  
**Description:** Create new business

**Request Body:**
```json
{
  "name": "string",
  "contactName": "string",
  "contactEmail": "string",
  "contactPhone": "string",
  "contactRole": "string"
}
```

---

### PATCH `/api/admin/businesses/:businessId/contact`
**Auth:** authenticateApiKey + requireAdmin  
**Description:** Update business contact information

**Request Body:**
```json
{
  "contactName": "string (optional)",
  "contactEmail": "string (optional)",
  "contactPhone": "string (optional)",
  "contactRole": "string (optional)"
}
```

---

### POST `/api/admin/businesses/:businessId/branches`
**Auth:** authenticateApiKey + requireAdmin  
**Description:** Create new branch for a business

**Request Body:**
```json
{
  "name": "string",
  "twilioNumber": "string (optional)",
  "subscriptionCostGbp": 400,
  "includedMinutes": 400
}
```

---

### POST `/api/admin/garages/:garageId/activate`
**Auth:** authenticateApiKey + requireAdmin  
**Description:** Manually activate subscription for a garage (skip trial)

---

### PUT `/api/admin/garages/:garageId/twilio-number`
**Auth:** authenticate + requireAdmin  
**Description:** Update Twilio phone number for a garage

**Request Body:**
```json
{
  "twilioNumber": "string"
}
```

---

### GET `/api/admin/twilio-number`
**Auth:** authenticate + requireAdmin  
**Description:** Get available Twilio numbers for assignment

**Query Parameters:**
- `garageId` (optional) - Check number for specific garage

---

### DELETE `/api/admin/businesses/:businessId`
**Auth:** authenticate + requireAdmin  
**Description:** Delete business and all associated branches

---

### DELETE `/api/admin/branches/:branchId`
**Auth:** authenticate + requireAdmin  
**Description:** Delete specific branch/garage

---

### GET `/api/admin/users`
**Auth:** authenticate + requireAdmin  
**Description:** Get all users in the system

---

### PATCH `/api/admin/invoices/:invoiceId/status`
**Auth:** authenticate + requireAdmin  
**Description:** Update invoice status

**Request Body:**
```json
{
  "status": "pending | paid | failed | cancelled"
}
```

---

## 5. Admin - User Management

### POST `/api/admin/users`
**Auth:** authenticateApiKey + requireAdmin  
**Description:** Create new user account

**Request Body:**
```json
{
  "email": "string",
  "password": "string",
  "garageAccessIds": ["garage-id"],
  "role": "USER | ADMIN",
  "branchRoles": { "garage-id": "MANAGER" }
}
```

---

### DELETE `/api/admin/users/:userId`
**Auth:** authenticate + requireAdmin  
**Description:** Delete user account

---

### PUT `/api/admin/users/:userId`
**Auth:** authenticate + requireAdmin  
**Description:** Update user details

**Request Body:**
```json
{
  "email": "string (optional)",
  "role": "USER | ADMIN (optional)",
  "garageAccessIds": ["garage-id"] (optional),
  "mustChangePassword": false (optional)
}
```

---

### GET `/api/admin/users`
**Auth:** authenticate + requireAdmin  
**Description:** List all users with their access rights

---

## 6. Admin - Onboarding

### POST `/api/admin/onboard`
**Auth:** authenticateApiKey + requireAdmin  
**Description:** Complete onboarding flow (alternative to /api/onboarding/create-business)

**Request Body:**
```json
{
  "branchName": "string",
  "contactName": "string",
  "contactEmail": "string",
  "websiteUrl": "string",
  "agentType": "assist | automate",
  "subscriptionCostGbp": 400,
  "includedMinutes": 400,
  "trialType": "days | bookings (optional)",
  "trialDays": 14 (optional),
  "requireBookings": 4 (optional)
}
```

---

## 7. Billing (Admin)

### GET `/api/billing/usage`
**Auth:** authenticate + requireAdmin  
**Description:** Get billing usage for a garage

**Query Parameters:**
- `garageId` (required)
- `startDate` (optional)
- `endDate` (optional)

**Response:**
```json
{
  "garageId": "string",
  "totalMinutes": 450,
  "includedMinutes": 400,
  "overageMinutes": 50,
  "costPerMinute": 0.25,
  "overageCost": 12.50,
  "subscriptionCost": 400,
  "totalCost": 412.50,
  "vatAmount": 82.50,
  "totalWithVat": 495.00
}
```

---

### PUT `/api/billing/usage`
**Auth:** authenticate + requireAdmin  
**Description:** Update billing usage record

---

### GET `/api/billing/invoices`
**Auth:** authenticate + requireAdmin  
**Description:** Get all invoices (admin view)

**Query Parameters:**
- `garageId` (optional)
- `status` (optional) - pending, paid, failed, cancelled
- `startDate` (optional)
- `endDate` (optional)

---

### POST `/api/billing/invoices`
**Auth:** authenticate + requireAdmin  
**Description:** Manually create invoice for a garage

**Request Body:**
```json
{
  "garageId": "string",
  "periodStart": "ISO8601",
  "periodEnd": "ISO8601",
  "totalMinutes": 450,
  "includedMinutes": 400,
  "overageMinutes": 50
}
```

---

### POST `/api/billing/invoices/:invoiceId/process-payment`
**Auth:** authenticate + requireAdmin  
**Description:** Process payment for an invoice via GoCardless

---

### GET `/api/billing/payment-history`
**Auth:** authenticate + requireAdmin  
**Description:** Get payment history for a garage

**Query Parameters:**
- `garageId` (required)

---

### GET `/api/billing/upcoming-invoices`
**Auth:** authenticate + requireAdmin  
**Description:** Get upcoming invoices due for generation

---

### POST `/api/billing/generate-invoices`
**Auth:** authenticate + requireAdmin  
**Description:** Manually trigger invoice generation for all garages

---

### GET `/api/billing/subscription-status`
**Auth:** authenticate + requireAdmin  
**Description:** Check subscription status for a garage

**Query Parameters:**
- `garageId` (required)

**Response:**
```json
{
  "garageId": "string",
  "isActive": true,
  "trialEndDate": "ISO8601 (optional)",
  "requiresBookingActivation": false,
  "bookingsRequired": 0,
  "currentBookings": 0,
  "subscriptionActivatedAt": "ISO8601 (optional)"
}
```

---

### POST `/api/billing/trial/extend`
**Auth:** authenticate + requireAdmin  
**Description:** Extend trial period for a garage

**Request Body:**
```json
{
  "garageId": "string",
  "additionalDays": 7
}
```

---

### POST `/api/billing/trial/end`
**Auth:** authenticate + requireAdmin  
**Description:** Manually end trial and activate billing

**Request Body:**
```json
{
  "garageId": "string"
}
```

---

### DELETE `/api/admin/invoices/:invoiceId`
**Auth:** authenticate + requireAdmin  
**Description:** Delete an invoice

---

### POST `/api/admin/invoices/:invoiceId/credit`
**Auth:** authenticate + requireAdmin  
**Description:** Issue credit note for an invoice

**Request Body:**
```json
{
  "amount": 100.00,
  "reason": "string"
}
```

---

### POST `/api/billing/trigger-invoice-generation`
**Auth:** authenticate + requireAdmin  
**Description:** Trigger monthly invoice generation job manually

---

## 8. Customer Billing

### GET `/api/customer/billing/invoices`
**Auth:** authenticate + requireManager  
**Description:** Get invoices for customer's garages

**Query Parameters:**
- `garageId` (optional)
- `status` (optional)

---

### GET `/api/customer/billing/invoices/:invoiceId/pdf`
**Auth:** authenticate + requireManager  
**Description:** Download invoice as PDF

**Response:** PDF file stream

---

### GET `/api/customer/billing/business-info`
**Auth:** authenticate + requireManager  
**Description:** Get business billing information

**Response:**
```json
{
  "businessName": "string",
  "contactName": "string",
  "contactEmail": "string",
  "billingAddress": "string",
  "vatNumber": "string (optional)"
}
```

---

### PUT `/api/customer/billing/business-info`
**Auth:** authenticate + requireManager  
**Description:** Update business billing information

**Request Body:**
```json
{
  "businessName": "string (optional)",
  "contactName": "string (optional)",
  "billingAddress": "string (optional)",
  "vatNumber": "string (optional)"
}
```

---

### GET `/api/customer/billing/mandate-status`
**Auth:** authenticate + requireManager  
**Description:** Check GoCardless Direct Debit mandate status

**Response:**
```json
{
  "hasMandateSetup": true,
  "mandateStatus": "active | pending | cancelled",
  "gocardlessMandateId": "string",
  "gocardlessCustomerId": "string"
}
```

---

## 9. Payment Setup

### POST `/api/payment/create-mandate-flow`
**Auth:** authenticate  
**Description:** Start GoCardless Direct Debit setup flow

**Response:**
```json
{
  "redirectUrl": "string (GoCardless checkout URL)",
  "flowId": "string"
}
```

---

### POST `/api/payment/confirm-mandate`
**Auth:** authenticate  
**Description:** Confirm mandate setup after customer completes GoCardless flow

**Request Body:**
```json
{
  "flowId": "string"
}
```

---

### GET `/api/payment/mandate-status`
**Auth:** authenticate  
**Description:** Get current mandate status for user

---

### POST `/api/payment/update-mandate-flow`
**Auth:** authenticate  
**Description:** Start flow to update existing Direct Debit mandate

---

### POST `/api/payment/confirm-mandate-update`
**Auth:** authenticate  
**Description:** Confirm mandate update after customer completes flow

---

## 10. Billing Activation

### POST `/api/admin/activate-billing/:userId`
**Auth:** authenticate + requireAdmin  
**Description:** Manually activate billing for a user (bypass trial)

---

### GET `/api/admin/users-pending-billing`
**Auth:** authenticate + requireAdmin  
**Description:** Get list of users whose trial has ended but billing not activated

---

### GET `/api/admin/users-without-mandate`
**Auth:** authenticate + requireAdmin  
**Description:** Get users who haven't set up Direct Debit mandate

---

### POST `/api/admin/request-direct-debit/:userId`
**Auth:** authenticate + requireAdmin  
**Description:** Send reminder email to user to set up Direct Debit

---

## 11. Messages & Conversations

### GET `/api/messages/platforms`
**Auth:** authenticate  
**Description:** Get connected messaging platforms for garage

**Query Parameters:**
- `garageId` (required)

**Response:**
```json
{
  "platforms": [
    {
      "platform": "whatsapp | facebook | instagram",
      "isConnected": true,
      "phoneNumber": "string (for WhatsApp)",
      "pageId": "string (for Facebook/Instagram)"
    }
  ]
}
```

---

### GET `/api/messages/conversations`
**Auth:** authenticate  
**Description:** Get all conversations for a garage

**Query Parameters:**
- `garageId` (required)
- `platform` (optional) - whatsapp, facebook, instagram
- `status` (optional) - active, archived
- `page` (optional)
- `limit` (optional)

---

### GET `/api/messages/conversations/:conversationId`
**Auth:** authenticate  
**Description:** Get specific conversation with all messages

---

### GET `/api/messages/conversations/:conversationId/messages`
**Auth:** authenticate  
**Description:** Get messages for a conversation (paginated)

**Query Parameters:**
- `page` (optional)
- `limit` (optional)

---

### GET `/api/messages/unread-count`
**Auth:** authenticate  
**Description:** Get unread message count per platform

**Query Parameters:**
- `garageId` (required)

**Response:**
```json
{
  "whatsapp": 5,
  "facebook": 2,
  "instagram": 0,
  "total": 7
}
```

---

### GET `/api/messages/customer/:customerId`
**Auth:** authenticate  
**Description:** Get all conversations for a specific customer across platforms

---

### POST `/api/messages/send`
**Auth:** authenticate  
**Description:** Send message to customer

**Request Body:**
```json
{
  "conversationId": "string",
  "message": "string",
  "platform": "whatsapp | facebook | instagram"
}
```

---

### PATCH `/api/messages/conversations/:conversationId/read`
**Auth:** authenticate  
**Description:** Mark conversation as read

---

### PATCH `/api/messages/conversations/:conversationId/archive`
**Auth:** authenticate  
**Description:** Archive conversation

---

### PATCH `/api/messages/conversations/:conversationId/unarchive`
**Auth:** authenticate  
**Description:** Unarchive conversation

---

### PATCH `/api/messages/:messageId/read`
**Auth:** authenticate  
**Description:** Mark specific message as read

---

## 12. SMS Logging

### POST `/api/sms/log`
**Auth:** authenticateApiKey  
**Description:** Log SMS sent by agent for billing purposes

**Request Body:**
```json
{
  "garageId": "string",
  "customerId": "string",
  "phoneNumber": "string",
  "message": "string",
  "direction": "outbound | inbound",
  "timestamp": "ISO8601"
}
```

---

### GET `/api/sms/history`
**Auth:** authenticate  
**Description:** Get SMS history for a garage

**Query Parameters:**
- `garageId` (required)
- `startDate` (optional)
- `endDate` (optional)
- `page` (optional)
- `limit` (optional)

---

### GET `/api/sms/billing-summary`
**Auth:** authenticate  
**Description:** Get SMS billing summary

**Query Parameters:**
- `garageId` (required)
- `month` (optional) - YYYY-MM format

**Response:**
```json
{
  "totalSms": 150,
  "costPerSms": 0.05,
  "totalCost": 7.50
}
```

---

## 13. Twilio Management

### POST `/api/admin/twilio/available-numbers`
**Auth:** authenticateApiKey + requireAdmin  
**Description:** Search for available Twilio phone numbers

**Request Body:**
```json
{
  "areaCode": "string (optional)",
  "contains": "string (optional)",
  "country": "GB (default)"
}
```

**Response:**
```json
{
  "numbers": [
    {
      "phoneNumber": "+441234567890",
      "friendlyName": "string",
      "locality": "London"
    }
  ]
}
```

---

### POST `/api/admin/twilio/purchase`
**Auth:** authenticateApiKey + requireAdmin  
**Description:** Purchase a specific Twilio phone number

**Request Body:**
```json
{
  "phoneNumber": "+441234567890"
}
```

---

## 14. OAuth & Social Media

### POST `/api/oauth/meta/initiate`
**Auth:** authenticate  
**Description:** Initiate Meta (Facebook/Instagram/WhatsApp) OAuth flow

**Request Body:**
```json
{
  "garageId": "string",
  "platform": "whatsapp | facebook | instagram"
}
```

**Response:**
```json
{
  "authUrl": "string (redirect user to this URL)"
}
```

---

### GET `/api/oauth/meta/callback`
**Auth:** Public (OAuth callback)  
**Description:** Meta OAuth callback handler (redirects back to portal)

**Query Parameters:**
- `code` - OAuth authorization code
- `state` - State parameter with garageId and platform

---

### GET `/api/social-connections`
**Auth:** authenticate  
**Description:** Get all social media connections for a garage

**Query Parameters:**
- `garageId` (required)

**Response:**
```json
{
  "connections": [
    {
      "platform": "whatsapp | facebook | instagram",
      "isConnected": true,
      "accountName": "string",
      "connectedAt": "ISO8601"
    }
  ]
}
```

---

### DELETE `/api/social-connections/:connectionId`
**Auth:** authenticate  
**Description:** Disconnect social media account

---

## 15. Onboarding

### POST `/api/onboarding/create-business`
**Auth:** authenticateApiKey  
**Description:** Complete business onboarding (creates business, garage, agent config, user)

**Request Body:**
```json
{
  "branchName": "string",
  "contactName": "string",
  "contactEmail": "string",
  "websiteUrl": "string",
  "agentType": "assist | automate",
  "subscriptionCostGbp": 400,
  "includedMinutes": 400,
  "trialType": "days | bookings (optional)",
  "trialDays": 14 (optional),
  "requireBookings": 4 (optional),
  "autoPurchaseTwilioNumber": true (default),
  "activateTwilio": true (default)
}
```

---

### POST `/api/onboarding/complete`
**Auth:** authenticateApiKey  
**Description:** Mark onboarding as complete (legacy endpoint)

---

### POST `/api/onboarding/user`
**Auth:** authenticateApiKey  
**Description:** Create user account during onboarding

**Request Body:**
```json
{
  "email": "string",
  "garageAccessIds": ["garage-id"],
  "role": "USER",
  "branchRoles": { "garage-id": "MANAGER" }
}
```

---

### GET `/api/onboarding/status`
**Auth:** authenticate  
**Description:** Get onboarding status for current user

**Response:**
```json
{
  "setupWizardCompleted": false,
  "mustChangePassword": true,
  "mustSetupPayment": true
}
```

---

### POST `/api/onboarding/wizard-complete`
**Auth:** authenticate  
**Description:** Mark setup wizard as completed

---

### GET `/api/onboarding/initial-data`
**Auth:** authenticate  
**Description:** Get initial data for onboarding wizard

**Response:**
```json
{
  "garages": [...],
  "agentConfig": {...},
  "businessInfo": {...}
}
```

---

## 16. Voice/Call Routing

### POST `/webhooks/voice`
**Auth:** Public (Twilio webhook)  
**Description:** Twilio webhook for incoming call routing (generates TwiML)

**Request Body:** (Twilio webhook format)

**Response:** TwiML XML for call routing

---

### POST `/webhooks/recording-status`
**Auth:** Public (Twilio webhook)  
**Description:** Twilio callback for recording status updates

---

## 17. Agent Configuration Webhook

### POST `/webhooks/agent-config`
**Auth:** Public (internal webhook)  
**Description:** Webhook for agent to fetch configuration during call

**Request Body:**
```json
{
  "garageId": "string"
}
```

**Response:**
```json
{
  "agentConfig": {...}
}
```

---

## 18. Social Connections

### GET `/api/social-connections`
**Auth:** authenticate  
**Description:** Get social media connections (same as OAuth section)

---

### DELETE `/api/social-connections/:connectionId`
**Auth:** authenticate  
**Description:** Disconnect social media account (same as OAuth section)

---

## 19. Admin - Facebook Connection

### POST `/api/admin/create-fb-connection`
**Auth:** Public (diagnostic endpoint)  
**Description:** Create Facebook Messenger connection (for testing/diagnostics)

---

## 20. Voice Preview

### POST `/api/voice/preview`
**Auth:** authenticate  
**Description:** Generate voice preview with custom settings (same as Agent Configuration section)

---

## 21. Health Check

### GET `/health`
**Auth:** Public  
**Description:** Health check endpoint

**Response:**
```json
{
  "status": "ok",
  "timestamp": "ISO8601"
}
```

---

## Important Notes

### Agent Types
- **assist**: Agent collects information and hands off to human for booking
- **automate**: Agent handles complete booking process autonomously

### Call Statuses
- **in-progress**: Call is ongoing
- **completed**: Call finished successfully
- **failed**: Call failed or was missed
- **no-answer**: Customer didn't answer

### Messaging Platforms
- **whatsapp**: WhatsApp Business API
- **facebook**: Facebook Messenger
- **instagram**: Instagram Direct Messages

### User Roles
- **USER**: Standard user with branch access
- **ADMIN**: Full system administrator

### Branch Roles
- **MANAGER**: Branch manager (can view billing, manage settings)
- **VIEWER**: Read-only access to branch data

### Trial Types
- **days**: Trial ends after N days
- **bookings**: Trial ends after N successful bookings

### Invoice Statuses
- **pending**: Invoice generated, payment not yet attempted
- **paid**: Successfully paid
- **failed**: Payment failed
- **cancelled**: Invoice cancelled/voided

---

## Webhooks

The system receives webhooks from:
- **Twilio**: Voice calls, recordings, SMS
- **Meta (WhatsApp)**: Message delivery, status updates
- **Meta (Facebook)**: Messenger messages
- **Meta (Instagram)**: Instagram DMs
- **GoCardless**: Payment status, mandate updates

---

## Rate Limiting

All authenticated endpoints have rate limiting:
- **100 requests per minute** for regular users
- **1000 requests per minute** for admin users
- **No limit** for API key authenticated requests (internal services)

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "error": "Error message",
  "message": "Detailed explanation (optional)",
  "code": "ERROR_CODE (optional)"
}
```

Common HTTP status codes:
- **200**: Success
- **201**: Created
- **400**: Bad request (validation error)
- **401**: Unauthorized (missing/invalid token)
- **403**: Forbidden (insufficient permissions)
- **404**: Not found
- **500**: Internal server error
