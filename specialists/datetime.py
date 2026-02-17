from __future__ import annotations

from core.utils import uk_now
from specialists.base import SpecialistBase


class DatetimeSpecialist(SpecialistBase):
    async def current_datetime(self) -> dict:
        now = uk_now()
        return {
            "date": now.strftime("%A %d %B %Y"),
            "time": now.strftime("%I:%M %p"),
        }
