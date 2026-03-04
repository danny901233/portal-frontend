from __future__ import annotations

from typing import Literal

from core.state import Step
from core.utils import normalize_vehicle_registration, recent_transcript_blob
from specialists.base import SpecialistBase

IntentLiteral = Literal["booking", "quote", "message"]


class CallerIntakeSpecialist(SpecialistBase):
    async def save_caller_name(
        self,
        *,
        first_name: str,
        last_name: str = "",
        intent: IntentLiteral | str = "booking",
        service_hint: str = "",
        vrn: str = "",
    ) -> str | dict:
        if self.state.step != Step.GREETING:
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="Name already captured.",
                notes="save_caller_name is locked after greeting stage",
            )

        first = (first_name or "").strip()
        last = (last_name or "").strip()
        if not first:
            return "ERROR: Caller first name is required. Ask for their name before calling save_caller_name."

        transcripts_blob = recent_transcript_blob(self.state.recent_transcripts, limit=6).lower()
        if first.lower() not in transcripts_blob:
            return (
                "REJECTED: The caller has not said that name yet. Ask for their actual name first, "
                "then call save_caller_name with what they said."
            )

        self.state.customer_name_first = first
        self.state.customer_name_last = last
        self.state.intent = self._resolve_intent(intent)
        if service_hint:
            self.state.service_hint = service_hint.strip()

        if self.state.intent == "message":
            self.state.reset_for_message_mode()
            return self.json_directive(
                status="ok",
                step=self.state.step.value,
                say="Ask what message they'd like to leave, then collect phone number and callback time.",
                notes="Message intent detected during intake",
            )

        self.state.step = Step.NEED_VRN

        if vrn:
            normalized = normalize_vehicle_registration(vrn)
            self.state.vrn = normalized
            return self.json_directive(
                status="ok",
                step=Step.NEED_VRN.value,
                say="",
                silent_next_tool={"name": "lookup_vehicle", "args": {"reg": normalized}},
                notes=f"Name saved for {first} {last}; VRN provided inline",
            )

        return self.json_directive(
            status="ok",
            step=Step.NEED_VRN.value,
            say="Could I grab your reg?",
            notes=f"Name saved for {first} {last}; request VRN next",
        )

    def _resolve_intent(self, intent: str | IntentLiteral) -> IntentLiteral:
        normalized = (intent or "").strip().lower()
        if normalized == "quote":
            return "quote"
        if normalized == "message":
            return "message"
        return "booking"
