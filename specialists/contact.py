from __future__ import annotations

import re

from core.state import Step
from specialists.base import SpecialistBase


class ContactSpecialist(SpecialistBase):
    async def validate_address(self, *, postcode: str) -> str:
        if self.state.step != Step.NEED_CONTACT:
            if self.state.step == Step.GREETING:
                return "BLOCKED: save_caller_name must run before validate_address."
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="Postcode can wait for later in the flow.",
                notes="validate_address called outside NEED_CONTACT",
            )

        clean = (postcode or "").strip()
        if not clean:
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_CONTACT.value,
                say="What's your postcode?",
                notes="Postcode missing",
            )

        pc_lower = clean.lower()
        if "@" in pc_lower or any(domain in pc_lower for domain in ("gmail", "hotmail", "yahoo", "icloud", "outlook")):
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_CONTACT.value,
                say="Sorry, that's an email. Could I grab your postcode?",
                notes="Email passed to postcode field",
            )

        compact = re.sub(r"\s", "", clean)
        if compact.isalpha() or compact.isdigit() or len(compact) < 5 or len(compact) > 8:
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_CONTACT.value,
                say="Could you repeat the postcode? It should have letters and numbers like SW1A 1AA.",
                notes="Postcode format invalid",
            )

        lookup = await self.gh.validate_address(clean)
        street = lookup.get("street", "")
        city = lookup.get("city", "")
        self.state.postcode = clean
        self.state.street = street
        self.state.city = city

        if street or city:
            area = ", ".join(filter(None, [street, city])) or "the area"
            say_line = f"Is that {area}?"
        else:
            say_line = "Thanks — and the house number?"

        return self.json_directive(
            status="ok",
            step=Step.NEED_CONTACT.value,
            say=say_line.strip(),
            notes="Confirm area then ask for house number",
        )

    async def submit_booking(
        self,
        *,
        phone: str,
        email: str,
        house_name_or_number: str,
        postcode: str,
        street: str = "",
        city: str = "",
        notes: str = "",
    ) -> str:
        if self.state.step != Step.NEED_CONTACT:
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="Not ready to submit yet.",
                notes="submit_booking called outside NEED_CONTACT",
            )

        missing_pipeline = []
        if not self.state.session_id:
            missing_pipeline.append("vehicle lookup")
        if not self.state.service_selected_name:
            missing_pipeline.append("service selection")
        if not self.state.booking_date or not self.state.booking_time:
            missing_pipeline.append("timeslot selection")
        if missing_pipeline:
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="I need to finish the earlier steps before submitting.",
                notes=f"Missing: {', '.join(missing_pipeline)}",
            )

        first = self.state.customer_name_first
        last = self.state.customer_name_last
        phone = (phone or "").strip()
        email_clean = (email or "").strip().replace(" ", "").lower()
        house = (house_name_or_number or "").strip()
        postcode = (postcode or self.state.postcode or "").strip()
        street = (street or self.state.street or "").strip()
        city = (city or self.state.city or "").strip()

        missing = []
        if not first:
            missing.append("first name")
        if not last:
            missing.append("surname")
        if not phone:
            missing.append("phone number")
        if not email_clean or "@" not in email_clean:
            missing.append("valid email")
        if not house:
            missing.append("house name/number")
        if not postcode:
            missing.append("postcode")
        if not street or not city:
            missing.append("street/city (use validate_address)")

        if missing:
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_CONTACT.value,
                say="I still need " + ", ".join(missing) + ".",
                notes="Missing data for submit_booking",
            )

        contact_address = f"{house}, {street}".strip(", ")
        try:
            result = await self.gh.set_contact_info(
                self.state.session_id,
                contact_name=first,
                contact_last_name=last,
                contact_email=email_clean,
                contact_number=phone,
                contact_address=contact_address.lower(),
                contact_city=city.lower(),
                contact_postcode=postcode,
                contact_salutation=10,
                contact_address2="",
                notes=notes or self.state.notes,
            )
        except Exception as exc:
            self.schedule_report(
                message=f"submit_booking failed: {exc}",
                error_type="api_error",
                extra={"session_id": self.state.session_id},
            )
            return self.json_directive(
                status="error",
                step=Step.NEED_CONTACT.value,
                say="Something went wrong saving that. Could we try again?",
                notes="submit_booking API error",
            )

        if result.get("status") == "success":
            self.state.step = Step.CONFIRMED
            self.state.contact_phone = phone
            self.state.contact_email = email_clean
            self.state.house_name_or_number = house
            self.state.full_address = f"{house}, {street}, {city}, {postcode}".strip(", ")
            say_line = (
                f"That's all booked — {self.state.service_selected_name} on {self.state.booking_date} at "
                f"{self.state.booking_time}. Anything else while you're on?"
            )
            return self.json_directive(
                status="ok",
                step=Step.CONFIRMED.value,
                say=say_line,
                notes="Booking confirmed",
            )

        errors = result.get("errors", [])
        message = result.get("message", "Unknown error")
        return self.json_directive(
            status="error",
            step=Step.NEED_CONTACT.value,
            say="That didn't go through. Could we double-check the details?",
            notes=f"{message} | errors={errors}",
        )
