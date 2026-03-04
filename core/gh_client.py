from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

import aiohttp


class GHClient:
    """GarageHive external booking API client (per-call session)."""

    def __init__(
        self,
        customer_id: str,
        location_id: int,
        api_key: str | None,
        *,
        timeout_seconds: float = 20.0,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._customer_id = customer_id
        self._location_id = location_id
        self._api_key = api_key or ""
        self._timeout_seconds = timeout_seconds
        self._client: aiohttp.ClientSession | None = None
        self._logger = logger or logging.getLogger(__name__)
        self._base = f"https://onlinebooking.garagehive.co.uk/api/external-booking/{customer_id}"

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._client is None or self._client.closed:
            headers = {"Content-Type": "application/json"}
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"
            timeout = aiohttp.ClientTimeout(total=self._timeout_seconds)
            self._client = aiohttp.ClientSession(headers=headers, timeout=timeout)
        return self._client

    async def init_and_set_vehicle(self, reg: str) -> Dict[str, Any]:
        session = await self._ensure_session()
        async with session.post(f"{self._base}/init") as resp:
            if resp.status >= 400:
                raw = await resp.text()
                self._logger.error("[GH] init failed %s: %s", resp.status, raw)
                return {"error": f"Init failed (HTTP {resp.status})"}
            try:
                payload = json.loads(await resp.text())
            except json.JSONDecodeError:
                return {"error": "Init response not JSON"}
            booking = payload.get("booking", {})
            session_id = booking.get("session_id") or payload.get("sessionId")
            if not session_id:
                return {"error": "No session_id in init response"}

        async with session.post(
            f"{self._base}/{session_id}/set-vehicle-info",
            json={
                "registration_no": reg,
                "reg_no_country": "GB",
                "location_id": self._location_id,
            },
        ) as resp:
            data = await resp.json()
            data["session_id"] = session_id
            self._logger.info("[GH] init+vehicle success for %s", reg)
            return data

    async def list_services(self, session_id: str) -> List[dict]:
        session = await self._ensure_session()
        async with session.get(f"{self._base}/{session_id}/list-services") as resp:
            payload = await resp.json()
            return payload.get("services") or []

    async def set_service(self, session_id: str, service_price_ids: str) -> Dict[str, Any]:
        session = await self._ensure_session()
        raw_ids = [p.strip() for p in str(service_price_ids).split(",") if p.strip()]
        ids: List[int | str] = [int(x) if x.isdigit() else x for x in raw_ids]
        async with session.post(
            f"{self._base}/{session_id}/set-services",
            json={"servicePriceIDs": ids},
        ) as resp:
            return await resp.json()

    async def list_timeslots(self, session_id: str) -> List[dict]:
        session = await self._ensure_session()
        async with session.get(f"{self._base}/{session_id}/list-timeslots") as resp:
            payload = await resp.json()
            timeslots = payload.get("timeslots") or {}
            flat: List[dict] = []
            for day, times in timeslots.items():
                for time in times:
                    flat.append({"date": day, "time": time})
            return flat

    async def set_timeslot(self, session_id: str, booking_date: str, booking_time: str) -> Dict[str, Any]:
        session = await self._ensure_session()
        async with session.post(
            f"{self._base}/{session_id}/set-timeslot",
            json={"bookingDate": booking_date, "bookingTime": booking_time},
        ) as resp:
            return await resp.json()

    async def set_contact_info(self, session_id: str, **payload: Any) -> Dict[str, Any]:
        session = await self._session()
        async with session.post(
            f"{self._base}/{session_id}/set-contact-info",
            json=payload,
        ) as resp:
            status = resp.status
            try:
                data = await resp.json()
            except aiohttp.ContentTypeError:
                if 200 <= status < 300:
                    return {"status": "success", "booking": {}}
                return {"status": "error", "message": f"HTTP {status}"}

            if 200 <= status < 300 or data.get("status") == "success":
                return {"status": "success", "booking": data.get("booking", {})}
            return {
                "status": "error",
                "message": data.get("message", "Failed to confirm booking"),
                "errors": data.get("errors", []),
            }

    async def validate_address(self, postcode: str) -> Dict[str, str]:
        clean = postcode.replace(" ", "").upper()
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"https://api.postcodes.io/postcodes/{clean}") as resp:
                if resp.status != 200:
                    return {"street": "", "city": ""}
                payload = await resp.json()
                if payload.get("status") != 200 or not payload.get("result"):
                    return {"street": "", "city": ""}
                result = payload["result"]
                return {
                    "street": result.get("parish") or result.get("admin_ward") or "",
                    "city": result.get("admin_district") or result.get("postcode_area") or "",
                }

    async def close(self) -> None:
        if self._client and not self._client.closed:
            await self._client.close()

    async def __aenter__(self) -> "GHClient":  # pragma: no cover
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # pragma: no cover
        await self.close()
