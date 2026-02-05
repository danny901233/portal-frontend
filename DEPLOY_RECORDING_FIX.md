# Deploy Recording Fix to AWS EC2

## Changes Committed ✅
- Fixed recording mix-ups in `backend/src/routes/calls.ts`
- Added `roomName` to `prisma/schema.prisma`
- Pushed to GitHub

## Deployment Steps

### Step 1: Run Database Migration on EC2

SSH into your EC2 instance and run the migration:

```bash
# SSH into EC2
ssh -i ~/.ssh/receptionmate-ec2.pem ec2-user@18.171.230.217

# Navigate to project
cd /home/ec2-user/portal-frontend

# Run migration
npx prisma migrate deploy

# Or if you need to create the migration first:
npx prisma migrate dev --name add-room-name-to-twilio-recording
```

### Step 2: Deploy Backend Code

**Option A: Use the deployment script (from your local machine)**
```bash
cd /Users/dan/projects/portal-frontend
./deploy-backend-only.sh ~/.ssh/receptionmate-ec2.pem
```

**Option B: Manual deployment (if you're already SSH'd into EC2)**
```bash
cd /home/ec2-user/portal-frontend/backend
git pull
npm install
npm run build
pm2 restart 1
pm2 logs 1 --lines 30
```

### Step 3: Verify Deployment

Check PM2 logs to ensure backend started successfully:
```bash
ssh -i ~/.ssh/receptionmate-ec2.pem ec2-user@18.171.230.217 "pm2 logs 1 --lines 50 --nostream"
```

## What the Fix Does

1. **Reduced time tolerance:** 5 minutes → 30 seconds
2. **Added duration matching:** Calls must match both time AND duration
3. **Added roomName field:** For future precise matching

## Testing

After deployment:
1. Make 2 calls from the same phone number within 1 minute
2. Check that each call has the correct recording
3. Recordings should no longer be mixed up!

## Rollback (if needed)

```bash
ssh -i ~/.ssh/receptionmate-ec2.pem ec2-user@18.171.230.217
cd /home/ec2-user/portal-frontend
git checkout HEAD~1
cd backend
npm install
npm run build
pm2 restart 1
```

## Success Criteria

- ✅ Backend restarts without errors
- ✅ Prisma migration applied successfully
- ✅ Same customer calling multiple times gets correct recordings
- ✅ No more recording mix-ups

---

**Note:** You'll need your SSH key file to deploy. If it's not at `~/.ssh/receptionmate-ec2.pem`, specify the path when running the deploy script.
