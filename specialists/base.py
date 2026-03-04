from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Optional

from core.error_monitor import ErrorMonitor
from core.gh_client import GHClient
from core.state import CallState


class SpecialistBase:
    """Shared helpers/guards for silent specialist tool agents."""

    def __init__(
        self,
        *,
        state: CallState,
        gh: GHClient,
        room_name: str,
        logger: logging.Logger,
        error_monitor: ErrorMonitor,
    ) -> None:
        self.state = state
        self.gh = gh
        self.room = room_name
        self.logger = logger
        self._error_monitor = error_monitor

    def directive(
        self,
        *,
        status: str,
        step: str,
        say: Optional[str] = None,
        silent_next_tool: Optional[dict[str, Any]] = None,
        notes: Optional[str] = None,
        errors: Optional[list] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"status": status, "step": step}
        if say is not None:
            payload["say"] = say
        if silent_next_tool is not None:
            payload["silent_next_tool"] = silent_next_tool
        if notes:
            payload["notes"] = notes
        if errors:
            payload["errors"] = errors
        return payload

    def json_directive(
        self,
        *,
        status: str,
        step: str,
        say: Optional[str] = None,
        silent_next_tool: Optional[dict[str, Any]] = None,
        notes: Optional[str] = None,
        errors: Optional[list] = None,
    ) -> str:
        return json.dumps(
            self.directive(
                status=status,
                step=step,
                say=say,
                silent_next_tool=silent_next_tool,
                notes=notes,
                errors=errors,
            ),
            ensure_ascii=True,
        )

    async def report_error(self, *, message: str, error_type: str, extra: Optional[dict] = None) -> None:
        try:
            await self._error_monitor.report_error(
                error_msg=message,
                agent_name="SUPERVISOR",
                room_name=self.room,
                error_type=error_type,
                extra=extra,
            )
        except Exception as exc:  # pragma: no cover
            self.logger.warning("[SpecialistBase] Failed to report error: %s", exc)

    def schedule_report(self, *, message: str, error_type: str, extra: Optional[dict] = None) -> None:
        asyncio.create_task(
            self.report_error(message=message, error_type=error_type, extra=extra)
        )
