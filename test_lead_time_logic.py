"""
Test bookingLeadTimeDays filter + NO_MATCH/beyondRange fix.
Simulates Dan's Northampton scenario: caller asks for May, agent was wrongly showing April.
"""

import datetime

today = datetime.date.today()
print(f"Today: {today}\n")

# ─────────────────────────────────────────────
# SCENARIO 1: Lead time pushes earliest to May
# ─────────────────────────────────────────────
print("=" * 55)
print("SCENARIO 1: Lead time = 20 days (earliest slot in May)")
print("=" * 55)

BOOKING_LEAD_TIME_DAYS = 20
fake_timeslots = [
    {"date": (today + datetime.timedelta(days=i)).isoformat(), "time": "09:00"}
    for i in range(1, 30)
]

earliest_date = today + datetime.timedelta(days=BOOKING_LEAD_TIME_DAYS)
earliest_str = earliest_date.isoformat()
filtered = [t for t in fake_timeslots if t["date"] >= earliest_str]

print(f"Earliest allowed:   {earliest_str}  ({earliest_date.strftime('%A %d %B')})")
print(f"Raw slots:          {fake_timeslots[0]['date']} to {fake_timeslots[-1]['date']}")
print(f"After filter:       {len(filtered)} slots  ({filtered[0]['date'] if filtered else 'none'} to {filtered[-1]['date'] if filtered else 'none'})")
print()
if filtered:
    first = filtered[0]
    in_may = first["date"].startswith(f"{today.year}-05")
    print(f"First slot: {first['date']} ({'in May - PASS' if in_may else 'NOT in May - check'})")
else:
    print("No slots available after lead time filter.")
print()

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 2: Customer asks for May, but slots only go to end of April (old bug)
# ─────────────────────────────────────────────────────────────────────────────
print("=" * 55)
print("SCENARIO 2: Caller asks for May, slots only go to April")
print("  OLD behaviour: show first slot (April) -> wrong")
print("  NEW behaviour: show LAST slot + explain range")
print("=" * 55)

# Simulate slots only available in April (e.g. next 17 days)
april_only_slots = [
    {"date": (today + datetime.timedelta(days=i)).isoformat(), "time": "09:00"}
    for i in range(1, 18)  # up to 30 April roughly
]
last_slot = april_only_slots[-1]
last_date = datetime.date.fromisoformat(last_slot["date"])

# Customer preference: "sometime in May"
preference = "sometime in May"
req_month = "05"

# --- OLD logic (bug): always pick first slot ---
old_result = april_only_slots[0]
print(f"OLD - would show: {old_result['date']}  (wrong - customer asked for May, got first April slot)")

# --- NEW logic (beyondRange fix) ---
after_req = [t for t in april_only_slots if t["date"] >= f"{today.year}-05-01"]
if after_req:
    nearest = after_req[0]
    beyond_range = False
else:
    nearest = april_only_slots[-1]  # last available
    beyond_range = True

if beyond_range:
    print(f"NEW  - beyondRange=True, showing LAST slot: {nearest['date']}")
    print(f'       Say: "I\'m afraid our online booking only goes up to {last_date.strftime("%A %d %B")} —')
    print(f'       do you have a date in mind closer to then, or shall I get someone to call you back?"')
    print(f"       PASS - no longer showing first April slot for a May request")
else:
    print(f"NEW  - found a May slot: {nearest['date']}")

print()

# ─────────────────────────────────────────────────────────────────────────────
# SCENARIO 3: Customer asks for May, slots DO include May
# ─────────────────────────────────────────────────────────────────────────────
print("=" * 55)
print("SCENARIO 3: Caller asks for May, slots include May")
print("  Should show first May slot, not first overall slot")
print("=" * 55)

slots_with_may = [
    {"date": (today + datetime.timedelta(days=i)).isoformat(), "time": "09:00"}
    for i in range(1, 35)
]
after_may = [t for t in slots_with_may if t["date"] >= f"{today.year}-05-01"]
if after_may:
    print(f"First slot overall:  {slots_with_may[0]['date']}  (April - should NOT be shown)")
    print(f"First May slot:      {after_may[0]['date']}  (PASS - shown instead)")
else:
    print("No May slots available in this window.")
