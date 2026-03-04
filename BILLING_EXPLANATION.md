# ReceptionMate Billing System - How It Works

## Overview
The billing system has two components:
1. **Monthly Subscription** - Fixed fee per garage
2. **Usage/Overage** - Call minutes and SMS beyond included allowance

---

## 1. Monthly Subscription Billing

### When You Click "Activate Billing":
- ✅ **Immediately charges** the first month subscription (e.g., £1)
- ✅ Sets `billingCycleStartDate` to today
- ✅ Sets `nextBillingDate` to today + 1 month

### After Activation:
**Billing is MANUAL** - You must run it from the admin panel:

1. Go to **Admin Panel → Billing Dashboard**
2. See section: "Monthly Billing"
3. Shows users where `nextBillingDate` <= today
4. Click **"Process Monthly Billing"** button
5. System charges all due users and updates their `nextBillingDate`

**Example Timeline:**
- Feb 9: Activate billing → Charge £1 immediately → Next billing date: Mar 9
- Mar 9: User appears in "due for billing" list
- Admin clicks "Process Monthly Billing" → Charge £1 → Next billing date: Apr 9
- Repeat monthly...

---

## 2. Usage/Overage Billing (Minutes & SMS)

### Each Garage Has Configuration:
- **Subscription Cost**: £X/month (fixed)
- **Included Minutes**: Y minutes/month (free)
- **Cost Per Minute**: £Z per minute over limit
- **SMS Rates**: Per SMS cost

### Example:
```
Subscription: £50/month
Included Minutes: 100 minutes
Cost Per Minute: £0.10 above 100 minutes
```

**If customer uses 150 minutes in a month:**
- Base subscription: £50
- Overage: 50 minutes × £0.10 = £5
- **Total: £55**

### How Overage Works:

1. **Invoices Track Usage:**
   - System creates invoices for billing periods
   - Tracks: minutes used, SMS sent, subscription cost
   - Status: `draft` → `pending` → `paid` or `failed`

2. **Generate Invoices:**
   - Go to Admin Panel → Billing
   - Generate invoices for a period (e.g., last month)
   - Review usage and costs

3. **Charge Invoices:**
   - Draft invoices can be reviewed
   - Click "Charge" to create GoCardless payment
   - Payment is debited from customer's Direct Debit

---

## Current Setup - What You Need to Do:

### For Subscription Billing:
**IMPORTANT: Not automated yet!**

You must manually:
1. Check the billing dashboard regularly (monthly)
2. See who's due for billing
3. Click "Process Monthly Billing"

### For Usage Billing:
1. Generate invoices for the billing period
2. Review usage and overage charges
3. Click "Charge" on invoices to bill customers

---

## Recommended: Automate Monthly Billing

Currently, monthly subscription billing is **manual**. You should add a cron job to automate it:

```typescript
// In src/utils/scheduler.ts, add:

// Daily billing check at 9:00 AM
cron.schedule('0 9 * * *', async () => {
  console.log('Running daily billing check...');
  try {
    await processMonthlyBilling();
    console.log('Daily billing check completed');
  } catch (error) {
    console.error('Daily billing check failed:', error);
  }
}, {
  timezone: 'Europe/London',
});
```

---

## Garage Billing Configuration

To view/edit billing settings for a garage:
1. Admin Panel → Billing
2. Click on a garage
3. Configure:
   - Monthly subscription cost
   - Included minutes
   - Per-minute rate
   - Trial period
   - Activation requirements

---

## Customer Journey:

### New Customer:
1. Creates account → Sets up Direct Debit mandate
2. **Appears in "Pending Billing Activation"**
3. Admin clicks "Activate Billing"
4. First month charged immediately
5. Appears in "due for billing" on their monthly anniversary
6. Admin processes monthly billing

### Existing Customer:
- Monthly: Charged subscription on their billing date
- End of month: Usage invoice generated
- Overage: Charged for minutes/SMS beyond included amount

---

## Billing Status Checks:

**User's Billing Status:**
- `billingCycleStartDate`: When billing started
- `nextBillingDate`: When next subscription is due
- `gocardlessMandateId`: Direct Debit mandate reference

**Garage's Billing Status:**
- `subscriptionCostGbp`: Monthly fee
- `trialEndDate`: If in trial, billing deferred
- `requiresBookingActivation`: If true, billing deferred until X bookings

---

## Key Points:

✅ **First month is charged immediately** when you activate billing
✅ **Monthly billing is currently MANUAL** - you must click the button
✅ **Usage/overage is invoiced separately** - generate and charge invoices
⚠️ **Recommend adding automation** for daily billing checks
💡 **Monitor the billing dashboard** to ensure customers are being charged

---

## Questions?

- How often to bill? → Monthly on the customer's billing anniversary
- When to charge overage? → Generate invoices monthly, charge as needed
- Can I defer billing? → Yes, use trial periods or activation requirements
- What if payment fails? → GoCardless handles retries automatically
