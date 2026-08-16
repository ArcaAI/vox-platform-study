# TASK-738 — Harness Peer-Service Auth (SmrClient/NlpClient X-Service-Token)

| | |
|---|---|
| **Status** | Completed |
| **Type** | Bugfix |
| **Depends on** | — (follow-up to TASK-704, out of that ticket's scope) |

## 1. Requirement Analysis

`apps/harness`'s `SmrClient` (calls `apps/text`'s `/generate`) and `NlpClient` (calls
`apps/nlp`'s `/classify/tokens`) never sent an `X-Service-Token` header — their constructors
didn't even accept a token parameter. Both `apps/text` and `apps/nlp` require a matching
`X-Service-Token` whenever their configured secret (`TEXT_SERVICE_TOKEN` / `NLP_SERVICE_TOKEN`)
is non-empty, which it is in both `.env.dev` and `.env.test`. So in any non-dev-bypass
environment, harness's `generate` and `classify_tokens` Temporal activities 401 and retry
forever — the `HarnessDocWorkflow` never completes.

This is a follow-up to [TASK-704](../TASK-704-Generator-Entry-Point-Seam/README.md), whose
closeout pass drove a real `HarnessDocWorkflow` end to end and found the bug live: the
workflow's `generate` activity 401'd against `apps/text` with
`{"detail":"Invalid or missing service token"}`, confirmed by direct code reading (zero
`X-Service-Token` references in either client). TASK-704 explicitly flagged this as out of its
own scope (it owns entry-point routing, not harness's tool-client auth) and filed it as a
follow-up — this ticket.

**Out of scope:**
- `apps/text`/`apps/nlp`'s own `ServiceAuthMiddleware` — unmodified.
- The analogous gap possibly present in `apps/nlp → apps/text` (`NLP_EXTERNAL_TEXT_SERVICE_TOKEN`
  does not appear in `.env.dev`/`.env.test`/`turbo.json`, noticed while investigating this
  ticket). Different files, different pair of services — not chased here to avoid scope creep;
  worth a separate look.
- TASK-704's `HARNESS_E2E_FULL` end-to-end assertion itself — this ticket fixes the code-level
  blocker TASK-704 identified, but does not re-run or close out TASK-704's own acceptance
  criteria (that's TASK-704's README to update, cross-referenced below).

## 2. Current State Evaluation

Confirmed directly against code before planning (full detail also in the approved plan,
preserved in session history):

- **Peer AI-service calls are always direct, never relayed through `apps/api`.** Harness →
  text/nlp is the same shape as `nlp → text` (`ExternalTextClient`/`ExternalTextConfig`) and
  `text → guardrail` (`ExternalGuardrailClient`) — each peer client carries its own copy of the
  *target's* secret, never a shared/relayed one (`.claude/rules/06-python-services.md`).
- `apps/text`'s `ServiceAuthMiddleware` (`apps/text/src/text/api/middleware/auth.py:36-45`) and
  `apps/nlp`'s equivalent each check against exactly **one** configured secret via
  `hmac.compare_digest` — no OR-fallback. Reusing `HARNESS_SERVICE_TOKEN` (harness's own
  inbound/`apps/api`-outbound secret) was therefore not viable without widening two other
  services' auth surface — decided against; confirmed with the user in favor of per-target
  harness-side tokens, matching the `nlp → text` precedent.
- `apps/harness/src/harness/services/api_client.py:250-269`'s `ApiClient` already does this
  correctly (`service_token: str = ""` → `headers["X-Service-Token"]`) — the pattern mirrored
  here for `SmrClient`/`NlpClient`.
- `apps/harness/src/harness/core/config.py`'s root `Settings` (`env_prefix="HARNESS_"`) already
  held `smr_base_url`/`nlp_base_url`/`api_base_url` as flat fields alongside
  `service_token`/`internal_service_token` (`SecretStr`) — the new fields follow the same shape.
- `apps/harness/src/harness/temporal/activities.py`'s `_smr_client`/`_nlp_client` factories
  passed only `base_url`/`timeout`; `_api_client` was the pattern to mirror.
- Existing unit tests (`test_smr_client.py`, `test_nlp_client.py`) construct the clients directly
  with `httpx.MockTransport` and assert on request headers/body — followed exactly for the new
  cases. Activity-level tests (`test_activities.py`) monkeypatch the module-level factory
  functions rather than constructing real `Settings`, so adding an optional keyword param was
  non-breaking there (confirmed by the full-suite rerun below).
- **Adjacent finding, also flagged by TASK-704**: `.env.test`'s `HARNESS_SMR_BASE_URL`/
  `HARNESS_NLP_BASE_URL`/`HARNESS_API_BASE_URL` pointed at stale dev ports (8862/8864/8868)
  instead of `.env.test`'s own `TEXT_PORT`/`NLP_PORT`/`API_PORT` (8962/8964/8968) — verified
  against the actual values in `.env.test` and fixed in the same pass (same file section as the
  new token vars, low risk, directly un-blocks a `HARNESS_E2E_FULL` run without host-env
  overrides).

## 3. Decisions

Confirmed with the user before implementation (see `AskUserQuestion` exchange in session):

1. **New ticket, not appended to TASK-704** — the harness-side auth-wiring fix is a different
   file scope (`apps/harness/src/harness/services/*`) than TASK-704's entry-point-seam work
   (`packages/applications/**`).
2. **Per-target harness-side tokens**, not a shared/reused `HARNESS_SERVICE_TOKEN`. New settings
   `smr_service_token` / `nlp_service_token` (env `HARNESS_SMR_SERVICE_TOKEN` /
   `HARNESS_NLP_SERVICE_TOKEN`), each set to the same value as the target's own
   `TEXT_SERVICE_TOKEN` / `NLP_SERVICE_TOKEN`. No changes to `apps/text` or `apps/nlp`.

## 4. Implementation Summary

TDD, all tasks from the approved plan executed in order:

1. **RED**: added `test_generate_attaches_service_token_header` /
   `..._omits_service_token_header_when_unset` to `test_smr_client.py`, and the equivalent pair
   to `test_nlp_client.py` — failed against the unmodified clients (no `service_token` param).
2. **GREEN**: `SmrClient`/`NlpClient` gained a keyword-only `service_token: str = ""` constructor
   param, stored as `self._service_token`, sent as `X-Service-Token` only when non-empty
   (preserves the local dev-bypass wire shape). `SmrClient.generate` merges it into the existing
   conditional `Idempotency-Key` headers dict; `NlpClient.classify_tokens` gained a new
   conditional `headers` dict (previously none).
3. `config.py`: added `smr_service_token: SecretStr = SecretStr("")` and
   `nlp_service_token: SecretStr = SecretStr("")` next to `smr_base_url`/`nlp_base_url`.
   `activities.py`: `_smr_client`/`_nlp_client` now pass
   `service_token=settings.{smr,nlp}_service_token.get_secret_value()`, mirroring `_api_client`'s
   existing line exactly.
4. Env vars added: `apps/harness/.env.sample` (empty placeholders), `.env.dev`/`.env.test` (real
   values, set equal to each file's own `TEXT_SERVICE_TOKEN`/`NLP_SERVICE_TOKEN`),
   `turbo.json#globalEnv` (`HARNESS_SMR_SERVICE_TOKEN`, `HARNESS_NLP_SERVICE_TOKEN`, alphabetized
   into the existing `HARNESS_*` block).
5. `.env.test`'s `HARNESS_SMR_BASE_URL`/`HARNESS_NLP_BASE_URL`/`HARNESS_API_BASE_URL` corrected
   to `:8962`/`:8964`/`:8968`, verified against this file's own `TEXT_PORT=8962`,
   `NLP_PORT=8964`, `API_PORT=8968` before changing. `.env.dev` untouched (its ports were already
   correct).
6. Regression test added — `TestToolClientFactoriesSendServiceToken` in `test_activities.py`
   (3 cases): `_smr_client(settings)`/`_nlp_client(settings)` construct clients carrying the
   configured token, and carry none when explicitly unset. This is the guard TASK-704's README
   asked for ("consider whether the hermetic stub should also assert the auth header is
   present") — the existing activity tests all monkeypatch the factories themselves and would
   never have caught this class of bug.
7. Full verification pass (below).

### One in-flight fix during implementation

`pnpm harness:typecheck` initially flagged one real issue in this ticket's own diff:
`SmrClient.generate`'s `headers = headers or None` line widened `headers`'s type from
`dict[str, str]` to `dict[str, str] | None`, which mypy correctly rejected as an incompatible
reassignment. Fixed by dropping that line entirely — `httpx.AsyncClient.post(headers={})`
behaves identically to `headers=None` (no extra headers merged), so removing the widening
reassignment was a pure simplification with no behavior change. Reran clean.

### Files changed

- `apps/harness/src/harness/services/smr_client.py` — `service_token` param + conditional header.
- `apps/harness/src/harness/services/nlp_client.py` — `service_token` param + conditional header.
- `apps/harness/src/harness/core/config.py` — `smr_service_token`/`nlp_service_token` fields.
- `apps/harness/src/harness/temporal/activities.py` — `_smr_client`/`_nlp_client` factories pass
  the new tokens.
- `apps/harness/src/harness/tests/unit/services/test_smr_client.py` — 2 new tests.
- `apps/harness/src/harness/tests/unit/services/test_nlp_client.py` — 2 new tests.
- `apps/harness/src/harness/tests/unit/temporal/test_activities.py` — new
  `TestToolClientFactoriesSendServiceToken` class, 3 tests.
- `apps/harness/.env.sample` — new placeholder vars.
- `.env.dev` — real token values.
- `.env.test` — real token values + corrected stale base-URL ports.
- `turbo.json` — `globalEnv` entries for the two new vars.

## 5. Verification (actual command output)

An earlier pass in this same session hit collection errors in 3 unrelated test files
(`apps/harness/src/harness/temporal/interpreter/**`, `test_worker_model_cache_sweep.py`,
`test_worker_heartbeat.py`) caused by a concurrent sibling session's in-progress, uncommitted
work under `apps/harness/src/harness/temporal/interpreter/nodes/` (untracked directory,
confirmed via `git status`) — worked around with `--ignore` at the time. That sibling work
settled before this ticket's final verification pass, so the numbers below are the TRUE full
suite, no exclusions:

```
$ pnpm harness:test   [full suite, no --ignore needed]
4 failed, 1326 passed, 1 warning in 62.37s

  FAILED test_otel_tracing_task636.py::TestDeploymentEnvironmentIsNotHardcoded (3 cases)
  FAILED test_qdrant_api_key.py::TestRetrievalConfigApiKey::test_api_key_defaults_to_none

  All 4 are pre-existing and unrelated to this ticket's files (otel_deployment_environment,
  RetrievalConfig.qdrant_api_key — neither touched here); reproduced identically across every
  rerun in this session, before and after this ticket's code changes, confirming they are not
  a regression introduced here.

$ pnpm harness:test -k "TestSmrClient or TestNlpClient or TestToolClientFactoriesSendServiceToken"
22 passed, 1225 deselected in 2.15s
  [all new X-Service-Token tests green, plus every pre-existing test in the two touched
  client files and the touched activities test file]

$ pnpm harness:lint
All checks passed!

$ pnpm harness:typecheck
Success: no issues found in 117 source files
```

### Live verification: the exact 401 repro from TASK-704, now closed

Started `apps/text` and `apps/nlp` locally against `.env.test` (`NODE_ENV=test ./scripts/dev-service.sh text|nlp`, ports 8862/8864 — the harness worker itself was **not** started, keeping this pass small and avoiding any interaction with the concurrent sibling session's in-progress interpreter work). The already-running sibling `apps/api` test instance on :8968 was only ever queried (health check before/after), never touched. Both local services cleanly stopped at the end, zero orphaned processes, sibling instance confirmed healthy throughout and after.

Curled both endpoints directly with the exact bodies harness's clients send, first without a token (reproducing TASK-704's live finding), then with the token this ticket now wires (`HARNESS_SMR_SERVICE_TOKEN`/`HARNESS_NLP_SERVICE_TOKEN`'s values, copied from this same `.env.test`'s `TEXT_SERVICE_TOKEN`/`NLP_SERVICE_TOKEN`):

```
$ curl -X POST :8862/api/v1/generate  (no X-Service-Token)
{"detail":"Invalid or missing service token"}          HTTP 401

$ curl -X POST :8864/api/v1/classify/tokens  (no X-Service-Token)
{"detail":"Invalid or missing service token"}          HTTP 401

$ curl -X POST :8862/api/v1/generate  (X-Service-Token: <TEXT_SERVICE_TOKEN value>)
{"detail":"Field 'model' is required: SMR has no default model."}   HTTP 422

$ curl -X POST :8864/api/v1/classify/tokens  (X-Service-Token: <NLP_SERVICE_TOKEN value>)
{"error":"Token classification model not available"}                HTTP 503
```

The 401 → non-401 transition is the entire fix, proven live against real running services with
the real configured secrets. The remaining 422/503 are unrelated to auth (no default generation
model configured for this bare curl; NLP's classification model wasn't warmed in this quick
local start) — exactly what's expected from a minimal ad-hoc curl outside harness's real request
shape, and outside this ticket's scope. This does not replace TASK-704's own `HARNESS_E2E_FULL`
loop (full workflow, real generation, `SummaryMeta.assuranceCompletedAt` assertion) — that
remains TASK-704's own outstanding item, now directly un-blocked by this fix.

## 6. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored and implemented in full: `SmrClient`/`NlpClient` now send `X-Service-Token` (per-target harness-side tokens, decided against reusing `HARNESS_SERVICE_TOKEN` after confirming neither `apps/text` nor `apps/nlp`'s auth middleware accepts a second/fallback token); wired through `Settings`/`activities.py`; env vars added to `.env.sample`/`.env.dev`/`.env.test`/`turbo.json`; adjacent stale `.env.test` port bug (flagged by TASK-704) fixed in the same pass; regression test added (`TestToolClientFactoriesSendServiceToken`). Full suite reruns green modulo 4 pre-existing, unrelated failures (`test_otel_tracing_task636.py`, `test_qdrant_api_key.py`); an earlier pass's collection errors in 3 unrelated interpreter test files (a concurrent sibling session's in-flight, uncommitted work) had cleared by the final rerun — true full suite, no exclusions needed: 1326 passed, 4 failed (pre-existing). `pnpm harness:lint`/`harness:typecheck` clean. **Live-verified**: started `apps/text`+`apps/nlp` locally against `.env.test` and curled both endpoints directly — confirmed the exact TASK-704 401 repro without a token, and confirmed the 401 clears (replaced by unrelated 422/503 — no default model / model not warmed) with the token this ticket wires, using the real configured secrets. Sibling `apps/api` test instance on :8968 only queried, never touched; both local services cleanly stopped, zero orphans. Status → Completed. This ticket's own scope (the auth bug) is fully fixed and proven; TASK-704's own broader `HARNESS_E2E_FULL` full-workflow loop remains a separate, still-open item on that ticket, now directly un-blocked. | Sonnet 5 (this session) |
