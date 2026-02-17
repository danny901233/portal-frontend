from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List


class Step(Enum):
    """Step-by-step phases in the booking pipeline."""

    GREETING = "greeting"
    NEED_VRN = "need_vrn"
    CONFIRMING_VEHICLE = "confirming_vehicle"
    NEED_SERVICE = "need_service"
    NEED_TIMESLOT = "need_timeslot"
    NEED_CONTACT = "need_contact"
    CONFIRMED = "confirmed"
    DONE = "done"
    MESSAGE_ONLY = "message_only"


@dataclass(slots=True)
class CallState:
    """All mutable, per-call data shared by the supervisor and specialists."""

    step: Step = Step.GREETING
    intent: str = ""
    service_hint: str = ""

    # Caller
    customer_name_first: str = ""
    customer_name_last: str = ""

    # Vehicle
    vrn: str = ""
    vrn_confirmed: bool = False
    session_id: str = ""
    vehicle_make: str = ""
    vehicle_model: str = ""

    # Service
    services_available: List[dict] = field(default_factory=list)
    service_selected_id: str = ""
    service_selected_name: str = ""
    service_price: str = ""

    # Timeslot
    timeslots_available: List[dict] = field(default_factory=list)
    booking_date: str = ""
    booking_time: str = ""

    # Contact
    contact_phone: str = ""
    contact_email: str = ""
    house_name_or_number: str = ""
    postcode: str = ""
    street: str = ""
    city: str = ""
    full_address: str = ""
    notes: str = ""

    # Message
    message: str = ""
    preferred_callback_time: str = ""

    # Tracking
    vrn_attempts: int = 0
    vrn_partial: str = ""
    recent_transcripts: List[str] = field(default_factory=list)

    # Diagnostic intake
    diagnostic_mode: bool = False
    diagnostic_data: dict = field(default_factory=dict)  # Stores answers to diagnostic questions
    diagnostic_question_index: int = 0  # Current question being asked

    def append_transcript(self, text: str) -> None:
        self.recent_transcripts.append(text)

    def replace_last_transcript(self, text: str) -> None:
        if self.recent_transcripts:
            self.recent_transcripts[-1] = text
        else:
            self.recent_transcripts.append(text)

    def reset_for_message_mode(self) -> None:
        self.step = Step.MESSAGE_ONLY
        self.intent = "message"

    def reset_booking_pipeline(self) -> None:
        self.session_id = ""
        self.vehicle_make = ""
        self.vehicle_model = ""
        self.service_selected_id = ""
        self.service_selected_name = ""
        self.service_price = ""
        self.timeslots_available.clear()
        self.booking_date = ""
        self.booking_time = ""
        self.contact_phone = ""
        self.contact_email = ""
        self.house_name_or_number = ""
        self.postcode = ""
        self.street = ""
        self.city = ""
        self.full_address = ""
        self.notes = ""
        self.step = Step.NEED_VRN
