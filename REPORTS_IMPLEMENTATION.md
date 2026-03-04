# Weekly and Monthly Email Reports - Implementation Summary

## Overview
Implemented automated weekly and monthly summary email reports for admin users showing dashboard statistics for their assigned branches.

## Features Implemented

### 1. Email Templates
- **Weekly Report** (`reportEmails.ts`):
  - Sent every Sunday at 9:00 AM UK time
  - Shows stats for the past 7 days
  - Includes total calls and revenue summary
  - Branch-by-branch breakdown

- **Monthly Report** (`reportEmails.ts`):
  - Sent on the last day of each month at 9:00 AM UK time
  - Shows stats for the previous completed month
  - Includes total calls, revenue, and bookings
  - Branch-by-branch breakdown

### 2. Report Generation Service (`reportGenerator.ts`)
Calculates statistics for each branch:
- Total calls
- Call type breakdown (general enquiries, booking requests, complaints)
- Confirmed bookings
- Total revenue captured
- Average call duration
- Calls by day (for weekly reports)

### 3. Scheduled Jobs (`scheduler.ts`)
- **Weekly**: Cron schedule `0 9 * * 0` (Sundays at 9:00 AM)
- **Monthly**: Cron schedule `0 9 28-31 * *` (last day of month at 9:00 AM)
- Runs in UK timezone (Europe/London)
- Initialized automatically when backend starts

### 4. Email Design
Both reports feature:
- ReceptionMate branding and logo
- Dark theme matching portal (#09203c background)
- Purple gradient header (#3126cf)
- Clean, professional layout
- Mobile-responsive design
- "View Full Dashboard" button linking to portal

## Statistics Included

### Branch-Level Stats
- Total calls handled
- General enquiries count
- Booking requests count
- Confirmed bookings count (highlighted in green)
- Complaints count
- Average call duration
- Total revenue captured

### Overall Summary
- Total calls across all branches
- Total revenue across all branches
- Total bookings (monthly only)

## Recipients
- **Target**: Users with `role: 'ADMIN'`
- **Branches Included**: All garages in their `garageAccessIds` array
- **Email Address**: Sent to user's registered email

## Technical Details

### Dependencies Added
```json
{
  "node-cron": "^3.0.3",
  "@types/node-cron": "^3.0.11"
}
```

### Files Created
1. `backend/src/utils/reportEmails.ts` - Email template generation
2. `backend/src/utils/reportGenerator.ts` - Data aggregation and report logic
3. `backend/src/utils/scheduler.ts` - Cron job configuration

### Files Modified
1. `backend/src/server.ts` - Initialize scheduler on startup
2. `backend/package.json` - Add dependencies

### Email Service
Uses Mailgun API for transactional email delivery with optional O365 SMTP fallback:
- API Base: `https://api.mailgun.net` (or `https://api.eu.mailgun.net` for EU)
- Domain: `MAILGUN_DOMAIN`
- From: `MAILGUN_FROM`

Optional O365 fallback (used when Mailgun fails or is not configured):
- Host: `O365_SMTP_HOST` (default `smtp.office365.com`)
- Port: `O365_SMTP_PORT` (default `587`)
- User: `O365_SMTP_USER`
- Pass: `O365_SMTP_PASS`
- From: `O365_FROM` (defaults to user)

## Deployment Status
✅ Deployed to EC2 (18.171.230.217)
✅ Scheduler initialized and running
✅ Both weekly and monthly jobs configured
✅ All dependencies installed

## Testing the Reports
Since the reports run on a schedule, you can manually trigger them by:

1. SSH into EC2
2. Run Node REPL: `node`
3. Import and run:
```javascript
const { generateWeeklyReports } = await import('/home/ec2-user/portal-frontend/backend/dist/utils/reportGenerator.js');
await generateWeeklyReports();
```

Or for monthly:
```javascript
const { generateMonthlyReports } = await import('/home/ec2-user/portal-frontend/backend/dist/utils/reportGenerator.js');
await generateMonthlyReports();
```

## Next Steps (Future Enhancements)
1. Add configurable report schedules per user
2. Allow users to opt-in/opt-out of reports
3. Add more metrics (conversion rates, average booking value, etc.)
4. Add charts/graphs to email reports
5. Allow custom date range reports on-demand

## Logs
Check PM2 logs to verify scheduler is running:
```bash
pm2 logs 1 --lines 50
```

You should see:
```
✓ Weekly reports scheduled: Sundays at 9:00 AM (UK time)
✓ Monthly reports scheduled: Last day of month at 9:00 AM (UK time)
```
