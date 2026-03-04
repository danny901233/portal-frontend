#!/bin/bash
# Agent Launcher Script - Dynamically selects and launches the correct agent based on DynamoDB configuration
# Usage: ./launch-agent.sh [dev|prod]

set -e

MODE="${1:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load environment variables
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

# Get garage ID from environment
GARAGE_ID="${PORTAL_GARAGE_ID}"
if [ -z "$GARAGE_ID" ]; then
    echo "❌ PORTAL_GARAGE_ID not set in environment"
    exit 1
fi

echo "🔍 Fetching agent configuration from DynamoDB..."
echo "   Garage ID: $GARAGE_ID"

# Query DynamoDB to get agentScript field
AGENT_SCRIPT=$(aws dynamodb get-item \
    --table-name AgentConfig \
    --key "{\"garage_id\": {\"S\": \"$GARAGE_ID\"}}" \
    --projection-expression "configuration.agentScript" \
    --region "${AWS_REGION:-eu-west-2}" \
    --output json 2>/dev/null | \
    python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    config = data.get('Item', {}).get('configuration', {})
    # Handle both Map and String formats
    if 'M' in config:
        agent_script = config.get('M', {}).get('agentScript', {}).get('S', 'basic_agent2.py')
    elif 'S' in config:
        # Old format: configuration is JSON string
        import json as j
        config_obj = j.loads(config['S'])
        agent_script = config_obj.get('agentScript', 'basic_agent2.py')
    else:
        agent_script = 'basic_agent2.py'
    print(agent_script)
except Exception as e:
    print('basic_agent2.py', file=sys.stderr)
    sys.exit(0)
" || echo "basic_agent2.py")

# Fallback to basic_agent2.py if query failed
if [ -z "$AGENT_SCRIPT" ] || [ "$AGENT_SCRIPT" = "null" ]; then
    AGENT_SCRIPT="basic_agent2.py"
fi

echo "✅ Selected agent: $AGENT_SCRIPT"
echo ""

# Find agent script location
AGENT_PATH=""
if [ -f "/Users/dan/agents/examples/voice_agents/$AGENT_SCRIPT" ]; then
    AGENT_PATH="/Users/dan/agents/examples/voice_agents/$AGENT_SCRIPT"
elif [ -f "$PROJECT_ROOT/$AGENT_SCRIPT" ]; then
    AGENT_PATH="$PROJECT_ROOT/$AGENT_SCRIPT"
elif [ -f "/home/ec2-user/agents/$AGENT_SCRIPT" ]; then
    AGENT_PATH="/home/ec2-user/agents/$AGENT_SCRIPT"
elif [ -f "/home/ubuntu/agents/$AGENT_SCRIPT" ]; then
    AGENT_PATH="/home/ubuntu/agents/$AGENT_SCRIPT"
else
    echo "❌ Agent script not found: $AGENT_SCRIPT"
    echo "   Searched locations:"
    echo "   - /Users/dan/agents/examples/voice_agents/$AGENT_SCRIPT"
    echo "   - $PROJECT_ROOT/$AGENT_SCRIPT"
    echo "   - /home/ec2-user/agents/$AGENT_SCRIPT"
    echo "   - /home/ubuntu/agents/$AGENT_SCRIPT"
    exit 1
fi

echo "📂 Agent path: $AGENT_PATH"
echo "🚀 Launching agent in $MODE mode..."
echo ""

# Find Python virtual environment
VENV_PYTHON=""
if [ -f "/Users/dan/agents/examples/voice_agents/.venv/bin/python" ]; then
    VENV_PYTHON="/Users/dan/agents/examples/voice_agents/.venv/bin/python"
elif [ -f "$PROJECT_ROOT/.venv/bin/python" ]; then
    VENV_PYTHON="$PROJECT_ROOT/.venv/bin/python"
elif [ -f "/home/ec2-user/agents/.venv/bin/python" ]; then
    VENV_PYTHON="/home/ec2-user/agents/.venv/bin/python"
elif [ -f "/home/ubuntu/agents/.venv/bin/python" ]; then
    VENV_PYTHON="/home/ubuntu/agents/.venv/bin/python"
else
    # Fallback to system python3
    VENV_PYTHON="python3"
fi

echo "🐍 Python: $VENV_PYTHON"
echo ""

# Launch the agent
exec $VENV_PYTHON "$AGENT_PATH" "$MODE"
