"""
supervisor_receptionmate.py — Tyresoft ReceptionMate Voice AI Agent
Full Level 3 replication of GarageHive architecture.
Hybrid Supervisor: 1 speaking agent + 3 silent specialist LLMs.
"""

import os
import re
import json
import asyncio
import datetime

from livekit import agents
from livekit.agents import AgentSession, Agent, function_tool, JobContext, WorkerOptions, WorkerType, cli
from livekit.plugins import silero, deepgram, elevenlabs
from livekit.plugins.turn_detector.multilingual import MultilingualModel

try:
    from livekit.plugins import noise_cancellation
    HAS_NC = True
except ImportError:
    HAS_NC = False
    print("[STARTUP] noise_cancellation plugin not installed — running without")

from agent_infra import (
    # Config
    SPEAKING_MODEL, ELEVEN_VOICE_ID, ELEVEN_TTS_MODEL,
    ELEVEN_STABILITY, ELEVEN_SIMILARITY, ELEVEN_STYLE,
    TYRESOFT_WORKSPACE,
    # Enums & State
    Step, CallState,
    # Constants
    SERVICES, BRANCHES, CHANNEL_ID, _BVP_SWAPS,
    # Functions
    uk_now, uk_timestamp, uk_date,
    match_full_service, normalize_vrn,
    format_vrm_for_speech, format_price_for_speech, format_date_for_speech,
    format_time_for_speech, format_tyre_size_for_speech, format_brand_for_speech,
    format_vehicle_for_speech,
    sanitise_phone, sanitise_email,
    # API
    lookup_vehicle_by_vrm, get_available_slots, save_customer, save_vehicle,
    create_sale, build_tyre_item, build_service_item,
    # Inventory
    TYRE_INVENTORY, search_inventory, parse_tyre_size,
    # Specialists
    ask_service_advisor, ask_timeslot_matcher, ask_message_summariser,
    # Monitoring
    send_discord_notification, send_api_error_notification,
    # Greeting
    get_dynamic_greeting,
)


# ═══════════════════════════════════════════════════════════════════════════
# SYSTEM PROMPT
# ═══════════════════════════════════════════════════════════════════════════
def _build_system_prompt() -> str:
    now = uk_now()
    svc_list = "\n".join(
        f"  - {code}: {s['name']} ({s['price']} pounds)"
        for code, s in SERVICES.items()
    )
    return f"""You are Leah, a friendly voice AI receptionist for Tyresoft Tyre Centre.

TODAY: {now.strftime('%A %d %B %Y')} | TIME: {now.strftime('%H:%M')} UK

CORE RULES — FOLLOW WITHOUT EXCEPTION:
1. NO filler before/between tool calls. No "one moment", "let me check", "bear with me".
   When a tool says "GENERATE ZERO SPEECH", produce ZERO text — just call the tool immediately.
   Do NOT narrate what you are about to do. Do NOT repeat back what the caller asked.
2. NEVER say "confirmed" or "booked" unless a tool directive tells you to.
3. ONE QUESTION PER TURN. Ask one thing, then STOP. Wait for caller.
4. Each tool returns a DIRECTIVE — follow it EXACTLY.
5. Address caller by FIRST NAME only. Never surname as greeting.
6. ALL prices in pounds. Say "X pounds" not the pound symbol (TTS reads it as dollars).
7. Say "registration" not "reg" — TTS reads "reg" as R-E-G.
8. If submit_booking returns an error, MUST collect missing info and retry. NEVER end the call.
9. British English ONLY: "lovely", "brilliant", "cheers", "no worries", "pop it in", "give us a ring".
10. NEVER say these American phrases: "awesome", "gotten", "you guys", "super", "reach out",
    "don't hesitate to reach out", "sounds great", "absolutely", "for sure", "go ahead".

PRONUNCIATION:
- Times naturally: "half eight in the morning", "two in the afternoon"
- Registration: read back clearly with pauses "R  V  Zero  Six  L  N  T"
- Tyre sizes: "205 55 R 16" with pauses between numbers
- Prices: say naturally "forty-five pounds ninety-nine"

VOICE STYLE:
- SLOW, CALM, MEASURED pace. Never rush.
- Natural pauses between sentences.
- Friendly receptionist, not rushed call centre agent.
- British phrases: "pop that down for you", "get that sorted", "book you in"

AVAILABLE SERVICES:
{svc_list}

WORKFLOW:
1. MANDATORY FIRST STEP: Get the caller's name BEFORE anything else.
   - The greeting already asks "Who am I speaking to?"
   - Their FIRST response is their name. Call save_caller_name immediately. GENERATE ZERO SPEECH.
   - If they skip their name and say a registration or request, STILL ask for their name first.
   - Say: "Before I look into that, could I get your name please?"
   - Do NOT call ANY other tool until save_caller_name has succeeded.
2. Follow the directive from save_caller_name.
3. If they need tyres or engine-dependent service → ask for registration → call lookup_vehicle.
4. Follow EVERY tool directive EXACTLY.
5. Build their basket (tyres + services).
6. When done adding → call proceed_to_booking. GENERATE ZERO SPEECH.
   IMPORTANT: You MUST call proceed_to_booking BEFORE select_timeslot. Never skip it.
   Even if the caller already mentioned a date/time, call proceed_to_booking first.
7. Select timeslot → collect phone/email with save_contact_details → submit_booking.
   IMPORTANT: Do NOT call save_contact_details until the caller gives you an actual phone or email.
   Never call it with empty/null values.

CRITICAL: The ONLY tool you may call before save_caller_name is save_caller_name itself.
If the caller says a registration number, tyre size, or service request before giving their name,
you MUST ask for their name first. No exceptions.

STAY ON TASK: Only help with tyres, bookings, MOT, servicing. Redirect off-topic politely.
If customer interrupts, continue toward objective — don't restart.
If customer already stated what they need, DON'T ask again.

SELF-TALK / PAUSES: If the caller is clearly talking to themselves or asking you to wait
("where is it", "hang on", "let me find it", "one sec", "second", "one second", "just a sec",
"um", "hold on", "give me a minute", "wait", "bear with me"), just wait patiently.
Say "No worries, take your time" at most — then STOP and WAIT. Do NOT continue with the next step.
Do NOT try to answer rhetorical questions or self-talk. Do NOT give advice on finding their phone number.
Do NOT assume they've answered YES or NO to your previous question — wait for a clear answer.
"""


# ═══════════════════════════════════════════════════════════════════════════
# AGENT CLASS
# ═══════════════════════════════════════════════════════════════════════════
class TyresoftSupervisor(Agent):
    def __init__(self):
        self._state = CallState()
        super().__init__(instructions=_build_system_prompt())

    # ───────────────────────────────────────────────────────────────────
    # TOOL 1: save_caller_name
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def save_caller_name(self, first_name: str, last_name: str = "") -> str:
        """Save the caller's name. Call this FIRST before anything else.
        Pass the caller's EXACT spoken name. Do NOT modify or guess.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.GREETING:
            return f"ERROR: Wrong step ({s.step.value}). Name already saved as {s.customer_name_first}."

        first = first_name.strip().title()
        last = last_name.strip().title()

        # Stutter detection: "Gab Gabriel" → "Gabriel"
        if first and last and last.lower().startswith(first.lower()) and len(first) < len(last):
            first = last
            last = ""

        # Reject single-character names
        if len(first) < 2:
            return (
                "REJECTED: Name too short. Ask the caller their name again.\n"
                "Say: 'Sorry, I didn't catch that. Could you tell me your name?'\n"
                "Then STOP."
            )

        # Hallucination guard: check against recent transcripts
        if s.recent_transcripts:
            all_text = " ".join(s.recent_transcripts[-3:]).lower()
            if first.lower() not in all_text and len(s.recent_transcripts) > 0:
                print(f"[WARN] Name '{first}' not found in recent transcripts, accepting anyway")

        s.customer_name_first = first
        s.customer_name_last = last
        s.step = Step.BUILDING_BASKET

        print(f"[STATE] Name: {first} {last} | Step → BUILDING_BASKET")

        # Check transcripts for earlier requests so LLM doesn't have to guess
        earlier_request = ""
        if s.recent_transcripts:
            all_text = " ".join(s.recent_transcripts).lower()
            requests_found = []
            if any(w in all_text for w in ("tyre", "tire", "tyres", "tires", "rubber", "fitting")):
                requests_found.append("tyres/fitting")
            if any(w in all_text for w in ("full service", "service", "servic")):
                requests_found.append("full service")
            if "mot" in all_text:
                requests_found.append("MOT")
            if any(w in all_text for w in ("air con", "a/c", "aircon", "climate")):
                requests_found.append("air con")
            if any(w in all_text for w in ("align", "tracking")):
                requests_found.append("wheel alignment")
            if any(w in all_text for w in ("puncture", "flat", "nail")):
                requests_found.append("puncture repair")
            if requests_found:
                earlier_request = ", ".join(requests_found)
                print(f"[STATE] Earlier requests detected: {earlier_request}")

        if earlier_request:
            return (
                f"Name saved: {first} {last}.\n"
                f"The caller ALREADY mentioned they need: {earlier_request}.\n"
                f"Do NOT ask 'What can I help you with?' — they already told you.\n"
                f"Say: 'Lovely, thanks {first}. You mentioned {earlier_request} — could I get your vehicle registration please?'\n"
                "Then STOP. Wait for their registration.\n"
                f"If the caller mentioned MULTIPLE things, remember ALL of them: {earlier_request}. "
                "Work through each one after getting the vehicle."
            )
        else:
            return (
                f"Name saved: {first} {last}.\n"
                f"Say: 'Lovely, thanks {first}. What can I help you with today?'\n"
                "Then STOP. Wait for the caller to respond.\n"
                "Based on their response:\n"
                "- If they need tyres → ask for their vehicle registration\n"
                "- If they mention a service → ask for registration if needed, or add directly\n"
                "- If they want a callback → take their message\n"
                "ONE QUESTION ONLY. Then STOP."
            )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 2: lookup_vehicle (two-step readback)
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def lookup_vehicle(self, reg: str, confirmed: bool = False) -> str:
        """Look up a vehicle by registration. TWO-STEP process:
        Step 1: Pass the caller's EXACT words as-is (confirmed=False). Tool normalizes and returns readback.
        Step 2: After caller confirms the readback, call again with confirmed=True for actual API lookup.
        Do NOT convert NATO/phonetic letters yourself — the tool handles all conversion.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step not in (Step.BUILDING_BASKET, Step.NEED_VRN):
            if s.step == Step.GREETING:
                return (
                    "BLOCKED: You MUST call save_caller_name FIRST. No other tool may be called before the caller's name is saved.\n"
                    "The caller has NOT given their name yet. What they said is NOT a name — it may be a registration or request.\n"
                    "Say: 'Before I look into that, could I get your name please?'\n"
                    "Then STOP. Wait for their name. Then call save_caller_name. GENERATE ZERO SPEECH."
                )
            return f"ERROR: Wrong step ({s.step.value}). Vehicle lookup not needed now."

        # SHORT-CIRCUIT: Vehicle already confirmed with same VRN — don't re-lookup
        if s.vrn_confirmed and s.vrn and confirmed:
            candidate = normalize_vrn(reg) if not s.vrn_pending else s.vrn_pending
            if candidate == s.vrn:
                s.step = Step.BUILDING_BASKET
                print(f"[STATE] Vehicle already confirmed ({s.vrn}) — skipping re-lookup")
                return (
                    f"Vehicle already confirmed: {s.vehicle_year} {s.vehicle_make} {s.vehicle_model}.\n"
                    "Do NOT re-confirm the vehicle. Do NOT call lookup_vehicle again.\n"
                    "Continue with the caller's request — add services or tyres to the basket.\n"
                    "If tyres are unavailable for this vehicle, offer a callback instead."
                )

        if not confirmed:
            # STEP 1: Normalize + readback
            # Check for partial accumulation
            raw = reg.strip()
            if s.vrn_partial:
                raw = s.vrn_partial + " " + raw
                s.vrn_partial = ""

            normalized = normalize_vrn(raw)

            # Name echo protection
            caller_names = {s.customer_name_first.upper(), s.customer_name_last.upper()} - {""}
            if normalized in caller_names:
                return (
                    f"IGNORED: '{normalized}' is the caller's name, not a registration.\n"
                    "Ask: 'Could you give me your vehicle registration number?'\n"
                    "Then STOP."
                )

            # Partial VRN (less than 4 chars)
            if len(normalized) < 4:
                s.vrn_partial = normalized
                spaced = "  ".join(normalized)
                return (
                    f"PARTIAL VRN: only got '{spaced}' so far.\n"
                    "Say: 'I've got {spaced} so far. Could you give me the rest of the registration?'\n"
                    "Then STOP. Wait for the rest."
                )

            s.vrn_pending = normalized

            # Reset attempt counter if this is a different vehicle than previously confirmed
            if s.vrn_confirmed and normalized != s.vrn:
                s.vrn_attempts = 0
                print(f"[STATE] New VRN ({normalized} != {s.vrn}) — resetting attempts")

            s.vrn_attempts += 1
            s.step = Step.NEED_VRN
            spaced = format_vrm_for_speech(normalized)

            print(f"[STATE] VRN pending: {normalized} | Step → NEED_VRN | Attempt {s.vrn_attempts}")
            return (
                f"Normalized registration: {spaced}\n"
                f"Say: 'Just to confirm, that registration is {spaced}. Is that right?'\n"
                "Wait for YES/NO.\n"
                "If YES → call lookup_vehicle with the same reg and confirmed=true. GENERATE ZERO SPEECH.\n"
                "If NO → ask them to say it again.\n"
                "If they say a different registration → call lookup_vehicle with the new one."
            )

        else:
            # STEP 2: Confirmed → API lookup
            normalized = s.vrn_pending if s.vrn_pending else normalize_vrn(reg)
            if not normalized:
                return "ERROR: No registration to look up. Ask the caller for their registration."

            # Try primary, then B/V/P swaps
            regs_to_try = [normalized]
            first_char = normalized[0]
            if first_char in _BVP_SWAPS:
                for alt in _BVP_SWAPS[first_char]:
                    regs_to_try.append(alt + normalized[1:])

            vehicle = None
            used_vrn = normalized
            for try_vrn in regs_to_try:
                vehicle = await lookup_vehicle_by_vrm(try_vrn)
                if vehicle:
                    used_vrn = try_vrn
                    break

            if not vehicle:
                s.step = Step.BUILDING_BASKET
                s.vrn_pending = ""
                if s.vrn_attempts >= 3:
                    asyncio.create_task(send_api_error_notification(
                        error_type="VRN_FAILED_3X", endpoint="vrmLookup",
                        error_message=f"3 failed attempts for {normalized}",
                    ))
                    return (
                        f"Vehicle not found after {s.vrn_attempts} attempts.\n"
                        "Say: 'I'm having trouble finding that registration. "
                        "Let me arrange for someone to call you back to help.'\n"
                        "Then collect their phone number for a callback."
                    )
                spaced = format_vrm_for_speech(normalized)
                return (
                    f"Vehicle not found for {spaced}.\n"
                    f"Say: 'I couldn't find a vehicle on that registration. Could you double-check and tell me again?'\n"
                    "Then STOP. Wait for response."
                )

            # Success — store vehicle info
            s.vrn = used_vrn
            s.vrn_confirmed = True
            s.vrn_pending = ""
            s.vehicle_info = vehicle
            s.vehicle_make = vehicle.get("make", "")
            s.vehicle_model = vehicle.get("model", "")
            s.vehicle_year = vehicle.get("yearOfManufacture", "")
            s.vehicle_engine_cc = vehicle.get("engineCapacity", "")
            s.vehicle_fuel = vehicle.get("fuel", "")
            s.tyre_size_options = vehicle.get("tyreSizeOptions", [])
            s.step = Step.CONFIRMING_VEHICLE

            spoken_vehicle = format_vehicle_for_speech(s.vehicle_make, s.vehicle_model)
            spoken_vrn = format_vrm_for_speech(used_vrn)

            print(f"[STATE] Vehicle found: {s.vehicle_make} {s.vehicle_model} | Step → CONFIRMING_VEHICLE")
            return (
                f"Vehicle found: {s.vehicle_year} {spoken_vehicle} (registration {spoken_vrn}).\n"
                f"You MUST say this to the caller: 'I've got a {s.vehicle_year} {spoken_vehicle} on that registration. Is that right?'\n"
                "Then STOP and WAIT for the caller to say YES or NO.\n"
                "Do NOT skip this step. Do NOT auto-confirm. The caller MUST hear the vehicle description.\n"
                "After they confirm YES → call confirm_vehicle with confirmed=true. GENERATE ZERO SPEECH.\n"
                "If the VEHICLE is wrong → call confirm_vehicle with confirmed=false."
            )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 3: confirm_vehicle
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def confirm_vehicle(self, confirmed: bool) -> str:
        """Confirm or reject the vehicle from lookup.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.CONFIRMING_VEHICLE:
            return f"ERROR: Wrong step ({s.step.value}). No vehicle to confirm."

        if not confirmed:
            s.step = Step.BUILDING_BASKET
            s.vrn = ""
            s.vrn_confirmed = False
            s.vehicle_info = {}
            print("[STATE] Vehicle rejected → BUILDING_BASKET")
            return (
                "Vehicle rejected.\n"
                "Say: 'No worries. Could you give me the registration again?'\n"
                "Then STOP."
            )

        s.step = Step.BUILDING_BASKET
        print(f"[STATE] Vehicle confirmed: {s.vrn} | Step → BUILDING_BASKET")

        # Build tyre size info
        tyre_info = ""
        no_tyre_sizes = False
        if s.tyre_size_options:
            lines = []
            for i, opt in enumerate(s.tyre_size_options[:5], 1):
                size = opt.get("tyreSizeFront", "")
                std = " (recommended)" if opt.get("standardOption") else ""
                lines.append(f"  {i}. {size}{std}")
            tyre_info = "\nAvailable tyre sizes:\n" + "\n".join(lines)
        else:
            no_tyre_sizes = True
            tyre_info = "\nNO TYRE SIZES on record for this vehicle."

        # Engine info for services
        engine_info = ""
        if s.vehicle_engine_cc:
            engine_info = f"\nEngine: {s.vehicle_engine_cc}cc {s.vehicle_fuel}"

        # Build tyre directive based on availability
        if no_tyre_sizes:
            tyre_directive = (
                "- If they wanted TYRES → This vehicle has NO tyre sizes on record. "
                "Do NOT call select_tyre_size or search_tyres — they will fail.\n"
                "  Say: 'I'm afraid I don't have tyre sizes on record for this vehicle. "
                "Would you like me to arrange a callback so the team can find the right tyres for you?'\n"
                "  Then STOP and WAIT for the caller to say YES or NO.\n"
                "  If they say YES clearly → collect phone and call submit_callback.\n"
                "  If they say NO or give a different registration → handle that instead.\n"
                "  If they push back ('are you sure?', 'really?', 'that can't be right') → "
                "Say: 'I understand, unfortunately the system doesn't have tyre sizes listed for this vehicle. "
                "If you have a different vehicle registration, I can look that up instead?'\n"
                "  Do NOT assume they want a callback. Do NOT ask for their phone number unless they explicitly agree.\n"
            )
        else:
            tyre_directive = (
                "- If they wanted TYRES and there are multiple sizes → Ask: 'Which tyre size do you need? "
                "Or shall I go with the recommended one?' Then STOP.\n"
                "- If they wanted TYRES and only ONE tyre size → call select_tyre_size with option_number=1. GENERATE ZERO SPEECH.\n"
                "- If caller already said 'recommended' or 'go with recommended' → call select_tyre_size with option_number=1. GENERATE ZERO SPEECH.\n"
            )

        return (
            f"Vehicle confirmed: {s.vehicle_year} {s.vehicle_make} {s.vehicle_model}.{engine_info}{tyre_info}\n"
            "Now check the conversation context — what did the caller originally ask for?\n"
            f"{tyre_directive}"
            "- If they wanted a SERVICE → add the correct service based on engine size.\n"
            "IMPORTANT: When the caller has already told you what they want, act on it. Do NOT repeat what they said back as a question.\n"
            "Then STOP. Wait for response."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 4: select_tyre_size
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def select_tyre_size(self, option_number: int = 1) -> str:
        """Select tyre size by option number from the vehicle's tyre sizes.
        Use the number shown in the confirm_vehicle results.
        After selection, the tool automatically searches for matching tyres.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.BUILDING_BASKET:
            return f"ERROR: Wrong step ({s.step.value})."
        if not s.tyre_size_options:
            return "ERROR: No tyre sizes available. Need to look up vehicle first."

        idx = option_number - 1
        if idx < 0 or idx >= len(s.tyre_size_options):
            return f"REJECTED: Option {option_number} invalid. Choose 1-{len(s.tyre_size_options)}."

        opt = s.tyre_size_options[idx]
        s.selected_tyre_size = opt.get("tyreSizeFront", "")
        s.selected_tyre_search_string = opt.get("searchString", "")

        # Parse size and auto-search (prefetch pattern)
        parsed = parse_tyre_size(s.selected_tyre_size)
        print(f"[TYRE SEARCH] Size: {s.selected_tyre_size} → w={parsed['width']} a={parsed['aspect']} r={parsed['rim']}")
        results = search_inventory(
            s.selected_branch,
            width=parsed["width"], aspect=parsed["aspect"], rim=parsed["rim"],
        )
        spoken_size = format_tyre_size_for_speech(s.selected_tyre_size)

        # Auto-search other branch if current branch has nothing
        searched_branch = s.selected_branch
        if not results:
            other_branch = 2 if s.selected_branch == 1 else 1
            results = search_inventory(
                other_branch,
                width=parsed["width"], aspect=parsed["aspect"], rim=parsed["rim"],
            )
            if results:
                searched_branch = other_branch
                s.selected_branch = other_branch
                other_name = BRANCHES.get(other_branch, {}).get("name", f"Branch {other_branch}")
                print(f"[STATE] Auto-switched to Branch {other_branch} — found {len(results)} results")

        s.last_search_results = results

        if not results:
            print(f"[TYRE SEARCH] No results for size={s.selected_tyre_size} "
                  f"(w={parsed['width']} a={parsed['aspect']} r={parsed['rim']}) "
                  f"at either branch")
            return (
                f"Size {spoken_size} selected but no tyres found in stock at either branch.\n"
                "Say: 'I'm sorry, I don't have any tyres in that size at the moment across either of our branches. "
                "Would you like me to arrange a callback so the team can source them for you?'\n"
                "Then STOP."
            )

        # Format results
        lines = []
        for i, t in enumerate(results, 1):
            brand = format_brand_for_speech(t.get("brand", ""))
            price = format_price_for_speech(t.get("price", 0))
            avail = t.get("availability", "In Stock")
            rf = " (Run Flat)" if t.get("runflat") else ""
            lines.append(f"  {i}. {brand} — {price} per tyre — {avail}{rf}")
        result_text = "\n".join(lines)

        cheapest = format_brand_for_speech(results[0].get("brand", ""))
        cheapest_price = format_price_for_speech(results[0].get("price", 0))

        branch_name = BRANCHES.get(searched_branch, {}).get("name", f"Branch {searched_branch}")
        print(f"[STATE] Tyre size: {s.selected_tyre_size} | {len(results)} results at Branch {searched_branch}")
        return (
            f"Size {spoken_size} selected. Found {len(results)} options at {branch_name}:\n{result_text}\n\n"
            f"Say: 'For size {spoken_size}, the cheapest option is {cheapest} at {cheapest_price} per tyre.'\n"
            "Then briefly mention 1-2 more options.\n"
            "Ask: 'Which one would you like?'\n"
            "Then STOP. Wait for their choice.\n"
            "When they choose → call add_tyre_to_basket with the selection_number (1, 2, etc)."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 5: search_tyres
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def search_tyres(self, brand: str = "", max_results: int = 6) -> str:
        """Search for tyres. Uses the already-selected tyre size.
        Optionally filter by brand name.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.BUILDING_BASKET:
            return f"ERROR: Wrong step ({s.step.value})."
        if not s.selected_tyre_size:
            return "ERROR: No tyre size selected. Need to select_tyre_size first."

        parsed = parse_tyre_size(s.selected_tyre_size)
        results = search_inventory(
            s.selected_branch,
            width=parsed["width"], aspect=parsed["aspect"], rim=parsed["rim"],
            brand=brand, max_results=max_results,
        )
        spoken_size = format_tyre_size_for_speech(s.selected_tyre_size)

        # Auto-search other branch if current branch has nothing
        if not results:
            other_branch = 2 if s.selected_branch == 1 else 1
            results = search_inventory(
                other_branch,
                width=parsed["width"], aspect=parsed["aspect"], rim=parsed["rim"],
                brand=brand, max_results=max_results,
            )
            if results:
                s.selected_branch = other_branch
                print(f"[STATE] Auto-switched to Branch {other_branch} for search")

        s.last_search_results = results

        if not results:
            if brand:
                return (
                    f"No {brand} tyres found in size {spoken_size} at either branch.\n"
                    f"Say: 'I don't have any {brand} in that size across either branch. Would you like to try another brand?'\n"
                    "Then STOP."
                )
            return (
                f"No tyres found for {spoken_size} at either branch.\n"
                "Say: 'I'm sorry, I don't have any tyres in that size at the moment. "
                "Would you like me to arrange a callback so the team can source them for you?'\n"
                "Then STOP."
            )

        lines = []
        for i, t in enumerate(results, 1):
            b = format_brand_for_speech(t.get("brand", ""))
            p = format_price_for_speech(t.get("price", 0))
            rf = " (Run Flat)" if t.get("runflat") else ""
            lines.append(f"  {i}. {b} — {p} per tyre{rf}")
        return (
            f"Found {len(results)} tyres for {spoken_size}:\n" + "\n".join(lines) + "\n\n"
            "Present the options to the caller. Ask which they'd like.\n"
            "Then STOP. When they choose → call add_tyre_to_basket."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 6: add_tyre_to_basket (BY SELECTION NUMBER — fixes tyre bug)
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def add_tyre_to_basket(self, selection_number: int, quantity: int = 4) -> str:
        """Add tyres to basket by selection number from the last search results.
        IMPORTANT: You MUST call select_tyre_size FIRST to search for tyres before calling this tool.
        selection_number: the number shown in search results (1, 2, 3, etc.)
        quantity: number of tyres (default 4 for a full set)
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.BUILDING_BASKET:
            return f"ERROR: Wrong step ({s.step.value})."
        if not s.last_search_results:
            return (
                "ERROR: No search results available. You must call select_tyre_size FIRST to search for tyres.\n"
                "Call select_tyre_size now with the correct option_number. GENERATE ZERO SPEECH."
            )

        idx = selection_number - 1
        if idx < 0 or idx >= len(s.last_search_results):
            return f"REJECTED: Selection {selection_number} invalid. Choose 1-{len(s.last_search_results)}."

        tyre = s.last_search_results[idx]
        item = {
            "type": "tyre",
            "stock_number": tyre.get("stock_number", ""),
            "brand": tyre.get("brand", ""),
            "title": tyre.get("title", ""),
            "price": tyre.get("price", 0),
            "quantity": quantity,
            "total": tyre.get("price", 0) * quantity,
        }
        s.basket_items.append(item)

        brand_name = format_brand_for_speech(tyre.get("brand", ""))
        total_spoken = format_price_for_speech(item["total"])

        print(f"[BASKET] Added: {quantity}x {brand_name} @ {tyre.get('price', 0)} = {item['total']}")
        print(f"[BASKET] Stock: {tyre.get('stock_number', '')} | Basket: {len(s.basket_items)} items")
        return (
            f"Added: {quantity}x {brand_name} tyres. Total for the set: {total_spoken}.\n"
            f"Say: 'Lovely, {quantity} {brand_name} tyres — that's {total_spoken} for the set.'\n"
            "Ask: 'Would you like anything else, or shall we get those booked in?'\n"
            "Then STOP. Wait for response.\n"
            "If done adding → call proceed_to_booking. GENERATE ZERO SPEECH.\n"
            "If they want more → continue."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 7: add_service_to_basket (with Service Advisor specialist)
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def add_service_to_basket(self, service_description: str) -> str:
        """Add a service to the basket. Pass the caller's EXACT description.
        The tool uses an AI specialist to match vague descriptions to services.
        Examples: 'MOT', 'full service', 'air con recharge', 'wheel alignment', 'puncture repair'.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.BUILDING_BASKET:
            if s.step == Step.GREETING:
                return (
                    "BLOCKED: You MUST call save_caller_name FIRST. No other tool may be called before the caller's name is saved.\n"
                    "Say: 'Before I look into that, could I get your name please?'\n"
                    "Then STOP. Wait for their name. Then call save_caller_name. GENERATE ZERO SPEECH."
                )
            return f"ERROR: Wrong step ({s.step.value})."

        # Ask Service Advisor specialist
        advice = await ask_service_advisor(service_description)
        code = advice.get("service_code", "callback")

        # Handle special codes
        if code == "need_tyres":
            if not s.vrn_confirmed:
                return (
                    "The caller needs tyres. A vehicle registration is required to find the right size.\n"
                    "Say: 'To find the right tyres, I'll need your vehicle registration. Could you read that out for me?'\n"
                    "Then STOP. Wait for VRN."
                )
            return "The caller needs tyres. Use select_tyre_size or search_tyres instead."

        if code == "full_service":
            if not s.vrn_confirmed or not s.vehicle_engine_cc:
                return (
                    "Full service depends on engine size. Need the vehicle registration first.\n"
                    "Say: 'To work out the right service for your car, I'll need your registration. Could you read that out?'\n"
                    "Then STOP."
                )
            try:
                cc = int(s.vehicle_engine_cc)
            except (ValueError, TypeError):
                cc = 1500
            code = match_full_service(cc, s.vehicle_fuel)

        if code == "callback":
            if s.vrn_confirmed:
                # Mid-booking: don't derail to MESSAGE_ONLY — stay at BUILDING_BASKET
                # so the caller can still add tyres or other services
                return (
                    "This service needs a human to arrange.\n"
                    "Say: 'That's something the team would need to help with directly. "
                    "I can pop a note on your booking for them, or arrange a callback. "
                    "Is there anything else I can help with in the meantime — tyres, MOT, anything like that?'\n"
                    "Then STOP. If the caller has nothing else, collect phone and call submit_callback."
                )
            s.step = Step.MESSAGE_ONLY
            return (
                "This needs a human to help.\n"
                "Say: 'That's something one of the team would need to help with. Let me arrange a callback for you.'\n"
                "Ask for their phone number and a brief message.\n"
                "Then call submit_callback."
            )

        if code not in SERVICES:
            return (
                f"Could not match '{service_description}' to a service.\n"
                "Say: 'I'm not sure which service that is. We do MOTs, full servicing, wheel alignment, "
                "air con recharge, and puncture repair. Which of those were you after?'\n"
                "Then STOP."
            )

        svc = SERVICES[code]

        # Duplicate prevention: reject if same service already in basket
        for existing in s.basket_items:
            if existing.get("type") == "service" and existing.get("code") == code:
                spoken_price = format_price_for_speech(existing["price"])
                print(f"[BASKET] Duplicate blocked: {svc['name']} already in basket")
                return (
                    f"ALREADY IN BASKET: {svc['name']} at {spoken_price} is already added.\n"
                    "Do NOT add it again. Say: 'I've already got that down for you.'\n"
                    "Ask: 'Anything else, or shall we get that booked in?'\n"
                    "Then STOP."
                )

        item = {
            "type": "service",
            "code": code,
            "name": svc["name"],
            "price": svc["price"],
            "service_id": svc["service_id"],
            "quantity": 1,
            "total": svc["price"],
        }
        s.basket_items.append(item)

        spoken_price = format_price_for_speech(svc["price"])
        print(f"[BASKET] Added service: {svc['name']} (ID: {svc['service_id']}) @ {svc['price']}")
        return (
            f"Added: {svc['name']} at {spoken_price}.\n"
            f"Say: 'Right, I've got {svc['name']} down for you at {spoken_price}.'\n"
            "Ask: 'Anything else, or shall we get that booked in?'\n"
            "Then STOP."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 8: view_basket
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def view_basket(self) -> str:
        """Show all items in the basket."""
        s = self._state
        if not s.basket_items:
            return "Basket is empty. Ask what they'd like."

        lines = []
        total = 0
        for i, item in enumerate(s.basket_items, 1):
            if item["type"] == "tyre":
                b = format_brand_for_speech(item.get("brand", ""))
                p = format_price_for_speech(item["total"])
                lines.append(f"  {i}. {item['quantity']}x {b} tyres — {p}")
            else:
                p = format_price_for_speech(item["price"])
                lines.append(f"  {i}. {item['name']} — {p}")
            total += item["total"]

        total_spoken = format_price_for_speech(total)
        return (
            "Current basket:\n" + "\n".join(lines) +
            f"\nTotal: {total_spoken}\n"
            "Read this to the caller naturally."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 9: remove_from_basket
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def remove_from_basket(self, item_number: int) -> str:
        """Remove an item from the basket by its number (1-based)."""
        s = self._state
        if s.step != Step.BUILDING_BASKET:
            return f"ERROR: Wrong step ({s.step.value})."
        idx = item_number - 1
        if idx < 0 or idx >= len(s.basket_items):
            return f"REJECTED: Item {item_number} not in basket (1-{len(s.basket_items)})."
        removed = s.basket_items.pop(idx)
        name = removed.get("name", removed.get("brand", "item"))
        return (
            f"Removed: {name}.\n"
            f"Say: 'No worries, I've taken that off. Anything else?'\n"
            "Then STOP."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 10: proceed_to_booking
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def proceed_to_booking(self) -> str:
        """Move from basket building to timeslot selection.
        Validates basket is not empty and summarises items.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.BUILDING_BASKET:
            return f"ERROR: Wrong step ({s.step.value})."
        if not s.basket_items:
            return "ERROR: Basket is empty. Add items first."

        s.step = Step.NEED_TIMESLOT

        # Build summary
        parts = []
        total = 0
        for item in s.basket_items:
            if item["type"] == "tyre":
                b = format_brand_for_speech(item.get("brand", ""))
                parts.append(f"{item['quantity']} {b} tyres")
            else:
                parts.append(item["name"])
            total += item["total"]
        summary = " and ".join(parts) if len(parts) <= 2 else ", ".join(parts[:-1]) + f" and {parts[-1]}"
        total_spoken = format_price_for_speech(total)

        print(f"[STATE] Step → NEED_TIMESLOT | {len(s.basket_items)} items, total {total}")
        return (
            f"Basket: {summary}. Total: {total_spoken}.\n"
            f"Say: 'Right, so that's {summary}, coming to {total_spoken}. When would you like to book that in?'\n"
            "Then STOP. Wait for their preferred date/time."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 11: select_timeslot (with Timeslot Matcher specialist)
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def select_timeslot(self, preference: str) -> str:
        """Select a booking timeslot. Pass the caller's EXACT FULL words about when they want.
        CRITICAL: Include ALL time modifiers like 'next week', 'next', 'this week', 'after'.
        Examples: 'tomorrow morning', 'Thursday next week', 'next Friday at 2', 'around 10 AM'.
        WRONG: 'Thursday' when they said 'Thursday next week' — you MUST include 'next week'.
        The tool handles all date/time parsing and availability checking.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step == Step.DONE:
            # Booking already submitted — caller wants to change date
            ref = getattr(s, "booking_ref", "")
            ref_text = f" (reference {ref})" if ref else ""
            return (
                f"BOOKING ALREADY SUBMITTED{ref_text}. The date CANNOT be changed by this system.\n"
                "Say: 'I'm sorry, that booking has already gone through. "
                "Let me pop a callback request in so the team can adjust the date for you. "
                "They'll give you a ring shortly.'\n"
                "Then call submit_callback with a message explaining the date change needed.\n"
                "Do NOT ask the caller to ring back themselves."
            )
        if s.step != Step.NEED_TIMESLOT:
            return f"ERROR: Wrong step ({s.step.value})."

        # Determine service IDs for availability check
        service_ids = []
        has_tyres = False
        for item in s.basket_items:
            if item["type"] == "service":
                sid = SERVICES.get(item.get("code"), {}).get("service_id")
                if sid:
                    service_ids.append(sid)
            elif item["type"] == "tyre":
                has_tyres = True
        # Deduplicate service IDs (duplicate IDs may confuse the API)
        service_ids = list(dict.fromkeys(service_ids))
        if has_tyres or not service_ids:
            service_ids = [0] + service_ids if service_ids else [0]

        # API supports max 2 booking types per request
        if len(service_ids) > 2:
            print(f"[TIMESLOT] Capping service_ids from {len(service_ids)} to 2: {service_ids[:2]}")
            service_ids = service_ids[:2]

        depot_id = BRANCHES.get(s.selected_branch, {}).get("depot_id", 1)

        # Use specialist to parse preference
        match = await ask_timeslot_matcher(preference, s.available_slots)
        target_date = match.get("date")
        target_time = match.get("time")

        # Validate specialist date against day name in preference
        from agent_infra import _parse_timeslot_fallback
        pref_lower = preference.lower()
        _day_names_check = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        pref_day_idx = None
        for _di, _dn in enumerate(_day_names_check):
            if _dn in pref_lower:
                pref_day_idx = _di
                break

        if target_date and pref_day_idx is not None:
            # Specialist returned a date — verify it matches the day name the caller said
            resolved_day = datetime.date.fromisoformat(target_date).weekday()
            if resolved_day != pref_day_idx:
                print(f"[TIMESLOT] Specialist date {target_date} is {_day_names_check[resolved_day]}, "
                      f"but caller said {_day_names_check[pref_day_idx]} — overriding with fallback")
                fallback = _parse_timeslot_fallback(preference, s.available_slots, uk_now().date())
                target_date = fallback.get("date")
                if not target_time:
                    target_time = fallback.get("time")

        # If specialist returned null date, try fallback parser before defaulting
        if not target_date:
            fallback = _parse_timeslot_fallback(preference, s.available_slots, uk_now().date())
            target_date = fallback.get("date")
            if not target_time:
                target_time = fallback.get("time")
            if target_date:
                print(f"[TIMESLOT] Specialist returned null date, fallback resolved: {target_date}")

        # If still no date, default to tomorrow
        if not target_date:
            tomorrow = uk_now().date() + datetime.timedelta(days=1)
            target_date = tomorrow.isoformat()
            print(f"[TIMESLOT] No date resolved, defaulting to tomorrow: {target_date}")

        # Fetch availability for the target date
        print(f"[TIMESLOT] Searching: depot={depot_id} services={service_ids} date={target_date}")
        slots = await get_available_slots(depot_id, service_ids, target_date)
        s.available_slots = slots
        print(f"[TIMESLOT] Result: {len(slots)} slots found for {target_date}")

        if not slots:
            s.timeslot_attempts += 1
            date_text = format_date_for_speech(target_date)
            print(f"[TIMESLOT] No slots on {target_date} (attempt {s.timeslot_attempts})")

            # After 3 failed attempts, offer callback instead of looping
            if s.timeslot_attempts >= 3:
                print(f"[TIMESLOT] 3 failed attempts — offering callback")
                return (
                    f"No slots found after {s.timeslot_attempts} attempts.\n"
                    "Say: 'I'm really sorry, I'm struggling to find an available slot at the moment. "
                    "Let me arrange a callback so the team can get you booked in directly. "
                    "Could I take a phone number for you?'\n"
                    "Then collect phone + message and call submit_callback.\n"
                    "Do NOT keep searching for timeslots."
                )

            # Try next 5 days
            alt_dates = []
            check_date = datetime.date.fromisoformat(target_date)
            for i in range(1, 6):
                next_d = check_date + datetime.timedelta(days=i)
                print(f"[TIMESLOT] Fallback check: {next_d.isoformat()}")
                next_slots = await get_available_slots(depot_id, service_ids, next_d.isoformat())
                print(f"[TIMESLOT] Fallback result: {len(next_slots)} slots on {next_d.isoformat()}")
                if next_slots:
                    alt_dates.append(format_date_for_speech(next_d.isoformat()))
                    if len(alt_dates) >= 2:
                        break

            if alt_dates:
                alts = " or ".join(alt_dates)
                return (
                    f"No slots on {date_text}.\n"
                    f"Say: 'I haven't got anything available on {date_text}. "
                    f"The next available dates are {alts}. Would either of those work?'\n"
                    "Then STOP."
                )
            return (
                f"No slots available on {date_text} or nearby dates.\n"
                "Say: 'I'm sorry, we're quite booked up around then. What other dates might work for you?'\n"
                "Then STOP."
            )

        # Match specific time
        if target_time:
            exact = None
            close = []
            for slot in slots:
                st = slot.get("time", "")[:5]
                if st == target_time:
                    exact = slot
                    break
                if st.startswith(target_time.split(":")[0] + ":"):
                    close.append(slot)

            if exact:
                s.booking_date = target_date
                s.booking_time = exact.get("time", "")[:5]
                # Extract slot details from requiredSlots[0] or fall back to the slot itself
                req = (exact.get("requiredSlots") or [exact])[0]
                s.selected_slot = {
                    "date": target_date,
                    "time": s.booking_time,
                    "diaryCategoryID": req.get("diaryCategoryID", 1),
                    "estimatedTime": req.get("estimatedTime", 30),
                    "slotTypeID": req.get("slotTypeID", 1),
                }
                s.step = Step.NEED_CONTACT
                date_text = format_date_for_speech(target_date)
                time_text = format_time_for_speech(s.booking_time)
                print(f"[STATE] Slot: {target_date} {s.booking_time} | Step → NEED_CONTACT")
                return (
                    f"Slot confirmed: {date_text} at {time_text}.\n"
                    f"Say: 'Brilliant, {date_text} at {time_text} is available.'\n"
                    "Now collect contact details. Ask: 'Could I get a phone number for you?'\n"
                    "Then STOP."
                )

            if close:
                alts = [format_time_for_speech(c.get("time", "")[:5]) for c in close[:3]]
                return (
                    f"Exact time not available. Close alternatives: {', '.join(alts)}.\n"
                    f"Say: 'I haven't got that exact time, but I've got {', '.join(alts)}. Would any of those work?'\n"
                    "Then STOP."
                )

        # No specific time — show range
        first_t = format_time_for_speech(slots[0].get("time", "")[:5])
        last_t = format_time_for_speech(slots[-1].get("time", "")[:5])
        date_text = format_date_for_speech(target_date)
        return (
            f"Available on {date_text}: {len(slots)} slots from {first_t} to {last_t}.\n"
            f"Say: 'For {date_text}, I've got slots between {first_t} and {last_t}. What time suits you?'\n"
            "Then STOP. Wait for their preferred time."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 12: save_contact_details (with sanitisation)
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def save_contact_details(self, phone: str = "", email: str = "") -> str:
        """Save caller's phone and/or email. Pass whatever the caller just provided.
        The tool sanitises the input automatically (handles 'flush 44', spoken digits, etc.)
        IMPORTANT: Only call this when you HAVE actual contact details from the caller.
        Do NOT call with empty/null values — wait until the caller gives you a phone or email.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.NEED_CONTACT:
            return f"ERROR: Wrong step ({s.step.value})."

        # Guard: don't waste a round-trip if nothing was provided
        if not phone and not email:
            return "No contact details provided. Ask for a phone number first. Then STOP."

        # Save both phone and email FIRST, then decide what to return
        if phone:
            cleaned = sanitise_phone(phone)
            s.contact_phone = cleaned
            print(f"[STATE] Phone: {cleaned}")

        if email:
            # Guard: if email is just digits/spoken digits (no @ sign), it's
            # probably the rest of a phone number, not an email address
            test_email = sanitise_email(email)
            digits_only = re.sub(r"[^0-9]", "", test_email)
            if "@" not in test_email and digits_only == test_email and len(digits_only) <= 6:
                # This looks like remaining phone digits — append to phone
                s.contact_phone = (s.contact_phone or "") + digits_only
                print(f"[STATE] Phone (appended): {s.contact_phone}")
            else:
                s.contact_email = test_email
                print(f"[STATE] Email: {test_email}")

        # Now decide response based on what we have
        if s.contact_phone and s.contact_email:
            s.step = Step.CONFIRMED
            print(f"[STATE] Contact complete | Step → CONFIRMED")
            return (
                "All contact details collected.\n"
                "Say: 'Lovely, let me just pop that booking in for you.'\n"
                "NOW call submit_booking. GENERATE ZERO SPEECH."
            )

        if not s.contact_phone:
            if s.contact_email:
                return (
                    f"Email saved: {s.contact_email}.\n"
                    "Say: 'Lovely. And a phone number for you?'\n"
                    "Then STOP."
                )
            return "Still need phone. Ask: 'Could I get a phone number?' Then STOP."

        # Have phone but not email
        last3 = s.contact_phone[-3:] if len(s.contact_phone) >= 3 else s.contact_phone
        return (
            f"Phone saved: {s.contact_phone}.\n"
            f"Say: 'Got it, ending in {last3}. And what's your email address?'\n"
            "Then STOP. Wait for email."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 13: submit_booking
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def submit_booking(self) -> str:
        """Submit the final booking. Creates customer, vehicle, and sale in Tyresoft.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.CONFIRMED:
            if s.step == Step.NEED_CONTACT:
                missing = []
                if not s.contact_phone:
                    missing.append("phone")
                if not s.contact_email:
                    missing.append("email")
                return f"BLOCKED: Still need: {', '.join(missing)}. Collect before submitting."
            return f"ERROR: Wrong step ({s.step.value})."

        if not s.basket_items:
            return "ERROR: Basket is empty."
        if not s.booking_date or not s.booking_time:
            s.booking_submit_pending = True
            return "Cannot submit — missing date/time. Go back and select a timeslot."

        # Validate all required fields
        missing = []
        if not s.customer_name_first:
            missing.append("caller name")
        if not s.contact_phone:
            missing.append("phone number")
        if not s.contact_email:
            missing.append("email")
        if missing:
            s.booking_submit_pending = True
            return (
                f"Cannot submit — missing: {', '.join(missing)}.\n"
                "IMPORTANT: The booking is NOT confirmed yet. "
                "You MUST collect the missing info and retry BEFORE ending the call."
            )

        # Step 1: Save customer
        customer_result = await save_customer(
            first_name=s.customer_name_first,
            last_name=s.customer_name_last,
            mobile=s.contact_phone,
            email=s.contact_email,
        )
        if not customer_result:
            s.booking_submit_pending = True
            return (
                "ERROR: Failed to save customer details.\n"
                "Say: 'I'm having a bit of trouble with our system. Let me try again.'\n"
                "Call submit_booking again. GENERATE ZERO SPEECH."
            )
        s.customer_id = customer_result.get("customerID", 0)

        # Step 2: Save vehicle (if we have one)
        vehicle_id = 0
        if s.vrn and s.vehicle_info:
            veh_result = await save_vehicle(
                vrm=s.vrn, make=s.vehicle_make, model=s.vehicle_model,
                vehicle_info=s.vehicle_info,
            )
            if veh_result:
                vehicle_id = veh_result.get("vehicleID", 0)
                s.vehicle_id = vehicle_id

        # Step 3: Build sale items
        sale_items = []
        for item in s.basket_items:
            if item["type"] == "tyre":
                sale_items.append(build_tyre_item(
                    stock_number=item.get("stock_number", ""),
                    quantity=item.get("quantity", 1),
                    unit_price=item.get("price", 0),
                ))
            elif item["type"] == "service":
                svc = SERVICES.get(item.get("code"), {})
                sale_items.append(build_service_item(
                    service_id=svc.get("service_id", 0),
                    unit_price=item.get("price", 0),
                ))

        # Step 4: Create sale
        depot_id = BRANCHES.get(s.selected_branch, {}).get("depot_id", 1)
        booking_slot = s.selected_slot or {
            "date": s.booking_date, "time": s.booking_time,
            "diaryCategoryID": 1, "estimatedTime": 30, "slotTypeID": 1,
        }

        sale_result = await create_sale(
            depot_id=depot_id, customer_id=s.customer_id,
            vehicle_id=vehicle_id, booking_slot=booking_slot,
            items=sale_items,
        )
        if not sale_result:
            s.booking_submit_pending = True
            return (
                "ERROR: Failed to create booking in system.\n"
                "Say: 'I'm having trouble booking that in. Let me try once more.'\n"
                "Call submit_booking again. GENERATE ZERO SPEECH."
            )

        # SUCCESS
        s.booking_submit_pending = False
        sale_id = sale_result.get("saleID", "")
        sale_number = sale_result.get("saleNumber", "")
        back_order = sale_result.get("backOrder", False)
        booking_ref = f"TS-{sale_number}" if sale_number else f"TS-{sale_id}"

        total = sum(it["total"] for it in s.basket_items)
        total_spoken = format_price_for_speech(total)
        date_text = format_date_for_speech(s.booking_date)
        time_text = format_time_for_speech(s.booking_time)
        branch_name = BRANCHES.get(s.selected_branch, {}).get("name", f"Branch {s.selected_branch}")

        # Build items summary
        parts = []
        for item in s.basket_items:
            if item["type"] == "tyre":
                b = format_brand_for_speech(item.get("brand", ""))
                parts.append(f"{item['quantity']} {b} tyres")
            else:
                parts.append(item["name"])
        items_text = " and ".join(parts) if len(parts) <= 2 else ", ".join(parts[:-1]) + f" and {parts[-1]}"

        back_note = " Just to let you know, we'll need to order in the tyres but they'll be ready for your appointment." if back_order else ""

        # Log
        print(f"[BOOKING] Ref: {booking_ref} | Sale: {sale_number} | Customer: {s.customer_id} | Vehicle: {vehicle_id}")

        # Clear basket
        s.basket_items = []
        s.booking_date = ""
        s.booking_time = ""
        s.selected_slot = {}
        s.available_slots = []
        s.step = Step.DONE

        print(f"[STATE] Step → DONE")
        return (
            f"BOOKING CONFIRMED. Reference: {booking_ref}.\n"
            f"Say: 'That's all booked in for you. Your reference is {booking_ref}. "
            f"So that's {items_text} at {branch_name} on {date_text} at {time_text}. "
            f"Total comes to {total_spoken}.{back_note}'\n"
            "Ask: 'Is there anything else I can help with?'\n"
            "Then STOP."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 14: submit_callback (with Message Summariser)
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def submit_callback(self, phone: str, message: str) -> str:
        """Submit a callback request. Pass the caller's phone and their message.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state

        cleaned_phone = sanitise_phone(phone)
        summary = await ask_message_summariser(
            message=message,
            caller_name=f"{s.customer_name_first} {s.customer_name_last}".strip(),
            phone=cleaned_phone,
        )

        callback_log = {
            "timestamp": uk_timestamp(),
            "name": f"{s.customer_name_first} {s.customer_name_last}".strip(),
            "phone": cleaned_phone,
            "message": message,
            "category": summary.get("category", "callback"),
            "summary": summary.get("summary", message[:200]),
            "action": summary.get("action", "Call back customer"),
            "vrm": s.vrn,
            "branch": s.selected_branch,
        }
        print(f"[CALLBACK] {json.dumps(callback_log)}")

        await send_discord_notification(
            title="CALLBACK REQUEST",
            description=f"Caller: {callback_log['name']}",
            color="warning",
            fields=[
                {"name": "Phone", "value": cleaned_phone, "inline": True},
                {"name": "Category", "value": summary.get("category", "callback"), "inline": True},
                {"name": "Summary", "value": summary.get("summary", message[:200]), "inline": False},
                {"name": "Action", "value": summary.get("action", "Call back"), "inline": False},
            ],
        )

        # If booking already done, stay at DONE; otherwise go back to basket
        if s.step != Step.DONE:
            s.step = Step.BUILDING_BASKET
        return (
            f"Callback submitted for {cleaned_phone}.\n"
            f"Say: 'No worries, I've popped a callback request in for you. "
            f"Someone will give you a ring on that number as soon as they can.'\n"
            "Ask: 'Is there anything else I can help with?'\n"
            "Then STOP."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 15: set_branch
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def set_branch(self, branch_id: int) -> str:
        """Set which branch to book at. Default is Branch 1."""
        s = self._state
        if branch_id not in BRANCHES:
            opts = ", ".join(f"{k} ({v['name']})" for k, v in BRANCHES.items())
            return f"REJECTED: Invalid branch. Options: {opts}"
        s.selected_branch = branch_id
        name = BRANCHES[branch_id]["name"]
        return f"Branch set to {name}. Continue with current task."

    # ───────────────────────────────────────────────────────────────────
    # TOOL 16: get_current_datetime
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def get_current_datetime(self) -> str:
        """Get the current UK date and time. Use for booking date calculations."""
        now = uk_now()
        tomorrow = now + datetime.timedelta(days=1)
        return (
            f"Today: {now.strftime('%A %d %B %Y')}\n"
            f"Time: {now.strftime('%H:%M')}\n"
            f"Tomorrow: {tomorrow.strftime('%A %d %B %Y')}"
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 17: end_call
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def end_call(self) -> str:
        """End the call properly. Only use when customer has said goodbye."""
        s = self._state
        if s.booking_submit_pending:
            return (
                "BLOCKED: There is a pending booking that failed. "
                "You MUST collect missing info and retry before ending the call."
            )
        if s.basket_items:
            items = len(s.basket_items)
            return (
                f"WARNING: {items} items still in basket, not booked.\n"
                f"Say: 'Just before you go — I've still got those items noted down. "
                "Shall we get those booked in for you?'\n"
                "Then STOP."
            )
        s.call_ended = True
        print(f"[CALL ENDED] {uk_timestamp()}")
        return (
            "Call ended.\n"
            "Say: 'Cheers, have a lovely day! Bye!'\n"
            "Do NOT add extra filler like 'don't hesitate to reach out' or 'feel free to call again'. Just the goodbye above."
        )


# ═══════════════════════════════════════════════════════════════════════════
# SESSION ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════
# Entrypoint function


async def entrypoint(ctx: JobContext):
    print(f"[SESSION START] {uk_timestamp()} | Room: {ctx.room.name}")

    # VAD
    vad = silero.VAD.load(
        min_speech_duration=0.1,
        min_silence_duration=0.5,
        activation_threshold=0.6,
        sample_rate=16000,
    )

    # Agent
    supervisor = TyresoftSupervisor()
    supervisor._state.room_name = ctx.room.name

    # TTS
    tts = elevenlabs.TTS(
        voice_id=ELEVEN_VOICE_ID,
        model=ELEVEN_TTS_MODEL,
        voice_settings=elevenlabs.VoiceSettings(
            stability=ELEVEN_STABILITY,
            similarity_boost=ELEVEN_SIMILARITY,
            style=ELEVEN_STYLE,
            use_speaker_boost=True,
        ),
    )

    # Session
    session = AgentSession(
        stt=deepgram.STT(
            model="nova-3",
            language="en-GB",
            smart_format=True,
            punctuate=True,
        ),
        llm=SPEAKING_MODEL,
        tts=tts,
        turn_detection=MultilingualModel(),
        vad=vad,
        preemptive_generation=True,
        resume_false_interruption=True,
        false_interruption_timeout=1.0,
        user_away_timeout=4.0,
    )

    # Transcript tracking for hallucination detection
    @session.on("user_input_transcribed")
    def _on_user_transcript(ev):
        if ev.is_final:
            text = ev.transcript.strip()
            # Deduplicate overlapping Deepgram finals
            if supervisor._state.recent_transcripts and supervisor._state.recent_transcripts[-1] == text:
                return
            supervisor._state.recent_transcripts.append(text)
            print(f"[USER] {text[:80]}{'...' if len(text) > 80 else ''}")

    # Session isolation — prevent context bleeding
    @ctx.room.on("participant_disconnected")
    def _on_caller_left(participant):
        print(f"[SESSION] Caller disconnected: {participant.identity}")
        ctx.shutdown("caller_disconnected")

    # Start session with noise cancellation if available
    if HAS_NC:
        try:
            await session.start(
                room=ctx.room,
                agent=supervisor,
                room_options=agents.room_io.RoomOptions(
                    audio_input=agents.room_io.AudioInputOptions(
                        noise_cancellation=noise_cancellation.BVC(),
                    ),
                ),
            )
        except Exception as e:
            print(f"[WARN] Noise cancellation failed ({e}), starting without")
            await session.start(room=ctx.room, agent=supervisor)
    else:
        await session.start(room=ctx.room, agent=supervisor)

    # Instant greeting via TTS (no LLM latency)
    greeting = get_dynamic_greeting()
    try:
        session.say(text=greeting, allow_interruptions=True)
    except AttributeError:
        # Fallback if say() not available in this SDK version
        await session.generate_reply(instructions=f"Say warmly: {greeting}")


# ═══════════════════════════════════════════════════════════════════════════
# STARTUP NOTIFICATIONS
# ═══════════════════════════════════════════════════════════════════════════
async def _send_startup():
    await send_discord_notification(
        title="AGENT STARTED",
        description="Tyresoft ReceptionMate Voice Agent is online.",
        color="success",
        fields=[
            {"name": "Workspace", "value": TYRESOFT_WORKSPACE, "inline": True},
            {"name": "Model", "value": SPEAKING_MODEL, "inline": True},
            {"name": "Status", "value": "Listening for calls", "inline": True},
        ],
    )


def _run_startup():
    import threading
    def _thread():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_send_startup())
        loop.close()
    threading.Thread(target=_thread, daemon=True).start()


if __name__ == "__main__":
    _run_startup()
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, worker_type=WorkerType.ROOM, agent_name="tyresoft-agent"))
