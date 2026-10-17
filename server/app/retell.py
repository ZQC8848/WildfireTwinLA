from typing import Any

from retell import AsyncRetell
from retell.lib.webhook_auth import verify


class RetellGateway:
    def __init__(
        self, api_key: str, from_number: str, agent_id: str, client: AsyncRetell | None = None
    ) -> None:
        self.api_key = api_key
        self.from_number = from_number
        self.agent_id = agent_id
        self.client = client or (AsyncRetell(api_key=api_key) if api_key else None)

    @property
    def configured(self) -> bool:
        return bool(self.client and self.from_number and self.agent_id)

    async def create_alert_call(
        self,
        *,
        attempt_id: str,
        resident: dict,
        community_id: str,
        level: str,
        eta_min: float,
    ) -> str:
        if not self.configured or self.client is None:
            raise RuntimeError("Retell is not fully configured")
        response = await self.client.call.create_phone_call(
            from_number=self.from_number,
            to_number=resident["phone_e164"],
            override_agent_id=self.agent_id,
            honor_internal_dnc=True,
            idempotency_key=attempt_id,
            metadata={
                "attempt_id": attempt_id,
                "resident_id": resident["id"],
                "building_id": resident.get("building_id"),
                "community_id": community_id,
            },
            retell_llm_dynamic_variables={
                "resident_name": resident["name"],
                "language": resident["language"],
                "community_name": community_id,
                "alert_level": level,
                "eta_minutes": str(round(eta_min)),
                "official_status": "non_official_prediction",
            },
        )
        return response.call_id

    def verify_webhook(self, body: bytes, signature: str) -> bool:
        return bool(self.api_key and verify(body.decode(), self.api_key, signature))


def webhook_status(event: str, call: dict[str, Any]) -> str:
    if event == "call_started":
        return "in_progress"
    if event == "call_analyzed":
        analysis = call.get("call_analysis") or call.get("post_call_analysis_data") or {}
        if analysis.get("needs_help") is True:
            return "needs_help"
        return "confirmed" if analysis.get("call_successful") is True else "completed"
    if event == "call_ended":
        return "no_answer" if call.get("disconnection_reason") == "dial_no_answer" else "ended"
    return event
