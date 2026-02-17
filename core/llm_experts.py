"""Silent LLM experts for disambiguation and decision-making.

These experts are NOT speaking agents. They only return JSON directives
for the supervisor agent to interpret and act upon.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from functools import lru_cache
from typing import Optional

from openai import AsyncOpenAI

logger = logging.getLogger("receptionmate.llm_experts")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SERVICE_EXPERT_MODEL = os.getenv("SERVICE_EXPERT_MODEL", "gpt-4o-mini")
SERVICE_EXPERT_TIMEOUT_MS = int(os.getenv("SERVICE_EXPERT_TIMEOUT_MS", "1500"))
SERVICE_EXPERT_CONFIDENCE_THRESHOLD = float(os.getenv("SERVICE_EXPERT_CONFIDENCE_THRESHOLD", "0.65"))
SERVICE_EXPERT_CACHE_SIZE = int(os.getenv("SERVICE_EXPERT_CACHE_SIZE", "128"))

# ---------------------------------------------------------------------------
# OpenAI Client
# ---------------------------------------------------------------------------

_openai_client: Optional[AsyncOpenAI] = None


def _get_openai_client() -> AsyncOpenAI:
    global _openai_client
    if _openai_client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not set; cannot use Service Expert")
        _openai_client = AsyncOpenAI(api_key=api_key)
    return _openai_client


# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------

_service_expert_cache: dict[str, dict] = {}


def _cache_key(caller_text: str, services: list[dict]) -> str:
    """Generate cache key from normalized caller text + hash of services."""
    normalized = caller_text.lower().strip()
    service_ids = sorted(str(s.get("service_price_id", "")) for s in services)
    services_hash = hashlib.sha256("".join(service_ids).encode()).hexdigest()[:16]
    return f"{normalized}::{services_hash}"


def _get_cached_result(key: str) -> Optional[dict]:
    return _service_expert_cache.get(key)


def _set_cached_result(key: str, result: dict) -> None:
    global _service_expert_cache
    if len(_service_expert_cache) >= SERVICE_EXPERT_CACHE_SIZE:
        # Simple LRU: drop oldest half
        keys_to_drop = list(_service_expert_cache.keys())[: SERVICE_EXPERT_CACHE_SIZE // 2]
        for k in keys_to_drop:
            _service_expert_cache.pop(k, None)
    _service_expert_cache[key] = result


# ---------------------------------------------------------------------------
# Service Expert System Prompt
# ---------------------------------------------------------------------------

SERVICE_EXPERT_SYSTEM_PROMPT = """
You are a SILENT work expert for a British vehicle workshop using GarageHive software.
Your job is to choose the BEST work type from the provided list when the caller's request is vague or ambiguous.

IMPORTANT TERMINOLOGY:
- "Service" specifically means scheduled maintenance (Full Service, Interim Service, Oil Service)
- Other work includes: MOT, Diagnostics, Repairs, Brake work, Tyre fitting, etc.
- Don't call everything a "service" - use "work" as the general term

DIAGNOSTIC SCENARIOS:
When the caller describes symptoms/problems (warning lights, noises, performance issues), you should:
1. Set service_price_id to "" (empty)
2. Set confidence to 0.3 or lower
3. Set clarifying_question to "DIAGNOSTIC_INTAKE" (special flag)
4. Set reason to describe the symptom briefly

This triggers a diagnostic questionnaire to gather structured fault information before selecting work type.

RULES:
1. You must return ONLY valid JSON. No markdown, no explanations outside the JSON.
2. The JSON schema is:
   {
     "service_price_id": "<id from list or empty string>",
     "service_name": "<exact name from list or empty string>",
     "confidence": <float 0.0 to 1.0>,
     "reason": "<short British-English reason for your choice>",
     "clarifying_question": "<empty or one short question OR 'DIAGNOSTIC_INTAKE'>"
   }
3. If you are confident (confidence >= 0.65) and can pick ONE item from the list, fill in service_price_id and service_name with the EXACT values from the list.
4. If the caller describes SYMPTOMS/PROBLEMS (not scheduled work), return clarifying_question="DIAGNOSTIC_INTAKE" to trigger diagnostic questions.
5. If you need simple clarification (e.g., "full or interim service?"), provide a normal clarifying_question.
6. Do NOT invent work types that are not in the list.
7. Do NOT pick multiple items. Pick exactly ONE or NONE.
8. Consider British workshop context:
   - "knocking" or "warning light" → DIAGNOSTIC_INTAKE (gather fault info first)
   - "overdue" or "hasn't been serviced" → Full Service
   - "tyres" → Tyre Fitting
   - "brakes squeaking" → DIAGNOSTIC_INTAKE (could be repair or service)
   - "MOT due" → MOT
9. Use the descriptions and durations to help decide if they're provided.

Examples:
- Caller: "my engine light is on" → {"service_price_id":"", "confidence":0.2, "clarifying_question":"DIAGNOSTIC_INTAKE", "reason":"Engine warning light symptom"}
- Caller: "knocking noise when turning" → {"service_price_id":"", "confidence":0.2, "clarifying_question":"DIAGNOSTIC_INTAKE", "reason":"Knocking noise symptom"}
- Caller: "need a service" + list has Full/Interim → {"service_price_id":"", "confidence":0.4, "clarifying_question":"Would you like a full service or interim service?"}
- Caller: "need new tyres" + list includes "Tyre Fitting" → pick Tyre Fitting with high confidence
- Caller: "MOT due" → pick MOT with high confidence

Return ONLY the JSON object.
""".strip()


# ---------------------------------------------------------------------------
# Service Expert Function
# ---------------------------------------------------------------------------


async def run_service_expert(caller_text: str, services: list[dict]) -> dict:
    """
    Call the Service Expert LLM to choose the best service when ambiguous.

    Returns a dict with keys:
        service_price_id: str (ID from list or empty)
        service_name: str (exact name from list or empty)
        confidence: float (0.0 to 1.0)
        reason: str
        clarifying_question: str (empty if confident)
    """
    if not caller_text.strip() or not services:
        return {
            "service_price_id": "",
            "service_name": "",
            "confidence": 0.0,
            "reason": "No caller text or services provided",
            "clarifying_question": "",
        }

    # Check cache
    cache_key = _cache_key(caller_text, services)
    cached = _get_cached_result(cache_key)
    if cached:
        logger.info("[ServiceExpert] Cache hit for: %s", caller_text[:50])
        return cached

    # Serialize services list safely
    services_data = []
    for svc in services:
        services_data.append(
            {
                "service_price_id": str(svc.get("service_price_id", "")),
                "name": svc.get("name", ""),
                "price": svc.get("price", ""),
                "duration": svc.get("duration", ""),
                "description": svc.get("description", ""),
            }
        )

    user_message = f"""
Caller said: "{caller_text}"

Available services:
{json.dumps(services_data, indent=2)}

Return JSON only.
""".strip()

    try:
        client = _get_openai_client()
        timeout_sec = SERVICE_EXPERT_TIMEOUT_MS / 1000.0

        response = await asyncio.wait_for(
            client.chat.completions.create(
                model=SERVICE_EXPERT_MODEL,
                messages=[
                    {"role": "system", "content": SERVICE_EXPERT_SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                temperature=0.0,
                max_tokens=300,
                response_format={"type": "json_object"},
            ),
            timeout=timeout_sec,
        )

        raw_content = response.choices[0].message.content or ""
        logger.info("[ServiceExpert] LLM response: %s", raw_content[:200])

        result = json.loads(raw_content)
        # Validate schema
        if not isinstance(result, dict):
            raise ValueError("Response is not a dict")
        result.setdefault("service_price_id", "")
        result.setdefault("service_name", "")
        result.setdefault("confidence", 0.0)
        result.setdefault("reason", "")
        result.setdefault("clarifying_question", "")

        # Cache and return
        _set_cached_result(cache_key, result)
        logger.info(
            "[ServiceExpert] Decision: service=%s, confidence=%.2f",
            result.get("service_name") or "(none)",
            result.get("confidence", 0.0),
        )
        return result

    except asyncio.TimeoutError:
        logger.warning("[ServiceExpert] Timeout after %dms", SERVICE_EXPERT_TIMEOUT_MS)
        return {
            "service_price_id": "",
            "service_name": "",
            "confidence": 0.0,
            "reason": "LLM timeout",
            "clarifying_question": "",
        }
    except json.JSONDecodeError as exc:
        logger.error("[ServiceExpert] JSON parse error: %s", exc)
        return {
            "service_price_id": "",
            "service_name": "",
            "confidence": 0.0,
            "reason": "Invalid JSON from LLM",
            "clarifying_question": "",
        }
    except Exception as exc:
        logger.error("[ServiceExpert] Unexpected error: %s", exc)
        return {
            "service_price_id": "",
            "service_name": "",
            "confidence": 0.0,
            "reason": f"Error: {exc}",
            "clarifying_question": "",
        }
