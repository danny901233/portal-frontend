"""ReceptionMate Supervisor voice agent (Option A architecture).

One speaking agent (Leah) orchestrates per-call state and dispatches work to silent
specialist tool agents. Specialists never speak or touch AgentSession; they only
work with CallState + GH client and return directives/JSON for Leah to action.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from contextlib import suppress
from datetime import timedelta
from pathlib import Path
from typing import Optional

from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    WorkerOptions,
    WorkerType,
    cli,
)
from livekit.agents.llm import function_tool
from livekit.plugins import deepgram, elevenlabs

from core.error_monitor import ErrorMonitor, ErrorMonitorConfig
from core.gh_client import GHClient
from core.state import CallState
from core.utils import (
    dynamic_greeting,
    load_env_files,
    resolve_env_value,
    uk_now,
)
from specialists.contact import ContactSpecialist
from specialists.datetime import DatetimeSpecialist
from specialists.intake import CallerIntakeSpecialist
from specialists.message import MessageSpecialist
from specialists.profile import ProfileSpecialist
from specialists.service import ServiceSpecialist
from specialists.timeslot import TimeslotSpecialist
from specialists.vehicle import VehicleSpecialist

# ---------------------------------------------------------------------------
# Logging & environment
# ---------------------------------------------------------------------------

logger = logging.getLogger("receptionmate.supervisor")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

ROOT = Path(__file__).resolve().parent
_DOTENV_CANDIDATES = [
    ROOT / ".env",
    ROOT / ".env.local",
    ROOT.parent / ".env",
    ROOT.parent / ".env.local",
]
_LOADED_ENVS = load_env_files(_DOTENV_CANDIDATES)
if not _LOADED_ENVS:
    logger.warning("[SETUP] No .env* files found; relying on process environment")

DEFAULT_GH_CUSTOMER_ID = "devbc24_mpu"
DEFAULT_GH_LOCATION_ID = "399"
_GH_CUSTOMER_PLACEHOLDERS = {"", "your-customer-id", "your_customer_id", "customer-id"}
_GH_LOCATION_PLACEHOLDERS = {"", "your-location-id", "your_location_id", "your-location-code"}

PORTAL_GARAGE_ID = os.getenv("PORTAL_GARAGE_ID", "")
GH_CUSTOMER_ID = resolve_env_value(os.getenv("GH_CUSTOMER_ID"), DEFAULT_GH_CUSTOMER_ID, _GH_CUSTOMER_PLACEHOLDERS)
GH_LOCATION_ID = int(resolve_env_value(os.getenv("GH_LOCATION_ID"), DEFAULT_GH_LOCATION_ID, _GH_LOCATION_PLACEHOLDERS) or 23)
GH_API_KEY = os.getenv("GH_API_KEY", "")

AGENT_BRANCH_NAME = os.getenv("AGENT_BRANCH_NAME", "the garage")
AGENT_GREETING_LINE = os.getenv("AGENT_GREETING_LINE")
LLM_MODEL = os.getenv("SUPERVISOR_LLM_MODEL", "openai/gpt-4o-mini")

# Service Expert LLM configuration (optional; only used for ambiguous service requests)
SERVICE_EXPERT_MODEL = os.getenv("SERVICE_EXPERT_MODEL", LLM_MODEL)
SERVICE_EXPERT_TIMEOUT_MS = int(os.getenv("SERVICE_EXPERT_TIMEOUT_MS", "1500"))
SERVICE_EXPERT_CONFIDENCE_THRESHOLD = float(os.getenv("SERVICE_EXPERT_CONFIDENCE_THRESHOLD", "0.65"))
SERVICE_EXPERT_CACHE_SIZE = int(os.getenv("SERVICE_EXPERT_CACHE_SIZE", "128"))

ELEVEN_VOICE_ID = os.getenv("ELEVEN_VOICE_ID", "leah")
ELEVEN_TTS_MODEL = os.getenv("ELEVEN_TTS_MODEL", "eleven_turbo_v2_5")
ELEVEN_STABILITY = float(os.getenv("ELEVEN_STABILITY", "0.55"))
ELEVEN_SIMILARITY = float(os.getenv("ELEVEN_SIMILARITY_BOOST") or os.getenv("ELEVEN_SIMILARITY") or "0.75")
ELEVEN_STYLE = float(os.getenv("ELEVEN_STYLE", "0"))
ELEVEN_SPEED = float(os.getenv("ELEVEN_SPEED", "0.92"))
ELEVEN_SPEAKER_BOOST = os.getenv("ELEVEN_USE_SPEAKER_BOOST", "true").lower() == "true"

DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
ERROR_LOG_EXCEL_PATH = os.getenv("ERROR_LOG_EXCEL_PATH")

TRANSCRIPT_HISTORY_LIMIT = 8
TRANSCRIPT_COMMIT_DEBOUNCE = 0.5

# Log Service Expert configuration
logger.info("[SETUP] Service Expert: model=%s, timeout=%dms, threshold=%.2f, cache=%d", 
            SERVICE_EXPERT_MODEL, SERVICE_EXPERT_TIMEOUT_MS, SERVICE_EXPERT_CONFIDENCE_THRESHOLD, SERVICE_EXPERT_CACHE_SIZE)

# ---------------------------------------------------------------------------
# Helper prompt builder
# ---------------------------------------------------------------------------

TOOL_FLOW = "save_caller_name → lookup_vehicle → confirm_vehicle → select_service → select_timeslot → validate_address → submit_booking"


def _build_system_prompt(branch_name: str) -> str:
    today = uk_now()
    tomorrow = today + timedelta(days=1)
    greeting_line = dynamic_greeting(branch_name, AGENT_GREETING_LINE)

    return f"""
YOU ARE LEAH — one warm, confident British receptionist for {branch_name}. Only you speak.
Silent specialists (Vehicle, Service, Timeslot, Contact, Message, Profile, Datetime) exist, but they NEVER talk and you must never impersonate them.

CORE RULES:
- One question per turn. Ask, then stop talking.
- All tools are SILENT. When you call a tool, output ONLY the tool call. No filler like "hang on" or "let me check".
- Tool responses may be plain text or JSON. If JSON is returned, follow it exactly:
  * If `say` is present and non-empty, speak it verbatim (one sentence max).
  * If `status: needs_input`, ask the question in `say` and wait for the caller's response.
  * If `silent_next_tool` exists, call that tool immediately with ZERO speech.
  * Do not improvise or add commentary between tool calls.
- Strict tool order: {TOOL_FLOW}. `take_message` is the only escape hatch and may be used any time if the caller explicitly wants a message or after three failed VRN attempts.
- `save_caller_name` MUST run first. Never touch any other tool until it succeeds.
- Never say "booked" or "confirmed" until `submit_booking` returns success.
- Do not invent names, VRNs, services, or contact details. Repeat back what the caller actually said.
- If a tool returns `status: escalate`, pivot to taking a message immediately.
- Silence is fine. If the caller pauses or is spelling a reg, wait. Do not repeat questions back-to-back, and never claim the caller failed to mention something.

CALL FLOW REMINDERS:
1. Greeting already played ("{greeting_line}"). Next step: ask for their name if you don't have it.
2. Decide intent based on their words: booking, quote, or message. Always call `save_caller_name(first, last, intent, service_hint, vrn)`.
3. Vehicle lookup: pass exactly what they said. If a tool says the reg is partial, stay silent and wait for the caller to continue, then call `lookup_vehicle` again with ONLY the new characters.
4. Confirm vehicle, then the caller's name, then ask what work they need. Move through: work type → timeslot → contact details. Offer early slots naturally.
5. Contact stage order: surname (if missing) → phone → email → postcode (`validate_address`) → house number/name → `submit_booking`.
6. Quote-only callers: provide the price via `select_service`, then ask if they'd like to book. If they decline, take a message.
7. Message callers: collect the message, phone, and callback time, then call `take_message`.

TERMINOLOGY:
- Ask "What work do you need?" or "What brings you in?" — not "what service" (service = scheduled maintenance only).
- Full Service/Interim Service/Oil Service are "services". MOT, diagnostics, repairs, brakes, tyres are "work" but not "services".

LANGUAGE & TONE:
- British English only. Use phrases like "lovely", "no worries", "give you a ring", "bonnet", "half eight". Avoid Americanisms ("awesome", "you guys", "gotten").
- Natural, calm pacing. Friendly but not over the top. Closing lines such as "Cheers, have a lovely day" are ONLY for the end of the call.
- Refer to the car as "it" or "the car" after the make/model is established.

DATES & TIMES:
- Today is {today:%A %d %B %Y}. Tomorrow is {tomorrow:%A %d %B %Y}.
- Use natural phrasing: 08:30 → "half eight", 14:00 → "two o'clock".

FAILSAFES:
- If a caller changes their mind (booking ↔ message), pivot immediately. Message path always allowed.
- If a tool reports errors or missing data, address only what's missing. Never fabricate details.
- Never switch persona or refer to multiple colleagues speaking. Only Leah is on the line.

Follow specialist directives word-for-word. When unsure, ask concise clarification questions and wait.
""".strip()


# ---------------------------------------------------------------------------
# Supervisor Agent Definition
# ---------------------------------------------------------------------------


class SupervisorAgent(Agent):
    """Single speaking agent orchestrating silent specialists."""

    def __init__(
        self,
        *,
        state: CallState,
        gh: GHClient,
        error_monitor: ErrorMonitor,
        room_name: str,
        logger_name: str = "receptionmate.supervisor.agent",
    ) -> None:
        self._state = state
        self._gh = gh
        self._room = room_name
        self._session: Optional[AgentSession] = None
        agent_logger = logging.getLogger(logger_name)

        self._datetime = DatetimeSpecialist(
            state=state,
            gh=gh,
            room_name=room_name,
            logger=agent_logger.getChild("datetime"),
            error_monitor=error_monitor,
        )
        self._intake = CallerIntakeSpecialist(
            state=state,
            gh=gh,
            room_name=room_name,
            logger=agent_logger.getChild("intake"),
            error_monitor=error_monitor,
        )
        self._vehicle = VehicleSpecialist(
            state=state,
            gh=gh,
            room_name=room_name,
            logger=agent_logger.getChild("vehicle"),
            error_monitor=error_monitor,
        )
        self._service = ServiceSpecialist(
            state=state,
            gh=gh,
            room_name=room_name,
            logger=agent_logger.getChild("service"),
            error_monitor=error_monitor,
        )
        self._timeslot = TimeslotSpecialist(
            state=state,
            gh=gh,
            room_name=room_name,
            logger=agent_logger.getChild("timeslot"),
            error_monitor=error_monitor,
        )
        self._contact = ContactSpecialist(
            state=state,
            gh=gh,
            room_name=room_name,
            logger=agent_logger.getChild("contact"),
            error_monitor=error_monitor,
        )
        self._profile = ProfileSpecialist(
            state=state,
            gh=gh,
            room_name=room_name,
            logger=agent_logger.getChild("profile"),
            error_monitor=error_monitor,
        )
        self._message = MessageSpecialist(
            state=state,
            gh=gh,
            room_name=room_name,
            logger=agent_logger.getChild("message"),
            error_monitor=error_monitor,
        )

        instructions = _build_system_prompt(AGENT_BRANCH_NAME)

        @function_tool
        async def get_current_datetime(context: RunContext) -> dict:
            """Get the current UK date and time."""
            return await self._datetime.current_datetime()

        @function_tool
        async def save_caller_name(
            context: RunContext,
            first_name: str,
            last_name: str = "",
            intent: str = "booking",
            service_hint: str = "",
            vrn: str = "",
        ) -> str | dict:
            """Save the caller's name, determine intent, and optionally capture VRN/service hints."""
            return await self._intake.save_caller_name(
                first_name=first_name,
                last_name=last_name,
                intent=intent,
                service_hint=service_hint,
                vrn=vrn,
            )

        @function_tool
        async def lookup_vehicle(context: RunContext, reg: str) -> str:
            """Look up the vehicle via GarageHive using the caller's reg (accepts NATO phonetics)."""
            return await self._vehicle.lookup_vehicle(reg=reg)

        @function_tool
        async def confirm_vehicle(
            context: RunContext,
            confirmed: bool,
            corrected_first_name: str = "",
            corrected_last_name: str = "",
        ) -> str:
            """Confirm or reject the vehicle match, optionally updating the name."""
            return await self._vehicle.confirm_vehicle(
                confirmed=confirmed,
                corrected_first_name=corrected_first_name,
                corrected_last_name=corrected_last_name,
            )

        @function_tool
        async def select_service(context: RunContext, service_name: str) -> str:
            """Choose the service/work requested by the caller."""
            return await self._service.select_service(service_name=service_name)

        @function_tool
        async def select_timeslot(context: RunContext, booking_date: str, booking_time: str) -> str:
            """Reserve the chosen booking slot (date=YYYY-MM-DD, time=HH:MM)."""
            return await self._timeslot.select_timeslot(booking_date=booking_date, booking_time=booking_time)

        @function_tool
        async def validate_address(context: RunContext, postcode: str) -> str:
            """Validate a UK postcode and pre-fill the area before collecting the house number."""
            return await self._contact.validate_address(postcode=postcode)

        @function_tool
        async def submit_booking(
            context: RunContext,
            phone: str,
            email: str,
            house_name_or_number: str,
            postcode: str,
            street: str = "",
            city: str = "",
            notes: str = "",
        ) -> str:
            """Submit the booking once phone, email, postcode, street, city, and house number are known."""
            return await self._contact.submit_booking(
                phone=phone,
                email=email,
                house_name_or_number=house_name_or_number,
                postcode=postcode,
                street=street,
                city=city,
                notes=notes,
            )

        @function_tool
        async def update_caller_name(
            context: RunContext,
            first_name: str = "",
            last_name: str = "",
        ) -> str:
            """Update the caller's name mid-call when they correct it or provide a surname later."""
            return await self._profile.update_caller_name(first_name=first_name, last_name=last_name)

        @function_tool
        async def take_message(
            context: RunContext,
            message: str,
            phone: str,
            name_first: str = "",
            name_last: str = "",
            vrn: str = "",
            callback_time: str = "",
        ) -> str:
            """Log a message for the team to call back. Use anytime the caller asks to leave a message."""
            return await self._message.take_message(
                message=message,
                phone=phone,
                name_first=name_first,
                name_last=name_last,
                vrn=vrn,
                callback_time=callback_time,
            )

        tools = [
            get_current_datetime,
            save_caller_name,
            lookup_vehicle,
            confirm_vehicle,
            select_service,
            select_timeslot,
            validate_address,
            submit_booking,
            update_caller_name,
            take_message,
        ]

        super().__init__(instructions=instructions, tools=tools)

    def set_session(self, session: AgentSession) -> None:
        self._session = session

    async def on_enter(self) -> None:
        if not self._session:
            return
        greeting = dynamic_greeting(AGENT_BRANCH_NAME, AGENT_GREETING_LINE)
        self._session.say(text=greeting, allow_interruptions=True)
        logger.info("[Supervisor] Greeting delivered")


# ---------------------------------------------------------------------------
# LiveKit entrypoint
# ---------------------------------------------------------------------------


async def entrypoint(ctx: JobContext) -> None:
    logger.info("[ENTRYPOINT] Room %s", ctx.room.name)
    room_name = ctx.room.name

    state = CallState()
    error_monitor = ErrorMonitor(
        ErrorMonitorConfig(
            discord_webhook_url=DISCORD_WEBHOOK_URL,
            excel_path=Path(ERROR_LOG_EXCEL_PATH).resolve() if ERROR_LOG_EXCEL_PATH else None,
        ),
        logger=logger.getChild("error-monitor"),
    )
    gh_client = GHClient(
        customer_id=GH_CUSTOMER_ID,
        location_id=GH_LOCATION_ID,
        api_key=GH_API_KEY,
        logger=logger.getChild("gh"),
    )

    supervisor = SupervisorAgent(
        state=state,
        gh=gh_client,
        error_monitor=error_monitor,
        room_name=room_name,
    )

    session = AgentSession(
        turn_detection="server_vad",
        stt=deepgram.STT(
            model="nova-3",
            language="en-GB",
            interim_results=True,
            endpointing_ms=800,
            smart_format=True,
            punctuate=True,
        ),
        llm=LLM_MODEL,
        tts=elevenlabs.TTS(
            api_key=os.getenv("ELEVEN_API_KEY"),
            voice_id=ELEVEN_VOICE_ID,
            model=ELEVEN_TTS_MODEL,
            voice_settings=elevenlabs.VoiceSettings(
                stability=ELEVEN_STABILITY,
                similarity_boost=ELEVEN_SIMILARITY,
                style=ELEVEN_STYLE,
                speed=ELEVEN_SPEED,
                use_speaker_boost=ELEVEN_SPEAKER_BOOST,
            ),
        ),
    )
    supervisor.set_session(session)

    commit_task: asyncio.Task | None = None
    last_final: str = ""

    @session.on("user_input_transcribed")
    def _on_transcript(event) -> None:
        nonlocal commit_task, last_final
        if not event.is_final:
            return
        text = event.transcript.strip()
        if not text:
            return

        filtered = re.sub(r"[^a-z]", "", text.lower())
        caller_tokens = {
            state.customer_name_first.lower(),
            state.customer_name_last.lower(),
            (state.customer_name_first + state.customer_name_last).lower(),
        }
        caller_tokens.discard("")
        if filtered and filtered in caller_tokens:
            logger.info("[TRANSCRIPT] Ignoring echo that matches caller name: %s", text)
            return

        new_text_lower = text.lower().rstrip(".")
        prev_lower = last_final.lower().rstrip(".")
        if prev_lower and prev_lower in new_text_lower:
            state.replace_last_transcript(text)
        else:
            state.append_transcript(text)
            if len(state.recent_transcripts) > TRANSCRIPT_HISTORY_LIMIT:
                del state.recent_transcripts[:-TRANSCRIPT_HISTORY_LIMIT]
        last_final = text

        if commit_task and not commit_task.done():
            commit_task.cancel()
        commit_task = asyncio.create_task(_debounced_commit())

    async def _debounced_commit() -> None:
        try:
            await asyncio.sleep(TRANSCRIPT_COMMIT_DEBOUNCE)
            session.commit_user_turn()
        except asyncio.CancelledError:
            return

    try:
        await session.start(room=ctx.room, agent=supervisor)
    finally:
        if commit_task and not commit_task.done():
            commit_task.cancel()
            with suppress(asyncio.CancelledError):
                await commit_task
        await gh_client.close()
        logger.info("[ENTRYPOINT] Session closed & GH client released")


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            worker_type=WorkerType.ROOM,
        )
    )
