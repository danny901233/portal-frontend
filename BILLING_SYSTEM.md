# ReceptionMate Billing System

## Overview

Automated billing system that calculates and charges customers monthly from their mandate setup date. Charges are based on:
- Monthly subscription cost per branch
- Call minutes used (with included allowance)
- SMS booking links sent
- Configurable VAT rate

**Key Feature**: Each customer is billed monthly from the date they set up their Direct Debit mandate, not on a fixed calendar date. For example, if a customer sets up their mandate on February 15th, they will be billed on the 15th of each month.

## Database Schema

### User Model (Billing Cycle)
```typescript
{
  gocardlessMandateId: string        // GoCardless mandate ID
  billingCycleStartDate: DateTime    // When mandate was first set up
  nextBillingDate: DateTime          // When next billing is due
}
```

### Garage Model (Billing Config)
```typescript
{
  subscriptionCostGbp: number  // Monthly cost (e.g., 400.00)
  includedMinutes: number      // Free minutes (e.g., 600)
  costPerMinuteGbp: number     // Overage rate (e.g., 0.25)
  vatRate: number              // VAT rate (e.g., 0.20 for 20%)
}
```

### Invoice Model
```typescript
{
  garageId: string
  businessId: string
  periodStart: DateTime
  periodEnd: DateTime

  // Usage
  minutesUsed: number
  minutesIncluded: number
  smsCount: number

  // Costs (in pence)
  subscriptionAmount: number
  minutesAmount: number
  smsAmount: number
  subtotal: number
  vatAmount: number
  total: number

  // Audit trail
  subscriptionCostGbp: number
  costPerMinuteGbp: number
  vatRate: number

  // Status & Payment
  status: string  // draft, pending, paid, failed, cancelled
  gocardlessPaymentId: string?
  paidAt: DateTime?
}
```

## API Endpoints (Staff Only)

### Configure Billing for a Garage

**GET** `/api/billing/garages/:garageId/config`

Returns current billing configuration.

**PUT** `/api/billing/garages/:garageId/config`

```json
{
  "subscriptionCostGbp": 400,
  "includedMinutes": 600,
  "costPerMinuteGbp": 0.25,
  "vatRate": 0.20
}
```

### Calculate Usage

**GET** `/api/billing/garages/:garageId/usage?startDate=2026-02-01&endDate=2026-02-28`

Returns:
```json
{
  "usage": {
    "minutesUsed": 1000,
    "smsCount": 10
  },
  "billing": {
    "subscriptionAmount": 40000,
    "minutesAmount": 10000,
    "smsAmount": 990,
    "subtotal": 50990,
    "vatAmount": 10198,
    "total": 61188,
    "breakdown": {
      "subscriptionCostGbp": 400,
      "minutesUsed": 1000,
      "minutesIncluded": 600,
      "overageMinutes": 400,
      "costPerMinuteGbp": 0.25,
      "smsCount": 10,
      "costPerSmsGbp": 0.99,
      "vatRate": 0.20
    }
  }
}
```

### Generate Invoice

**POST** `/api/billing/invoices/generate`

```json
{
  "garageId": "garage-id",
  "periodStart": "2026-02-01T00:00:00Z",
  "periodEnd": "2026-02-28T23:59:59Z"
}
```

Creates an invoice in "draft" status.

**POST** `/api/billing/invoices/generate-batch`

```json
{
  "periodStart": "2026-02-01T00:00:00Z",
  "periodEnd": "2026-02-28T23:59:59Z"
}
```

Generates invoices for ALL garages with billing configured.

### List Invoices

**GET** `/api/billing/invoices?garageId=xxx&status=draft&limit=50`

Returns list of invoices.

**GET** `/api/billing/invoices/:invoiceId`

Returns single invoice with details.

### Charge Invoice

**POST** `/api/billing/invoices/:invoiceId/charge`

Creates GoCardless payment and updates invoice status to "pending".

## Billing Example

**Business A Setup:**
- 2 branches
- £400 per branch subscription
- 600 minutes included per branch
- £0.25 per minute overage
- 20% VAT

**Usage:**
- Branch 1: 1000 minutes, 5 SMS
- Branch 2: 600 minutes, 5 SMS

**Calculation:**

```
Branch 1:
  Subscription:   £400.00
  Minutes:        (1000 - 600) × £0.25 = £100.00
  SMS:            5 × £0.99 = £4.95
  Branch 1 Total: £504.95

Branch 2:
  Subscription:   £400.00
  Minutes:        (600 - 600) × £0.25 = £0.00
  SMS:            5 × £0.99 = £4.95
  Branch 2 Total: £404.95

Subtotal:        £909.90
VAT (20%):       £181.98
Total Due:       £1,091.88
```

## Usage Flow

### 1. Configure Billing (One Time)

For each garage, set billing configuration:

```bash
curl -X PUT http://localhost:4000/api/billing/garages/GARAGE_ID/config \
  -H "Authorization: Bearer YOUR_STAFF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subscriptionCostGbp": 400,
    "includedMinutes": 600,
    "costPerMinuteGbp": 0.25,
    "vatRate": 0.20
  }'
```

### 2. Customer Sets Up Direct Debit

When a customer completes the GoCardless mandate setup:
- `billingCycleStartDate` is set to the current date
- `nextBillingDate` is set to 1 month from now
- System automatically tracks when this customer is due for billing

### 3. Process Monthly Billing (Automated)

Run this daily (via cron or scheduled task) to process billing for all customers due:

```bash
curl -X POST http://localhost:4000/api/billing/process-monthly \
  -H "Authorization: Bearer YOUR_STAFF_TOKEN"
```

This will:
- Find all users whose `nextBillingDate` has passed
- Generate invoices for each of their garages
- Update `nextBillingDate` to the next month
- Return summary of success/failure

### 4. Check Users Due for Billing

See which users are due for billing:

```bash
curl http://localhost:4000/api/billing/users-due \
  -H "Authorization: Bearer YOUR_STAFF_TOKEN"
```

### 5. Review Invoices

Check generated invoices:

```bash
curl http://localhost:4000/api/billing/invoices?status=draft \
  -H "Authorization: Bearer YOUR_STAFF_TOKEN"
```

### 6. Charge Customers

For each invoice, create GoCardless payment:

```bash
curl -X POST http://localhost:4000/api/billing/invoices/INVOICE_ID/charge \
  -H "Authorization: Bearer YOUR_STAFF_TOKEN"
```

### 7. Monitor Payment Status

GoCardless will send webhooks when payments complete or fail.

## Example: Customer Billing Timeline

**Customer A sets up mandate on February 15, 2026:**
- `billingCycleStartDate`: Feb 15, 2026
- `nextBillingDate`: March 15, 2026

**March 15, 2026:**
- System processes billing for Customer A
- Generates invoices for period: Feb 15 - March 15
- Updates `nextBillingDate` to April 15, 2026

**April 15, 2026:**
- System processes billing for Customer A
- Generates invoices for period: March 15 - April 15
- Updates `nextBillingDate` to May 15, 2026

This ensures each customer is billed exactly one month from when they set up their Direct Debit.

## Webhook Integration

The existing GoCardless webhook handler automatically updates invoice status when payment events occur.

Add to webhook handler in `backend/src/routes/webhooks/gocardless.ts`:

```typescript
case 'payments':
  const paymentId = event.links?.payment;

  // Find invoice by payment ID
  const invoice = await prisma.invoice.findFirst({
    where: { gocardlessPaymentId: paymentId }
  });

  if (invoice) {
    if (action === 'confirmed' || action === 'paid_out') {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'paid', paidAt: new Date() }
      });
    } else if (action === 'failed' || action === 'cancelled') {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'failed' }
      });
    }
  }
  break;
```

## Admin UI (To Build)

The frontend admin UI should include:

### Billing Configuration Page
- List all garages
- Configure subscription cost, included minutes, cost per minute, VAT rate
- Save configuration per garage

### Billing Dashboard
- Current month usage preview (live calculation)
- Generate invoices button
- List of all invoices with status
- Filter by garage, status, date range
- Charge all pending invoices button

### Invoice Detail View
- Full breakdown of charges
- Usage details (minutes, SMS)
- Payment status
- Charge button (if not charged)
- Download PDF button (future)

## Testing

### Test Billing Configuration

```bash
# Configure test garage
curl -X PUT http://localhost:4000/api/billing/garages/GARAGE_ID/config \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subscriptionCostGbp":50,"includedMinutes":100,"costPerMinuteGbp":0.10,"vatRate":0.20}'

# Check current usage
curl "http://localhost:4000/api/billing/garages/GARAGE_ID/usage?startDate=2026-02-01&endDate=2026-02-05" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Invoice Generation

```bash
# Generate test invoice
curl -X POST http://localhost:4000/api/billing/invoices/generate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "garageId": "GARAGE_ID",
    "periodStart": "2026-02-01T00:00:00Z",
    "periodEnd": "2026-02-05T23:59:59Z"
  }'

# View invoice
curl http://localhost:4000/api/billing/invoices/INVOICE_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Payment Creation (Sandbox Only)

```bash
# Create payment for invoice
curl -X POST http://localhost:4000/api/billing/invoices/INVOICE_ID/charge \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Database Queries

### Find high usage garages

```sql
SELECT
  g.name,
  SUM(c."durationSeconds") / 60 as minutes_used,
  COUNT(s.id) as sms_count
FROM "Garage" g
LEFT JOIN "Call" c ON c."garageId" = g.id
LEFT JOIN "SmsBookingLink" s ON s."garageId" = g.id
WHERE c."createdAt" >= '2026-02-01'
  AND c."createdAt" < '2026-03-01'
GROUP BY g.id, g.name
ORDER BY minutes_used DESC;
```

### View unpaid invoices

```sql
SELECT
  i.id,
  g.name,
  i."periodStart",
  i."periodEnd",
  i.total / 100.0 as total_gbp,
  i.status
FROM "Invoice" i
JOIN "Garage" g ON g.id = i."garageId"
WHERE i.status IN ('draft', 'pending')
ORDER BY i."periodStart" DESC;
```

## Production Checklist

- [ ] Configure billing for all active garages
- [ ] Test invoice generation in sandbox
- [ ] Verify GoCardless payments work
- [ ] Set up automated monthly billing job
- [ ] Build admin UI for configuration
- [ ] Build admin UI for invoice management
- [ ] Add email notifications for invoices
- [ ] Add PDF invoice generation
- [ ] Monitor payment success/failure rates

## Next Steps

To complete the billing system:

1. **Build Admin UI** - Frontend pages for configuration and invoice management
2. **Automate Monthly Billing** - Cron job or scheduled task
3. **Email Notifications** - Send invoices and payment confirmations
4. **PDF Generation** - Professional invoice PDFs
5. **Reporting** - Analytics dashboard for billing metrics

## Files Created

- `prisma/schema.prisma` - Updated with billing fields and Invoice model
- `backend/src/services/billing.ts` - Billing calculation and invoice generation
- `backend/src/routes/billing.ts` - API endpoints
- `backend/src/routes/webhooks/gocardless.ts` - Payment webhook handler
- `backend/src/server.ts` - Routes registered

## Support

All billing operations are logged with timestamps. Check backend logs:
```bash
tail -f /tmp/backend.log | grep "billing"
```
