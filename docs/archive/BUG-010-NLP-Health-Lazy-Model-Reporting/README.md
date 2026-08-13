# BUG-010 — NLP `/health` reports lazy models as permanently unhealthy

- **Status:** Review
- **Type:** bugfix
- **Area:** `apps/nlp` (Python microservice health contract)
- **Reported symptom:** Admin console → AI Services → NLP tab shows `status: degraded` with
  `text_classifier`, `token_classifier`, `text_corrector`, `medical_suggester` all `unhealthy`
  (each `duration_ms: 0`) on a freshly booted, otherwise-functional NLP service.

## Requirement Analysis

The NLP service must report an accurate health document:

1. A cold, lazily-loaded model is **not a fault** — a booted worker intentionally holds zero ML
   weights (see `nlp/lifespan.py`). Health must not report it as `unhealthy`, and must not drag
   `overall` to `degraded`/`unhealthy`.
2. Health must observe **the objects that actually serve production traffic**, so that once a model
   is loaded, health reflects it.
3. `/health/ready` must not gate readiness on lazy model loads — a booted process that can
   lazy-load on first request is ready.

The HOPE health contract (three statuses `healthy|degraded|unhealthy`; `/health`, `/health/live`,
`/health/ready`) is unchanged. The per-component vocabulary gains `lazy`, matching the existing
`guardrail` precedent.

## Current State Evaluation (root cause)

`apps/nlp/src/nlp/api/v1/rest/monitoring.py` builds `checks` by calling the **singleton** getters
`get_text_classifier` / `get_token_classifier` / `get_medical_suggester` / `get_text_corrector`
(from `nlp/dependencies.py`) and reading `is_initialized`.

But the REST inference routes resolve models through a **separate per-request `ModelCache`**:

| Route | Resolves via | Same object health inspects? |
|---|---|---|
| REST `POST /classify/text` | `pinned_text_classifier` → `_text_classifier_cache` | ❌ No |
| REST `POST /classify/tokens` | `pinned_token_classifier` → `_token_classifier_cache` | ❌ No |
| REST `POST /diagnosis` | `pinned_medical_suggester` → `_medical_suggester_cache` | ❌ No |
| REST `POST /correct` | `get_text_corrector` singleton | ✅ Yes (genuine process singleton) |
| WS `/classify` | `get_text_classifier` / `get_token_classifier` singletons | ✅ Yes |

Consequences:

- `text_classifier`, `token_classifier`, `medical_suggester` singletons are **never initialized by
  REST inference** (the path the gateway/admin uses), so they report `unhealthy` indefinitely,
  even after serving successful inference. `medical_suggester`'s singleton is referenced *only* by
  the health endpoint, so it can never become healthy by any code path.
- On a fresh idle boot, all four are uninitialized → each `unhealthy` → `overall: degraded`. This is
  the reported symptom; the service is actually fine.
- `/health/ready` returns `503 "No models loaded"` at idle and stays there, so k8s / gateway
  health-gating never marks a working pod ready.

The regression was invisible because `tests/conftest.py` presets every singleton to a
`FakeService(is_initialized=True)`, masking the singleton-vs-cache divergence.

**Precedent for the correct behavior already exists in-repo:** `guardrail`'s `_gliner_status`
(`apps/guardrail/src/guardrail/api/endpoints/health.py`) reports its lazy GLiNER cache as
`status: "lazy"` with `loaded_models` from `cache.cached_models()`, and explicitly never degrades
health. `smr` degrades only on real dependency failures (Redis / provider ping).

## Implementation Plan (TDD)

1. **RED** — `apps/nlp/tests/test_health.py`:
   - idle `/health` → `overall == "healthy"`; every component check `status == "lazy"`,
     `loaded is False`; the three cache-backed checks carry `loaded_models == []`.
   - a warmed cache surfaces in `loaded_models` and flips `loaded` to `True`, overall still healthy.
   - `/health/ready` → `200` / `healthy` with **no** models loaded (idle).
2. **GREEN**
   - `nlp/dependencies.py`: add `model_cache_snapshot()` returning resident model ids per
     cache-backed component, reading the existing cache globals **without forcing construction**
     (reuses the `_CACHE_GLOBALS` machinery).
   - `nlp/api/v1/rest/monitoring.py`: report the three cache-backed components as `lazy` with real
     resident-model lists; report `text_corrector` as a lazy singleton (`loaded = is_initialized`);
     `overall` stays `healthy` (no hard dependencies fail in this endpoint); decouple `/health/ready`
     from lazy model loading (ready once the process is up).
3. **REFACTOR / verify** — `pnpm nlp:test`, `py:nlp:lint`, `py:nlp:typecheck`.

## Verification Criteria

- New health tests pass; existing liveness/root tests still pass.
- `ruff` + `mypy` clean for `apps/nlp`.
- Admin console renders the new shape unchanged (defensive `UpstreamDocument` renderer;
  `status` → badge, `loaded_models` → key/value). No admin-console change required.

## Implementation Summary

Files changed:

- `apps/nlp/src/nlp/dependencies.py` — added `_COMPONENT_CACHE_GLOBALS` + `model_cache_snapshot()`:
  resident model ids per cache-backed component, read from the live cache globals **without forcing
  construction** (a cold worker reports `[]`).
- `apps/nlp/src/nlp/api/v1/rest/monitoring.py` —
  - `/health`: the three cache-backed components (`text_classifier`, `token_classifier`,
    `medical_suggester`) now report `status: "lazy"` with `loaded` + `loaded_models` sourced from the
    **ModelCache that serves inference** (not the `get_*` singletons). `text_corrector` reports
    `status: "lazy"` with `loaded = is_initialized` (it is a genuine SymSpell process singleton).
    `overall` is `healthy` when the process is up — a cold lazy model is not a fault.
  - `/health/ready`: decoupled from lazy model loading — ready once startup completed
    (`effective_config_client` constructed), `503 "Service is starting"` only before that.
  - Removed the now-unused singleton getter imports and the `_MODELS` table.
- `apps/nlp/tests/test_health.py` — added BUG-010 regression tests (idle-is-healthy-and-lazy;
  resident models surface from the cache; readiness ready without warmed models).

Behavior (real, **unmocked** app via `TestClient`, cold boot):

```
GET /api/v1/health        -> 200  status=healthy
  text_classifier   : {status: lazy, loaded: false, loaded_models: []}
  token_classifier  : {status: lazy, loaded: false, loaded_models: []}
  medical_suggester : {status: lazy, loaded: false, loaded_models: []}
  text_corrector    : {status: lazy, loaded: false}
GET /api/v1/health/ready  -> 200  status=healthy        (was 503 "No models loaded")
```

The admin console renders this unchanged — the NLP panel proxies the document verbatim through the
defensive `UpstreamDocument` renderer (`status` → badge, `loaded_models` → key/value). No
admin-console change required.

### Evidence

- `pytest apps/nlp/tests/test_health.py` — 6 passed (3 new BUG-010 guards).
- `pytest apps/nlp/tests/` — **184 passed**.
- `ruff check` on the three changed files — clean.
- `mypy --config-file apps/nlp/pyproject.toml apps/nlp/src/` — no error attributable to this change.

### Out of scope (pre-existing, present at HEAD — NOT fixed here)

- `apps/nlp/src/nlp/dependencies.py:184` — `_retention_kwargs()` returns `dict[str, int]` but includes
  `"metrics": build_model_cache_metrics_sink()`; mypy `dict-item` error. Pre-existing.
- `apps/nlp/tests/test_model_cache_retention.py:11` — ruff `I001` import-order. Pre-existing.

Both block the `py:nlp` gates independently of this fix; flagged for a separate cleanup.

## Change History

- 2026-07-23 — Ticket opened; root cause identified (health inspects singletons, inference uses
  per-request `ModelCache`); plan drafted against the `guardrail` lazy-cache precedent.
- 2026-07-23 — Implemented (TDD): `model_cache_snapshot()` + rewritten `/health` and `/health/ready`;
  6 health tests green, full nlp suite 184 passed; runtime-proven on the unmocked app. Status → Review.
  Noted two pre-existing `py:nlp` gate failures as out of scope.
