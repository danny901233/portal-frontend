# Anniversary Billing System

## Overview

ReceptionMate now uses **anniversary billing** - the industry-standard approach where customers are billed on the same day each month as their signup date. This is simpler, more predictable, and easier for customers to understand than fixed billing dates.

## How It Works

### Signup & Payment Setup

When a customer confirms their GoCardless Direct Debit:

### Standard Customers (No Trial, No Activation Required)
1. **Billing cycle starts**: `billingCycleStartDate` = today (signup date)
2. **First billing date set**: `nextBillingDate` = today + 1 month
3. **First month charged**: Full subscription cost (£400) charged immediately
4. **Billing anniversary**: Same day every month as signup

**Example:**
- Customer signs up: March 10
- Billing cycle start: March 10
- Next billing date: April 10
- First month charge: £400

### Trial Customers
1. **Billing cycle NOT started yet**: `billingCycleStartDate` = null
2. **No charges at signup**: £0 charged
3. **When trial ends**: Billing cycle starts on trial end date
4. **Billing anniversary**: Same day every month as trial end date

**Example:**
- Customer signs up: March 10 (14-day trial)
- Trial ends: March 24
- **Billing cycle starts: March 24** ← This is their anniversary
- Next billing date: April 24
- First month charge: £400 on April 24

### Booking Activation Customers
1. **Billing cycle NOT started yet**: `billingCycleStartDate` = null
2. **No charges at signup**: £0 charged
3. **When 4th booking confirmed**: Billing cycle starts on activation date
4. **Billing anniversary**: Same day every month as activation date

**Example:**
- Customer signs up: March 10
- 4th booking confirmed: March 15
- **Billing cycle starts: March 15** ← This is their anniversary
- Next billing date: April 15
- First month charge: £400 on April 15

### Monthly Billing

Every billing date (same day each month):

**Charges:**
- ✅ **Previous period usage**: Minutes overage + SMS for the past month (in arrears)
- ✅ **Next period subscription**: Full month subscription for upcoming month (in advance)

**Example:** April 10 billing for customer who signed up March 10
- Previous period: March 10 - April 9
- Usage charge: Minutes overage (if any) + SMS count
- Subscription: £400 for April 10 - May 9
- Next billing: May 10

### Trial Periods (Optional)

**14-day free trial** (configurable per branch):

- ✅ AI agent works normally
- ❌ **No charges at all** during trial (subscription + usage)
- 🗓️ Trial end date calculated from trial days setting

When trial ends, normal billing resumes on next billing date.

**Example:**
- Signup March 10 with 14-day trial
- Trial ends: March 24
- **Billing anniversary: 24th** (trial end date)
- First billing: April 24
  - Usage charge: March 24 - April 23 (31 days)
  - Subscription: £400 for April 24 - May 23
- Future billing: 24th of every month

### Booking-Based Activation (Optional)

**Subscription requires confirmed bookings** (configurable per branch, typically Automate plan):

Settings:
- `requiresBookingActivation: true`
- `bookingsRequiredForActivation: 4` (default)

How it works:
- ❌ **No subscription charge** until booking threshold reached
- ✅ **Usage charges apply** (minutes and SMS)
- 📊 Automatic tracking via confirmed bookings
- 🎉 Subscription activates immediately when threshold reached

**Example:**
- Customer signs up: March 10
- Branch requires 4 bookings
- March 10-14: Only 2 bookings confirmed → no billing cycle started yet
- March 15: 4th booking confirmed! 🎉
  - **Billing anniversary: 15th** (activation date)
  - Billing cycle starts: March 15
  - Next billing: April 15
- April 15 billing:
  - Usage charge: March 15 - April 14 (£50)
  - Subscription: £400 for April 15 - May 14
- Future billing: 15th of every month

## Billing Timeline Example

**Customer: "Manchester Garage"**
- Signs up: March 10
- Plan: Standard (no trial, no activation requirement)
- Subscription: £400/month, 400 minutes included

### March 10 - Signup
- ✅ Charged immediately: £400 (first month subscription)
- Next billing: April 10

### April 10 - First Monthly Billing
- Period: March 10 - April 9 (30 days)
- Used: 450 minutes, 10 SMS
- Charges:
  - Previous usage: 50 minutes overage (£50) + SMS (£0.99)
  - Next subscription: £400 (April 10 - May 9)
  - Subtotal: £450.99
  - VAT (20%): £90.20
  - **Total: £541.19**
- Next billing: May 10

### May 10 - Second Monthly Billing
- Period: April 10 - May 9 (30 days)
- Used: 380 minutes, 5 SMS
- Charges:
  - Previous usage: £0 (under allowance) + SMS (£0.50)
  - Next subscription: £400 (May 10 - June 9)
  - Subtotal: £400.50
  - VAT (20%): £80.10
  - **Total: £480.60**
- Next billing: June 10

And continues on the 10th of every month...

## Billing Components

### Subscription (Charged in Advance)
- **Base cost**: £400/month (configurable per branch)
- **Includes**: Minutes allowance (e.g., 400 minutes)
- **Skipped if**: In trial OR awaiting booking activation

### Minutes Overage (Charged in Arrears)
- **Cost**: £1/minute over allowance (configurable)
- **Example**: Used 450 minutes, allowance 400 → charge £50
- **Still charged**: Even during booking activation period

### SMS (Charged in Arrears)
- **Cost**: £0.99 per SMS (configurable)
- **Counted**: Outbound SMS booking links
- **Still charged**: Even during booking activation period

### VAT
- **Rate**: 20% (configurable)
- **Applied to**: All charges (subscription + usage)

## Key Benefits

✅ **Industry standard** - Used by Stripe, Chargebee, and most SaaS companies
✅ **Simple for customers** - Same billing date every month
✅ **No catch-up charges** - No confusing proration weeks after signup
✅ **Predictable** - Customers know exactly when they'll be billed
✅ **Flexible trials** - Can offer free trial periods
✅ **Performance-based** - Can require bookings before subscription
✅ **Fully automated** - GoCardless Direct Debit handles collection

## Technical Details

### Database Fields (User model)
- `billingCycleStartDate`: Date when billing cycle started (moves forward each month)
- `nextBillingDate`: Date of next billing (always same day as signup, different month)
- `gocardlessMandateId`: GoCardless mandate for Direct Debit
- `gocardlessCustomerId`: GoCardless customer ID

### Database Fields (Garage model)
- `subscriptionCostGbp`: Monthly subscription cost
- `includedMinutes`: Minutes included in subscription
- `costPerMinuteGbp`: Cost per minute overage
- `vatRate`: VAT rate (default 0.20 = 20%)
- `trialEndDate`: When trial ends (null if no trial)
- `requiresBookingActivation`: Whether subscription requires bookings
- `bookingsRequiredForActivation`: Number of bookings needed (default 4)
- `activationBookingsCount`: Current booking count
- `subscriptionActivatedAt`: When subscription activated (null if not activated)

### Billing Process
1. **Daily check**: `findUsersDueForBilling()` finds users where `nextBillingDate <= today`
2. **Generate invoices**: `generateInvoicesForUser()` creates invoices for each garage
3. **Create payments**: `createPaymentForInvoice()` charges via GoCardless
4. **Update billing date**: `nextBillingDate` moves forward 1 month

### Code Calculations
All billing calculations use deterministic code (no AI):
- Period calculation: `billingCycleStartDate` to `nextBillingDate`
- Minutes overage: `max(0, minutesUsed - includedMinutes)`
- Amounts in pence for precision: `Math.round(amount * 100)`
- VAT: `Math.round(subtotal * vatRate)`
- Next billing: `new Date(nextBillingDate).setMonth(month + 1)`

## Migration Notes

Existing customers on fixed billing dates (1st/15th) will need to be migrated:
1. Remove `billingDay` field from User records
2. Keep existing `billingCycleStartDate` and `nextBillingDate`
3. Future billings will continue on their current date
4. No need to re-charge or adjust - just continue from current `nextBillingDate`

For example:
- Customer on 15th billing cycle with `nextBillingDate = May 15`
- After migration: Will be billed on 15th of every month (anniversary of their assigned date)
- No disruption to billing cycle
