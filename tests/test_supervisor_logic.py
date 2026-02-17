from __future__ import annotations

import json
import logging
import unittest

from core.error_monitor import ErrorMonitor, ErrorMonitorConfig
from core.state import CallState, Step
from core.utils import match_service, normalize_vehicle_registration
from specialists.vehicle import VehicleSpecialist


class DummyGH:
    """Minimal GH client stub for unit-style specialist tests."""

    async def init_and_set_vehicle(self, reg: str) -> dict:
        return {
            "session_id": "sess-test",
            "booking": {
                "vehicle": {"make_name": "Ford", "model_name": "Focus"},
            },
        }

    async def list_services(self, session_id: str) -> list[dict]:  # pragma: no cover - unused
        return []

    async def set_service(self, session_id: str, service_price_ids: str) -> dict:  # pragma: no cover
        return {"status": "ok"}

    async def list_timeslots(self, session_id: str) -> list[dict]:  # pragma: no cover
        return []

    async def set_timeslot(self, session_id: str, booking_date: str, booking_time: str) -> dict:  # pragma: no cover
        return {"status": "ok"}

    async def set_contact_info(self, session_id: str, **kwargs):  # pragma: no cover
        return {"status": "success"}

    async def validate_address(self, postcode: str) -> dict:  # pragma: no cover
        return {"street": "High Street", "city": "Leeds"}


def _vehicle_specialist(state: CallState) -> VehicleSpecialist:
    monitor = ErrorMonitor(ErrorMonitorConfig(), logger=logging.getLogger("test-monitor"))
    return VehicleSpecialist(
        state=state,
        gh=DummyGH(),
        room_name="test-room",
        logger=logging.getLogger("test-vehicle"),
        error_monitor=monitor,
    )


class UtilsTestCase(unittest.TestCase):
    def test_vrn_normalization(self) -> None:
        self.assertEqual(normalize_vehicle_registration("V two zero ala"), "V20ALA")
        self.assertEqual(normalize_vehicle_registration("alpha bravo 12"), "AB12")

    def test_service_fuzzy_match(self) -> None:
        services = [
            {"name": "Full Service", "service_price_id": 1},
            {"name": "MOT", "service_price_id": 2},
        ]
        match = match_service("full service please", services)
        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match["service_price_id"], 1)


class SpecialistBehaviourTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_partial_vrn_combine(self) -> None:
        state = CallState()
        state.step = Step.NEED_VRN
        state.customer_name_first = "Alex"
        specialist = _vehicle_specialist(state)

        partial = await specialist.lookup_vehicle(reg="vee")
        payload = json.loads(partial)
        self.assertEqual(payload["status"], "needs_input")
        self.assertEqual(state.vrn_partial, "V")

        response = await specialist.lookup_vehicle(reg="two zero ala")
        payload = json.loads(response)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(state.session_id, "sess-test")
        self.assertEqual(state.step, Step.CONFIRMING_VEHICLE)

    async def test_tool_order_guardrail(self) -> None:
        state = CallState()
        specialist = _vehicle_specialist(state)
        result = await specialist.lookup_vehicle(reg="V20ALA")
        self.assertIn("BLOCKED", result)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
