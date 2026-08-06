"""
Test bookingLeadTimeDays in chatAgentV2.ts.
Adaptive: reads agent replies and gives contextual answers to reach timeslots.

Prerequisites:
  1. Backend running:  cd backend && npm run dev
  2. bookingLeadTimeDays=5 already set on test garage (done via psql)
"""

import requests
import uuid
import datetime

BASE_URL = "http://localhost:4000"
GARAGE_ID = "e2fb4f90-a3c8-46cd-84c3-0ea89adceae5"
CONVERSATION_ID = str(uuid.uuid4())

def chat(message: str) -> str:
    resp = requests.post(f"{BASE_URL}/api/chat/widget", json={
        "garageId": GARAGE_ID,
        "message": message,
        "conversationId": CONVERSATION_ID,
    }, timeout=30)
    if not resp.text:
        return "(empty response)"
    try:
        data = resp.json()
        messages = data.get("messages", [data.get("message", str(data))])
        return "\n".join(messages) if isinstance(messages, list) else str(messages)
    except Exception:
        return f"[HTTP {resp.status_code}] {resp.text[:300]}"

def pick_reply(agent_text: str) -> str | None:
    t = agent_text.lower()
    if "name" in t and "?" in t:
        return "John"
    if "registration" in t or "reg" in t or "plate" in t:
        return "AB12CDE"
    if "what can" in t or ("help" in t and "today" in t) or "brings you" in t or "book" in t and "?" in t:
        return "I need to book my car in for a full service please"
    if "work" in t and ("need" in t or "does" in t):
        return "Full service"
    if "correct" in t or "right" in t or "confirm" in t or "daimler" in t or "vehicle" in t:
        return "Yes that's correct"
    if "drop" in t or "drop-off" in t:
        return "No, I'll wait"
    if "date" in t or "when" in t or "available" in t or "suit" in t or "prefer" in t:
        return "The earliest possible please"
    return None

print("=== LEAD TIME TEST ===")
print(f"Garage: {GARAGE_ID}")
print(f"Conversation: {CONVERSATION_ID}")
today = datetime.date.today()
earliest_ok = today + datetime.timedelta(days=5)
print(f"Today: {today} — no dates before {earliest_ok} should appear\n")

# Start the conversation
reply = chat("Hi, I'd like to book my car in for a full service")
print(f"User: Hi, I'd like to book my car in for a full service")
print(f"Agent: {reply}\n")

for turn in range(12):
    response = pick_reply(reply)
    if response is None:
        print("--- Could not determine next reply. Stopping. ---")
        print(f"Last agent message: {reply}")
        break

    print(f"User: {response}")
    reply = chat(response)
    print(f"Agent: {reply}\n")

    # Check if we've reached timeslots (look for specific date/time patterns)
    reply_lower = reply.lower()
    timeslot_keywords = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
                         "18th", "19th", "20th", "21st", "22nd", "23rd", "24th", "25th",
                         "at 8:", "at 9:", "at 10:", "at 11:", "at 12:", "half eight", "half nine",
                         "i have available", "next available", "earliest i have"]
    if any(kw in reply_lower for kw in timeslot_keywords):
        print("=== TIMESLOTS REACHED ===")
        print(f"Check: do all dates appear on or after {earliest_ok}?")
        break

    if any(kw in reply_lower for kw in ["confirmed", "booked", "all done", "anything else"]):
        print("--- Booking complete ---")
        break
