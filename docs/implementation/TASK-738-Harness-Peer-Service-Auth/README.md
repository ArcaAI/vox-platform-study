# TASK-738 — Harness Peer-Service Auth (SmrClient/NlpClient X-Service-Token)

| | |
|---|---|
| **Status** | Completed — **superseded in part by owner decision D-D (2026-08-17)**; see §7 |
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


## 7. D-D supersession — ONE shared internal access token (2026-08-17)

### 7.1 What changed

[`owner-decisions-2026-08-17.md`](../../programs/agentic-workflow-platform/owner-decisions-2026-08-17.md)
**D-D** reverses §3 decision 2 of this ticket:

> Internal service-to-service auth uses a **single shared access token**, set by the DevOps
> engineer, identical across all services, internal use only. Do not design per-service tokens,
> per-pair tokens, or a rotation scheme per service.

This ticket's `HARNESS_SMR_SERVICE_TOKEN` / `HARNESS_NLP_SERVICE_TOKEN` are exactly the
"per-pair tokens" D-D forbids. They were the right call against the constraint that existed at the
time (§2: "each peer client carries its own copy of the *target's* secret… neither `apps/text` nor
`apps/nlp`'s auth middleware accepts a second/fallback token"). D-D removes that constraint by
changing the middlewares instead of working around them.

### 7.2 The naming decision, and why

**The canonical variable is `INTERNAL_ACCESS_TOKEN`.** Unprefixed, one value, every service.

| Candidate | Verdict |
|---|---|
| `INTERNAL_SERVICE_TOKEN` | **Rejected.** `HARNESS_INTERNAL_SERVICE_TOKEN` already exists and means something else entirely (it gates the harness knowledge-ingest endpoint only — the descriptor for it opens with "SECOND, SEPARATE harness credential — NOT an alias of `HARNESS_SERVICE_TOKEN`"). A canonical name one prefix away from an unrelated credential is a name that will be mis-set. |
| `HOPE_INTERNAL_TOKEN` | Rejected — a product prefix on a value that is not product-scoped, and it matches no existing convention in this repo. |
| Reusing one existing `*_SERVICE_TOKEN` (e.g. `TEXT_SERVICE_TOKEN`) | Rejected — the prefix asserts ownership by one service, which is precisely the property D-D removes. It would also read as "text's secret" in every non-text `.env`. |
| **`INTERNAL_ACCESS_TOKEN`** | **Chosen.** It is the owner's own phrase in D-D ("internal access token"); it collides with nothing; and being *unprefixed* it visibly signals what D-D asserts — the token belongs to no single service. Under pydantic-settings a `validation_alias` also bypasses each service's `env_prefix`, so the one name binds identically in all six services. |

Descriptor key `internal.accessToken` → `toEnvVarName()` → `INTERNAL_ACCESS_TOKEN`. Registered in
`packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts`,
which is what puts it in `turbo.json#globalEnv`, `apps/api/.env.sample` and the consolidated root
`.env.sample` — all three are GENERATED by `pnpm env:sync`, never hand-edited.

### 7.3 Backward compatibility — kept, because it cost one line each

The brief allowed backward compatibility "only if it costs nothing". It costs a tuple:

* **Inbound** — every `ServiceAuthMiddleware` now compares against
  `settings.accepted_service_tokens`, a `(shared, legacy)` tuple, with `hmac.compare_digest` over
  each. Both empty ⇒ the pre-existing dev/CI bypass, unchanged.
* **Outbound** — every peer client resolves through `settings.peer_service_token(legacy)` (Python)
  or `resolveInternalAccessToken(secrets, legacyKey)` (TypeScript): shared first, legacy second.

So `INTERNAL_ACCESS_TOKEN` can be rolled out **before** the legacy family is removed, and removing
the legacy family later is a pure deletion. The `HARNESS_SMR_SERVICE_TOKEN` /
`HARNESS_NLP_SERVICE_TOKEN` vars this ticket added survive only in that fallback role.

### 7.4 The config-wiring gap this closes

The pre-existing gap flagged against this ticket was that `HARNESS_SMR_SERVICE_TOKEN` /
`HARNESS_NLP_SERVICE_TOKEN` were absent from `turbo.json#globalEnv` (verified: they still are —
`env-sync.mts` derives `globalEnv` from the settings registry ∪ a scan of real *TypeScript*
`process.env` reads, and these are Python-only vars declared in a hand-maintained
`apps/harness/.env.sample`, so the generator never had a reason to emit them). Under D-D the fix is
NOT to add the two per-pair vars to the declared surface — that would enshrine the model D-D
rejects. It is to declare the ONE canonical variable, which is now in `globalEnv` and in every
relevant `.env.sample`, and let the two legacy vars fade out as fallbacks.

### 7.5 One real bug found and fixed in passing

`apps/harness`'s two `GuardrailClient` construction sites
(`temporal/interpreter/nodes/guardrail_check.py`, `.../consultation.py`, added by TASK-720 after
this ticket closed) presented `settings.service_token` — i.e. `HARNESS_SERVICE_TOKEN` — on the
harness→guardrail hop. `apps/guardrail` validates its OWN `GUARDRAIL_SERVICE_TOKEN` and has no
OR-fallback, so that hop would have 401'd in every environment with auth on: the same class of
defect this ticket was created to fix, in a third client. Both sites now resolve
`settings.peer_service_token(settings.guardrail_service_token)`, and a
`HARNESS_GUARDRAIL_SERVICE_TOKEN` legacy field was added for the fallback leg.

### 7.6 Files changed in this pass

* `packages/applications/src/services/settings-registry/descriptors/platform-secrets.descriptors.ts`
  — `internal.accessToken` descriptor (the source of the generated env surface).
* `apps/{text,nlp,guardrail,tts,harness}/src/**/core/config.py` — shared-token field +
  `accepted_service_tokens` / `peer_service_token`.
* `apps/{text,nlp,guardrail,tts}/src/**/api/middleware/auth.py` — accept shared OR legacy
  (`apps/nlp` in both the HTTP middleware and the WebSocket `enforce_service_token_ws` counterpart).
* `apps/text/src/text/{main.py,services/external_guardrail.py}`,
  `apps/nlp/src/nlp/{lifespan.py,services/external_text_client.py}`,
  `apps/harness/src/harness/temporal/{activities.py,interpreter/nodes/guardrail_check.py,interpreter/nodes/consultation.py}`
  — outbound clients prefer the shared token.
* `apps/api/src/modules/streaming/text-proxy.controller.ts`,
  `apps/api/src/modules/ai-inference/ai-inference.client.ts`,
  `packages/applications/src/services/consultation/live-documentation/{live-documentation.service.ts,live-tool-registry.ts}`
  — same, via `resolveInternalAccessToken`.
* `packages/applications/src/common/internal-service-headers.ts` — **new**; the one place that
  encodes both halves of the internal-call contract (see TASK-737).
* `turbo.json`, `.env.sample`, `apps/api/.env.sample`, `apps/{text,nlp,guardrail,harness,tts}/.env.sample`,
  `env-surface.generated.md`.
* Tests: `apps/text/src/text/tests/unit/test_internal_access_token.py` (**new**, 10 cases).

### 7.7 Verification

See [TASK-737 §8](../TASK-737-Mandatory-Tenant-Header/README.md#8-verification-actual-command-output) — the two tickets were implemented and verified as one change. The D-D-specific evidence is the `test_internal_access_token.py` RED/GREEN pair and `pnpm env:sync --check` recorded there.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-19 | **The `CHANGE_ME` truthy trap — closed on both sides, and the generator completed.** `CHANGE_ME` is the unfilled-secret sentinel `env-sync.mts` writes and `generate-env-file.sh` leaves behind; `vault-seed-secrets.sh` already refuses to write it ("would make an unconfigured provider look configured"). The services disagreed: the sentinel is a NON-EMPTY string, and every fallback is a truthiness chain (`internal_access_token or legacy`), so `INTERNAL_ACCESS_TOKEN=CHANGE_ME` was PRESENTED as the credential on every outbound hop and the legacy fallback — the thing that would have worked — was never reached. Every internal call 401'd, and it read as an auth bug rather than a config one. **(1) Shared helper:** new `hope_env.placeholders` (`real_secret` / `first_real_secret` / `is_placeholder`) maps the sentinel onto `""`, which is the ALREADY-documented path (`.env.sample`: "Empty everywhere = auth disabled") — not a new policy, the one that was already written down. All five Python services (harness/text/guardrail/nlp/tts) route both `accepted_service_tokens` and `peer_service_token` through it, so the sentinel is never accepted inbound nor presented outbound. **(2) TypeScript:** `realSecret()` in `internal-service-headers.ts`, applied in `resolveInternalAccessToken` — the `SECRETS_PROVIDER=env` path returns env values verbatim, so the gateway had the identical exposure. **(3) Generator completed:** `INTERNAL_ACCESS_TOKEN` and `WEBHOOK_SECRET_PEPPER` were declared secrets that `generate-env-file.sh` neither generated nor declared external — so a fresh `.env.dev` shipped a real value for all six legacy `*_SERVICE_TOKEN`s and the literal `CHANGE_ME` for the token that supersedes them. Both now generated (64-hex, independently random); a new `_MINTED_LATER_KEYS` category covers the Vault AppRole pair so the closing report stops advising developers to paste values a later step mints; and an UNCLASSIFIED bucket now reports any future gap as a bug in the script rather than a task for the developer. Vendor-issued keys (Azure/OIDC/vLLM/judge) stay operator-supplied — synthesising them is the failure `vault-seed-secrets.sh` exists to prevent. **Guards added:** 19 py-env tests pinning sentinel→absent and real-value→verbatim (including that a value merely CONTAINING `CHANGE_ME` is kept), plus three `scripts/__tests__/env-sync.test.ts` cases asserting the partition is total (declared ⊆ generated ∪ external ∪ minted-later) — the check whose absence let this ship. **Verified:** a fresh generated env file leaves only the 6 vendor keys + 2 Vault-minted, zero unclassified; harness 1468/1468, py-env 92/92, tts 277/277, all five services ruff + mypy clean; full workflow run still green end to end. | execution agent |
| 2026-08-16 | Ticket authored and implemented in full (see §4–§6). | Sonnet 5 |
| 2026-08-17 | **D-D supersession.** Per-pair `HARNESS_SMR_SERVICE_TOKEN`/`HARNESS_NLP_SERVICE_TOKEN` demoted to backward-compatibility fallbacks; the canonical credential is now the single shared `INTERNAL_ACCESS_TOKEN`, accepted inbound by all four Python `ServiceAuthMiddleware`s (+ NLP's WS counterpart) and preferred outbound by every peer client in both languages. Naming decision and rejected alternatives recorded in §7.2. Found and fixed a real 401-in-waiting on the harness→guardrail hop (§7.5). Implemented jointly with TASK-737 as one coherent internal-call contract. | Opus 5 |
