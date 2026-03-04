"""Behavioral regression tests for the ReceptionMate LiveKit agent.

These tests follow the LiveKit Agents testing guide:
https://docs.livekit.io/agents/start/testing/
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from livekit.agents import AgentSession
from livekit.plugins import openai as lk_openai

AGENT_PATH_ENV = "RECEPTION_AGENT_MODULE"
MODEL_ENV = "LIVEKIT_TEST_MODEL"
DEFAULT_MODEL = "gpt-4o-mini"


def _load_agent_module() -> tuple[Any, Path]:
    module_path = os.getenv(AGENT_PATH_ENV)
    if not module_path:
        pytest.skip(
            f"Set {AGENT_PATH_ENV} to the path of multi_agent_receptionmatenew.py to run agent tests",
            allow_module_level=True,
        )

    candidate = Path(module_path).expanduser().resolve()
    if not candidate.exists():
        pytest.skip(
            f"Unable to import agent module; {candidate} does not exist",
            allow_module_level=True,
        )

    spec = importlib.util.spec_from_file_location("multi_agent_reception", candidate)
    if spec is None or spec.loader is None:
        pytest.skip(
            f"Failed to create import spec for {candidate}",
            allow_module_level=True,
        )

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, candidate


AGENT_MODULE, AGENT_SOURCE = _load_agent_module()
GreetingAgent = getattr(AGENT_MODULE, "GreetingAgent")
InitBookingAgent = getattr(AGENT_MODULE, "InitBookingAgent")
GetServicesAgent = getattr(AGENT_MODULE, "GetServicesAgent")
ListTimeslotsAgent = getattr(AGENT_MODULE, "ListTimeslotsAgent")
ConfirmationAgent = getattr(AGENT_MODULE, "ConfirmationAgent")
MessageAgent = getattr(AGENT_MODULE, "MessageAgent")
UserData = getattr(AGENT_MODULE, "UserData")
AGENT_LOGGER_NAME = getattr(getattr(AGENT_MODULE, "logger", None), "name", "multi-agent-reception")

CLOSING_PHRASES = (
    "take care",
    "all set",
    "all sorted",
    "all done",
    "that's booked",
    "thats booked",
    "goodbye",
    "bye",
    "cheers",
    "have a lovely day",
    "speak soon",
)


def _decode_call_arguments(call_event: Any) -> dict[str, Any]:
    raw_args = call_event.event().item.arguments or {}
    if isinstance(raw_args, str):
        try:
            return json.loads(raw_args)
        except json.JSONDecodeError:
            return {}
    return raw_args


def _message_text(event: Any) -> str:
    payload = event.event().item
    if isinstance(payload, dict):
        content = payload.get("content") or []
        if isinstance(content, list):
            return " ".join(str(part) for part in content)
        return str(content)
    text = getattr(payload, "text_content", None)
    if text:
        return text
    content = getattr(payload, "content", None)
    if isinstance(content, list):
        return " ".join(str(part) for part in content)
    return str(content or "")


def _assert_no_closing_phrases(log_records: list[logging.LogRecord], context: str) -> None:
    speech_lines: list[str] = []
    for record in log_records:
        message = record.getMessage()
        if "[AGENT_SPEECH" not in message:
            continue
        speech_lines.append(message.lower())
    for phrase in CLOSING_PHRASES:
        assert all(phrase not in line for line in speech_lines), (
            f"Found closing phrase '{phrase}' during {context}: {speech_lines}"
        )


def _expect_function_call_with_preamble(
    result,
    target_name: str,
    allowed_preamble: tuple[str, ...] = (),
    allow_missing: bool = False,
    allowed_handoff: type[Any] | None = None,
):
    """Advance through assistant events until the named function call appears."""

    allowed = set(allowed_preamble)
    while True:
        try:
            next_event = result.expect.next_event()
        except AssertionError:
            if allow_missing:
                return None
            raise
        event_type = next_event.event().type
        if event_type == "function_call":
            item = next_event.event().item
            func_name = item["name"] if isinstance(item, dict) else getattr(item, "name", None)
            if func_name == target_name:
                return next_event.is_function_call(name=target_name)
            if func_name in allowed:
                next_event.is_function_call(name=func_name)
                result.expect.next_event().is_function_call_output()
                continue
            raise AssertionError(f"Unexpected function call '{func_name}' while waiting for {target_name}")
        if event_type == "function_call_output":
            continue
        if event_type == "message":
            continue
        if event_type == "agent_handoff" and allowed_handoff is not None:
            next_event.is_agent_handoff(new_agent_type=allowed_handoff)
            continue
        raise AssertionError(f"Unexpected event '{event_type}' while waiting for {target_name}")


@pytest_asyncio.fixture()
async def llm_client():
    """Share a single OpenAI responses client across tests."""
    if not os.getenv("OPENAI_API_KEY"):
        pytest.skip("OPENAI_API_KEY is required to run agent evaluations", allow_module_level=True)

    model = os.getenv(MODEL_ENV, DEFAULT_MODEL)
    async with lk_openai.responses.LLM(model=model, temperature=0) as client:
        yield client


@pytest.fixture(autouse=True)
def stubbed_garagehive(monkeypatch):
    """Replace GarageHive HTTP calls with deterministic fakes for local testing."""
    state: dict[str, Any] = {
        "registrations": [],
        "services": [],
        "timeslots": [],
        "contact_payload": None,
        "get_services_called": 0,
    }

    async def fake_gh_initiate_booking(context, reg: str) -> dict[str, Any]:
        state["registrations"].append(reg)
        session_id = "sess-test-123"
        return {
            "session_id": session_id,
            "booking": {
                "vehicle": {
                    "make_name": "Land Rover",
                    "model_name": "Range Rover Evoque",
                }
            },
            "SPEAK_NOW": "I've got a Land Rover Range Rover Evoque on that reg. Is that right?",
        }

    async def fake_get_services(session_id: str) -> dict[str, Any]:
        state["get_services_called"] += 1
        return {
            "services": [
                {
                    "service_price_id": "101",
                    "name": "Full Service",
                    "price": "210.00",
                    "currency_code": "GBP",
                    "description": "Annual full service",
                },
                {
                    "service_price_id": "OTHER",
                    "name": "Other investigation",
                    "price": "95.00",
                    "currency_code": "GBP",
                    "description": "Diagnostic time to trace noises",
                },
            ]
        }

    async def fake_gh_set_service(context, session_id: str, service_price_ids: str | list[str]):
        state["services"].append({"session_id": session_id, "ids": service_price_ids})
        return {"status": "success"}

    async def fake_list_timeslots(session_id: str) -> dict[str, Any]:
        return {
            "timeslots": {
                "2026-02-18": ["08:30", "14:00"],
                "2026-02-19": ["09:00"],
            }
        }

    async def fake_gh_set_timeslot(context, session_id: str, booking_date: str, booking_time: str):
        state["timeslots"].append({
            "session_id": session_id,
            "booking_date": booking_date,
            "booking_time": booking_time,
        })
        return {"status": "success"}

    async def fake_validate_address(context, house_name_or_number: str, postcode: str) -> dict[str, Any]:
        return {
            "status": "success",
            "house_name_or_number": house_name_or_number,
            "street": "62 High Street",
            "city": "London",
            "postcode": postcode,
            "full_address": f"{house_name_or_number} High Street, London, {postcode}",
        }

    async def fake_gh_set_contact_info(
        context,
        session_id: str,
        contact_name: str,
        contact_last_name: str,
        contact_email: str,
        contact_number: str,
        contact_address: str,
        contact_city: str,
        contact_postcode: str,
        notes: str = "",
    ) -> dict[str, Any]:
        state["contact_payload"] = {
            "session_id": session_id,
            "contact_name": contact_name,
            "contact_last_name": contact_last_name,
            "contact_email": contact_email,
            "contact_number": contact_number,
            "contact_address": contact_address,
            "contact_city": contact_city,
            "contact_postcode": contact_postcode,
            "notes": notes,
        }
        return {"status": "success"}

    monkeypatch.setattr(AGENT_MODULE.gh_initiate_booking, "_func", fake_gh_initiate_booking)
    monkeypatch.setattr(AGENT_MODULE, "_gh_get_services_request", fake_get_services)
    monkeypatch.setattr(AGENT_MODULE.gh_set_service, "_func", fake_gh_set_service)
    monkeypatch.setattr(AGENT_MODULE, "_gh_list_timeslots_request", fake_list_timeslots)
    monkeypatch.setattr(AGENT_MODULE.gh_set_timeslot, "_func", fake_gh_set_timeslot)
    monkeypatch.setattr(AGENT_MODULE.validate_customer_address, "_func", fake_validate_address)
    monkeypatch.setattr(AGENT_MODULE.gh_set_contact_info, "_func", fake_gh_set_contact_info)

    return state


@pytest.mark.asyncio
async def test_greeting_routes_quote_requests(llm_client):
    """Quote enquiries must route straight to InitBookingAgent with the correct intent."""

    agent = GreetingAgent()
    userdata = UserData()

    async with AgentSession(llm=llm_client) as session:
        agent.prime_context(session, userdata)
        await session.start(agent=agent)

        user_input = (
            "Hey, it's Jamie calling. I'm just after a price quote for front brake pads on my Evoque. "
            "Could you give me the cost?"
        )
        result = await session.run(user_input=user_input)

        persist_call = result.expect.next_event().is_function_call(name="persist_caller_name")
        raw_args = persist_call.event().item.arguments or {}
        if isinstance(raw_args, str):
            try:
                call_args = json.loads(raw_args)
            except json.JSONDecodeError:
                call_args = {}
        else:
            call_args = raw_args
        assert (call_args.get("handoff") or "").lower() in {"quote", "auto", ""}, "handoff argument should reflect the intent"

        result.expect.next_event().is_function_call_output()
        result.expect.next_event().is_agent_handoff(new_agent_type=InitBookingAgent)
        # InitBookingAgent speaks immediately on enter; allow that scripted line
        result.expect.skip_next_event_if(type="message", role="assistant")
        result.expect.no_more_events()

        assert (userdata.intent or "").lower() == "quote", "UserData.intent should persist the quote flag"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "caller_name, quote_prompt, reg, service_prompt, slot_request",
    [
        (
            "Dylan Moore",
            "Hey, it's Dylan Moore. I'm just after a price for a full service on my Evoque.",
            "K20EVO",
            "That sounds fine, please go ahead and book the full service.",
            "Next Wednesday the 18th at half eight works great.",
        ),
        (
            "Sophie Green",
            "Hello, I'm Sophie Green calling for a quote on a full service for my Range Rover Evoque.",
            "R44LRR",
            "Great, please get it booked in for the full service option.",
            "Could you do Thursday the 19th at 9 in the morning?",
        ),
    ],
    ids=["quote-to-booking-dylan", "quote-to-booking-sophie"],
)
async def test_quote_request_flows_can_progress_to_booking(
    llm_client,
    stubbed_garagehive,
    caller_name,
    quote_prompt,
    reg,
    service_prompt,
    slot_request,
):
    """Quote callers who commit should complete the standard booking pipeline."""

    agent = GreetingAgent()
    userdata = UserData()

    def _engage_list_timeslots(result, allowed_replays: tuple[str, ...] = ()) -> bool:
        while True:
            try:
                next_event = result.expect.next_event()
            except AssertionError:
                return False
            event_type = next_event.event().type
            if event_type == "message":
                continue
            if event_type == "function_call":
                item = next_event.event().item
                func_name = item["name"] if isinstance(item, dict) else getattr(item, "name", None)
                if func_name in allowed_replays:
                    next_event.is_function_call(name=func_name)
                    result.expect.next_event().is_function_call_output()
                    continue
                if func_name == "route_to_list_timeslots":
                    next_event.is_function_call(name="route_to_list_timeslots")
                    result.expect.next_event().is_function_call_output()
                    continue
                raise AssertionError(
                    f"Unexpected function call '{func_name}' while waiting for ListTimeslotsAgent handoff"
                )
            if event_type == "agent_handoff":
                next_event.is_agent_handoff(new_agent_type=ListTimeslotsAgent)
                return True
            raise AssertionError(
                f"Unexpected event '{event_type}' while waiting for ListTimeslotsAgent handoff"
            )

    async with AgentSession(llm=llm_client) as session:
        agent.prime_context(session, userdata)
        await session.start(agent=agent)

        quote_stage = await session.run(user_input=quote_prompt)
        persist_call = quote_stage.expect.next_event().is_function_call(name="persist_caller_name")
        persist_args = _decode_call_arguments(persist_call)
        assert persist_args.get("first_name") == caller_name.split()[0]
        quote_stage.expect.next_event().is_function_call_output()
        quote_stage.expect.next_event().is_agent_handoff(new_agent_type=InitBookingAgent)
        quote_stage.expect.skip_next_event_if(type="message", role="assistant")
        quote_stage.expect.no_more_events()
        assert (userdata.intent or "").lower() == "quote", "Intent should reflect the quote request before booking"

        vrn_run = await session.run(user_input=f"Sure, the registration is {reg}.")
        init_call = vrn_run.expect.next_event().is_function_call(name="gh_initiate_booking")
        init_args = _decode_call_arguments(init_call)
        assert reg in (init_args.get("reg") or "")
        vrn_run.expect.next_event().is_function_call_output()
        vrn_run.expect.skip_next_event_if(type="message", role="assistant")
        vrn_run.expect.no_more_events()

        confirm_vehicle = await session.run(user_input="Yes, that's my car.")
        persist_booking = _expect_function_call_with_preamble(
            confirm_vehicle,
            target_name="persist_booking_data",
            allowed_preamble=("persist_caller_name",),
            allow_missing=True,
        )
        if persist_booking is None:
            confirm_vehicle = await session.run(user_input=f"Yes, {caller_name} is correct.")
            persist_booking = _expect_function_call_with_preamble(
                confirm_vehicle,
                target_name="persist_booking_data",
                allowed_preamble=("persist_caller_name",),
            )
        confirm_vehicle.expect.next_event().is_function_call_output()
        next_transition = confirm_vehicle.expect.next_event()
        if next_transition.event().type == "function_call":
            next_transition.is_function_call(name="route_to_get_services")
            confirm_vehicle.expect.next_event().is_function_call_output()
            next_transition = confirm_vehicle.expect.next_event()
        next_transition.is_agent_handoff(new_agent_type=GetServicesAgent)
        while True:
            try:
                residue = confirm_vehicle.expect.next_event()
            except AssertionError:
                break
            event_type = residue.event().type
            if event_type == "agent_handoff":
                residue.is_agent_handoff(new_agent_type=GetServicesAgent)
                continue
            if event_type == "message":
                continue
            raise AssertionError(f"Unexpected event '{event_type}' after GetServices handoff")
        confirm_vehicle.expect.no_more_events()

        service_run = await session.run(user_input=service_prompt)
        set_service = service_run.expect.next_event().is_function_call(name="gh_set_service")
        service_args = _decode_call_arguments(set_service)
        assert service_args.get("service_price_ids"), "Service selection must persist"
        service_run.expect.next_event().is_function_call_output()
        service_run.expect.next_event().is_function_call(name="persist_service_data")
        service_run.expect.next_event().is_function_call_output()
        list_timeslots_source: Any | None = None
        if _engage_list_timeslots(service_run, allowed_replays=("gh_set_service", "persist_service_data")):
            list_timeslots_source = service_run
        else:
            proceed_prompts = [
                "Yes please, go ahead and find me an appointment.",
                "Yes, go ahead and book it in now.",
            ]
            for proceed_prompt in proceed_prompts:
                candidate_run = await session.run(user_input=proceed_prompt)
                if _engage_list_timeslots(
                    candidate_run, allowed_replays=("gh_set_service", "persist_service_data")
                ):
                    list_timeslots_source = candidate_run
                    break

        if list_timeslots_source is not None:
            list_timeslots_source.expect.skip_next_event_if(type="message", role="assistant")
            list_timeslots_source.expect.skip_next_event_if(type="agent_handoff")
            list_timeslots_source.expect.skip_next_event_if(type="message", role="assistant")
            list_timeslots_source.expect.no_more_events()

        slot_result = await session.run(user_input=slot_request)
        set_slot = _expect_function_call_with_preamble(
            slot_result,
            target_name="gh_set_timeslot",
            allowed_preamble=(
                "route_to_list_timeslots",
                "gh_set_service",
                "persist_service_data",
                "gh_list_timeslots",
                "get_current_datetime",
                "get_timezone_offset",
            ),
            allow_missing=True,
            allowed_handoff=ListTimeslotsAgent,
        )
        if set_slot is None:
            slot_result = await session.run(user_input=slot_request)
            set_slot = _expect_function_call_with_preamble(
                slot_result,
                target_name="gh_set_timeslot",
                allowed_preamble=(
                    "route_to_list_timeslots",
                    "gh_set_service",
                    "persist_service_data",
                    "gh_list_timeslots",
                    "get_current_datetime",
                    "get_timezone_offset",
                ),
                allowed_handoff=ListTimeslotsAgent,
                allow_missing=True,
            )
        if set_slot is None:
            slot_result = await session.run(user_input="Yes, that slot works perfectly — please book it.")
            set_slot = _expect_function_call_with_preamble(
                slot_result,
                target_name="gh_set_timeslot",
                allowed_preamble=(
                    "route_to_list_timeslots",
                    "gh_set_service",
                    "persist_service_data",
                    "gh_list_timeslots",
                    "get_current_datetime",
                    "get_timezone_offset",
                ),
                allowed_handoff=ListTimeslotsAgent,
            )
        slot_args = _decode_call_arguments(set_slot)
        assert slot_args.get("booking_date") and slot_args.get("booking_time")
        slot_result.expect.next_event().is_function_call_output()
        slot_result.expect.next_event().is_function_call(name="persist_timeslot_data")
        slot_result.expect.next_event().is_function_call_output()
        next_transition = slot_result.expect.next_event()
        if next_transition.event().type == "function_call":
            next_transition.is_function_call(name="route_to_confirmation")
            slot_result.expect.next_event().is_function_call_output()
            slot_result.expect.next_event().is_agent_handoff(new_agent_type=ConfirmationAgent)
        else:
            next_transition.is_agent_handoff(new_agent_type=ConfirmationAgent)
        slot_result.expect.skip_next_event_if(type="message", role="assistant")
        slot_result.expect.skip_next_event_if(type="agent_handoff")
        slot_result.expect.skip_next_event_if(type="message", role="assistant")
        slot_result.expect.no_more_events()

        assert userdata.session_id == "sess-test-123"
        assert stubbed_garagehive["services"], "Service selection should hit GarageHive"
        assert stubbed_garagehive["timeslots"], "Timeslot booking should reach GarageHive"

@pytest.mark.asyncio
@pytest.mark.parametrize(
    "caller_name, reg, service_prompt, slot_request",
    [
        (
            "Alex Price",
            "V20ALA",
            "Could you book it for a full service, please?",
            "Next Wednesday the 18th at half eight in the morning would be perfect.",
        ),
        (
            "Jordan Miller",
            "L55EVO",
            "Let's go ahead with the full service option, please.",
            "Thursday the 19th around nine in the morning works for me.",
        ),
    ],
    ids=["full-service-alex", "full-service-jordan"],
)
async def test_full_booking_flow_reaches_confirmation(
    llm_client,
    stubbed_garagehive,
    caller_name,
    reg,
    service_prompt,
    slot_request,
):
    """Happy-path booking should progress through VRN, services, and timeslot selection."""

    agent = GreetingAgent()
    userdata = UserData()

    async with AgentSession(llm=llm_client) as session:
        agent.prime_context(session, userdata)
        await session.start(agent=agent)

        greeting = await session.run(
            user_input=(
                f"Morning, it's {caller_name}. I'd like to book my Evoque in for a full service next week. "
                f"The registration is {reg}."
            )
        )
        persist_call = greeting.expect.next_event().is_function_call(name="persist_caller_name")
        persist_args = _decode_call_arguments(persist_call)
        assert persist_args.get("first_name") == caller_name.split()[0]
        greeting.expect.next_event().is_function_call_output()
        greeting.expect.next_event().is_agent_handoff(new_agent_type=InitBookingAgent)
        greeting.expect.skip_next_event_if(type="message", role="assistant")
        greeting.expect.no_more_events()
        assert (userdata.intent or "").lower() == "new_booking"

        vrn_run = await session.run(user_input=f"Sure, it's {reg}.")
        init_call = vrn_run.expect.next_event().is_function_call(name="gh_initiate_booking")
        init_args = _decode_call_arguments(init_call)
        assert reg in (init_args.get("reg") or "")
        vrn_run.expect.next_event().is_function_call_output()
        vrn_run.expect.skip_next_event_if(type="message", role="assistant")
        vrn_run.expect.no_more_events()

        confirm_vehicle = await session.run(user_input="Yes, that's the right car.")
        confirm_vehicle.expect.skip_next_event_if(type="message", role="assistant")
        confirm_vehicle.expect.next_event().is_function_call(name="persist_booking_data")
        confirm_vehicle.expect.next_event().is_function_call_output()
        confirm_vehicle.expect.next_event().is_agent_handoff(new_agent_type=GetServicesAgent)
        confirm_vehicle.expect.skip_next_event_if(type="message", role="assistant")
        confirm_vehicle.expect.no_more_events()

        service_run = await session.run(user_input=service_prompt)
        set_service = service_run.expect.next_event().is_function_call(name="gh_set_service")
        service_args = _decode_call_arguments(set_service)
        service_ids = service_args.get("service_price_ids")
        if isinstance(service_ids, list):
            assert service_ids, "service selection returned empty id list"
        else:
            assert service_ids, "service selection must include an id"
        service_run.expect.next_event().is_function_call_output()
        service_run.expect.next_event().is_function_call(name="persist_service_data")
        service_run.expect.next_event().is_function_call_output()
        next_event = service_run.expect.next_event()
        if next_event.event().type == "function_call":
            next_event.is_function_call(name="route_to_list_timeslots")
            service_run.expect.next_event().is_function_call_output()
            service_run.expect.next_event().is_agent_handoff(new_agent_type=ListTimeslotsAgent)
        else:
            next_event.is_agent_handoff(new_agent_type=ListTimeslotsAgent)
        service_run.expect.skip_next_event_if(type="message", role="assistant")
        service_run.expect.skip_next_event_if(type="agent_handoff", new_agent_type=ListTimeslotsAgent)
        service_run.expect.skip_next_event_if(type="message", role="assistant")
        service_run.expect.skip_next_event_if(type="agent_handoff")
        service_run.expect.skip_next_event_if(type="message", role="assistant")
        service_run.expect.no_more_events()

        assert "service" in (userdata.service_selected_name or "").lower()
        assert stubbed_garagehive["get_services_called"] >= 1, "GetServices must be called for bookings"

        slot_result = await session.run(user_input=slot_request)
        set_slot = _expect_function_call_with_preamble(
            slot_result,
            target_name="gh_set_timeslot",
            allowed_preamble=("gh_list_timeslots", "get_current_datetime"),
            allow_missing=True,
        )
        if set_slot is None:
            slot_result = await session.run(user_input=slot_request)
            set_slot = _expect_function_call_with_preamble(
                slot_result,
                target_name="gh_set_timeslot",
                allowed_preamble=("gh_list_timeslots", "get_current_datetime"),
            )
        slot_args = _decode_call_arguments(set_slot)
        assert slot_args.get("booking_date"), "booking date should be captured"
        assert slot_args.get("booking_time"), "booking time should be captured"
        slot_result.expect.next_event().is_function_call_output()
        slot_result.expect.next_event().is_function_call(name="persist_timeslot_data")
        slot_result.expect.next_event().is_function_call_output()
        next_transition = slot_result.expect.next_event()
        if next_transition.event().type == "function_call":
            next_transition.is_function_call(name="route_to_confirmation")
            slot_result.expect.next_event().is_function_call_output()
            slot_result.expect.next_event().is_agent_handoff(new_agent_type=ConfirmationAgent)
        else:
            next_transition.is_agent_handoff(new_agent_type=ConfirmationAgent)
        slot_result.expect.skip_next_event_if(type="message", role="assistant")
        slot_result.expect.skip_next_event_if(type="agent_handoff")
        slot_result.expect.skip_next_event_if(type="message", role="assistant")
        slot_result.expect.no_more_events()

        assert userdata.session_id == "sess-test-123"
        assert userdata.booking_date == slot_args.get("booking_date")
        assert userdata.booking_time == slot_args.get("booking_time")
        assert not stubbed_garagehive["contact_payload"] or "notes" in stubbed_garagehive["contact_payload"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "caller_name, reg, intro_detail, detail_prompt, fault_keywords, note_expectations",
    [
        (
            "Jamie Collins",
            "V20ALA",
            "there's a knocking noise over bumps",
            "It's a dull knocking noise from the front left. It mostly happens when I turn left over bumps,"
            " basically every drive for the last two weeks. No warning lights on the dash, and it's gradually"
            " getting worse, so please book it in to investigate.",
            ("knocking noise", "knocking"),
            {
                "description": ("knocking noise", "front left"),
                "when": ("turn left", "over bumps"),
                "frequency": ("every drive", "each drive"),
                "warning_lights": ("no warning lights", "no dash lights"),
                "duration": ("two weeks", "couple of weeks"),
            },
        ),
        (
            "Chris Nolan",
            "P90RVR",
            "it's making a metallic clunk whenever I go over speed bumps",
            "It's a metallic clunk from the rear right corner. It happens on almost every commute whenever"
            " I drive over speed bumps, and it's been doing that for about three weeks now. No warning lights"
            " have appeared, but it's getting progressively worse so I'd like it investigated.",
            ("clunk", "metallic"),
            {
                "description": ("metallic clunk", "rear right"),
                "when": ("speed bump", "over speed"),
                "frequency": ("every commute", "almost every commute"),
                "warning_lights": ("no warning lights", "no lights"),
                "duration": ("three weeks", "3 weeks"),
            },
        ),
    ],
    ids=["knocking-jamie", "clunk-chris"],
)
async def test_knocking_noise_requests_extra_detail(
    llm_client,
    stubbed_garagehive,
    caller_name,
    reg,
    intro_detail,
    detail_prompt,
    fault_keywords,
    note_expectations,
):
    """Diagnostic bookings must proactively ask for noise specifics."""

    agent = GreetingAgent()
    userdata = UserData()

    async with AgentSession(llm=llm_client) as session:
        agent.prime_context(session, userdata)
        await session.start(agent=agent)

        greeting = await session.run(
            user_input=(
                f"Hi, it's {caller_name}. I need to bring my Evoque in — {intro_detail}, the reg is {reg}."
            )
        )
        greeting.expect.next_event().is_function_call(name="persist_caller_name")
        greeting.expect.next_event().is_function_call_output()
        greeting.expect.next_event().is_agent_handoff(new_agent_type=InitBookingAgent)
        greeting.expect.skip_next_event_if(type="message", role="assistant")
        greeting.expect.no_more_events()

        await session.run(user_input=f"Registration is {reg}.")

        confirm_vehicle = await session.run(user_input="Yes, that's my car.")
        persist_booking = _expect_function_call_with_preamble(
            confirm_vehicle,
            target_name="persist_booking_data",
            allowed_preamble=("persist_caller_name",),
            allow_missing=True,
        )
        if persist_booking is None:
            confirm_vehicle = await session.run(user_input=f"Yes, {caller_name} is correct.")
            persist_booking = _expect_function_call_with_preamble(
                confirm_vehicle,
                target_name="persist_booking_data",
                allowed_preamble=("persist_caller_name",),
            )
        confirm_vehicle.expect.next_event().is_function_call_output()
        next_transition = confirm_vehicle.expect.next_event()
        if next_transition.event().type == "function_call":
            next_transition.is_function_call(name="route_to_get_services")
            confirm_vehicle.expect.next_event().is_function_call_output()
            next_transition = confirm_vehicle.expect.next_event()
        next_transition.is_agent_handoff(new_agent_type=GetServicesAgent)
        probe_text = ""
        probe_found = False
        probe_keywords = ("noise", "knock", "clunk", "when", "where", "how often", "happen")
        for _ in range(5):
            try:
                message_event = confirm_vehicle.expect.next_event(type="message")
            except AssertionError:
                break
            probe_text = _message_text(message_event).lower()
            keyword_hits = sum(1 for keyword in probe_keywords if keyword in probe_text)
            if keyword_hits >= 2:
                probe_found = True
                break
        assert probe_found, f"diagnostic prompt missing details; last assistant line: '{probe_text}'"
        confirm_vehicle.expect.no_more_events()

        details_run = await session.run(user_input=detail_prompt)
        details_run.expect.next_event().is_function_call(name="gh_set_service")
        details_run.expect.next_event().is_function_call_output()
        details_run.expect.next_event().is_function_call(name="persist_service_data")
        details_run.expect.next_event().is_function_call_output()
        next_step = details_run.expect.next_event()
        if next_step.event().type == "function_call":
            next_step.is_function_call(name="route_to_list_timeslots")
            details_run.expect.next_event().is_function_call_output()
            details_run.expect.next_event().is_agent_handoff(new_agent_type=ListTimeslotsAgent)
        else:
            next_step.is_agent_handoff(new_agent_type=ListTimeslotsAgent)
        details_run.expect.skip_next_event_if(type="message", role="assistant")
        details_run.expect.skip_next_event_if(type="agent_handoff")
        details_run.expect.skip_next_event_if(type="message", role="assistant")
        details_run.expect.no_more_events()

        assert stubbed_garagehive["get_services_called"] >= 1
        assert stubbed_garagehive["services"], "gh_set_service should persist the selection"

        def _normalize_ids(raw_ids):
            if isinstance(raw_ids, list):
                return [str(val).upper() for val in raw_ids]
            return [str(raw_ids).upper()]

        assert any(
            "OTHER" in _normalize_ids(entry["ids"]) for entry in stubbed_garagehive["services"]
        )
        lower_detail = (userdata.fault_detail_text or "").lower()
        notes_lower = (userdata.notes or "").lower()
        assert (userdata.service_selected_name or "").lower().startswith("other")
        assert any(keyword in lower_detail for keyword in fault_keywords), "fault detail text should capture caller description"
        for field, options in note_expectations.items():
            assert any(option in notes_lower for option in options), f"notes missing {field} detail"


@pytest.mark.asyncio
async def test_greeting_handoff_has_no_closing_phrases(llm_client, caplog):
    """Greeting agent must keep the call live until InitBooking takes over."""

    agent = GreetingAgent()
    userdata = UserData()

    with caplog.at_level(logging.INFO, logger=AGENT_LOGGER_NAME):
        async with AgentSession(llm=llm_client) as session:
            agent.prime_context(session, userdata)
            await session.start(agent=agent)

            start_idx = len(caplog.records)
            greeting = await session.run(
                user_input=(
                    "Hi, it's Alex Price. I'd like to book my Evoque in for a full service next week; the reg is V20ALA."
                )
            )
            greeting.expect.next_event().is_function_call(name="persist_caller_name")
            greeting.expect.next_event().is_function_call_output()
            greeting.expect.next_event().is_agent_handoff(new_agent_type=InitBookingAgent)
            greeting.expect.skip_next_event_if(type="message", role="assistant")
            greeting.expect.no_more_events()

    _assert_no_closing_phrases(caplog.records[start_idx:], "Greeting handoff to InitBooking")


@pytest.mark.asyncio
async def test_init_booking_handoff_has_no_closing_phrases(llm_client, caplog):
    """InitBooking must not wrap up the call before routing to GetServices."""

    agent = GreetingAgent()
    userdata = UserData()

    with caplog.at_level(logging.INFO, logger=AGENT_LOGGER_NAME):
        async with AgentSession(llm=llm_client) as session:
            agent.prime_context(session, userdata)
            await session.start(agent=agent)

            greeting = await session.run(
                user_input=(
                    "Hi, it's Alex Price. I'd like to book my Evoque in for a full service next week; the reg is V20ALA."
                )
            )
            greeting.expect.next_event().is_function_call(name="persist_caller_name")
            greeting.expect.next_event().is_function_call_output()
            greeting.expect.next_event().is_agent_handoff(new_agent_type=InitBookingAgent)
            greeting.expect.skip_next_event_if(type="message", role="assistant")
            greeting.expect.no_more_events()

            vrn_run = await session.run(user_input="Registration is V20ALA.")
            vrn_run.expect.next_event().is_function_call(name="gh_initiate_booking")
            vrn_run.expect.next_event().is_function_call_output()
            vrn_run.expect.skip_next_event_if(type="message", role="assistant")
            vrn_run.expect.no_more_events()

            start_idx = len(caplog.records)
            confirm_vehicle = await session.run(user_input="Yes, that's my car.")
            persist_booking = _expect_function_call_with_preamble(
                confirm_vehicle,
                target_name="persist_booking_data",
                allowed_preamble=("persist_caller_name",),
                allow_missing=True,
            )
            if persist_booking is None:
                start_idx = len(caplog.records)
                confirm_vehicle = await session.run(user_input="Yes, Alex Price is correct.")
                persist_booking = _expect_function_call_with_preamble(
                    confirm_vehicle,
                    target_name="persist_booking_data",
                    allowed_preamble=("persist_caller_name",),
                )
            confirm_vehicle.expect.next_event().is_function_call_output()
            next_transition = confirm_vehicle.expect.next_event()
            if next_transition.event().type == "function_call":
                next_transition.is_function_call(name="route_to_get_services")
                confirm_vehicle.expect.next_event().is_function_call_output()
                next_transition = confirm_vehicle.expect.next_event()
            next_transition.is_agent_handoff(new_agent_type=GetServicesAgent)
            while True:
                try:
                    residue = confirm_vehicle.expect.next_event()
                except AssertionError:
                    break
                event_type = residue.event().type
                if event_type == "agent_handoff":
                    residue.is_agent_handoff(new_agent_type=GetServicesAgent)
                    continue
                if event_type == "message":
                    continue
                raise AssertionError(f"Unexpected event '{event_type}' after GetServices handoff")
            confirm_vehicle.expect.no_more_events()

    _assert_no_closing_phrases(caplog.records[start_idx:], "InitBooking handoff to GetServices")


@pytest.mark.asyncio
async def test_get_services_handoff_has_no_closing_phrases(llm_client, caplog):
    """GetServices must not say farewells when handing to ListTimeslots."""

    agent = GreetingAgent()
    userdata = UserData()

    with caplog.at_level(logging.INFO, logger=AGENT_LOGGER_NAME):
        async with AgentSession(llm=llm_client) as session:
            agent.prime_context(session, userdata)
            await session.start(agent=agent)

            greeting = await session.run(
                user_input=(
                    "Hi, it's Alex Price. I'd like to book my Evoque in for a full service next week; the reg is V20ALA."
                )
            )
            greeting.expect.next_event().is_function_call(name="persist_caller_name")
            greeting.expect.next_event().is_function_call_output()
            greeting.expect.next_event().is_agent_handoff(new_agent_type=InitBookingAgent)
            greeting.expect.skip_next_event_if(type="message", role="assistant")
            greeting.expect.no_more_events()

            await session.run(user_input="Registration is V20ALA.")

            confirm_vehicle = await session.run(user_input="Yes, that's my car.")
            persist_booking = _expect_function_call_with_preamble(
                confirm_vehicle,
                target_name="persist_booking_data",
                allowed_preamble=("persist_caller_name",),
                allow_missing=True,
            )
            if persist_booking is None:
                confirm_vehicle = await session.run(user_input="Yes, Alex Price is correct.")
                persist_booking = _expect_function_call_with_preamble(
                    confirm_vehicle,
                    target_name="persist_booking_data",
                    allowed_preamble=("persist_caller_name",),
                )
            confirm_vehicle.expect.next_event().is_function_call_output()
            next_transition = confirm_vehicle.expect.next_event()
            if next_transition.event().type == "function_call":
                next_transition.is_function_call(name="route_to_get_services")
                confirm_vehicle.expect.next_event().is_function_call_output()
                next_transition = confirm_vehicle.expect.next_event()
            next_transition.is_agent_handoff(new_agent_type=GetServicesAgent)
            while True:
                try:
                    residue = confirm_vehicle.expect.next_event()
                except AssertionError:
                    break
                event_type = residue.event().type
                if event_type == "agent_handoff":
                    residue.is_agent_handoff(new_agent_type=GetServicesAgent)
                    continue
                if event_type == "message":
                    continue
                raise AssertionError(f"Unexpected event '{event_type}' after GetServices handoff")
            confirm_vehicle.expect.no_more_events()

            start_idx = len(caplog.records)
            details_run = await session.run(
                user_input="Please pop me down for the full service option."
            )
            details_run.expect.next_event().is_function_call(name="gh_set_service")
            details_run.expect.next_event().is_function_call_output()
            details_run.expect.next_event().is_function_call(name="persist_service_data")
            details_run.expect.next_event().is_function_call_output()
            next_step = details_run.expect.next_event()
            if next_step.event().type == "function_call":
                next_step.is_function_call(name="route_to_list_timeslots")
                details_run.expect.next_event().is_function_call_output()
                details_run.expect.next_event().is_agent_handoff(new_agent_type=ListTimeslotsAgent)
            else:
                next_step.is_agent_handoff(new_agent_type=ListTimeslotsAgent)
            details_run.expect.skip_next_event_if(type="message", role="assistant")
            details_run.expect.skip_next_event_if(type="agent_handoff")
            details_run.expect.skip_next_event_if(type="message", role="assistant")
            details_run.expect.no_more_events()

    _assert_no_closing_phrases(caplog.records[start_idx:], "GetServices handoff")


@pytest.mark.asyncio
async def test_list_timeslots_handoff_has_no_closing_phrases(llm_client, caplog):
    """ListTimeslots must enter Confirmation silently without farewell phrases."""

    agent = GreetingAgent()
    userdata = UserData()

    with caplog.at_level(logging.INFO, logger=AGENT_LOGGER_NAME):
        async with AgentSession(llm=llm_client) as session:
            agent.prime_context(session, userdata)
            await session.start(agent=agent)

            greeting = await session.run(
                user_input=(
                    "Hi, it's Alex Price. I'd like to book my Evoque in for a full service next week; the reg is V20ALA."
                )
            )
            greeting.expect.next_event().is_function_call(name="persist_caller_name")
            greeting.expect.next_event().is_function_call_output()
            greeting.expect.next_event().is_agent_handoff(new_agent_type=InitBookingAgent)
            greeting.expect.skip_next_event_if(type="message", role="assistant")
            greeting.expect.no_more_events()

            await session.run(user_input="Registration is V20ALA.")

            confirm_vehicle = await session.run(user_input="Yes, that's my car.")
            confirm_vehicle.expect.skip_next_event_if(type="message", role="assistant")
            confirm_vehicle.expect.next_event().is_function_call(name="persist_booking_data")
            confirm_vehicle.expect.next_event().is_function_call_output()
            confirm_vehicle.expect.next_event().is_agent_handoff(new_agent_type=GetServicesAgent)
            confirm_vehicle.expect.skip_next_event_if(type="message", role="assistant")
            confirm_vehicle.expect.no_more_events()

            details_run = await session.run(
                user_input="Please book me in for the full service option."
            )
            details_run.expect.next_event().is_function_call(name="gh_set_service")
            details_run.expect.next_event().is_function_call_output()
            details_run.expect.next_event().is_function_call(name="persist_service_data")
            details_run.expect.next_event().is_function_call_output()
            next_step = details_run.expect.next_event()
            if next_step.event().type == "function_call":
                next_step.is_function_call(name="route_to_list_timeslots")
                details_run.expect.next_event().is_function_call_output()
                details_run.expect.next_event().is_agent_handoff(new_agent_type=ListTimeslotsAgent)
            else:
                next_step.is_agent_handoff(new_agent_type=ListTimeslotsAgent)
            details_run.expect.skip_next_event_if(type="message", role="assistant")
            details_run.expect.skip_next_event_if(type="agent_handoff")
            details_run.expect.skip_next_event_if(type="message", role="assistant")
            details_run.expect.no_more_events()

            start_idx = len(caplog.records)
            slot_result = await session.run(
                user_input="Next Wednesday the 18th at half eight would be great."
            )
            set_slot_event = _expect_function_call_with_preamble(
                slot_result,
                target_name="gh_set_timeslot",
                allowed_preamble=("gh_list_timeslots", "get_current_datetime"),
                allow_missing=True,
            )
            if set_slot_event is None:
                slot_result = await session.run(
                    user_input="Half eight that morning suits me perfectly."
                )
                set_slot_event = _expect_function_call_with_preamble(
                    slot_result,
                    target_name="gh_set_timeslot",
                    allowed_preamble=("gh_list_timeslots", "get_current_datetime"),
                )
            slot_result.expect.next_event().is_function_call_output()
            slot_result.expect.next_event().is_function_call(name="persist_timeslot_data")
            slot_result.expect.next_event().is_function_call_output()
            next_transition = slot_result.expect.next_event()
            if next_transition.event().type == "function_call":
                next_transition.is_function_call(name="route_to_confirmation")
                slot_result.expect.next_event().is_function_call_output()
                slot_result.expect.next_event().is_agent_handoff(new_agent_type=ConfirmationAgent)
            else:
                next_transition.is_agent_handoff(new_agent_type=ConfirmationAgent)
            slot_result.expect.skip_next_event_if(type="message", role="assistant")
            slot_result.expect.skip_next_event_if(type="agent_handoff")
            slot_result.expect.skip_next_event_if(type="message", role="assistant")
            slot_result.expect.no_more_events()

    _assert_no_closing_phrases(caplog.records[start_idx:], "ListTimeslots handoff")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "user_input",
    [
        "Hi, it's Sam Carter. You already have my car in today and I'm just looking for an update on how it's going.",
        "Hello, this is Priya Shah. You've got my Evoque in for diagnostics already—can you give me any news on it?",
    ],
    ids=["status-update-sam", "status-update-priya"],
)
async def test_status_update_call_routes_to_message_agent(llm_client, user_input):
    """Callers chasing an update should route to MessageAgent with intent set."""

    agent = GreetingAgent()
    userdata = UserData()

    async with AgentSession(llm=llm_client) as session:
        agent.prime_context(session, userdata)
        await session.start(agent=agent)

        result = await session.run(user_input=user_input)
        result.expect.next_event().is_function_call(name="persist_caller_name")
        result.expect.next_event().is_function_call_output()
        result.expect.next_event().is_agent_handoff(new_agent_type=MessageAgent)
        result.expect.skip_next_event_if(type="message", role="assistant")
        result.expect.no_more_events()

        assert (userdata.intent or "").lower() == "message"
