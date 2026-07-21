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

The screen is **content-addressed** so unchanged note content is not
re-screened for every criterion on every regen pass. When :meth:`SafetySensor.arun`
is given the shared ``screen_cache`` (the same dict the verdict-cache module threads across
passes), each criterion's verdict is keyed on ``(criterion, screened text, granite model)``
via the shared key helpers; an unchanged-content pass is a full HIT (no Granite call) and a
changed note (or model/criterion change) is a MISS that re-screens. The cached verdict is
byte-identical to a fresh screen, and a degraded screen is **never** cached (fail-closed).
"""

from __future__ import annotations

from harness.eval.judge.base import JudgeClient
from harness.sensors.base import SensorContext, SensorResult
from harness.sensors.inferential.base import degraded_result
from harness.sensors.inferential.granite_client import GraniteGuardianClient, GraniteServiceError
from harness.sensors.inferential.verdict_cache import (
    VerdictCache,
    claim_verdict_key,
    sensor_identity,
)

NAME = "safety"

# The safety-screen identity fed to ``sensor_identity`` so the content-addressed
# key auto-invalidates on a screen-framing change (mirrors the groundedness/citation
# ``_SYSTEM_PROMPT`` lever). With the Granite *model* id (the dominant lever) and the
# per-criterion name, the three together make a model swap, a criterion change, OR a
# screened-text change a cache MISS — guaranteeing a cached verdict equals a fresh one.
_SCREEN_PROMPT = (
    "granite-guardian content-safety screen: one no-think BYOC <guardian> verdict per "
    "harm criterion over the whole note (yes => the risk IS present => unsafe)"
)


class SafetySensor:
    """Score = safe harm dimensions / total dimensions (any unsafe => not passed)."""

    name = NAME

    def __init__(self, client: GraniteGuardianClient) -> None:
        self._client = client

    async def arun(
        self,
        ctx: SensorContext,
        *,
        judge: JudgeClient,
        screen_cache: VerdictCache | None = None,
    ) -> SensorResult:
        try:
            dimensions = await self._screen(ctx.note_blob(), screen_cache)
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

    async def _screen(self, text: str, cache: VerdictCache | None) -> dict[str, bool]:
        """Screen ``text`` across every harm criterion, reusing prior-pass verdicts.

        With ``cache is None`` this is exactly the single ``screen`` call the legacy path
        makes, byte-for-byte. With a cache provided, each criterion's verdict is
        content-addressed on ``(criterion, screened text, granite model)``:

        * **Full HIT** (every criterion already cached for this exact text+model) — the
          ordered ``{dimension: is_unsafe}`` dict is rebuilt from the cache and the Granite
          backend is NOT called (the cache's reduction on an unchanged-content pass).
        * **MISS** (any criterion absent ⇒ changed/new content, a model swap, or a criterion
          change) — the note is re-screened once and every verdict is populated, so the next
          unchanged pass is a HIT (a miss always re-screens, never assumes safe).

        A ``GraniteServiceError`` propagates to :meth:`arun` (the sensor degrades, fail-closed)
        and is NEVER cached — a degraded/unverifiable screen is never recorded as safe.
        """
        # The fast-path needs the client to enumerate its criteria so it can rebuild the
        # ordered verdict dict without a model call; with no cache, or a client that cannot
        # enumerate them, the note is screened directly — the pre-cache behaviour, byte-for-byte.
        criteria: list[str] | None = getattr(self._client, "criteria", None)
        if cache is None or criteria is None:
            return await self._client.screen(text)

        identity = sensor_identity(NAME, _SCREEN_PROMPT, self._client.model)
        keys = {
            criterion: claim_verdict_key(
                claim_text=text, premise=criterion, judge_identity=identity
            )
            for criterion in criteria
        }
        if keys and all(key in cache for key in keys.values()):
            return {criterion: cache[key] for criterion, key in keys.items()}

        dimensions = await self._client.screen(text)
        for dim, unsafe in dimensions.items():
            key = keys.get(dim) or claim_verdict_key(
                claim_text=text, premise=dim, judge_identity=identity
            )
            cache[key] = unsafe
        return dimensions
