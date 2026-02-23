#!/usr/bin/env bash
# Usage: ./scripts/test_chat.sh
# Tests chat agent scenarios

JQ=/opt/homebrew/bin/jq
API="https://api.receptionmate.co.uk/api/chat/widget"
GID="d51dfa55-15d0-4d60-ad81-c675579d16f6"

# State: track current conversation ID
CURRENT_CID=""

step() {
  local msg="$1"
  echo ""
  echo ">>> USER: $msg"
  local PAYLOAD
  if [ -n "$CURRENT_CID" ]; then
    PAYLOAD="{\"garageId\":\"$GID\",\"conversationId\":\"$CURRENT_CID\",\"message\":\"$msg\"}"
  else
    PAYLOAD="{\"garageId\":\"$GID\",\"message\":\"$msg\"}"
  fi
  local RESULT
  RESULT=$(curl -s -X POST "$API" -H "Content-Type: application/json" -d "$PAYLOAD")
  # Extract conversationId for next call
  NEW_CID=$($JQ -r '.conversationId // empty' <<< "$RESULT")
  if [ -n "$NEW_CID" ]; then
    CURRENT_CID="$NEW_CID"
  fi
  RESP=$($JQ -r '.response // .error // "ERROR"' <<< "$RESULT")
  echo "<<< AGENT: $RESP"
  sleep 1
}

new_session() {
  CURRENT_CID=""
}

echo "=============================="
echo "SCENARIO 19: Tyres"
echo "=============================="
new_session
step "yes"
step "I want to book my car in"
step "John Smith"
step "v20ala"
step "tyres"

echo ""
echo "=============================="
echo "SCENARIO: Diagnostic - Knocking noise"
echo "=============================="
new_session
step "yes"
step "I want to book my car in"
step "Jane Doe"
step "v20ala"
step "there is a knocking noise from the front of the car"
