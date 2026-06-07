"""Safety inferential sensor — content-safety screen via Granite Guardian.

Screens the generated note through the constructor-injected
:class:`~harness.sensors.inferential.granite_client.GraniteGuardianClient` (the
backend-specific client is injected at ``__init__``, exactly as the computational
sensors take their ``threshold``; the shared ``judge`` is accepted on :meth:`arun`
for a uniform call site but is unused — safety screens via Granite, not the judge).

``passed`` is False if **any** harm dimension is flagged unsafe — unsafe content is
never auto-regenerated, it escalates to a clinician — and the triggered dimensions
are surfaced in both ``details`` and ``claims_flagged``. ``score`` is the safe
fraction (1.0 = every dimension clear). A Granite backend failure returns
:func:`degraded_result` so an unverifiable safety screen never auto-PASSes and
never raises into the durable loop.
"""

from __future__ import annotations

from harness.eval.judge.base import JudgeClient
from harness.sensors.base import SensorContext, SensorResult
from harness.sensors.inferential.base import degraded_result
from harness.sensors.inferential.granite_client import GraniteGuardianClient, GraniteServiceError

NAME = "safety"


class SafetySensor:
    """Score = safe harm dimensions / total dimensions (any unsafe => not passed)."""

    name = NAME

    def __init__(self, client: GraniteGuardianClient) -> None:
        self._client = client

    async def arun(self, ctx: SensorContext, *, judge: JudgeClient) -> SensorResult:
        try:
            dimensions = await self._client.screen(ctx.note_blob())
        except GraniteServiceError as exc:
            return degraded_result(NAME, f"granite guardian unavailable: {exc}")

        flagged = [dim for dim, unsafe in dimensions.items() if unsafe]
        total = len(dimensions)
        score = 1.0 if total == 0 else (total - len(flagged)) / total
        return SensorResult(
            name=NAME,
            score=score,
            passed=not flagged,
            claims_flagged=flagged,
            details={
                "unsafe": bool(flagged),
                "flagged_dimensions": flagged,
                "dimensions": dimensions,
                "model": self._client.model,
            },
        )
