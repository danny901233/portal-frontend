# Agent A/B Testing Feature - Deployment Guide

## Overview

You can now select which agent script (basic_agent2.py or Newreceptionmateagent.py) to use for each garage via the portal. This allows for:
- **A/B testing** - Compare performance between old and new agents
- **Safe rollback** - Quickly revert to the stable agent if issues arise
- **Per-garage configuration** - Different garages can use different agents

## Changes Made

### 1. Database Schema
- Added `agentScript` field to `AgentConfiguration` table
- Default value: `basic_agent2.py` (production agent)
- Options: `basic_agent2.py` or `Newreceptionmateagent.py`

### 2. Portal UI
- New dropdown in Agent Configurations page: **"Agent Version (A/B Testing)"**
- Located right below the "Agent Type" section
- Only ReceptionMate staff can change this setting

### 3. Agent Launcher Script
- Created `scripts/launch-agent.sh` - automatically reads `agentScript` from DynamoDB
- Launches the correct Python agent based on portal configuration
- Works in both development and production environments

## Local Testing

### Test the launcher script:
```bash
cd /Users/dan/projects/portal-frontend

# Set up environment (if not already done)
export PORTAL_GARAGE_ID=d51dfa55-15d0-4d60-ad81-c675579d16f6
export AWS_REGION=eu-west-2
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret

# Test launching the agent
./scripts/launch-agent.sh dev
```

### Switch agents in portal:
1. Go to https://portal.receptionmate.co.uk/agent-configurations
2. Click Edit
3. Find "Agent Version (A/B Testing)" dropdown
4. Select "New Agent" (Newreceptionmateagent.py)
5. Save Configuration
6. Restart your agent (it will automatically pick up the new script)

## Production Deployment

### Step 1: Deploy Database Changes
```bash
# SSH into EC2
ssh ec2-user@18.171.230.217

cd /home/ec2-user/portal-frontend

# Pull latest code
git pull origin receptionmate-demo-branch-2

# Run database migration
cd backend
./node_modules/.bin/prisma generate --schema=../prisma/schema.prisma
psql receptionmate -c "ALTER TABLE \"AgentConfiguration\" ADD COLUMN IF NOT EXISTS \"agentScript\" TEXT NOT NULL DEFAULT 'basic_agent2.py';"

# Restart backend to pick up new field
pm2 restart backend
```

### Step 2: Deploy Frontend
```bash
# Still on EC2
cd /home/ec2-user/portal-frontend

# Install dependencies and build
npm install
npm run build

# Restart frontend
pm2 restart frontend
```

### Step 3: Upload Agent Scripts
Make sure both agent scripts are on the EC2 server:
```bash
# From your local machine
scp /Users/dan/agents/examples/voice_agents/basic_agent2.py ec2-user@18.171.230.217:/home/ec2-user/agents/
scp /Users/dan/agents/examples/voice_agents/Newreceptionmateagent.py ec2-user@18.171.230.217:/home/ec2-user/agents/
```

### Step 4: Upload Launcher Script
```bash
# From your local machine
scp /Users/dan/projects/portal-frontend/scripts/launch-agent.sh ec2-user@18.171.230.217:/home/ec2-user/agents/
ssh ec2-user@18.171.230.217 "chmod +x /home/ec2-user/agents/launch-agent.sh"
```

### Step 5: Update PM2 to Use Launcher
```bash
# SSH into EC2
ssh ec2-user@18.171.230.217

cd /home/ec2-user/agents

# Stop current agent
pm2 delete receptionmate-agent || true

# Start agent with launcher script
pm2 start ./launch-agent.sh --name receptionmate-agent -- dev

# Save PM2 configuration
pm2 save
```

## How It Works

### Configuration Flow:
1. Portal saves `agentScript` field to PostgreSQL database
2. Portal webhook sends configuration to Lambda function
3. Lambda stores configuration in DynamoDB `AgentConfig` table (including `agentScript`)
4. Launcher script queries DynamoDB for the `agentScript` value
5. Launcher script starts the correct Python agent

### Agent Selection Logic:
```
Portal UI → PostgreSQL → Lambda → DynamoDB → Launcher Script → Python Agent
```

## Usage Examples

### Switch to New Agent:
1. Portal: Select "New Agent (Newreceptionmateagent.py)"
2. Save configuration
3. Restart agent: `pm2 restart receptionmate-agent`
4. Agent automatically launches Newreceptionmateagent.py

### Rollback to Legacy Agent:
1. Portal: Select "Legacy Agent (basic_agent2.py)"
2. Save configuration
3. Restart agent: `pm2 restart receptionmate-agent`
4. Agent automatically launches basic_agent2.py

## Verification

### Check which agent is running:
```bash
# On EC2
pm2 logs receptionmate-agent --lines 20

# Look for log line:
# "✅ Selected agent: basic_agent2.py" or "✅ Selected agent: Newreceptionmateagent.py"
```

### Check DynamoDB configuration:
```bash
aws dynamodb get-item \
  --table-name AgentConfig \
  --key '{"garage_id": {"S": "d51dfa55-15d0-4d60-ad81-c675579d16f6"}}' \
  --projection-expression "configuration.agentScript" \
  --region eu-west-2
```

## Troubleshooting

### Agent not switching:
- Verify the agentScript field is in DynamoDB
- Check PM2 is using the launcher script (not directly running Python)
- Restart the agent after changing configuration

### Launcher script fails:
- Check AWS credentials are set in environment
- Verify PORTAL_GARAGE_ID is set
- Check both agent scripts exist in the expected location

### Portal UI not showing dropdown:
- Clear browser cache
- Verify you're logged in as ReceptionMate staff
- Check backend has been restarted after migration

## Benefits

✅ **Zero downtime switching** - Change agents via portal, restart worker
✅ **Per-garage control** - Each garage can run a different agent version
✅ **Safe testing** - Test new agent on one garage before rolling out
✅ **Easy rollback** - One click to revert to stable agent
✅ **Audit trail** - All changes logged in database

## Next Steps

1. Test locally first using the launcher script
2. Deploy to production EC2
3. Select one test garage to try Newreceptionmateagent.py
4. Monitor call quality and performance
5. Gradually roll out to more garages if successful
6. Keep basic_agent2.py as fallback option
