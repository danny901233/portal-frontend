from __future__ import annotations

from core.state import Step
from specialists.base import SpecialistBase


class ProfileSpecialist(SpecialistBase):
    async def update_caller_name(self, *, first_name: str = "", last_name: str = "") -> str:
        if self.state.step == Step.GREETING:
            return "WRONG TOOL: Call save_caller_name during greeting."

        updates = []
        if first_name.strip():
            self.state.customer_name_first = first_name.strip()
            updates.append("first name")
        if last_name.strip():
            self.state.customer_name_last = last_name.strip()
            updates.append("surname")

        if not updates:
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="I need the updated first name, surname, or both.",
                notes="update_caller_name called without data",
            )

        next_actions = {
            Step.NEED_VRN: "Ask for the reg.",
            Step.CONFIRMING_VEHICLE: "Confirm the vehicle.",
            Step.NEED_SERVICE: "Ask what work it needs.",
            Step.NEED_TIMESLOT: "Offer timeslots.",
            Step.NEED_CONTACT: "Collect contact info.",
        }
        say_line = next_actions.get(self.state.step, "Carry on where you left off.")

        return self.json_directive(
            status="ok",
            step=self.state.step.value,
            say=say_line,
            notes=f"Updated: {', '.join(updates)}",
        )
