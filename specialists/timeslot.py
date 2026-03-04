from __future__ import annotations

from core.state import Step
from specialists.base import SpecialistBase


class TimeslotSpecialist(SpecialistBase):
    async def select_timeslot(self, *, booking_date: str, booking_time: str) -> str:
        if self.state.step != Step.NEED_TIMESLOT:
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="Timeslot selection isn't needed just now.",
                notes="select_timeslot called outside NEED_TIMESLOT",
            )

        try:
            await self.gh.set_timeslot(self.state.session_id, booking_date, booking_time)
        except Exception as exc:
            self.logger.error("[TimeslotSpecialist] set_timeslot failed: %s", exc)
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="That slot didn't go through. Could we pick another?",
                notes="set_timeslot API error",
            )

        self.state.booking_date = booking_date.strip()
        self.state.booking_time = booking_time.strip()
        self.state.step = Step.NEED_CONTACT

        say_line = "Lovely, that's pencilled in. I just need a couple of details. What's the best number for you?"
        if not self.state.customer_name_last:
            say_line = "Brilliant, before we wrap that in could I grab your surname?"

        return self.json_directive(
            status="ok",
            step=Step.NEED_CONTACT.value,
            say=say_line,
            notes="Collect contact details in order: surname (if missing) → phone → email → postcode → house number",
        )
