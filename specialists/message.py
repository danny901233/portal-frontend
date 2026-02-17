from __future__ import annotations

from core.state import Step
from specialists.base import SpecialistBase


class MessageSpecialist(SpecialistBase):
    async def take_message(
        self,
        *,
        message: str,
        phone: str,
        name_first: str = "",
        name_last: str = "",
        vrn: str = "",
        callback_time: str = "",
    ) -> str:
        allowed = {Step.GREETING, Step.MESSAGE_ONLY, Step.NEED_VRN, Step.NEED_SERVICE, Step.NEED_TIMESLOT, Step.NEED_CONTACT}
        if self.state.step not in allowed:
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="Can't take a message at this stage.",
                notes="take_message called in disallowed step",
            )

        if name_first:
            self.state.customer_name_first = name_first.strip()
        if name_last:
            self.state.customer_name_last = name_last.strip()
        if vrn:
            from core.utils import normalize_vehicle_registration

            self.state.vrn = normalize_vehicle_registration(vrn)

        self.state.message = (message or "").strip()
        self.state.contact_phone = (phone or "").strip()
        self.state.preferred_callback_time = (callback_time or "").strip()
        self.state.step = Step.DONE

        self.schedule_report(
            message=f"Call escalated to message: {self.state.message}",
            error_type="escalation",
            extra={"caller": f"{self.state.customer_name_first} {self.state.customer_name_last}", "intent": self.state.intent},
        )

        return self.json_directive(
            status="ok",
            step=Step.DONE.value,
            say="I'll make sure the team sees this and gives you a ring back shortly.",
            notes="Message logged",
        )
