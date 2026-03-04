# ReceptionMate Portal - API Endpoints Documentation

Complete list of all API endpoints in the ReceptionMate portal backend, organized by category.

---

## Authentication

### POST `/api/login`
- **Auth**: Public
- **Description**: Authenticate user and receive JWT token
- **Body**: `{ email, password, garageId? }`

### POST `/api/request-password-reset`
- **Auth**: Public
- **Description**: Request a password reset link via email
- **Body**: `{ email }`

### POST `/api/reset-password`
- **Auth**: Public
- **Description**: Reset password using reset token
- **Body**: `{ token, password }`

### POST `/api/verify-magic-link`
- **Auth**: Public
- **Description**: Verify magic link token and auto-login user
- **Body**: `{ token }`

---

## Calls Management

### POST `/api/calls`
- **Auth**: Webhook (webhook secret via header)
- **Description**: Create a new call record from agent webhook
- **Body**: Call data including duration, transcript, metrics, etc.

### GET `/api/garages/:garageId/calls`
- **Auth**: `authenticate`
- **Description**: List calls for a garage with optional filters
- **Query**: `callType`, `startDate`, `endDate`, `garageIds`

### GET `/api/garages/:garageId/calls/:callId`
- **Auth**: `authenticate`
- **Description**: Get single call details

### POST `/api/garages/:garageId/calls/:callId/feedback`
- **Auth**: `authenticate`
- **Description**: Submit or update feedback for a call
- **Body**: `{ rating: 'up' | 'down', reasons?, notes? }`

### GET `/api/garages/:garageId/confirmed-bookings.csv`
- **Auth**: `authenticate`
- **Description**: Export confirmed bookings as CSV
- **Query**: `startDate`, `endDate`, `garageIds`

### GET `/api/calls/:id/recording`
- **Auth**: `authenticate`
- **Description**: Get recording URL for a specific call

### GET `/api/calls/:id/recording/audio`
- **Auth**: Public (call ID provides security)
- **Description**: Stream recording audio (MP3) from Twilio

### GET `/api/garages`
- **Auth**: `authenticate`
- **Description**: List all garages accessible to the user

---

## Agent Configuration

### GET `/api/garages/:garageId/agent-config`
- **Auth**: `authenticate`
- **Description**: Get agent configuration and knowledge base for a garage

### PUT `/api/garages/:garageId/agent-config`
- **Auth**: `authenticate`
- **Description**: Update agent configuration
- **Body**: Configuration object with branch details, opening hours, settings, etc.

### POST `/api/garages/:garageId/website-scan`
- **Auth**: `authenticate`
- **Description**: Scan website and extract knowledge base
- **Body**: `{ url, selectedUrls? }`

### POST `/api/garages/:garageId/voice-preview`
- **Auth**: `authenticate`
- **Description**: Generate voice preview using ElevenLabs
- **Body**: `{ voiceId }`

---

## Admin - Business & Branch Management

### GET `/api/admin/businesses`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: List all businesses with branches

### POST `/api/admin/businesses`
- **Auth**: `authenticateApiKey`, `requireAdmin`
- **Description**: Create a new business
- **Body**: `{ name }`

### PATCH `/api/admin/businesses/:businessId/contact`
- **Auth**: `authenticateApiKey`, `requireAdmin`
- **Description**: Update business contact details
- **Body**: `{ contactName?, contactEmail?, contactPhone?, contactRole? }`

### DELETE `/api/admin/businesses/:businessId`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Delete a business and all its branches

### POST `/api/admin/businesses/:businessId/branches`
- **Auth**: `authenticateApiKey`, `requireAdmin`
- **Description**: Create a new branch for a business
- **Body**: `{ name }`

### DELETE `/api/admin/branches/:branchId`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Delete a branch

### POST `/api/admin/garages/:garageId/activate`
- **Auth**: `authenticateApiKey`, `requireAdmin`
- **Description**: Activate garage with Twilio provisioning
- **Body**: `{ twilioNumber }`

### PUT `/api/admin/garages/:garageId/twilio-number`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Update Twilio number for a garage
- **Body**: `{ twilioNumber }`

### GET `/api/admin/twilio-number`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Get Twilio number (fallback to first garage)

### PATCH `/api/garages/:garageId/messaging-access`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Toggle messaging subscription for a garage
- **Body**: `{ hasMessagingAccess: boolean }`

---

## Admin - User Management

### GET `/api/admin/users`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: List all users

### POST `/api/admin/users`
- **Auth**: `authenticateApiKey`, `requireAdmin`
- **Description**: Create a new user
- **Body**: `{ email, password, role, garageAccessIds, branchRoles? }`

### PUT `/api/admin/users/:userId`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Update user details
- **Body**: `{ password?, role?, garageAccessIds?, branchRoles?, mustSetupPayment? }`

### DELETE `/api/admin/users/:userId`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Delete a user

---

## Admin - Onboarding

### POST `/api/admin/onboard`
- **Auth**: `authenticateApiKey`, `requireAdmin`
- **Description**: Complete end-to-end onboarding (business, branch, user, Twilio)
- **Body**: `{ businessName, branchName, twilioNumber?, userEmail, userPassword?, userRole? }`

---

## Billing (Staff Only)

### GET `/api/billing/garages/:garageId/config`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Get billing configuration for a garage

### PUT `/api/billing/garages/:garageId/config`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Update billing configuration
- **Body**: `{ subscriptionCostGbp, includedMinutes, costPerMinuteGbp, vatRate, trialDays?, requiresBookingActivation?, bookingsRequiredForActivation? }`

### GET `/api/billing/garages/:garageId/usage`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Calculate current usage for a period
- **Query**: `startDate`, `endDate`

### POST `/api/billing/invoices/generate`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Generate invoice for a garage
- **Body**: `{ garageId, periodStart, periodEnd }`

### POST `/api/billing/invoices/generate-batch`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Generate invoices for all garages for a period
- **Body**: `{ periodStart, periodEnd }`

### GET `/api/billing/invoices`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: List all invoices with filters
- **Query**: `garageId?`, `status?`, `limit?`

### GET `/api/billing/invoices/:invoiceId`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Get single invoice details

### POST `/api/billing/invoices/:invoiceId/charge`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Create GoCardless payment for an invoice

### GET `/api/billing/users-due`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Get users due for billing

### POST `/api/billing/process-monthly`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Process monthly billing for all users due

### POST `/api/billing/users/:userId/generate-invoices`
- **Auth**: `authenticate`, `requireStaff`
- **Description**: Generate invoices for a specific user

### POST `/api/admin/billing/trigger-invoice-generation`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Manually trigger invoice generation for a garage
- **Body**: `{ garageId }`

### DELETE `/api/admin/invoices/:invoiceId`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Delete an invoice (admin only)

### POST `/api/admin/invoices/:invoiceId/credit`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Credit/void an invoice
- **Body**: `{ reason }`

---

## Customer Billing

### GET `/api/customer/billing/invoices`
- **Auth**: `authenticate`, `requireManager`
- **Description**: List invoices for user's managed garages
- **Query**: `garageId?`

### GET `/api/customer/billing/invoices/:invoiceId/pdf`
- **Auth**: `authenticate`, `requireManager`
- **Description**: Download invoice as PDF

### GET `/api/customer/billing/business-info`
- **Auth**: `authenticate`, `requireManager`
- **Description**: Get business billing information

### PUT `/api/customer/billing/business-info`
- **Auth**: `authenticate`, `requireManager`
- **Description**: Update business billing information
- **Body**: `{ billingAddress?, billingCity?, billingPostcode?, billingCountry?, vatNumber?, companyRegNumber?, billingEmail? }`

### GET `/api/customer/billing/mandate-status`
- **Auth**: `authenticate`, `requireManager`
- **Description**: Get Direct Debit mandate status
- **Query**: `garageId?`

---

## Payment Setup (GoCardless)

### POST `/api/payment/create-mandate-flow`
- **Auth**: `authenticate`
- **Description**: Create GoCardless redirect flow for mandate setup

### POST `/api/payment/confirm-mandate`
- **Auth**: `authenticate`
- **Description**: Complete mandate setup after GoCardless redirect
- **Body**: `{ redirectFlowId }`

### GET `/api/payment/mandate-status`
- **Auth**: `authenticate`
- **Description**: Get current mandate status for user

### POST `/api/payment/update-mandate-flow`
- **Auth**: `authenticate`
- **Description**: Create redirect flow to update payment method

### POST `/api/payment/confirm-mandate-update`
- **Auth**: `authenticate`
- **Description**: Complete mandate update after redirect
- **Body**: `{ redirectFlowId }`

---

## Billing Activation

### POST `/api/admin/activate-billing/:userId`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Activate billing for a user (charge first month)

### GET `/api/admin/users-pending-billing`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Get users with mandates but no billing dates

### GET `/api/admin/users-without-mandate`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Get users without GoCardless mandates

### POST `/api/admin/request-direct-debit/:userId`
- **Auth**: `authenticate`, `requireAdmin`
- **Description**: Send Direct Debit request email to a user

---

## Messages & Conversations

### GET `/api/garages/:garageId/messaging-access`
- **Auth**: `authenticate`
- **Description**: Check if garage has messaging access

### GET `/api/garages/:garageId/messages/needs-attention-count`
- **Auth**: `authenticate`
- **Description**: Get count of messages needing attention

### GET `/api/garages/:garageId/message-stats`
- **Auth**: `authenticate`
- **Description**: Get message statistics by platform
- **Query**: `startDate?`, `endDate?`

### GET `/api/garages/:garageId/message-stats/csv`
- **Auth**: `authenticate`
- **Description**: Download message statistics as CSV
- **Query**: `startDate?`, `endDate?`

### GET `/api/garages/:garageId/conversations`
- **Auth**: `authenticate`, `requireMessagingAccess`
- **Description**: List conversations with filters
- **Query**: `platform?`, `status?`

### GET `/api/conversations/:conversationId`
- **Auth**: `authenticate`
- **Description**: Get single conversation with all messages

### POST `/api/conversations/:conversationId/messages`
- **Auth**: `authenticate`
- **Description**: Send manual message in a conversation
- **Body**: `{ content }`

### PATCH `/api/conversations/:conversationId`
- **Auth**: `authenticate`
- **Description**: Update conversation status
- **Body**: `{ status?, unreadCount? }`

### PATCH `/api/conversations/:conversationId/tags`
- **Auth**: `authenticate`
- **Description**: Update conversation tags/metadata
- **Body**: `{ messageType?, confirmedBooking?, confirmedBookingCategory?, capturedRevenue?, bookingDetails?, tags? }`

### PATCH `/api/conversations/:conversationId/agent`
- **Auth**: `authenticate`
- **Description**: Toggle agent pause/resume
- **Body**: `{ agentPaused: boolean, pauseDurationHours? }`

### PATCH `/api/conversations/:conversationId/flag`
- **Auth**: `authenticate`
- **Description**: Toggle needs attention flag
- **Body**: `{ needsAttention: boolean }`

---

## SMS Logging

### POST `/api/sms/log`
- **Auth**: `authenticateApiKey`
- **Description**: Log an SMS booking link send (called by agent)
- **Body**: `{ garageId, phoneNumber, twilioMessageSid?, status? }`

### GET `/api/garages/:garageId/sms-stats`
- **Auth**: `authenticate`
- **Description**: Get SMS statistics for billing
- **Query**: `startDate?`, `endDate?`

### GET `/api/garages/:garageId/sms-stats/csv`
- **Auth**: `authenticate`
- **Description**: Download SMS log as CSV for billing
- **Query**: `startDate?`, `endDate?`

---

## Twilio Management

### POST `/api/admin/twilio/available-numbers`
- **Auth**: `authenticateApiKey`, `requireAdmin`
- **Description**: Search for available Twilio numbers
- **Body**: `{ areaCode?, countryCode?, contains?, limit? }`

### POST `/api/admin/twilio/purchase`
- **Auth**: `authenticateApiKey`, `requireAdmin`
- **Description**: Purchase a Twilio number
- **Body**: `{ phoneNumber }`

---

## OAuth & Social Media

### POST `/api/oauth/meta/initiate`
- **Auth**: `authenticate`
- **Description**: Start Meta OAuth flow for WhatsApp/Facebook/Instagram
- **Body**: `{ platform, garageId }`

### GET `/api/oauth/meta/callback`
- **Auth**: Public (OAuth callback)
- **Description**: Handle OAuth callback from Meta
- **Query**: `code`, `state`, `error?`

### GET `/api/garages/:garageId/social-connections`
- **Auth**: `authenticate`
- **Description**: List all social media connections for a garage

### DELETE `/api/social-connections/:connectionId`
- **Auth**: `authenticate`
- **Description**: Disconnect a social media platform

---

## Onboarding

### POST `/api/onboarding/create-business`
- **Auth**: `authenticateApiKey`
- **Description**: Comprehensive onboarding - creates business, branch, user, agent config, with auto-purchase Twilio number
- **Body**: `{ branchName, contactName, contactEmail, websiteUrl, agentType, subscriptionCostGbp, includedMinutes, trialType?, trialDays?, requireBookings?, autoPurchaseTwilioNumber?, activateTwilio? }`

### POST `/api/onboarding/complete`
- **Auth**: `authenticateApiKey`
- **Description**: Complete end-to-end onboarding with optional auto-purchase
- **Body**: `{ business: { name }, branch: { name }, user: { email, password, role }, twilioNumber?, autoPurchaseTwilioNumber?, activateTwilio? }`

### POST `/api/onboarding/user`
- **Auth**: `authenticateApiKey`
- **Description**: Add a new user to an existing branch
- **Body**: `{ branchId, email, password, role? }`

### GET `/api/onboarding/status`
- **Auth**: `authenticate`
- **Description**: Check if user needs to complete setup wizard

### POST `/api/onboarding/wizard-complete`
- **Auth**: `authenticate`
- **Description**: Mark setup wizard as completed for garage

### GET `/api/onboarding/initial-data`
- **Auth**: `authenticate`
- **Description**: Get initial data for wizard pre-population

---

## Voice/Call Routing (Twilio)

### POST `/api/voice`
- **Auth**: Public (Twilio webhook)
- **Description**: Twilio voice webhook - returns TwiML to route call to LiveKit
- **Query**: `garageId`

### POST `/api/webhooks/recording-status`
- **Auth**: Public (Twilio webhook)
- **Description**: Twilio recording status callback - stores recording info and updates call duration
- **Body**: Twilio recording status data

---

## Agent Configuration Webhook

### POST `/api/webhooks/agent-config`
- **Auth**: Webhook secret via header
- **Description**: Receive agent configuration updates from portal (file-based agent deployment)
- **Body**: `{ garageId, configuration, knowledgeBase, knowledgeVersion }`

---

## Admin - Facebook Connection (Diagnostic)

### POST `/api/admin/create-fb-connection`
- **Auth**: Public (diagnostic endpoint)
- **Description**: Diagnostic endpoint to create Facebook connection with hardcoded credentials

---

## Authentication Types

- **Public**: No authentication required
- **`authenticate`**: Requires valid JWT token in Authorization header
- **`authenticateApiKey`**: Requires X-API-Key header
- **`requireAdmin`**: User must have ADMIN or RECEPTIONMATE_STAFF role
- **`requireManager`**: User must be a MANAGER of at least one branch
- **`requireStaff`**: User must have RECEPTIONMATE_STAFF role
- **`requireMessagingAccess`**: Garage must have messaging subscription enabled
- **Webhook**: Requires webhook secret in header (X-Webhook-Secret)

---

## Base URL

All endpoints are prefixed with `/api` by default in the portal backend.

Example: `https://portal.receptionmate.co.uk/api/login`

---

## Notes

1. **Agent Types**: `assist` (human-in-loop) or `automate` (fully automated)
2. **Agent Scripts**: `receptionmate-agent` (v2) or `receptionmate-agent-v3` (v3)
3. **Call Types**: `confirmed booking`, `enquiry`, `callback`, `complaint`, `spam`, `unknown`
4. **Message Platforms**: `whatsapp`, `facebook`, `instagram`
5. **Conversation Status**: `active`, `resolved`, `archived`
6. **Roles**: `USER`, `ADMIN`, `RECEPTIONMATE_STAFF`
7. **Branch Roles**: `USER`, `MANAGER` (per-branch permissions)

---

Last Updated: February 21, 2026
