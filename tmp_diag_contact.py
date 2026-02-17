import asyncio
import importlib.util
import json
import os
from pathlib import Path

from livekit.agents import AgentSession
from livekit.plugins import openai as lk_openai

AGENT_PATH = os.environ.get("RECEPTION_AGENT_MODULE", "/Users/dan/Downloads/multi_agent_receptionmatenew.py")
path = Path(AGENT_PATH).expanduser().resolve()
if not path.exists():
    raise SystemExit(f"Agent path not found: {path}")

spec = importlib.util.spec_from_file_location("receptionmate_agent", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

state = {
    "registrations": [],
    "services": [],
    "timeslots": [],
    "contact_payload": None,
}


async def fake_gh_initiate_booking(context, reg: str):
    state["registrations"].append(reg)
    return {
        "session_id": "sess-test-123",
        "booking": {
            "vehicle": {
                "make_name": "Land Rover",
                "model_name": "Range Rover Evoque",
            }
        },
        "SPEAK_NOW": "I've got a Land Rover Range Rover Evoque on that reg. Is that right?",
    }


async def fake_get_services(session_id: str):
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


async def fake_gh_set_service(context, session_id: str, service_price_ids):
    state["services"].append({"session_id": session_id, "ids": service_price_ids})
    return {"status": "success"}


async def fake_list_timeslots(session_id: str):
    return {
        "timeslots": {
            "2026-02-18": ["08:30", "14:00"],
            "2026-02-19": ["09:00"],
        }
    }


async def fake_gh_set_timeslot(context, session_id: str, booking_date: str, booking_time: str):
    state["timeslots"].append(
        {
            "session_id": session_id,
            "booking_date": booking_date,
            "booking_time": booking_time,
        }
    )
    return {"status": "success"}


async def fake_validate_address(context, house_name_or_number: str, postcode: str):
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
):
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


module.gh_initiate_booking._func = fake_gh_initiate_booking
module._gh_get_services_request = fake_get_services
module.gh_set_service._func = fake_gh_set_service
module._gh_list_timeslots_request = fake_list_timeslots
module.gh_set_timeslot._func = fake_gh_set_timeslot
module.validate_customer_address._func = fake_validate_address
module.gh_set_contact_info._func = fake_gh_set_contact_info


async def main():
    model = os.getenv("LIVEKIT_TEST_MODEL", "gpt-4o-mini")
    agent = module.GreetingAgent()
    userdata = module.UserData()
    prompts = [
        "Hi, it's Jamie Collins. I need to bring my Evoque in — there's a knocking noise over bumps, the reg is V20ALA.",
        "Registration is V20ALA.",
        "Yes, that's my car.",
        "It happens when I turn left over rough roads and it's getting worse — can you book it in to investigate?",
        "Next Wednesday the 18th at half eight would be great.",
        "My number is 07700 900123.",
        "Email is jamie@example.com.",
        "Yes, that's correct.",
        "Postcode is SW1A 1AA.",
        "Yes, that's right.",
        "House number 62.",
        "Yes, that's right.",
        "No, that's everything. Thanks.",
    ]
    async with lk_openai.responses.LLM(model=model, temperature=0) as client:
        async with AgentSession(llm=client) as session:
            agent.prime_context(session, userdata)
            await session.start(agent=agent)
            for text in prompts:
                await session.run(user_input=text)

    # Manually invoke the contact tool with the collected userdata snapshot
    await fake_gh_set_contact_info(
        None,
        userdata.session_id,
        userdata.customer_name_first,
        userdata.customer_name_last,
        userdata.contact_email,
        userdata.contact_phone,
        userdata.street or userdata.full_address,
        userdata.city or "",
        userdata.postcode,
        notes=userdata.notes,
    )

    print(json.dumps(
        {
            "contact_payload": state["contact_payload"],
            "fault_detail_text": userdata.fault_detail_text,
            "notes": userdata.notes,
        },
        indent=2,
    ))


if __name__ == "__main__":
    asyncio.run(main())
