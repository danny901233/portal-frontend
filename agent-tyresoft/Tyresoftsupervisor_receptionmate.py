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
import time
import aiohttp
import datetime as _dt
from pathlib import Path
from dotenv import load_dotenv
from typing import Optional
from openai import AsyncOpenAI

# Load environment variables from .env file
_DOTENV_CANDIDATES = [
    Path(__file__).parent / ".env",
    Path(__file__).parent / ".env.local",
]
for candidate in _DOTENV_CANDIDATES:
    if candidate.exists():
        load_dotenv(dotenv_path=candidate, override=True)
        print(f"[STARTUP] Loaded environment from {candidate}")
        break

from livekit import agents, api as lk_api
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
    # Configuration loading
    load_agent_config, apply_agent_configuration,
    format_time_for_speech, format_tyre_size_for_speech, format_brand_for_speech,
    format_vehicle_for_speech,
    sanitise_phone, sanitise_email,
    # Business hours
    is_within_business_hours, get_business_hours_text,
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
# PORTAL LOGGING CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════
PORTAL_API_URL = os.getenv("PORTAL_API_URL", "https://portal.receptionmate.co.uk/api/calls")
PORTAL_WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "optional-shared-secret")
RECORDING_BASE_URL = os.getenv("RECORDING_BASE_URL", "").strip()
S3_ACCESS_KEY_ID = os.getenv("S3_ACCESS_KEY_ID", "").strip()
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY", "").strip()
S3_REGION = os.getenv("S3_REGION", "eu-west-2").strip()
S3_BUCKET = os.getenv("S3_BUCKET", "receptionmate-recordings").strip()

_LIVEKIT_INFERENCE_URL = "https://agent-gateway.livekit.cloud/v1"
_specialist_llm: Optional[AsyncOpenAI] = None


def _create_inference_token() -> str:
    """Mint a short-lived JWT for LiveKit Cloud inference gateway."""
    grant = lk_api.access_token.InferenceGrants(perform=True)
    return (
        lk_api.AccessToken(
            os.getenv("LIVEKIT_API_KEY", ""),
            os.getenv("LIVEKIT_API_SECRET", ""),
        )
        .with_identity("agent")
        .with_inference_grants(grant)
        .with_ttl(_dt.timedelta(seconds=600))
        .to_jwt()
    )


def _get_specialist_llm() -> Optional[AsyncOpenAI]:
    """Lazy-init an AsyncOpenAI client routed through LiveKit Cloud inference.
    Uses LIVEKIT_API_KEY + LIVEKIT_API_SECRET (no separate OPENAI_API_KEY needed).
    Returns None if LiveKit credentials are missing."""
    global _specialist_llm
    if _specialist_llm is None:
        if not os.getenv("LIVEKIT_API_KEY") or not os.getenv("LIVEKIT_API_SECRET"):
            return None
        _specialist_llm = AsyncOpenAI(
            api_key=_create_inference_token(),
            base_url=_LIVEKIT_INFERENCE_URL,
        )
    else:
        # Refresh the JWT before each use (10-min TTL)
        _specialist_llm.api_key = _create_inference_token()
    return _specialist_llm


# ═══════════════════════════════════════════════════════════════════════════
# PORTAL LOGGING FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════
async def generate_call_summary(transcript: list, state) -> str:
    """Use GPT via LiveKit inference to generate a detailed structured call summary."""
    # Build plain-text transcript from entries
    lines = []
    for entry in transcript:
        speaker = entry.get("speaker", "unknown").capitalize()
        text = entry.get("text", "")
        if text:
            lines.append(f"{speaker}: {text}")
    transcript_text = "\n".join(lines)

    if not transcript_text or len(lines) < 2:
        return "No conversation was had."

    try:
        llm = _get_specialist_llm()
        if not llm:
            raise ValueError("No LLM client available")

        # Build context from state
        customer_name = f"{state.customer_name_first} {state.customer_name_last}".strip() or "Customer"
        vehicle_info = state.vrn or "their vehicle"
        if state.vrn and state.vehicle_make and state.vehicle_model:
            vehicle_info = f"{state.vrn} ({state.vehicle_make} {state.vehicle_model})"

        booking_status = ""
        if state.step == Step.CONFIRMED:
            booking_status = "BOOKING WAS SUCCESSFULLY SUBMITTED TO THE SYSTEM."
        elif state.booking_date and state.booking_time:
            booking_status = "TIMESLOT WAS DISCUSSED BUT BOOKING WAS NOT COMPLETED. Customer needs a callback to finalize the booking."
        elif state.intent in ("message", "quote", "vehicle_update"):
            booking_status = "Customer requested a MESSAGE/CALLBACK."

        prompt = f"""Create a structured call summary from this garage receptionist call transcript.

BOOKING STATUS: {booking_status}

CRITICAL RULES:
1. ONLY summarize information that is ACTUALLY in the transcript below
2. DO NOT make up or infer details that aren't explicitly stated
3. Use the BOOKING STATUS above to determine if booking was confirmed or callback needed
4. If BOOKING STATUS says "NOT COMPLETED", you MUST state "Callback required to complete the booking"
5. If the customer only said "hello" then hung up, respond ONLY with "No conversation was had."

REQUIRED FORMAT:
Start with: "{customer_name} called regarding {vehicle_info}."

Then provide 2-4 paragraphs covering ONLY what was actually discussed:

Paragraph 1 - Purpose & Vehicle:
- Why they called (service needed, enquiry, complaint, etc.)
- Vehicle details if mentioned (make, model, registration, issues)

Paragraph 2 - Services/Booking Details:
- Specific work discussed, prices quoted
- If booking confirmed: "Booking confirmed for [DATE] at [TIME]"
- If not completed: "Booking was NOT finalized."

Paragraph 3 - Callback/Follow-up:
- If callback needed: "Callback required - [specific reason]"
- Only state "No callback required" if booking was SUCCESSFULLY SUBMITTED

Transcript:
{transcript_text}

Call Summary:"""

        response = await asyncio.wait_for(
            llm.chat.completions.create(
                model="openai/gpt-4o-mini",
                messages=[
                    {"role": "system", "content": "You write factual, detailed summaries of garage phone calls based ONLY on what was actually said in the transcript. Never invent names, registrations, or details not present in the transcript."},
                    {"role": "user", "content": prompt},
                ],
                max_tokens=500,
                temperature=0.1,
            ),
            timeout=10.0,
        )
        summary = response.choices[0].message.content.strip()
        if not summary or len(summary) < 20:
            return "No conversation was had."
        print(f"[PORTAL] GPT summary generated ({len(summary)} chars)")
        return summary
    except Exception as e:
        print(f"[PORTAL] GPT summary failed, using fallback: {e}")
        # Fallback: build summary from state fields
        parts = []
        name = f"{state.customer_name_first} {state.customer_name_last}".strip() or "Customer"
        parts.append(f"{name} called")
        if state.vrn:
            parts.append(f"regarding {state.vrn}")
            if state.vehicle_make and state.vehicle_model:
                parts.append(f"({state.vehicle_make} {state.vehicle_model})")
        if state.booking_date:
            parts.append(f"Booking: {state.booking_date} at {state.booking_time}")
        elif state.message:
            parts.append(f"Message: {state.message}")
        elif state.intent:
            parts.append(f"Intent: {state.intent}")
        return ". ".join(parts) + "."


async def log_call_to_portal(
    garage_id: str,
    room_name: str,
    duration_seconds: int,
    transcript: list,
    summary: str,
    customer_name: str = "",
    customer_phone: str = "",
    registration_number: str = "",
    confirmed_booking: bool = False,
    booking_details: str = "",
    call_type: str = "unknown",
    metrics: dict = None,
) -> None:
    """Log call data to the portal backend."""
    
    # Only log calls that are 55 seconds or longer
    if duration_seconds < 55:
        print(f"[PORTAL] Skipping call log - duration {duration_seconds}s is under 55s threshold")
        return
    
    try:
        # metrics must be non-empty object
        if not metrics:
            metrics = {"duration_seconds": duration_seconds, "call_type": call_type}

        payload = {
            "garageId": garage_id,
            "roomName": room_name,
            "durationSeconds": duration_seconds,
            "transcript": transcript,
            "summary": summary,
            "confirmedBooking": confirmed_booking,
            "metrics": metrics,
        }

        # Only include optional string fields when non-empty (schema requires min 1 char if present)
        if customer_name:
            payload["customerName"] = customer_name
        if customer_phone:
            payload["customerPhone"] = customer_phone
        if registration_number:
            payload["registrationNumber"] = registration_number
        if booking_details:
            payload["bookingDetails"] = booking_details
        if call_type and call_type != "unknown":
            payload["callType"] = call_type
        
        # Add recording URL if available
        if RECORDING_BASE_URL:
            recording_url = f"{RECORDING_BASE_URL.rstrip('/')}/{room_name}.mp4"
            payload["recordingUrl"] = recording_url
            print(f"[PORTAL] Including recording URL: {recording_url}")
        else:
            print("[PORTAL] RECORDING_BASE_URL not set; recordingUrl will be omitted")
        
        headers = {
            "Content-Type": "application/json",
            "X-Webhook-Secret": PORTAL_WEBHOOK_SECRET,
        }
        
        print(f"[PORTAL] Posting call to {PORTAL_API_URL} | transcript={len(transcript)} entries | metrics_keys={list(metrics.keys())} | customerPhone={'YES' if customer_phone else 'OMITTED'}")
        
        async with aiohttp.ClientSession() as session:
            async with session.post(PORTAL_API_URL, json=payload, headers=headers) as response:
                if response.status == 201:
                    data = await response.json()
                    print(f"[PORTAL] Call logged successfully: {data.get('callId', 'unknown')}")
                else:
                    text = await response.text()
                    print(f"[PORTAL] Failed to log call: {response.status} - {text}")
    except Exception as e:
        print(f"[PORTAL] Error logging call: {e}")


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
3. REGISTRATION COLLECTION:
   - BOOKINGS/QUOTES → Ask for VRN → call lookup_vehicle to get make/model
   - MESSAGES/UPDATES/CALLBACKS → Ask for VRN but DO NOT call lookup_vehicle (just collect it)
   - OPENING HOURS → No VRN needed at all
4. For bookings: Follow EVERY tool directive EXACTLY.
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
    @function_tool()
    async def save_caller_name(
        self,
        first_name: str,
        last_name: str = "",
        intent: str = "",
        service_hint: str = "",
        vrn: str = "",
        requested_person: str = "",
    ) -> str:
        """Save the caller's name and determine intent.
        intent: 'booking' for appointments, 'quote' for price enquiries,
                'vehicle_update' for callers checking on a vehicle already at the garage,
                'message' for taking messages/enquiries,
                'transfer' for asking to speak to someone specific.
        service_hint: what work they mentioned (e.g. 'tyres', 'MOT', 'full service').
        vrn: vehicle registration if the caller already gave it.
        requested_person: name of person they asked for (e.g. 'manager', 'someone').
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.GREETING:
            return f"ERROR: Wrong step ({s.step.value}). Name already saved as {s.customer_name_first}."

        first = first_name.strip().title()
        last = last_name.strip().title()
        requested = (requested_person or "").strip()

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

        # Hallucination guard: check against recent transcripts (word boundaries)
        if s.recent_transcripts:
            all_speech = " ".join(s.recent_transcripts).lower()
            speech_words = set(re.findall(r"[a-z]+", all_speech))
            if first and first.lower() not in speech_words:
                return (
                    f"REJECTED: The caller has NOT said the name '{first}'. "
                    "You are hallucinating a name. ASK the caller: 'Can I take your name?' "
                    "and WAIT for their response. Only call save_caller_name with the name they actually say."
                )

        s.customer_name_first = first
        s.customer_name_last = last

        resolved = (intent or "").strip().lower()
        print(f"[SAVE_NAME] {first} {last}, intent={resolved}, hint={service_hint}, vrn={vrn}, requested_person={requested}")

        # Transfer request - asking for a specific person or human
        if resolved in ("transfer", "speak_to", "ask_for") or requested:
            s.intent = "message"
            s.step = Step.MESSAGE_ONLY
            person_mention = f" for {requested}" if requested else ""
            
            # Check if we're outside business hours
            if not is_within_business_hours():
                return (
                    f"Name saved: {first} {last}. Intent: transfer request{person_mention}.\n"
                    f"Address the caller as '{first}' (FIRST name only).\n"
                    f"OUTSIDE BUSINESS HOURS. Say naturally: 'The team aren't available outside of our opening hours, "
                    f"but I can take a message and they'll give you a ring back when we're open. What would you like me to pass on?'\n"
                    f"After they explain, ask: 'And could I grab your vehicle registration and a contact number?'\n"
                    f"Then collect VRN, phone, and callback preference before calling take_message."
                )
            
            return (
                f"Name saved: {first} {last}. Intent: transfer request{person_mention}.\n"
                f"Address the caller as '{first}' (FIRST name only).\n"
                f"Say naturally: 'Unfortunately the team aren't available at the moment — they're likely helping other customers. "
                f"However, I can help you with tyres and bookings, or I can take a message and get someone to give you a ring back. Which would you prefer?'\n"
                f"If they want a booking → continue with booking flow (ask what work they need).\n"
                f"If they want a message → ask 'What would you like the team to know?' then collect VRN, phone, and callback time before calling take_message."
            )

        # Message path - general enquiries, questions, complaints
        if resolved in ("message", "enquiry", "reschedule", "cancel", "complaint", "question"):
            s.intent = "message"
            s.step = Step.MESSAGE_ONLY
            return (
                f"Name saved: {first} {last}. Intent: message.\n"
                f"Address the caller as '{first}' (FIRST name only).\n"
                "Ask: 'What would you like the team to know?'\n"
                "After they explain, ask: 'And could I grab your vehicle registration and a contact number?'\n"
                "Then collect VRN, phone, and callback time before calling take_message."
            )

        # Vehicle update path — caller wants status on existing vehicle
        if resolved in ("vehicle_update", "update", "status", "progress"):
            s.intent = "vehicle_update"
            
            # Check if we're outside business hours
            if not is_within_business_hours():
                s.step = Step.MESSAGE_ONLY
                return (
                    f"Name saved: {first} {last}. Intent: vehicle update.\n"
                    f"Address the caller as '{first}' (FIRST name only).\n"
                    f"OUTSIDE BUSINESS HOURS. Say naturally: 'The team aren't available outside of our opening hours to check on your vehicle, "
                    f"but I can take a message and they'll give you a ring back when we're open. What would you like me to pass on?'\n"
                    f"After they explain, ask: 'And could I grab your vehicle registration and a contact number?'\n"
                    f"Then collect VRN, phone, and any callback preference before calling take_message."
                )
            
            s.step = Step.MESSAGE_ONLY
            return (
                f"Name saved: {first} {last}. Intent: vehicle update.\n"
                f"Address the caller as '{first}' (FIRST name only).\n"
                "Say: 'The team are currently with customers, but I can take a message about your vehicle "
                "and they'll give you a ring back shortly. What would you like them to know?'\n"
                "After they explain, ask: 'And could I grab your vehicle registration and a contact number?'\n"
                "Then collect VRN, phone, and callback time before calling take_message."
            )

        # Opening hours query
        if resolved in ("hours", "opening_hours", "when_open", "open_times"):
            business_hours = get_business_hours_text()
            return (
                f"Name saved: {first} {last}. Intent: opening hours query.\n"
                f"Address the caller as '{first}' (FIRST name only).\n"
                f"Say: 'We're open {business_hours}.'\n"
                "Then ask: 'Is there anything else I can help you with today?' and wait for their response.\n"
                "If they need a booking → continue with booking flow.\n"
                "If nothing else → thank them and end the call politely."
            )

        # Booking / quote path (default)
        s.intent = "quote" if resolved == "quote" else "tyre_purchase"
        if service_hint:
            s.service_hint = service_hint.strip()

        s.step = Step.BUILDING_BASKET
        print(f"[STATE] Name: {first} {last} | Step → BUILDING_BASKET")

        # Check transcripts for earlier requests
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
                "- If they need TYRES or a SERVICE BOOKING → ask for their vehicle registration and perform lookup\n"
                "- If they want OPENING HOURS → tell them our hours (no lookup needed)\n"
                "- If they want a MESSAGE, VEHICLE UPDATE, or CALLBACK → collect message, VRN, and phone (no lookup needed)\n"
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
            # If there was a pending VRN and we're getting a new one, caller rejected the previous readback
            normalized = normalize_vrn(reg)
            
            if s.vrn_pending and normalized != s.vrn_pending:
                s.vrn_readback_rejections += 1
                print(f"[LOOKUP] Caller rejected previous readback '{s.vrn_pending}', "
                     f"provided new input '{reg}' → '{normalized}' (rejection #{s.vrn_readback_rejections})")
            
            # Check for partial accumulation
            raw = reg.strip()
            if s.vrn_partial:
                if normalized.startswith(s.vrn_partial) or s.vrn_partial in normalized:
                    combined = normalized
                    print(f"[LOOKUP] Partial '{s.vrn_partial}' already in '{normalized}' — using '{combined}'")
                else:
                    combined = s.vrn_partial + normalized
                    print(f"[LOOKUP] Combining partial '{s.vrn_partial}' + '{normalized}' = '{combined}'")
                normalized = combined
                s.vrn_partial = ""

            # Name echo protection
            caller_names = {s.customer_name_first.upper(), s.customer_name_last.upper()} - {""}
            if normalized in caller_names:
                return (
                    f"IGNORED: '{normalized}' is the caller's name, not a registration.\n"
                    "Ask: 'Could you give me your vehicle registration number?'\n"
                    "Then STOP."
                )
            
            # VRN validation - check for no digits
            if not any(c.isdigit() for c in normalized):
                if len(normalized) <= 3:
                    s.vrn_partial = normalized
                    print(f"[LOOKUP] Partial VRN (no digits yet): '{normalized}' — waiting for more")
                    return (
                        f"PARTIAL VRN: '{normalized}' has no digits yet — the caller is still spelling. "
                        "Do NOT ask again. WAIT for them to continue. "
                        "When they say more, call lookup_vehicle with the new part."
                    )
                s.vrn_partial = ""
                return (
                    f"REJECTED: '{normalized}' has no digits — UK registrations ALWAYS contain numbers. "
                    "You may have passed the caller's name instead of their registration. "
                    "Ask the caller: 'Could I grab your registration?'"
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
            
            # Clear partial accumulator
            s.vrn_partial = ""
            
            if len(normalized) > 7:
                print(f"[LOOKUP] VRN too long ({len(normalized)} chars): '{normalized}' — truncating to 7")
                normalized = normalized[:7]

            s.vrn_pending = normalized

            # Reset attempt counter if this is a different vehicle than previously confirmed
            if s.vrn_confirmed and normalized != s.vrn:
                s.vrn_attempts = 0
                print(f"[STATE] New VRN ({normalized} != {s.vrn}) — resetting attempts")

            s.vrn_attempts += 1
            s.step = Step.NEED_VRN
            spaced = format_vrm_for_speech(normalized)

            print(f"[STATE] VRN pending: {normalized} | Step → NEED_VRN | Attempt {s.vrn_attempts}")
            
            # If this is a retry after caller rejected previous readback, ask for phonetic spelling
            if s.vrn_readback_rejections >= 1:
                print(f"[LOOKUP] Requesting phonetic spelling after {s.vrn_readback_rejections} rejection(s)")
                return (
                    f"Parsed registration: {normalized}.\n"
                    f"Say naturally: 'I'm hearing {normalized}, but let me make sure I've got this right. "
                    "Could you spell the full registration back to me using phonetics? "
                    "For example, Alpha for A, Bravo for B, and so on.'\n"
                    "Wait for them to spell it phonetically, then call lookup_vehicle again with confirmed=false."
                )
            
            # First readback - just read it back normally
            return (
                f"Normalized registration: {spaced}\n"
                f"Say: 'Just to confirm, that registration is {spaced}. Is that right?'\n"
                "Wait for YES/NO.\n"
                f"If YES → call lookup_vehicle(reg='{normalized}', confirmed=true). GENERATE ZERO SPEECH.\n"
                f"If NO → Say naturally: 'Let me make sure I've got this right. Could you spell the full registration back to me using phonetics? For example, Alpha for A, Bravo for B.' "
                "Then WAIT for them to spell it, and call lookup_vehicle with their phonetic spelling."
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
                
                # First attempt failed - ask for phonetic spelling
                if s.vrn_attempts == 1:
                    return (
                        f"Vehicle not found for registration '{normalized}'. "
                        "Say naturally: 'I'm not finding that one. Could you spell the full registration back to me using phonetics? "
                        "For example, A for Alpha, B for Bravo, and so on.'\n"
                        "Wait for them to spell it phonetically, then call lookup_vehicle again."
                    )
                
                # Subsequent attempts
                spaced = format_vrm_for_speech(normalized)
                return (
                    f"Vehicle still not found for {spaced}.\n"
                    "Ask the caller to read it out one letter at a time. "
                    "Common mishearings: B↔V, M↔N, S↔F, D↔T. "
                    "Read back what YOU heard so they can spot the error."
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
    # TOOL 5: search_tyres (with intelligent info gathering)
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def search_tyres(
        self,
        tyre_position: str = "",
        tyre_quality: str = "",
        brand: str = "",
    ) -> str:
        """Search for tyres and recommend best options based on caller's needs.
        tyre_position: e.g., 'front left', 'both fronts', 'all four', 'rear right'
        tyre_quality: 'budget', 'mid-range', or 'premium'
        brand: specific brand if requested (optional)
        
        The tool will ask for missing information (position, quality) before searching.
        Uses the already-selected tyre size from confirm_vehicle.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        if s.step != Step.BUILDING_BASKET:
            return f"ERROR: Wrong step ({s.step.value})."
        if not s.selected_tyre_size:
            return "ERROR: No tyre size selected. Need to select_tyre_size first."
        
        # Save any provided info to state
        if tyre_position:
            s.tyre_position = tyre_position.strip().lower()
            print(f"[TYRE_SEARCH] Position: {s.tyre_position}")
        if tyre_quality:
            s.tyre_quality = tyre_quality.strip().lower()
            print(f"[TYRE_SEARCH] Quality: {s.tyre_quality}")
        
        # Check if we need position
        if not s.tyre_position:
            return (
                "TYRE POSITION REQUIRED.\n"
                "Ask the caller: 'Which tyres need replacing — all four, just the fronts, or specific ones?'\n"
                "Then STOP. Wait for their answer.\n"
                "When they respond, call search_tyres again with tyre_position='their answer'."
            )
        
        # Check if we need quality preference
        if not s.tyre_quality:
            return (
                f"Tyre position recorded: {s.tyre_position}.\n"
                "QUALITY PREFERENCE REQUIRED.\n"
                "Ask the caller: 'Are you looking for budget, mid-range, or premium tyres?'\n"
                "Then STOP. Wait for their answer.\n"
                "When they respond, call search_tyres again with tyre_quality='their answer'."
            )
        
        # Now we have position and quality — search inventory
        parsed = parse_tyre_size(s.selected_tyre_size)
        results = search_inventory(
            s.selected_branch,
            width=parsed["width"], aspect=parsed["aspect"], rim=parsed["rim"],
            brand=brand,
        )
        spoken_size = format_tyre_size_for_speech(s.selected_tyre_size)
        
        # Auto-search other branch if current branch has nothing
        searched_branch = s.selected_branch
        if not results:
            other_branch = 2 if s.selected_branch == 1 else 1
            results = search_inventory(
                other_branch,
                width=parsed["width"], aspect=parsed["aspect"], rim=parsed["rim"],
                brand=brand,
            )
            if results:
                searched_branch = other_branch
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
        
        # Calculate quantity based on position
        qty_map = {
            "all four": 4, "all 4": 4, "four": 4, "full set": 4, "all": 4,
            "both fronts": 2, "front": 2, "fronts": 2, "both front": 2,
            "both rears": 2, "rear": 2, "rears": 2, "both rear": 2, "back": 2,
            "front left": 1, "front right": 1, "rear left": 1, "rear right": 1,
            "one": 1, "single": 1,
        }
        quantity = 4  # default
        for key, val in qty_map.items():
            if key in s.tyre_position:
                quantity = val
                break
        
        # Filter/sort by quality preference
        quality_pref = s.tyre_quality
        if quality_pref == "budget":
            # Sort by price ascending, show cheapest first
            results.sort(key=lambda x: x.get("price", 999999))
            results = results[:6]
        elif quality_pref == "premium":
            # Sort by price descending, show most expensive first
            results.sort(key=lambda x: x.get("price", 0), reverse=True)
            results = results[:6]
        else:  # mid-range or unspecified
            # Sort by price, take middle range
            results.sort(key=lambda x: x.get("price", 0))
            mid = len(results) // 2
            start = max(0, mid - 3)
            results = results[start:start+6]
        
        s.last_search_results = results
        
        # Format results with quantity context
        lines = []
        for i, t in enumerate(results, 1):
            b = format_brand_for_speech(t.get("brand", ""))
            p = format_price_for_speech(t.get("price", 0))
            total = t.get("price", 0) * quantity
            total_spoken = format_price_for_speech(total)
            rf = " (Run Flat)" if t.get("runflat") else ""
            lines.append(f"  {i}. {b} — {p} per tyre ({total_spoken} for {quantity}){rf}")
        result_text = "\n".join(lines)
        
        # Build recommendation
        top_tyre = results[0]
        top_brand = format_brand_for_speech(top_tyre.get("brand", ""))
        top_price = format_price_for_speech(top_tyre.get("price", 0))
        top_total = format_price_for_speech(top_tyre.get("price", 0) * quantity)
        
        position_text = s.tyre_position
        quality_desc = {
            "budget": "best value",
            "mid-range": "mid-range",
            "premium": "premium quality",
        }.get(quality_pref, quality_pref)
        
        branch_name = BRANCHES.get(searched_branch, {}).get("name", f"Branch {searched_branch}")
        print(f"[TYRE_SEARCH] {len(results)} {quality_desc} results | {position_text} = {quantity} tyres | Branch {searched_branch}")
        
        return (
            f"Found {len(results)} {quality_desc} options for {spoken_size} at {branch_name}:\n{result_text}\n\n"
            f"RECOMMENDATION: For {position_text} ({quantity} tyres) in the {quality_desc} range, "
            f"the best option is {top_brand} at {top_price} per tyre — that's {top_total} total.\n\n"
            f"Say to caller: 'For {position_text}, I'd recommend {top_brand} at {top_price} per tyre — "
            f"that comes to {top_total} for the {quantity}.'\n"
            "Then briefly mention 1-2 alternatives from the list.\n"
            "Ask: 'Would you like to go with those?'\n"
            "Then STOP. When they choose → call add_tyre_to_basket with the selection_number and quantity={quantity}."
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
    # TOOL 15: update_caller_name
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def update_caller_name(
        self,
        first_name: str = "",
        last_name: str = "",
    ) -> str:
        """Update the caller's name AFTER save_caller_name has already been called.
        Use when the caller corrects their name or gives their surname later.
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        
        if s.step == Step.GREETING:
            return (
                "WRONG TOOL: You are still in GREETING step. "
                "Call save_caller_name (not update_caller_name) to save the name AND set the intent. "
                "save_caller_name advances the call. update_caller_name is only for corrections later."
            )
        
        updated = []
        if first_name and first_name.strip():
            s.customer_name_first = first_name.strip()
            updated.append(f"first_name='{first_name.strip()}'")
        if last_name and last_name.strip():
            s.customer_name_last = last_name.strip()
            updated.append(f"last_name='{last_name.strip()}'")
        if not updated:
            return "ERROR: Provide at least first_name or last_name to update."
        
        print(f"[UPDATE_NAME] Updated: {', '.join(updated)}")
        
        # Give a specific next-action based on current step
        step_next = {
            Step.NEED_VRN: "Say ONE short sentence asking for their registration, then STOP and WAIT.",
            Step.CONFIRMING_VEHICLE: "Now confirm the vehicle with the caller.",
            Step.BUILDING_BASKET: "Continue with building the basket or booking.",
            Step.NEED_TIMESLOT: "Now offer available timeslots.",
            Step.CONFIRMED: "Continue collecting contact details (phone → email).",
            Step.MESSAGE_ONLY: "Continue collecting message details.",
        }
        next_action = step_next.get(s.step, "Continue the conversation.")
        
        return (
            f"Name updated: {', '.join(updated)}. "
            f"Full name on file: {s.customer_name_first} {s.customer_name_last}.\n"
            f"Keep addressing them as '{s.customer_name_first}' (first name only).\n"
            f"NEXT ACTION: {next_action}\n"
            "Do NOT call update_caller_name again unless the caller EXPLICITLY corrects their name."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 16: record_diagnostic_info
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def record_diagnostic_info(
        self,
        diagnostic_answer: str,
    ) -> str:
        """Record the caller's answer to a diagnostic question.
        Use this to save important details about symptoms, timing, frequency, etc.
        Example: 'When braking at speed', 'Constant for 2 weeks', 'Engine light came on yesterday'
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state
        
        if not s.diagnostic_notes:
            s.diagnostic_notes = []
        
        s.diagnostic_notes.append(diagnostic_answer)
        print(f"[DIAGNOSTIC] Recorded: {diagnostic_answer}")
        
        return (
            f"Diagnostic info recorded: '{diagnostic_answer}'\n"
            "Continue with the next diagnostic question if there are more, "
            "or proceed to recommend the appropriate service based on the symptoms described."
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 17: take_message
    # ───────────────────────────────────────────────────────────────────
    @function_tool()
    async def take_message(
        self,
        message: str,
        phone: str,
        name_first: str = "",
        name_last: str = "",
        vrn: str = "",
        callback_time: str = "",
    ) -> str:
        """Save a message for the team to call back. Use this for message-only calls.
        message: What the caller wants the team to know
        phone: Caller's phone number
        callback_time: When they prefer to be called back (optional)
        GENERATE ZERO SPEECH before calling this tool."""
        s = self._state

        s.message = (message or "").strip()
        s.contact_phone = (phone or "").strip()
        s.preferred_callback_time = (callback_time or "").strip()
        
        if name_first:
            s.customer_name_first = name_first.strip()
        if name_last:
            s.customer_name_last = name_last.strip()
        if vrn:
            s.vrn = normalize_vrn(vrn)

        s.step = Step.DONE
        first = s.customer_name_first
        last = s.customer_name_last
        
        # Aggregate all notes (diagnostic + tyre + message)
        all_notes_parts = []
        
        if s.tyre_position or s.selected_tyre_size or s.tyre_quality:
            tyre_parts = []
            if s.tyre_position:
                tyre_parts.append(f"Position: {s.tyre_position}")
            if s.selected_tyre_size:
                tyre_parts.append(f"Size: {s.selected_tyre_size}")
            if s.tyre_quality:
                tyre_parts.append(f"Quality: {s.tyre_quality}")
            all_notes_parts.append("TYRE INFORMATION:\n" + "\n".join(tyre_parts))
        
        if s.diagnostic_notes:
            all_notes_parts.append("DIAGNOSTIC INFO:\n" + "\n".join(s.diagnostic_notes))
        
        if message:
            all_notes_parts.append(f"MESSAGE: {message}")
        
        full_message = "\n\n".join(all_notes_parts) if all_notes_parts else message
        
        print(f"[TAKE_MESSAGE] From {first} {last}: {full_message[:200]}")

        # Send Discord notification
        await send_discord_notification(
            title="MESSAGE FOR TEAM",
            description=f"From: {first} {last}",
            color="info",
            fields=[
                {"name": "Phone", "value": phone, "inline": True},
                {"name": "Callback Time", "value": callback_time or "ASAP", "inline": True},
                {"name": "Message", "value": full_message[:500], "inline": False},
            ],
        )

        return (
            f"Message saved from {first} {last}.\n"
            "Read back a brief summary to confirm.\n"
            "Then say: 'Lovely, I'll make sure the team gets this. They'll give you a ring back shortly.'\n"
            "Close: 'Cheers, have a lovely day!'"
        )

    # ───────────────────────────────────────────────────────────────────
    # TOOL 18: set_branch
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
    # TOOL 19: get_current_datetime
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
    # TOOL 20: end_call
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

    # Extract garage_id from room name and load configuration
    room_name = ctx.room.name
    garage_id = None
    match = re.match(r'^garage-([a-f0-9-]+)', room_name)
    if match:
        garage_id = match.group(1)
        print(f"[ENTRYPOINT] Extracted garage_id: {garage_id}")
        # Load configuration for this garage
        try:
            config = load_agent_config(garage_id)
            if config:
                apply_agent_configuration(config)
                print(f"[ENTRYPOINT] Loaded configuration for garage: {garage_id}")
        except Exception as e:
            print(f"[ENTRYPOINT] Failed to load garage config: {e}")
            import traceback
            traceback.print_exc()

    # Agent
    supervisor = TyresoftSupervisor()
    supervisor._state.room_name = ctx.room.name
    supervisor._state.call_start_time = time.time()  # Track call start for portal logging

    # Start LiveKit egress recording to S3
    if RECORDING_BASE_URL and S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY and S3_BUCKET:
        try:
            from livekit.protocol.egress import (
                RoomCompositeEgressRequest,
                EncodedFileOutput,
                EncodedFileType,
                S3Upload as EgressS3Upload,
            )
            lkapi = lk_api.LiveKitAPI()
            async with lkapi:
                egress_info = await lkapi.egress.start_room_composite_egress(
                    RoomCompositeEgressRequest(
                        room_name=room_name,
                        file_outputs=[
                            EncodedFileOutput(
                                file_type=EncodedFileType.MP4,
                                filepath=f"{room_name}.mp4",
                                s3=EgressS3Upload(
                                    access_key=S3_ACCESS_KEY_ID,
                                    secret=S3_SECRET_ACCESS_KEY,
                                    region=S3_REGION,
                                    bucket=S3_BUCKET,
                                ),
                            )
                        ],
                    )
                )
            supervisor._state.egress_id = egress_info.egress_id
            print(f"[RECORDING] Started egress recording: {supervisor._state.egress_id}")
        except Exception as e:
            print(f"[RECORDING] Failed to start egress recording: {e}")

    # Store references for portal logging
    s = supervisor._state
    room_name = ctx.room.name

    # Session - matching newreceptionmateagent.py configuration
    # Use agent_infra module directly to get current voice settings
    import agent_infra
    session = AgentSession(
        vad=silero.VAD.load(),
        turn_detection=MultilingualModel(),
        stt=deepgram.STT(
            model="nova-3",
            language="en-GB",
            interim_results=True,
            smart_format=True,
            punctuate=True,
        ),
        llm="openai/gpt-4.1-mini",
        tts=elevenlabs.TTS(
            model=agent_infra.ELEVEN_TTS_MODEL,
            voice_id=agent_infra.ELEVEN_VOICE_ID,
            voice_settings=elevenlabs.VoiceSettings(
                stability=agent_infra.ELEVEN_STABILITY,
                similarity_boost=agent_infra.ELEVEN_SIMILARITY,
                style=agent_infra.ELEVEN_STYLE,
            ),
        ),
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

    # Capture full conversation for portal transcript
    @session.on("conversation_item_added")
    def _on_conversation_item(item):
        try:
            role = getattr(item, "role", "")
            text = getattr(item, "text", "")
            if not text and hasattr(item, "content"):
                content = item.content
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts = []
                    for part in content:
                        if hasattr(part, "text"):
                            parts.append(part.text or "")
                        elif isinstance(part, dict):
                            parts.append(part.get("text", ""))
                    text = " ".join(p for p in parts if p)
            text = text.strip()
            if not text:
                return
            speaker = "agent" if role in ("assistant", "agent") else "customer"
            ts = max(0.0, time.time() - (s.call_start_time or time.time()))
            s.conversation_items.append({"speaker": speaker, "text": text, "timestamp": round(ts, 1)})
            print(f"[TRANSCRIPT] {speaker.capitalize()}: {text[:80]}{'...' if len(text) > 80 else ''}")
        except Exception as exc:
            print(f"[TRANSCRIPT] conversation_item_added error: {exc}")

    # Session isolation — prevent context bleeding
    @ctx.room.on("participant_disconnected")
    def _on_caller_left(participant):
        print(f"[SESSION] Caller disconnected: {participant.identity}")
        
        async def _shutdown_and_log():
            # Log call to portal before shutdown
            try:
                call_duration = int(time.time() - s.call_start_time) if s.call_start_time else 0

                # Extract phone from SIP participant attributes if not already set
                caller_phone = s.contact_phone or ""
                if not caller_phone:
                    try:
                        attrs = participant.attributes or {}
                        caller_phone = (
                            attrs.get("sip.phoneNumber") or
                            attrs.get("sip.from") or
                            ""
                        )
                        # Fall back: parse identity like sip_+447841422472
                        if not caller_phone and participant.identity.startswith("sip_"):
                            caller_phone = participant.identity[4:]  # strip 'sip_'
                        if caller_phone:
                            s.contact_phone = caller_phone
                            print(f"[PORTAL] Extracted caller phone from attributes: {caller_phone}")
                    except Exception:
                        pass

                # Build transcript: prefer conversation_items (full agent+customer turns captured in real-time)
                # Fall back to synthetic transcript from recent_transcripts if no conversation_items
                base_ts = s.call_start_time or time.time()
                if s.conversation_items:
                    transcript = s.conversation_items
                    # Ensure at least one agent entry exists
                    if not any(e.get("speaker") == "agent" for e in transcript):
                        transcript = [{"speaker": "agent", "text": "Hello, how can I help you today?", "timestamp": 0}] + transcript
                    print(f"[PORTAL] Using {len(transcript)} conversation_items for transcript")
                else:
                    # Fallback: synthetic transcript from customer utterances
                    print("[PORTAL] No conversation_items — building synthetic transcript from recent_transcripts")
                    transcript = []
                    transcript.append({"speaker": "agent", "text": "Hello, how can I help you today?", "timestamp": 0})
                    for i, text in enumerate(s.recent_transcripts or [], start=1):
                        transcript.append({"speaker": "customer", "text": text, "timestamp": i * 5})
                    # Append key structured events as agent turns
                    offset = len(transcript) * 5
                    if s.vrn:
                        transcript.append({"speaker": "agent", "text": f"I have your vehicle registration as {s.vrn}.", "timestamp": offset})
                        offset += 5
                    if s.booking_date:
                        transcript.append({"speaker": "agent", "text": f"Booking confirmed for {s.booking_date} at {s.booking_time}.", "timestamp": offset})

                # Generate GPT summary (falls back to state-based if LLM unavailable)
                summary = await generate_call_summary(transcript, s)

                # Determine call type
                call_type = "unknown"
                if s.intent == "tyre_purchase" and s.booking_date:
                    call_type = "booking"
                elif s.intent == "quote":
                    call_type = "quote"
                elif s.intent == "message":
                    call_type = "message"
                elif s.intent == "vehicle_update":
                    call_type = "vehicle_update"

                # Build booking details if applicable
                booking_details = ""
                if s.booking_date:
                    booking_parts = []
                    booking_parts.append(f"Date: {s.booking_date}")
                    if s.booking_time:
                        booking_parts.append(f"Time: {s.booking_time}")
                    if s.basket_items:
                        for item in s.basket_items:
                            if item.get("name"):
                                booking_parts.append(f"Item: {item['name']}")
                    booking_details = ", ".join(booking_parts)

                # metrics must be a non-empty object
                metrics = {
                    "duration_seconds": call_duration,
                    "intent": s.intent or "unknown",
                    "vrn_captured": bool(s.vrn),
                    "booking_confirmed": s.step == Step.CONFIRMED,
                }

                print(f"[PORTAL] Call duration: {call_duration}s, Transcript entries: {len(transcript)}")

                # Stop egress recording
                if s.egress_id:
                    try:
                        lkapi = lk_api.LiveKitAPI()
                        async with lkapi:
                            await lkapi.egress.stop_egress(s.egress_id)
                        print(f"[RECORDING] Stopped egress recording: {s.egress_id}")
                    except Exception as e:
                        print(f"[RECORDING] Failed to stop egress recording: {e}")

                # Log to portal
                await log_call_to_portal(
                    garage_id=garage_id,
                    room_name=room_name,
                    duration_seconds=call_duration,
                    transcript=transcript,
                    summary=summary,
                    customer_name=f"{s.customer_name_first} {s.customer_name_last}".strip() or "Unknown",
                    customer_phone=caller_phone,
                    registration_number=s.vrn,
                    confirmed_booking=s.step == Step.CONFIRMED,
                    booking_details=booking_details,
                    call_type=call_type,
                    metrics=metrics,
                )
            except Exception as e:
                print(f"[PORTAL] Failed to log call: {e}")

            ctx.shutdown("caller_disconnected")

        asyncio.create_task(_shutdown_and_log())

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
