# Deploy Agent Type Feature to AWS EC2

## Quick Deploy Commands

SSH into your EC2 server and run these commands:

```bash
# SSH to EC2
ssh ubuntu@18.171.230.217

# Or if using ec2-user:
ssh ec2-user@18.171.230.217
```

Then run:

```bash
cd /home/ubuntu/portal-frontend
# Or: cd /home/ec2-user/portal-frontend

# Pull latest code
git pull origin receptionmate-demo-branch-2

# Backend deployment
cd backend
npm install
npx prisma generate --schema=../prisma/schema.prisma
npx prisma migrate deploy --schema=../prisma/schema.prisma
pm2 restart backend

# Frontend deployment
cd ..
npm install
npm run build
pm2 restart frontend

# Verify services are running
pm2 list
```

## What This Deploys

- ✅ New `agentType` field in database (assist/automate)
- ✅ Agent Type dropdown in UI (above Diary Integration)
- ✅ Backend API support for saving/loading agent type
- ✅ Database migration to add the new field

## Verification

After deployment, visit your portal and go to Agent Configurations. You should see a new "Agent Type" section with a dropdown to select between:
- **Assist**: Collects enquiries and customer details for callback
- **Automate**: Handles full booking process with diary integration
