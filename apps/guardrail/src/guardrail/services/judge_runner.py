"""The judge runner (TASK-1050 §12, §10.2 A2/A3, OD-26/OD-42): every LLM-judge lane, one seam.

``JudgeRunner.judge`` takes a set of LANES and a list of WINDOWS and answers one
:class:`LaneVerdict` per ``(lane, window.region_key)``. It never raises past itself: anything that
goes wrong is an ``undetermined`` verdict whose ``category`` names the reason.

**Resolution.** Each lane's model is the row its routing task key elects (tenant → SYSTEM, the
resolver's cascade): ``guardrail.judge.<lane>`` for the four safety lanes, ``guardrail.validate``
for the medical lane. The row must DECLARE the lane in ``_metadata.judge``
(``assertModelSupportsLane`` semantics) or the lane is undetermined ``JUDGE_LANE_UNSUPPORTED``.
One grandfathered case: a row with NO declaration at all still serves ``medical_validation`` as
``criteria_json``, because every pre-TASK-1050 ``guardrail.validate`` row is exactly that.

**Grouping.** Lanes are grouped by the model (and the parameters) they resolved to, and each group
is ONE call per window:

* ``criteria_json`` → TEXT ``/api/v1/generate/internal/judge``. A group of several lanes sends a
  COMBINED system prompt (one ``<section id="<lane>">`` per lane's criteria) and a strict
  ``json_schema`` with one verdict-only object per lane. A group that is the medical lane alone
  sends exactly today's medical request (window criterion + the medical verdict schema).
* ``qwen3guard_native`` → by the row's ``servedBy`` (owner 2026-10-07): an LM Studio (TEXT-served)
  row goes to TEXT ``/api/v1/generate/internal/judge`` with ``protocol: "native_chat"`` (the user
  turn, plus the assistant turn in response mode; no system prompt, no ``response_format``) and the
  raw completion is parsed here; an nlp-served row (or one that does not say) goes to apps/nlp
  ``/api/v1/guard/judge``. Either way the native tier/categories are mapped through the row's
  ``categoryMap`` / ``tiers``.

Temperature and max tokens are the lane's model row's ``judgeTemperature`` / ``judgeMaxTokens``
(the winning routing row's ``configJson`` tuning still wins where it carries one, exactly as
``build_judge_client`` has always done). Every judged text is enveloped (§3.2) on the
``criteria_json`` path; a text carrying the closing marker is never sent.

**Sharing.** A process-wide :class:`SingleFlight` plus the FC-7 window-verdict cache, keyed by
``(tenant, policy version, model, sorted lane set, direction, mode, window)``. Two routes asking
for the SAME lane set over the SAME window text therefore make one call between them. The two
routes that matter — ``/api/medical/validate`` (regions) and ``/guardrail/screen/inbound`` — get
identical lane sets by building their calls with :func:`plan_inbound_judge_calls`, from the same
inputs:

* the regions as ``(key, text, trust)`` exactly as the caller sent them;
* ``enabled_safety_lanes`` from :func:`enabled_inbound_safety_lanes` (one availability read);
* ``medical_skip`` = the ``guardrail.safety`` row's ``medicalJudgeConfigRegions``;
* the geometry from :func:`judge_geometry` (the screen window bounded by the judge input cap).

Each window's lane set is then ``medical_validation`` (unless the region is a configuration
block) plus the enabled inbound safety lanes when the region is a ``data`` region (A3). The medical
route runs only the groups that contain the medical lane; the screen route runs every group, and
passes ``include_medical=False`` only when the request is medical-exempt.

Only a fully determined group answer is cached, and only text-free fields are stored.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Literal

from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.core.metrics import record_guardrail_call
from guardrail.core.policy import GuardrailPolicy
from guardrail.services import judge_protocols as jp
from guardrail.services.judge_envelope import contains_closing_marker, wrap_untrusted
from guardrail.services.window_cache import WindowVerdictCache
from guardrail.services.windowing import WindowGeometry, region_windows

logger = get_logger(__name__)

Verdict = Literal["pass", "flag", "undetermined"]
Direction = Literal["inbound", "outbound"]
Mode = Literal["prompt", "response"]


@dataclass(frozen=True)
class JudgeWindow:
    """One window to judge. ``region_key`` must be unique per window (see :func:`region_of`).

    ``items`` are the ``(itemId, itemVersion)`` pairs the window's text came from (README §9.7.4);
    they ride along for the caller and never enter a cache key.
    """

    region_key: str
    text: str
    items: tuple[tuple[str, int], ...]


@dataclass(frozen=True)
class LaneVerdict:
    """One lane's verdict on one window.

    ``category``: on ``flag``, the lane's verdict category (``None`` when the model named none);
    for ``medical_validation``, the judge's ``context_type`` on pass AND flag; on
    ``undetermined``, the REASON code (``JUDGE_LANE_UNSUPPORTED``, ``JUDGE_ENGINE_ERROR``, …,
    ``judge_protocols.REASON_*``); ``None`` on a safety-lane pass.
    ``confidence``: the judge's, or 1.0 for a tier-only native model (§12).
    ``tier``: for ``qwen3guard_native``, the tier VALUE the row maps the answered tier to
    (``pass`` / ``warn`` / ``block`` / ``flag``) — a ``flag`` with ``warn``/``block`` is a FIXED
    outcome, a ``flag`` with ``flag`` takes the check's configured action; ``None`` otherwise.
    """

    lane: str
    verdict: Verdict
    category: str | None
    confidence: float | None
    model: str | None
    latency_ms: int
    tier: str | None


# ── single-flight ──────────────────────────────────────────────────────────────


class SingleFlight:
    """At most ONE in-flight computation per key; every concurrent asker awaits it.

    Process-wide by default (:data:`DEFAULT_SINGLE_FLIGHT`), because the two routes that share a
    call each build their own runner per request. Keys carry the tenant, so coalescing can never
    merge two tenants.
    """

    def __init__(self) -> None:
        self._in_flight: dict[str, asyncio.Future[Any]] = {}

    async def run(self, key: str, compute: Callable[[], Awaitable[Any]]) -> tuple[Any, bool]:
        """``(result, led)`` — ``led`` is False for a follower that reused the leader's answer."""
        running = self._in_flight.get(key)
        if running is not None:
            try:
                return await asyncio.shield(running), False
            except asyncio.CancelledError:
                current = asyncio.current_task()
                if not running.cancelled() or (current is not None and current.cancelling()):
                    raise
                # The LEADER was cancelled, not us: compute for ourselves.
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        self._in_flight[key] = future
        try:
            result = await compute()
        except asyncio.CancelledError:
            future.cancel()
            raise
        except BaseException as exc:
            future.set_exception(exc)
            future.exception()  # retrieved: followers still see it through `await`
            raise
        else:
            future.set_result(result)
            return result, True
        finally:
            if self._in_flight.get(key) is future:
                self._in_flight.pop(key, None)


DEFAULT_SINGLE_FLIGHT: Final = SingleFlight()


# ── selection ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Selection:
    """One lane's resolved model and the parameters it is judged with."""

    lane: str
    protocol: str
    cfg: Any
    provider: str
    model: str
    temperature: float
    max_tokens: int
    min_confidence: float
    criteria: str | None
    meta: Mapping[str, Any] | None
    timeout_s: float | None
    nlp_deadline_s: float

    def group_key(self) -> tuple[Any, ...]:
        return (
            self.protocol,
            self.provider,
            self.model,
            self.temperature,
            self.max_tokens,
            self.timeout_s,
            json.dumps(self.meta, sort_keys=True, default=str) if self.meta else None,
        )


@dataclass
class _Group:
    protocol: str
    selections: list[_Selection] = field(default_factory=list)

    @property
    def lanes(self) -> tuple[str, ...]:
        return jp.canonical_lanes(s.lane for s in self.selections)

    @property
    def lead(self) -> _Selection:
        return self.selections[0]


_SEVERITY: Final[Mapping[str, int]] = {"pass": 0, "undetermined": 1, "flag": 2}


def _cached_value(parsed: Mapping[str, jp.ParsedLane]) -> dict[str, list[Any]]:
    """Text-free: verdict, category, confidence, tier — never prose, never window text."""
    return {lane: [p.verdict, p.category, p.confidence, p.tier] for lane, p in parsed.items()}


def _from_cached(value: Mapping[str, Any], lanes: Sequence[str]) -> dict[str, jp.ParsedLane] | None:
    out: dict[str, jp.ParsedLane] = {}
    for lane in lanes:
        entry = value.get(lane)
        if not isinstance(entry, list) or len(entry) != 4 or entry[0] not in ("pass", "flag"):
            return None
        out[lane] = jp.ParsedLane(str(entry[0]), entry[1], entry[2], entry[3])
    return out


def _sum_stats(stats: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    if not stats:
        return None
    total = dict(stats[0])
    for key in ("prompt_tokens", "predicted_tokens", "total_tokens", "total_ms"):
        values = [s.get(key) for s in stats if isinstance(s.get(key), (int, float))]
        if values:
            total[key] = sum(values)
    return total


class JudgeRunner:
    """One request's judge runner. Build with :func:`build_judge_runner` or :func:`build_judge_runner_for_app`."""

    def __init__(
        self,
        *,
        tenant_id: str,
        resolver: Any,
        settings: Any,
        http_client: Any,
        cache: WindowVerdictCache | None = None,
        policy_version: str | None = None,
        provider_overrides: dict[str, Any] | None = None,
        judge_timeout_s: float | None = None,
        breakers: Mapping[str, Any] | None = None,
        single_flight: SingleFlight | None = None,
        concurrency: int = 4,
        draft_policy: Mapping[str, Any] | None = None,
        draft_judge_meta: Mapping[str, Any] | None = None,
    ) -> None:
        self.tenant_id = tenant_id
        self._resolver = resolver
        self._settings = settings
        self._http = http_client
        # No policy version ⇒ no key can name its policy ⇒ no cache (same rule as WindowRunner).
        self._cache = cache if policy_version else None
        self._policy_version = policy_version
        self._overrides = provider_overrides
        self._judge_timeout_s = judge_timeout_s
        self._breakers = breakers or {}
        self._single_flight = single_flight or DEFAULT_SINGLE_FLIGHT
        self._semaphore = asyncio.Semaphore(max(1, int(concurrency)))
        self._draft_policy = dict(draft_policy or {})
        self._draft_meta = dict(draft_judge_meta or {})
        self._selections: dict[tuple[str, str], _Selection | str] = {}
        self._stats: list[dict[str, Any]] = []

    # -- public --------------------------------------------------------------

    def usage_stats(self) -> dict[str, Any] | None:
        """Summed usage of the judge calls THIS runner made (cache hits / followers: none)."""
        return _sum_stats(self._stats)

    async def judge(
        self,
        *,
        tenant_id: str,
        direction: Direction,
        lanes: Sequence[str],
        windows: Sequence[JudgeWindow],
        mode: Mode = "prompt",
        prompt_context: str | None = None,
    ) -> dict[tuple[str, str], LaneVerdict]:
        """One verdict per ``(lane, window.region_key)``. Never raises (cancellation aside)."""
        wanted = jp.canonical_lanes(lane for lane in lanes if lane in jp.GUARDRAIL_JUDGE_LANES)
        out: dict[tuple[str, str], LaneVerdict] = {}
        if not wanted or not windows:
            return out
        try:
            selections = {lane: await self._select(tenant_id, lane) for lane in wanted}
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — the runner never raises past itself
            logger.error("guardrail.judge_runner.selection_failed", error=type(exc).__name__)
            selections = dict.fromkeys(wanted, jp.REASON_SELECTION_UNAVAILABLE)

        groups: dict[tuple[Any, ...], _Group] = {}
        for lane, selection in selections.items():
            if isinstance(selection, str):
                for window in windows:
                    self._merge(
                        out,
                        LaneVerdict(lane, "undetermined", selection, None, None, 0, None),
                        window,
                    )
                continue
            group = groups.setdefault(selection.group_key(), _Group(selection.protocol))
            group.selections.append(selection)

        jobs = [(group, window) for group in groups.values() for window in windows]
        results = await asyncio.gather(
            *(self._window(tenant_id, direction, mode, prompt_context, g, w) for g, w in jobs),
            return_exceptions=True,
        )
        for (group, window), result in zip(jobs, results, strict=True):
            if isinstance(result, asyncio.CancelledError):
                raise result
            if isinstance(result, BaseException):
                logger.error("guardrail.judge_runner.window_failed", error=type(result).__name__)
                parsed = {lane: jp.undetermined(jp.REASON_ENGINE_ERROR) for lane in group.lanes}
                latency = 0
            else:
                parsed, latency = result
            for lane in group.lanes:
                p = parsed.get(lane) or jp.undetermined(jp.REASON_UNPARSEABLE)
                self._merge(
                    out,
                    LaneVerdict(
                        lane=lane,
                        verdict=p.verdict,  # type: ignore[arg-type]
                        category=p.category,
                        confidence=p.confidence,
                        model=group.lead.model,
                        latency_ms=latency,
                        tier=p.tier,
                    ),
                    window,
                )
        return out

    # -- selection -----------------------------------------------------------

    async def _select(self, tenant_id: str, lane: str) -> _Selection | str:
        key = (tenant_id, lane)
        if key not in self._selections:
            self._selections[key] = await self._resolve_lane(tenant_id, lane)
        return self._selections[key]

    async def _resolve_lane(self, tenant_id: str, lane: str) -> _Selection | str:
        try:
            cfg = await self._resolver.resolve(tenant_id, jp.lane_task_key(lane))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — veto, unreadable, unwired: all undetermined
            logger.warning(
                "guardrail.judge_runner.selection_unavailable",
                lane=lane,
                error=type(exc).__name__,
            )
            return jp.REASON_SELECTION_UNAVAILABLE
        model = (getattr(cfg, "model", None) or "").strip()
        if not model:
            return jp.REASON_SELECTION_UNAVAILABLE

        meta = getattr(cfg, "judge", None)
        if self._draft_meta and isinstance(meta, dict):
            meta = {**meta, **self._draft_meta}
        if meta is None and lane == jp.MEDICAL_LANE:
            protocol = jp.CRITERIA_JSON  # grandfathered: every pre-TASK-1050 medical judge row
        elif jp.model_supports_lane(meta, lane):
            protocol = str(meta["protocol"])  # type: ignore[index]
        else:
            return jp.REASON_LANE_UNSUPPORTED

        blob = getattr(cfg, "policy", None)
        policy = GuardrailPolicy.from_blob(
            {**(blob if isinstance(blob, dict) else {}), **self._draft_policy},
            source_tenant_id=getattr(cfg, "source_tenant_id", None),
        )
        try:
            # The routing row's configJson tuning wins where present (build_judge_client's rule),
            # except over an explicit dry-run draft.
            temperature = (
                policy.judge_temperature
                if getattr(cfg, "temperature", None) is None
                or "judgeTemperature" in self._draft_policy
                else float(cfg.temperature)
            )
            max_tokens = (
                policy.judge_max_tokens
                if getattr(cfg, "max_tokens", None) is None
                or "judgeMaxTokens" in self._draft_policy
                else int(cfg.max_tokens)
            )
            criteria = (
                policy.require_criteria(jp.LANE_CRITERIA_KEYS[lane])
                if protocol == jp.CRITERIA_JSON
                else None
            )
        except GuardrailUndeterminedError:
            return jp.REASON_POLICY_UNRESOLVED

        provider = (getattr(cfg, "provider", None) or "").strip()
        if provider.lower() == "azure" and getattr(cfg, "azure_deployment", None):
            model = str(cfg.azure_deployment)
        timeout = getattr(cfg, "timeout_s", None)
        return _Selection(
            lane=lane,
            protocol=protocol,
            cfg=cfg,
            provider=provider,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            min_confidence=policy.judge_min_confidence,
            criteria=criteria,
            meta=meta if protocol == jp.QWEN3GUARD_NATIVE else None,
            timeout_s=float(timeout) if timeout is not None else self._judge_timeout_s,
            nlp_deadline_s=policy.nlp_deadline_seconds,
        )

    # -- one group × one window ----------------------------------------------

    async def _window(
        self,
        tenant_id: str,
        direction: str,
        mode: str,
        prompt_context: str | None,
        group: _Group,
        window: JudgeWindow,
    ) -> tuple[dict[str, jp.ParsedLane], int]:
        lanes = group.lanes
        lead = group.lead
        context = (prompt_context or "") if mode == "response" else ""
        started = time.monotonic()

        cache_key: str | None = None
        cache = self._cache
        if cache is not None and self._policy_version:
            task = f"judge:{group.protocol}:{'+'.join(lanes)}:{direction}:{mode}"
            cache_key = cache.key(
                tenant_id, self._policy_version, lead.model, task, f"{window.text}\x1e{context}"
            )
            hit = await cache.get(cache_key)
            restored = _from_cached(hit, lanes) if hit is not None else None
            if restored is not None:
                return restored, int((time.monotonic() - started) * 1000)

        flight_key = hashlib.sha256(
            json.dumps(
                [
                    tenant_id,
                    self._policy_version or "",
                    lead.group_key(),
                    lanes,
                    direction,
                    mode,
                    [
                        hashlib.sha256((s.criteria or "").encode()).hexdigest()
                        for s in group.selections
                    ],
                    window.text,
                    context,
                ],
                default=str,
            ).encode("utf-8")
        ).hexdigest()

        async def _compute() -> dict[str, jp.ParsedLane]:
            async with self._semaphore:
                parsed = await self._call(tenant_id, group, window.text, mode, context)
            if (
                cache is not None
                and cache_key is not None
                and all(p.verdict != "undetermined" for p in parsed.values())
            ):
                await cache.set(cache_key, _cached_value(parsed))
            return parsed

        parsed, _led = await self._single_flight.run(flight_key, _compute)
        return parsed, int((time.monotonic() - started) * 1000)

    async def _call(
        self, tenant_id: str, group: _Group, text: str, mode: str, context: str
    ) -> dict[str, jp.ParsedLane]:
        lanes = group.lanes
        try:
            if group.protocol == jp.QWEN3GUARD_NATIVE:
                return await self._call_native(tenant_id, group, text, mode, context)
            if contains_closing_marker(text):
                logger.warning("guardrail.judge_runner.envelope_marker", lanes=list(lanes))
                return {lane: jp.undetermined(jp.REASON_ENVELOPE_MARKER) for lane in lanes}
            return await self._call_criteria(tenant_id, group, text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — every failure is undetermined, never raised
            logger.error(
                "guardrail.judge_runner.call_failed",
                protocol=group.protocol,
                lanes=list(lanes),
                error=type(exc).__name__,
            )
            return {lane: jp.undetermined(jp.REASON_ENGINE_ERROR) for lane in lanes}

    async def _call_criteria(
        self, tenant_id: str, group: _Group, text: str
    ) -> dict[str, jp.ParsedLane]:
        from guardrail.services.external_text_client import (
            JUDGE_VERDICT_SCHEMA,
            judge_call_stats,
            medical_judge_prompt,
        )

        lanes = group.lanes
        by_lane = {s.lane: s for s in group.selections}
        if lanes == (jp.MEDICAL_LANE,):
            criteria = str(by_lane[jp.MEDICAL_LANE].criteria)
            system_prompt, prompt, schema = (
                criteria,
                medical_judge_prompt(text),
                JUDGE_VERDICT_SCHEMA,
            )
        else:
            system_prompt = jp.combined_system_prompt(
                (s.lane, str(s.criteria)) for s in group.selections
            )
            prompt = jp.combined_user_prompt(lanes, wrap_untrusted(text))
            schema = jp.combined_verdict_schema(lanes)

        client = self._text_client(tenant_id, group.lead, system_prompt)
        payload = await client.judge_raw(prompt=prompt, system_prompt=system_prompt, schema=schema)
        stats = judge_call_stats(payload, client.provider, client.model)
        self._stats.append(stats.to_dict())
        record_guardrail_call(
            provider=stats.provider,
            model=stats.model,
            status="success",
            prompt_tokens=stats.prompt_tokens,
            completion_tokens=stats.predicted_tokens,
        )
        content = str(payload.get("content") or "").strip()
        floors = {s.lane: s.min_confidence for s in group.selections}
        if lanes == (jp.MEDICAL_LANE,):
            try:
                raw = json.loads(content)
            except (TypeError, ValueError):
                raw = None
            return {jp.MEDICAL_LANE: jp.parse_lane(jp.MEDICAL_LANE, raw, floors[jp.MEDICAL_LANE])}
        return jp.parse_combined(content, lanes, min_confidence=floors)

    async def _call_native(
        self, tenant_id: str, group: _Group, text: str, mode: str, context: str
    ) -> dict[str, jp.ParsedLane]:
        lead = group.lead
        if jp.native_judge_transport(getattr(lead.cfg, "served_by", None)) == "text":
            return await self._call_native_text(tenant_id, group, text, mode, context)
        return await self._call_native_nlp(tenant_id, group, text, mode, context)

    async def _call_native_text(
        self, tenant_id: str, group: _Group, text: str, mode: str, context: str
    ) -> dict[str, jp.ParsedLane]:
        """An LM Studio-served native guard: TEXT ``native_chat``, parsed here."""
        from guardrail.services.external_text_client import judge_call_stats

        lead = group.lead
        client = self._text_client(tenant_id, lead, None)
        payload = await client.judge_native_chat(
            messages=jp.native_chat_messages(mode, context, text)
        )
        stats = judge_call_stats(payload, client.provider, client.model)
        self._stats.append(stats.to_dict())
        record_guardrail_call(
            provider=stats.provider,
            model=stats.model,
            status="success",
            prompt_tokens=stats.prompt_tokens,
            completion_tokens=stats.predicted_tokens,
        )
        native = jp.parse_qwen3guard_text(str(payload.get("content") or ""), mode=mode)
        if native["tier"] == jp.QWEN3GUARD_UNDETERMINED:
            # PHI-safe: the reason code only, never the completion or the input.
            logger.warning(
                "guardrail.judge_runner.native_undetermined",
                reason=str(native["undetermined_reason"] or ""),
            )
        return jp.map_qwen3guard(native, group.lanes, lead.meta or {})

    async def _call_native_nlp(
        self, tenant_id: str, group: _Group, text: str, mode: str, context: str
    ) -> dict[str, jp.ParsedLane]:
        from guardrail.services.external_nlp_client import NlpGuardClient

        lead = group.lead
        settings = self._settings
        client = NlpGuardClient(
            base_url=settings.nlp_url,
            service_token=settings.peer_service_token(settings.service_token),
            http_client=self._http,
            tenant_id=tenant_id,
            model_id=lead.model,
            timeout_s=lead.nlp_deadline_s,
            breaker=self._breakers.get("nlp"),
        )
        payload = await client.judge(
            protocol=jp.QWEN3GUARD_NATIVE,
            mode=mode,
            prompt=context if mode == "response" else text,
            response=text if mode == "response" else None,
            max_new_tokens=lead.max_tokens,
            temperature=lead.temperature,
        )
        if payload.get("tier") == "undetermined":
            logger.warning(
                "guardrail.judge_runner.native_undetermined",
                reason=str(payload.get("undetermined_reason") or ""),
            )
        return jp.map_qwen3guard(payload, group.lanes, lead.meta or {})

    def _text_client(self, tenant_id: str, lead: _Selection, criteria: str | None) -> Any:
        """A TEXT judge-lane client; ``criteria=None`` builds the ``native_chat`` one."""
        from guardrail.core.effective_config import DEFAULT_JUDGE_TIMEOUT_S
        from guardrail.core.tenant_config import _judge_connection
        from guardrail.services.external_text_client import TextJudgeClient

        settings = self._settings
        try:
            overrides = _judge_connection(lead.provider, self._overrides, lead.cfg)
        except AttributeError:
            overrides = self._overrides
        return TextJudgeClient(
            base_url=settings.text_url,
            http_client=self._http,
            service_token=settings.peer_service_token(settings.service_token),
            provider=lead.provider,
            model=lead.model,
            tenant_id=tenant_id,
            criteria=criteria,
            policy=settings.judge,
            min_confidence=lead.min_confidence,
            temperature=lead.temperature,
            max_tokens=lead.max_tokens,
            timeout_s=lead.timeout_s if lead.timeout_s is not None else DEFAULT_JUDGE_TIMEOUT_S,
            provider_overrides=overrides,
            breaker=self._breakers.get("text"),
            native_chat=criteria is None,
        )

    # -- merging -------------------------------------------------------------

    @staticmethod
    def _merge(
        out: dict[tuple[str, str], LaneVerdict], verdict: LaneVerdict, window: JudgeWindow
    ) -> None:
        """Worst-of per ``(lane, region_key)``: flag > undetermined > pass."""
        key = (verdict.lane, window.region_key)
        current = out.get(key)
        if current is None or _SEVERITY[verdict.verdict] > _SEVERITY[current.verdict]:
            out[key] = verdict


# ── building ────────────────────────────────────────────────────────────────


async def build_judge_runner(
    tenant_id: str,
    *,
    resolver: Any,
    settings: Any,
    http_client: Any = None,
    cache: WindowVerdictCache | None = None,
    policy_version: str | None = None,
    provider_overrides: dict[str, Any] | None = None,
    judge_timeout_s: float | None = None,
    breakers: Mapping[str, Any] | None = None,
    single_flight: SingleFlight | None = None,
    concurrency: int = 4,
    draft_policy: Mapping[str, Any] | None = None,
    draft_judge_meta: Mapping[str, Any] | None = None,
) -> JudgeRunner:
    """The frozen W2a↔W2a2 seam. Everything after ``settings`` is optional wiring.

    ``http_client`` is required to actually call a peer; without one every lane is undetermined
    ``JUDGE_ENGINE_ERROR`` (the runner still never raises). Routes call
    :func:`build_judge_runner_for_app`, which fills every optional from ``app.state``.
    """
    return JudgeRunner(
        tenant_id=tenant_id,
        resolver=resolver,
        settings=settings,
        http_client=http_client,
        cache=cache,
        policy_version=policy_version,
        provider_overrides=provider_overrides,
        judge_timeout_s=judge_timeout_s,
        breakers=breakers,
        single_flight=single_flight,
        concurrency=concurrency,
        draft_policy=draft_policy,
        draft_judge_meta=draft_judge_meta,
    )


async def build_judge_runner_for_app(
    app_state: Any,
    tenant_id: str,
    *,
    provider_overrides: dict[str, Any] | None = None,
    dry_run: bool = False,
    draft_policy: Mapping[str, Any] | None = None,
    draft_judge_meta: Mapping[str, Any] | None = None,
) -> JudgeRunner:
    """A runner wired from ``app.state``: http client, breakers, judge timeout, cache, policy version.

    ``dry_run`` builds a runner that shares NOTHING: no cache (a draft verdict must never be stored
    under the live policy version) and a private single-flight.
    """
    from hope_env import real_secret

    from guardrail.core.dependencies import resolve_judge_timeout_s, resolve_screen_policy
    from guardrail.core.policy_version import (
        PolicyVersionUnavailableError,
        resolve_policy_version,
    )

    settings = app_state.settings
    screen_policy = await resolve_screen_policy(app_state, tenant_id)
    cache: WindowVerdictCache | None = None
    policy_version: str | None = None
    if not dry_run:
        secret_field = getattr(settings, "window_cache_key", None)
        secret = real_secret(secret_field) if secret_field is not None else ""
        cache = WindowVerdictCache.build(
            getattr(app_state, "redis", None), secret, ttl_s=screen_policy.window_cache_ttl_seconds
        )
        if cache is not None:
            try:
                policy_version = await resolve_policy_version(app_state, tenant_id)
            except PolicyVersionUnavailableError as exc:
                logger.warning("guardrail.judge_runner.no_policy_version", error=str(exc))
    breakers = getattr(app_state, "circuit_breakers", None)
    return await build_judge_runner(
        tenant_id,
        resolver=getattr(app_state, "tenant_config_resolver", None),
        settings=settings,
        http_client=getattr(app_state, "http_client", None),
        cache=cache,
        policy_version=policy_version,
        provider_overrides=provider_overrides,
        judge_timeout_s=await resolve_judge_timeout_s(app_state),
        breakers=breakers if isinstance(breakers, dict) else None,
        single_flight=(
            SingleFlight()
            if dry_run
            else getattr(app_state, "judge_single_flight", None) or DEFAULT_SINGLE_FLIGHT
        ),
        concurrency=screen_policy.screen_window_concurrency,
        draft_policy=draft_policy,
        draft_judge_meta=draft_judge_meta,
    )


# ── identical lane sets for the two inbound routes ───────────────────────────────


def judge_geometry(screen_policy: GuardrailPolicy, judge_max_input_chars: int) -> WindowGeometry:
    """The judge window: the screen window bounded by the judge input cap (`build_judge_window_plan`)."""
    from guardrail.core.policy_version import judge_window_chars

    _size, overlap = screen_policy.screen_window_geometry
    size = judge_window_chars(screen_policy, judge_max_input_chars)
    return WindowGeometry(
        size=size,
        overlap=min(overlap, max(0, size - 1)),
        concurrency=screen_policy.screen_window_concurrency,
    )


async def enabled_inbound_safety_lanes(app_state: Any, tenant_id: str) -> tuple[str, ...]:
    """The inbound safety-judge lanes this tenant's availability turns on (canonical order).

    Empty when the resolver is not wired — no judge model could be resolved anyway. Otherwise one
    availability read (`core/dependencies._resolve_availability`, the screener's own), so the
    medical route and the screen route cannot disagree on the set.
    """
    if getattr(app_state, "tenant_config_resolver", None) is None:
        return ()
    from guardrail.core.dependencies import _resolve_availability

    availability = await _resolve_availability(app_state, tenant_id)
    is_enabled = getattr(availability, "is_enabled", None)
    if not callable(is_enabled):
        return ()
    return tuple(lane for lane in jp.INBOUND_SAFETY_LANES if is_enabled(lane))


def window_region_key(region: str, offset: int) -> str:
    """The unique per-window ``region_key``: ``<region>@<offset>``."""
    return f"{region}@{offset}"


def region_of(region_key: str) -> str:
    """The region a :func:`window_region_key` came from."""
    return region_key.rsplit("@", 1)[0] if "@" in region_key else region_key


#: Region keys that carry the platform's OWN earlier output (screened by TEXT's output gate
#: when generated). A protocol name shared with the live lane (`LIVE_SELF_NOTE_REGION_KEY`),
#: not configuration. TASK-1050 / TASK-1049 F7.
SELF_OUTPUT_REGIONS: Final[frozenset[str]] = frozenset({"current_note"})


def plan_inbound_judge_calls(
    regions: Iterable[tuple[str, str, str]],
    *,
    enabled_safety_lanes: Iterable[str],
    medical_skip: frozenset[str],
    geometry: WindowGeometry,
    include_medical: bool = True,
    items: Mapping[str, tuple[tuple[str, int], ...]] | None = None,
) -> list[tuple[tuple[str, ...], list[JudgeWindow]]]:
    """``[(lanes, windows)]`` — the inbound judge calls for a request, grouped by lane set.

    Per region ``(key, text, trust)``: ``medical_validation`` unless ``include_medical`` is False or
    ``key`` is a configuration block (``medical_skip``); plus every enabled inbound safety lane when
    ``trust == "data"`` (A3: the inbound judges screen DATA regions only). Same inputs ⇒ the same
    plan, so two routes building from the same request make the same calls. ``items`` optionally
    maps a region key to its source ``(itemId, itemVersion)`` pairs.
    """
    safety = tuple(lane for lane in jp.INBOUND_SAFETY_LANES if lane in set(enabled_safety_lanes))
    plan: dict[tuple[str, ...], list[JudgeWindow]] = {}
    for key, text, trust in regions:
        wanted: list[str] = []
        if include_medical and key not in medical_skip:
            wanted.append(jp.MEDICAL_LANE)
        # F7: the live lane's own previous note is never re-judged by ANY lane (its medical
        # skip comes from `medicalJudgeConfigRegions`). Other settings regions stay
        # safety-judged: tenant-authored text can still carry an injection.
        if trust == "data" and key not in SELF_OUTPUT_REGIONS:
            wanted.extend(safety)
        lanes = jp.canonical_lanes(wanted)
        if not lanes:
            continue
        source = (items or {}).get(key, ())
        for window in region_windows(key, text, geometry):
            plan.setdefault(lanes, []).append(
                JudgeWindow(window_region_key(key, window.offset), window.text, source)
            )
    return list(plan.items())
