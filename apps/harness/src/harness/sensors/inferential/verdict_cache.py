"""TASK-359 WS-1 — content-addressed per-claim verdict cache (L1 intra-pass + L2 carrier).

The inferential judge is the costly part of the harness gate; across a regen loop the SAME
claim is otherwise re-judged on every pass. This module is the *content-addressed* primitive
that lets an inferential sensor reuse a prior verdict for an unchanged claim — WITHOUT ever
changing the verdict (the TASK-355 verdict-parity rail, AC-2):

* :func:`claim_verdict_key` hashes the **exact bytes the judge receives** — the post-clean
  claim text (already cleaned upstream by ``provenance._clean_claim_text``; we do **not** apply
  any further lossy ``normalize_text``/lowercasing — a red-team correction, see TASK-359
  §4.1 WS-1), the sensor's premise, and a stable sensor/judge identity. Same inputs ⇒ same key
  ⇒ (deterministic ``temperature=0`` judge) same verdict; a miss re-judges.
* :func:`sensor_identity` composes the identity component (sensor name + a prompt-version +
  the judge/model id) so a model swap or a prompt edit yields a different key (auto-invalidation).
* :data:`VerdictCache` is the carrier type: a plain ``dict[str, bool]`` (key → supported). The
  SAME dict is both the **L1** intra-pass memo (two identical claims in one pass collapse to one
  key) and the **L2** workflow-run carrier (the Temporal workflow threads it from one inferential
  pass's OUTPUT into the next pass's INPUT as additive-optional, data-only fields — no new
  workflow command, no ``workflow.patched()``).
* :func:`cached_verdict` is the get-or-compute helper the sensors use so the hit/miss/populate
  semantics (conservative miss) are identical across groundedness (WS-1) and the later
  citation_verify (WS-2) / safety (TASK-363) reuse.

L3 (a cross-run/persistent store) is intentionally NOT implemented here: it is default-OFF
pending a privacy review (TASK-359 §4.5). The key is L3-ready (optional HMAC) but nothing in
this module writes outside the in-memory ``dict`` the caller owns.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from collections.abc import Awaitable, Callable

# The carrier IS a plain dict: key → supported verdict. The same instance serves the L1
# intra-pass memo and the L2 workflow-run carrier (threaded via additive activity I/O).
VerdictCache = dict[str, bool]

# Bump when the key construction changes (invalidates every prior entry).
KEY_SCHEMA_VERSION = "v1"

# Unit Separator — an unambiguous field delimiter never present in clinical text, so the
# concatenation cannot collide (``a|b`` vs ``ab|``).
_SEP = "\x1f"

# Optional HMAC secret (L3-ready). When set, keys are HMAC-SHA256 instead of bare SHA-256 so a
# persisted key cannot be linked back to its inputs even in theory. Unset (the L1/L2 default) ⇒
# plain SHA-256, which is deterministic and stable ACROSS worker processes (so the L2 carrier
# keys from pass N line up with the lookups in pass N+1 on any worker). Read once at import.
_HMAC_SECRET = os.environ.get("HARNESS_VERDICT_CACHE_HMAC_KEY", "").encode("utf-8")


def claim_verdict_key(claim_text: str, premise: str, judge_identity: str) -> str:
    """Content-addressed cache key for one per-claim judge verdict (a hex digest).

    Hashes the EXACT bytes the judge receives — ``claim_text`` (the post-clean hypothesis),
    ``premise`` (the sensor's ``_premise(...)`` output) and ``judge_identity`` (a stable
    sensor/prompt/model identity, see :func:`sensor_identity`) — so an identical judge call maps
    to an identical key and a deterministic judge yields the identical verdict (AC-2). NEVER
    keyed on the positional ``claim-{n}`` id (unstable across a regen).
    """
    payload = _SEP.join((KEY_SCHEMA_VERSION, judge_identity, premise, claim_text)).encode("utf-8")
    if _HMAC_SECRET:
        return hmac.new(_HMAC_SECRET, payload, hashlib.sha256).hexdigest()
    return hashlib.sha256(payload).hexdigest()


def sensor_identity(sensor_name: str, system_prompt: str, model: str) -> str:
    """Compose the stable ``judge_identity`` component for :func:`claim_verdict_key`.

    Combines the sensor name + a prompt-version (a short hash of the sensor system prompt, so a
    prompt edit changes the key) + the judge/model id (so a model swap changes the key) — the
    two auto-invalidation levers the broader-cache design requires (TASK-359 §4.5).
    """
    prompt_version = hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:16]
    return _SEP.join((sensor_name, prompt_version, model))


async def cached_verdict(
    cache: VerdictCache | None,
    *,
    key: str,
    compute: Callable[[], Awaitable[bool]],
) -> bool:
    """Return a cached verdict on HIT, else ``await compute()`` and populate on MISS.

    ``compute`` MUST already apply the sensor's conservative parsing (an unparseable / ambiguous
    judge response ⇒ ``False`` / ungrounded) so only a final, conservative boolean is ever
    cached. A miss ALWAYS re-judges (never assumes grounded). With ``cache is None`` this is a
    straight passthrough (today's uncached behaviour).

    Note: intra-pass dedupe of two CONCURRENT identical-key claims is best-effort (both may miss
    before either populates — same input ⇒ same verdict, so parity is unaffected); the
    deterministic win is cross-pass reuse, where the cache is fully populated before the next pass.
    """
    if cache is not None and key in cache:
        return cache[key]
    verdict = await compute()
    if cache is not None:
        cache[key] = verdict
    return verdict
