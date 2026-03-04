from __future__ import annotations

from core.state import Step
from core.utils import normalize_vehicle_registration
from specialists.base import SpecialistBase


class VehicleSpecialist(SpecialistBase):
    async def lookup_vehicle(self, *, reg: str) -> str:
        if self.state.step not in (Step.NEED_VRN, Step.CONFIRMING_VEHICLE, Step.MESSAGE_ONLY):
            if self.state.step == Step.GREETING:
                return "BLOCKED: Call save_caller_name first."
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="Vehicle lookup not required right now.",
                notes="lookup_vehicle called outside NEED_VRN/CONFIRMING_VEHICLE",
            )

        if self.state.step == Step.MESSAGE_ONLY:
            self.state.intent = "booking"
            self.state.step = Step.NEED_VRN

        normalized = normalize_vehicle_registration(reg)
        if self.state.vrn_partial:
            normalized = f"{self.state.vrn_partial}{normalized}"

        has_digit = any(ch.isdigit() for ch in normalized)
        if not has_digit:
            caller_names = {
                self.state.customer_name_first.upper(),
                self.state.customer_name_last.upper(),
            }
            caller_names.discard("")
            if normalized.upper() in caller_names:
                self.state.vrn_partial = ""
                return self.json_directive(
                    status="needs_input",
                    step=Step.NEED_VRN.value,
                    say="",
                    notes="VRN attempt matched caller name; likely echo",
                )

        if len(normalized) < 4 or not has_digit:
            self.state.vrn_partial = normalized
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_VRN.value,
                say="",
                notes="VRN partial captured; wait for caller to continue spelling",
            )

        self.state.vrn_partial = ""
        self.state.vrn = normalized
        self.state.vrn_attempts += 1

        try:
            result = await self.gh.init_and_set_vehicle(normalized)
        except Exception as exc:
            self.schedule_report(message=f"lookup_vehicle failed: {exc}", error_type="api_error", extra={"reg": normalized})
            if self.state.vrn_attempts >= 3:
                self.state.reset_for_message_mode()
                return self.json_directive(
                    status="escalate",
                    step=self.state.step.value,
                    say="I'm struggling to pull that up. Let me take your details for a callback.",
                    notes="API error after 3 attempts",
                )
            return self.json_directive(
                status="error",
                step=Step.NEED_VRN.value,
                say="I couldn't quite get that. Could you spell it once more for me?",
                notes="API error",
            )

        if "error" in result:
            if self.state.vrn_attempts >= 3:
                self.state.reset_for_message_mode()
                return self.json_directive(
                    status="escalate",
                    step=self.state.step.value,
                    say="Still no luck finding that one. I'll grab a few details and have the team ring you back.",
                    notes="Vehicle not found after 3 tries",
                )
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_VRN.value,
                say="I couldn't find that. Could you read it one letter at a time for me?",
                notes="Vehicle not found",
            )

        booking = result.get("booking", {})
        vehicle = booking.get("vehicle", {})
        make = vehicle.get("make_name", "")
        model = vehicle.get("model_name", "")
        session_id = result.get("session_id", "")

        if not make and not model:
            if self.state.vrn_attempts >= 3:
                self.state.reset_for_message_mode()
                return self.json_directive(
                    status="escalate",
                    step=self.state.step.value,
                    say="I can't seem to match that reg. Let me take a message for the team.",
                    notes="Empty GH response",
                )
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_VRN.value,
                say="That came back blank. Mind spelling it again just to double-check?",
                notes="Vehicle data empty",
            )

        self.state.session_id = session_id
        self.state.vehicle_make = make
        self.state.vehicle_model = model
        self.state.step = Step.CONFIRMING_VEHICLE

        say_line = f"I've got a {make.title()} {model.title()} on that reg. Is that right?"
        return self.json_directive(
            status="ok",
            step=Step.CONFIRMING_VEHICLE.value,
            say=say_line,
            notes="Confirm vehicle with caller, then call confirm_vehicle",
        )

    async def confirm_vehicle(
        self,
        *,
        confirmed: bool,
        corrected_first_name: str = "",
        corrected_last_name: str = "",
    ) -> str:
        if self.state.step != Step.CONFIRMING_VEHICLE:
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="There's nothing to confirm just now.",
                notes="confirm_vehicle called outside CONFIRMING_VEHICLE",
            )

        if not confirmed:
            self.state.step = Step.NEED_VRN
            self.state.session_id = ""
            self.state.vehicle_make = ""
            self.state.vehicle_model = ""
            if self.state.vrn_attempts >= 3:
                self.state.reset_for_message_mode()
                return self.json_directive(
                    status="escalate",
                    step=self.state.step.value,
                    say="Still not matching. I'll take your details for a call back.",
                    notes="Vehicle rejected repeatedly",
                )
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_VRN.value,
                say="No worries. Could you read it again for me?",
                notes="Vehicle rejected",
            )

        if corrected_first_name:
            self.state.customer_name_first = corrected_first_name.strip()
        if corrected_last_name:
            self.state.customer_name_last = corrected_last_name.strip()
        self.state.vrn_confirmed = True

        try:
            services = await self.gh.list_services(self.state.session_id)
            self.state.services_available = services
        except Exception as exc:
            self.logger.warning("[VehicleSpecialist] Service prefetch failed: %s", exc)
            services = []

        self.state.step = Step.NEED_SERVICE
        notes = self.state.service_hint or "Ask what work the car needs."
        return self.json_directive(
            status="ok",
            step=Step.NEED_SERVICE.value,
            say="What work does it need?",
            notes=notes,
        )
