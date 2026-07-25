# TASK-478 — SMR Input Guardrail: Fail-Open → Fail-Closed / Degrade-Safe (Theme D1 · SOTA S3)

- **Status**: Completed -- all 6 ACs met (RED->GREEN) + review-delta applied (stale FAIL_OPEN removed from both deploy artifacts) + gates green (smr 774 passed, lint/typecheck clean); only the owner's own push/PR to main remains (per owner directive, they land it)
- **Type**: bugfix (clinical-safety posture — PHI moderation)
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **D1** (Live-surface guardrails — independent safety win)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA S3 (guardrail fail-posture) — "an outage ships unmoderated PHI prompts"
- **Pairs with**: [TASK-465](../TASK-465-NLP-Guardrail-Service-Token-Enforcement/README.md) (the fail-closed **service-token** posture — same fail-closed family, receiver-side) and completes the sender-side of the guardrail-failure story before [TASK-479](../SOTA-Track/README.md) (D2 live output/groundedness gate) builds on it.
- **Theme**: D1 · **Size**: S–M · **Value**: High (PHI safety) · **Risk**: Med (changes outage behavior — must degrade safely, not brick generation)
- **Depends on**: none (independent of the ASR/NER measurement gate — this is a guardrail posture change, not a quality claim).
- **Suggested agent**: security-auditor (mirrors TASK-460 / TASK-465)

## File-ownership manifest (best-effort exclusive — binding)

| File | Change |
|---|---|
| `apps/smr/src/smr/services/external_guardrail.py` | Eliminate the fail-**open** branch (:74-80); make the on-error path **degrade-safe → fail-closed** (bounded retry, then a deterministic not-allowed verdict — never `allowed: True` on an error). Remove the `require_medical=False` allow-all foot-gun from the clinical path (:66) or gate it explicitly. |
| `apps/smr/src/smr/core/config.py` | `ExternalGuardrailConfig` (:77-86): retire/repurpose `fail_open` (default `False` today, but its mere existence is the foot-gun); add bounded-retry knobs (`max_retries`, `retry_backoff_ms`); document `enabled` as the empty-bypass switch (dev/CI) vs the clinical enforce posture. |
| `apps/smr/src/smr/api/endpoints/generate.py` | The gate (:132-145): close the two silent bypasses — `verdict.get("allowed", True)` (:141) must default to **False** (fail-closed) on a missing/malformed verdict; when moderation is required but `guardrail_client is None`, **fail-closed** rather than skip. |
| `apps/smr/src/smr/tests/test_external_guardrail*.py` (extend/new) | RED→GREEN: transient blip (1 error then success) → generation PROCEEDS (degrade-safe, bounded retry absorbs it); sustained outage → **reject, never generate** (fail-closed); disabled/empty → dev bypass preserved; malformed verdict → fail-closed. |
| `apps/smr/src/smr/tests/` (endpoint test) | The `/generate` gate: `guardrail_client is None` + enforce → 4xx/5xx reject (not a silent pass); `allowed` missing → reject. |
| `turbo.json` · `.env.example` | Register any new `SMR_EXTERNAL_GUARDRAIL_*` retry knobs (per `.claude/rules/00`/`06`). |

**Read-only reference (do NOT modify)**: `apps/smr/src/smr/api/middleware/auth.py` (the SMR `X-Service-Token` middleware — the reference fail-closed pattern), `apps/smr/src/smr/core/dependencies.py` (:83-85 `get_guardrail_client`), `apps/smr/src/smr/main.py` (:55-68 wiring, :203 the explicit `None`), `apps/smr/src/smr/models/requests.py` (:21-23 the `prompt` field).

**Manifest-growth guard (STOP-and-report)**: this ticket is **input-side** only. The **output-side / groundedness** moderation gate is D2 ([TASK-479](../SOTA-Track/README.md)) — do NOT add output moderation here. The guardrail **receiver** enforcement is done ([TASK-465](../TASK-465-NLP-Guardrail-Service-Token-Enforcement/README.md)) — do NOT touch `apps/guardrail`. If flipping `enabled`'s default to on for production surfaces a wiring/provisioning need (guardrail reachable in prod), that is an **ops rollout** step (mirror TASK-465 §Ops rollout ordering) — record it, don't hard-wire a prod URL.

## Requirement Analysis

SMR's `/generate` input moderation must never let a guardrail failure **ship an unmoderated PHI prompt** to the LLM — but it also must not **brick generation on a transient guardrail blip**. The target is **fail-closed / degrade-safe**: a momentary error is absorbed by a bounded retry (generation proceeds after a clean re-check), and only a *sustained* outage results in a fail-closed rejection (a clear, retryable error) — never a silent pass-through of unmoderated clinical text. This is the sender-side counterpart to TASK-465's receiver-side fail-closed `X-Service-Token` posture.

### Current-state framing correction (verified — the ticket premise is refined by the code)

The SOTA one-liner is "input validation defaults fail-open (an outage ships unmoderated PHI prompts)." The code is more nuanced, and the ticket must target the real gaps:

1. **The literal fail-open branch exists but is flag-gated `False` by default.** `external_guardrail.py:74-80` returns `allowed: True` on any exception **only when `settings.fail_open` is `True`**; `fail_open` defaults to `False` (`config.py:83`), so an *enabled* guardrail today actually fails **closed** (422). The foot-gun is that `fail_open=True` is a single config flip away from silently shipping unmoderated PHI on every outage — it should not exist as a clinical option.
2. **The de-facto default-open is that moderation is DISABLED by default.** `enabled` defaults to `False` (`config.py:80`), so `validate()` short-circuits to `allowed: True` **without ever calling the safety service** (`external_guardrail.py:34-40`). In a default deployment, prompts are **unmoderated** — this is the real "ships unmoderated" today.
3. **Three more silent allow-all bypasses**: `require_medical=False` forces `allowed: True` even with a reachable guardrail (`external_guardrail.py:66`); a `None` client (`get_guardrail_client` → `None`, `dependencies.py:85`; explicit at `main.py:203`) skips the whole gate (`generate.py:135`); and `verdict.get("allowed", True)` **defaults to allow** if the verdict lacks the key (`generate.py:141`).

So D1's work is: **remove the fail-open branch**, make the error path **bounded-retry-then-fail-closed**, and **close the default-allow bypasses** — while preserving the empty/disabled **dev-and-CI bypass** exactly as TASK-465 preserved the empty-token bypass (local dev + hermetic CI must stay green without a guardrail up).

### Acceptance criteria

- [ ] **AC-1 (no fail-open — RED first)** — a test sets `fail_open=True` (today's foot-gun) + a guardrail error and asserts the request currently PROCEEDS (fail-open). Then the fail-open branch is removed so the same scenario **rejects** (or degrade-retries then rejects) — an errored guardrail can NEVER return `allowed: True`. Assert no code path yields `allowed: True` from the `except` block.
- [ ] **AC-2 (degrade-safe on transient blip)** — a test where the guardrail errors **once then succeeds** asserts generation PROCEEDS after the bounded retry (the blip is absorbed — NOT a hard-fail). Bounded retry count + backoff are config-driven (`max_retries`, `retry_backoff_ms`) with small safe defaults.
- [ ] **AC-3 (fail-closed on sustained outage)** — a test where the guardrail errors on **every** attempt asserts the request is **rejected with a clear, retryable error** (e.g. 503 "guardrail unavailable, retry") and generation is **never invoked** (assert the provider `generate` is not called). No silent pass.
- [ ] **AC-4 (close the default-allow bypasses)** — `generate.py:141` defaults to **fail-closed** on a missing/malformed `allowed` key; when moderation is required and the client is `None`, the gate **fails closed** (not skipped). Tests for both.
- [ ] **AC-5 (dev/CI bypass preserved)** — with `enabled=False` (or empty config), `validate()` still short-circuits `allowed: True` (the documented dev/hermetic-CI bypass, mirroring TASK-465's empty-token bypass) — the full existing SMR suite stays green with no guardrail service up. The clinical **enforce** posture (enabled) is documented as the ops/production configuration.
- [ ] **AC-6 (pairs with TASK-465)** — §Implementation Summary states the combined posture: TASK-465 = receiver enforces `X-Service-Token` (fail-closed); TASK-478 = sender treats a guardrail failure as degrade-safe→fail-closed; together an unmoderated PHI prompt cannot reach the LLM on either an auth failure or a guardrail outage.
- [ ] **AC-gate** — `pnpm py:smr:test` (+ `:unit`), `pnpm py:smr:lint`, `pnpm py:smr:typecheck` green; new `SMR_EXTERNAL_GUARDRAIL_*` retry knobs in `turbo.json#globalEnv` + `.env.example`; output pasted.

### Non-goals

- **Output-side / groundedness moderation** (post-generation NLI gate) — that is D2 ([TASK-479](../SOTA-Track/README.md)); this ticket is input-side only.
- Guardrail **receiver** enforcement — done in [TASK-465](../TASK-465-NLP-Guardrail-Service-Token-Enforcement/README.md); `apps/guardrail` is untouched here.
- Changing the guardrail's medical-validation semantics or the `/api/medical/validate` contract.
- Rotating/short-lived tokens; re-architecting the guardrail client transport.
- Forcing `enabled=True` in local dev / hermetic CI (the empty/disabled bypass stays — production enablement is an ops rollout step, not a code default that breaks dev).

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ 87b33f57)

**The single moderation path** — `apps/smr/src/smr/services/external_guardrail.py`, `ExternalGuardrailClient.validate(prompt, system_prompt, tenant_id)`:
- **Disabled short-circuit (the default-open)** — :34-40: `if not self.settings.enabled: return {"allowed": True, …, "reason": "external_guardrail_disabled"}`. `enabled` defaults `False` (`config.py:80`) → no check runs by default.
- **HTTP call** — :52-62: `POST {base_url}/api/medical/validate` with `X-Service-Token` (:44-46, present-only — the receiver enforces it per TASK-465) and `X-Tenant-Id`. On success (:64-71): `allowed = is_medical if require_medical else True` — so **`require_medical=False` is an allow-all** (:66).
- **THE FAIL-OPEN SITE** — :72-87: `except Exception as exc:` → **if `self.settings.fail_open:` return `{"allowed": True, …, "reason": "external_guardrail_failed_open"}`** (:74-80) — the branch to remove; else return `{"allowed": False, …, "reason": "external_guardrail_unavailable"}` (:81-87, the current default since `fail_open=False`). No retry today — a single blip immediately decides.

**Config** — `apps/smr/src/smr/core/config.py:77-86`, `ExternalGuardrailConfig` (`env_prefix="SMR_EXTERNAL_GUARDRAIL_"`): `enabled=False` (:80), `base_url` (:81), `timeout_s=10` (:82), `fail_open=False` (:83), `require_medical=True` (:84), `include_reasoning=False` (:85), `service_token: SecretStr("")` (:86). Registered on root settings (`config.py:159`).

**The gate** — `apps/smr/src/smr/api/endpoints/generate.py:132-145`, inline in the `POST /generate` handler, BEFORE any generation: `if guardrail_client is not None:` (:135) → `validate(...)` → `if not verdict.get("allowed", True): raise HTTPException(422, …)` (:141-145). Two silent bypasses: **`guardrail_client is None` skips the entire gate** (client injected at :126 via `get_guardrail_client`, which returns `None` when unwired — `dependencies.py:83-85`, explicit `None` at `main.py:203`); and **`verdict.get("allowed", True)` defaults to allow** on a missing key (:141). Streaming (:216) and non-streaming (:280-283) generation are both after this single gate.

**PHI context** — the input is consultation/clinical text by domain (`external_guardrail.py:16` "medical-content validation"; tenant forwarded for per-tenant provider resolution :47-48; `require_medical=True` default; endpoint `/api/medical/validate`), but the `prompt` field is a **generic `str`** with no PHI/clinical type annotation (`models/requests.py:21-23`) — a typing gap worth a note, not fixed here.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-465 README (the receiver-side fail-closed pattern + the empty-bypass posture to mirror) · TASK-460 §C4-04 (the fail-open/fail-closed asymmetry write-up) · SOTA-Track §Theme D · `.claude/rules/06-python-services.md` (pydantic-settings `env_prefix`, `SecretStr`, ruff/mypy, hermetic-CI posture) · `.claude/rules/04`/`05` (404-over-403, clinical-safety posture).

1. **RED (fail-open + bypasses)** — tests that today (a) `fail_open=True` + error → proceeds; (b) `enabled=True` + sustained error → 422 but with no retry; (c) missing `allowed` key → proceeds; (d) `None` client → gate skipped. Watch them capture the current behavior.
2. **GREEN (client)** — in `external_guardrail.py`: wrap the call in a bounded retry (`max_retries`/`retry_backoff_ms`); on exhausted retries return a deterministic not-allowed verdict (`reason: external_guardrail_unavailable`); **delete the `fail_open` branch** so no error path yields `allowed: True`. Decide `require_medical=False`'s fate (keep as an explicit non-clinical mode, documented; the clinical path enforces).
3. **GREEN (gate)** — in `generate.py`: `verdict.get("allowed", False)` (fail-closed default); when moderation is required and the client is `None`, reject (or refuse to serve) rather than skip. Map a sustained-outage verdict to a **retryable** status (503) distinct from a content rejection (422).
4. **Config + bypass** — retire/repurpose `fail_open`; add retry knobs; keep `enabled=False` empty/dev bypass; document the production enforce posture (ops rollout, mirroring TASK-465 §Ops rollout ordering).
5. **Env + gates** — register knobs in `turbo.json#globalEnv` + `.env.example`; run the SMR gates.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm py:smr:test          # external_guardrail + generate gate suites
pnpm py:smr:lint && pnpm py:smr:typecheck
```

Adversarial review focus: (a) can ANY error path still yield `allowed: True` (grep the `except`/verdict handling)? (b) does a single transient blip get absorbed (degrade-safe) while a sustained outage fails closed — proven by asserting the provider `generate` is NOT called on sustained failure, not just "raises"? (c) is the dev/CI empty/disabled bypass intact (full suite green with no guardrail up)? (d) is the sustained-outage error retryable (503) vs a content rejection (422)? (e) zero diff outside the manifest (no `apps/guardrail`, no output-side moderation).

## Implementation Summary (2026-07-10)

Implemented via strict TDD (RED → GREEN) on `fix/task-478-smr-fail-closed` off `fix/2605-review` @ 2d019dc5. The SMR `/generate` input-moderation path is now **degrade-safe → fail-CLOSED**: a transient guardrail blip is absorbed by a bounded retry, a sustained outage rejects (retryable 503) without ever invoking the model, an errored guardrail can never return `allowed: True`, the silent allow-all bypasses are closed, and the intentional `enabled=False` dev/CI bypass is preserved exactly.

### Files changed

| File | Change |
|---|---|
| `apps/smr/src/smr/core/config.py` | `ExternalGuardrailConfig`: **removed `fail_open`** (the foot-gun). `pydantic` `extra='forbid'` rejects it as an **init kwarg** (the `test_fail_open_option_removed_from_config` path), but a lingering `SMR_EXTERNAL_GUARDRAIL_FAIL_OPEN` **env var is silently ignored at boot — the service still starts** (env vars aren't init kwargs), so the migration is boot-safe (the stale deploy-artifact copies were removed regardless). Added bounded-retry knobs `max_retries: int = 2` and `retry_backoff_ms: int = 100`. Documented `enabled` (dev/CI bypass vs clinical enforce) and `require_medical` (explicit, documented non-clinical mode — never a silent default). |
| `apps/smr/src/smr/services/external_guardrail.py` | Wrapped the `POST /api/medical/validate` call in a **bounded retry loop** (`max_retries + 1` tries, linear `retry_backoff_ms` backoff). On success returns the verdict; **deleted the `if self.settings.fail_open: return allowed:True` branch**; on exhausted retries returns a deterministic not-allowed verdict `reason = GUARDRAIL_UNAVAILABLE_REASON` (new module constant `"external_guardrail_unavailable"`). No error path yields `allowed: True`. The `enabled=False` short-circuit (dev/CI bypass) is untouched. |
| `apps/smr/src/smr/api/endpoints/generate.py` | Gate: `verdict.get("allowed", False)` (**fail-closed default** on a missing/malformed key, was `True`); a sustained-outage reason maps to a **retryable 503** (vs a **422** content rejection); a **`None` client under the enforce posture** (`settings.external_guardrail.enabled`) now **fails closed (503)** instead of silently skipping. The TASK-469 idempotency block (above the gate) is untouched. |
| `apps/smr/src/smr/main.py` | **Forced one-line fix** (not a wiring change): the `guardrail_client_initialized` log referenced the removed `settings.external_guardrail.fail_open` → now logs `max_retries`. Comment updated to the fail-closed posture. Construction (`:57-62`) and the explicit `None` default (`:203`) untouched. |
| `apps/smr/src/smr/tests/unit/test_external_guardrail_client.py` | RED→GREEN: added `test_transient_blip_absorbed_by_bounded_retry` (AC-2), `test_sustained_outage_fails_closed_after_bounded_retries` (AC-3/AC-1, asserts bounded call count), `test_fail_open_option_removed_from_config` (AC-1, asserts `ValidationError`), `test_retry_budget_is_config_driven_{no_retry,bounded}` (AC-2). Removed `test_fail_open_allows_when_guardrail_unreachable` (dead — fail-open retired); updated `test_fail_closed_blocks_when_guardrail_unreachable` (dropped the removed `fail_open` kwarg). |
| `apps/smr/src/smr/tests/unit/test_generate_guardrail_wiring.py` | RED→GREEN: added `test_sustained_outage_returns_503_and_never_generates` (AC-3), `test_missing_allowed_key_fails_closed` (AC-4), `test_none_client_with_enforce_posture_fails_closed` (AC-4). Updated `test_blocked_content_rejected_with_422` (content-rejection reason, since `unavailable` now → 503); removed dead `test_fail_open_verdict_proceeds`. `test_no_guardrail_client_skips_validation` **stays green** (None client + default `enabled=False` → skip). |
| `turbo.json` · `.env.example` (root) | Registered `SMR_EXTERNAL_GUARDRAIL_ENABLED` / `_MAX_RETRIES` / `_RETRY_BACKOFF_MS`; `.env.example` documents the dev/CI-bypass-vs-enforce posture. |
| `apps/smr/.env.example` · `deployment/k3s/base/configmap.yaml` (review delta) | Removed the now-dead `SMR_EXTERNAL_GUARDRAIL_FAIL_OPEN` from BOTH deploy artifacts (a PHI-safety change must leave no misleading "set-it-for-availability" knob); added the `_MAX_RETRIES` / `_RETRY_BACKOFF_MS` knobs + fail-closed note to the app-local `.env.example` for parity with the root one. Configmap validated as YAML. |

### Acceptance criteria

- **AC-1 (no fail-open)** — `fail_open` branch + config field deleted; `test_fail_open_option_removed_from_config` proves the option is un-settable; `test_sustained_outage_*` proves an errored guardrail returns `allowed: False`. ✓
- **AC-2 (degrade-safe on blip)** — `test_transient_blip_absorbed_by_bounded_retry`: one error then success → generation proceeds; retry count is config-driven (`max_retries`/`retry_backoff_ms`). ✓
- **AC-3 (fail-closed on sustained outage)** — `test_sustained_outage_returns_503_and_never_generates`: 503 (retryable) and `provider.generate` asserted **not called**. ✓
- **AC-4 (close default-allow bypasses)** — `verdict.get("allowed", False)` + `None`-client-under-enforce → 503; `test_missing_allowed_key_fails_closed`, `test_none_client_with_enforce_posture_fails_closed`. ✓
- **AC-5 (dev/CI bypass preserved)** — `enabled=False` short-circuit intact; full SMR suite (**774 passed, 29 deselected**) green with no guardrail service up. ✓
- **AC-6 (pairs with TASK-465)** — combined posture: TASK-465 = guardrail **receiver** enforces `X-Service-Token` (fail-closed); TASK-478 = SMR **sender** treats a guardrail failure as degrade-safe→fail-closed. Together an unmoderated PHI prompt cannot reach the LLM on either an auth failure or a guardrail outage. ✓

### RED → GREEN evidence

RED (unmodified worktree source) — the 6 new behavioral tests fail, 15 existing pass:

```
FAILED test_external_guardrail_client.py::test_transient_blip_absorbed_by_bounded_retry
FAILED test_external_guardrail_client.py::test_sustained_outage_fails_closed_after_bounded_retries
FAILED test_external_guardrail_client.py::test_fail_open_option_removed_from_config
FAILED test_generate_guardrail_wiring.py::test_sustained_outage_returns_503_and_never_generates
FAILED test_generate_guardrail_wiring.py::test_missing_allowed_key_fails_closed
FAILED test_generate_guardrail_wiring.py::test_none_client_with_enforce_posture_fails_closed
6 failed, 15 passed in 0.20s
```

GREEN (after implementation) — the two guardrail suites: **21 passed in 0.57s** (14 client + 7 wiring).

### Verification gate (actual output)

```
pnpm py:smr:test        → 774 passed, 29 deselected, 8 warnings in 142.55s   (full suite; incl. the 21 guardrail tests)
pnpm py:smr:lint        → All checks passed!
pnpm py:smr:typecheck   → Success: no issues found in 45 source files
```

### Deviations / notes

- **`main.py` touched (marked read-only in the manifest)** — a **forced one-line** log fix: removing the `fail_open` config field would otherwise `AttributeError` at startup on `settings.external_guardrail.fail_open`. Swapped that log kwarg to `max_retries`; the wiring logic (`:57-62`) and the explicit `None` (`:203`) are untouched. This is the only change outside the manifest.
- **`require_medical` kept, not removed** — per the plan's "keep as an explicit non-clinical mode, documented"; default stays `True` (enforce). Documented in the config; not a silent default.
- **Line drift** — cited line numbers moved after TASK-469 (idempotency) landed; the gate is now generate.py ~:164-190, the idempotency block ~:141-162 (untouched). Manifest-growth guard honored: input-side only — no `apps/guardrail`, no output-side moderation.
- **Runner note (reproduction)** — the shared `arcaenv` has `smr` installed **editable against the main checkout**, so `smr` imports resolve there, not to a worktree. Running the gate from a worktree therefore collects the worktree **tests** but imports the main-checkout **source** — the 9 new/updated guardrail tests then run against un-patched source and spuriously fail. Pin the worktree source to reproduce the green gate: `PYTHONPATH=<worktree>/apps/smr/src pnpm py:smr:test` → **774 passed** (do NOT `pip install -e` into the shared env — many agents share it). The 774-passed / lint / typecheck numbers above are all with the worktree source pinned. (Also: direct `conda run` is blocked in this sandbox's zsh — the `pnpm` scripts spawn conda via `sh` and succeed.)

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Ticket scaffolded from the [SOTA-Track](../SOTA-Track/README.md) plan (Theme D1 — SMR input fail-open → fail-closed). Fail-open site cited and code-verified against `fix/2605-review` @ 87b33f57: `external_guardrail.py:74-80` (the `if fail_open: return allowed:True` branch). **Framing refined by the code**: the fail-open branch is flag-gated (`fail_open` default `False` → on-error today fails *closed*/422), so the real default-open gap is `enabled=False` (`config.py:80` → moderation off by default, `validate()` short-circuits `allowed:True` at :34-40) plus three silent allow-all bypasses (`require_medical=False` :66; `None` client skip `generate.py:135`; `verdict.get("allowed", True)` :141). Target: remove the fail-open branch, make the error path bounded-retry-then-fail-closed (degrade-safe, not hard-fail), close the default-allow bypasses, preserve the empty/disabled dev-and-CI bypass — pairing with TASK-465's receiver-side fail-closed posture. No implementation. |
| 2026-07-10 | **Implemented (status → Review).** Removed the `fail_open` branch + config field; added bounded-retry (`max_retries`/`retry_backoff_ms`) fail-closed in `external_guardrail.py`; gate `verdict.get("allowed", False)` + sustained-outage→503 + `None`-client-under-enforce→503 in `generate.py`; forced one-line `main.py` log fix; registered the retry knobs in `turbo.json`/`.env.example`. Strict TDD: 6 RED behavioral tests → GREEN; guardrail suites 21 passed; **`pnpm py:smr:test` 774 passed / 29 deselected** (worktree source pinned), `:lint` clean, `:typecheck` clean. Dev/CI `enabled=False` bypass preserved (AC-5). Only out-of-manifest change: the forced `main.py` log line. Not merged — orchestrator reviews. |
| 2026-07-10 | **Review delta (No-Critical; pre-merge fixes).** IMPORTANT — removed the stale/misleading `SMR_EXTERNAL_GUARDRAIL_FAIL_OPEN` from the two deploy artifacts a case-sensitive grep had missed (`deployment/k3s/base/configmap.yaml`, `apps/smr/.env.example`) and added the `_MAX_RETRIES`/`_RETRY_BACKOFF_MS` knobs to the app-local `.env.example` for parity; configmap re-validated as YAML. MINOR-a — documented the bounded worst-case latency ceiling (`~(max_retries+1)×timeout_s ≈ 30s` under a hang, relying on the caller's request timeout) at the retry loop, defaults unchanged. MINOR-b — corrected the README to note a lingering `FAIL_OPEN` **env var is silently ignored at boot** (only the init-kwarg/test path is `extra='forbid'`-rejected), so the migration is boot-safe. Re-ran gates: **`pnpm py:smr:test` 774 passed / 29 deselected**, `:lint` clean, `:typecheck` clean. Not merged — orchestrator re-reviews the delta. |
</content>
| 2026-07-11 | **Closed (Status -> Completed).** Closure-review pass (owner directive "close if finished completely and properly"): all 6 ACs met with RED->GREEN evidence, py:smr:test 774 passed + lint/typecheck clean; review-delta pass applied every finding (removed the stale FAIL_OPEN from both deploy artifacts, documented the latency ceiling); production enablement is an explicit non-goal (separate ops step). No external work remains -- only the owner's git push/PR to main. |
