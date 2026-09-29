# TASK-1011 — tts/nlp model-registry credential fetch always 401s

**Status:** Review
**Type:** bugfix
**Branch:** `agent/focused-driscoll-a2624a` → target `dev-2.2` (not merged yet)
**Related:** TASK-1010 (`apps/asr-vllm` has its own client and was left alone on purpose)

## Requirement Analysis

A static reading on 2026-09-29 suggested that `apps/tts` and `apps/nlp` could never fetch a
model-registry credential (`AiProviderConnection` with `service='model-registry'`: the HF token or
S3 key pair used to pull private weights that are not yet published into `hope-models`). The task:
prove it with a failing test or show the suspicion was wrong, then fix both Python clients so they
present what the gateway guard actually accepts.

## Current State Evaluation

**Gateway side (correct, unchanged).** `GET /api/v1/internal/model-registry-credential`
(`apps/api/src/modules/internal/model-registry-internal.controller.ts`) is `@Public()` +
`@UseGuards(InternalServiceTokenGuard)`. The guard
(`apps/api/src/modules/internal/internal-service-token.guard.ts`):

1. returns 401 if `?service=` is absent;
2. reads `X-Internal-Service-Key` for `service=stt` **only**. Every other service must send
   `X-Service-Token`;
3. accepts the shared `INTERNAL_ACCESS_TOKEN` for every service, plus the legacy per-service secret
   as a fallback (`tts` → `INTERNAL_ACCESS_TOKEN`, `nlp` → `NLP_SERVICE_TOKEN`).

`internal-service-token.guard.test.ts` already covers each of these rules: "rejects a missing
service query param", "does NOT accept X-Internal-Service-Key for any other service", and "accepts
the ONE shared INTERNAL_ACCESS_TOKEN for service=nlp/tts".

**Client side (defect).** Both `apps/tts/src/tts/core/model_credentials.py` and
`apps/nlp/src/nlp/core/model_credentials.py` copied the STT worker's request shape: they sent
`X-Internal-Service-Key: <API_GATEWAY_KEY>` with params `{provider, tenantId}` and no `service`
parameter. So every request failed rule 1, and would have failed rule 2 even with the parameter
added. The client turns the 401 into `UNAVAILABLE`, and `resolve_s3_credentials` then raises
`CredentialUnavailable` (fail closed).

The existing client tests (`test_x_internal_service_key_is_sent`) asserted the wrong header, so the
suites stayed green. They were written against the client's own assumption, not against the guard.

**Blast radius.** Only `s3://` sources that need a credential are affected. A model already
published into `hope-models` (with a `localPath` present) never calls this route, which is likely
why nobody noticed. The owner tenant (`tenantId` + `X-Tenant-Id`) was already sent correctly: tts
always uses SYSTEM (process-wide operator paths), and nlp uses the model row's owner through
`owner_tenant_of`.

**Token availability.** No new secret or vault-kv field is needed. Both services already hold the
shared `INTERNAL_ACCESS_TOKEN` (`tts.core.config.Settings.internal_access_token`,
`nlp.core.config.NLPServiceConfig.internal_access_token`) and expose it through
`peer_service_token()`, the same value their `EffectiveConfigClient` presents to
`/internal/effective-config`. nlp's per-service `NLP_SERVICE_TOKEN` is retired on nlp's side, but
the guard accepts the shared token for `service=nlp`.

## Implementation Plan

1. RED: client tests assert `?service=<svc>`, `X-Service-Token`, and no `X-Internal-Service-Key`.
   A process-client test asserts that the singleton presents `peer_service_token()` rather than
   `API_GATEWAY_KEY`.
2. GREEN: add the `CALLER_SERVICE` constant, send `service`, rename the constructor argument
   `api_key` → `service_token`, and build the singleton from `peer_service_token()`.
3. Remove the settings field that the fix left unused (`api_gateway_key` in both services) along
   with its generated env surface.

## Implementation Summary

### Code

| File | Change |
|---|---|
| `apps/tts/src/tts/core/model_credentials.py` | `CALLER_SERVICE = "tts"`; sends `service`, `provider`, `tenantId` and headers `X-Service-Token` + `X-Tenant-Id`; `ModelRegistryCredentialClient(base_url, service_token, …)`; singleton uses `settings.peer_service_token()`; docstring point 4 rewritten |
| `apps/nlp/src/nlp/core/model_credentials.py` | Same, with `CALLER_SERVICE = "nlp"` and `settings.service.peer_service_token()` |
| `apps/tts/src/tts/core/config.py`, `apps/nlp/src/nlp/core/config.py` | Removed `api_gateway_key` (`API_GATEWAY_KEY`, plus the nlp alias `NLP_API_GATEWAY_KEY`). This client was its only reader |
| `apps/nlp/tests/test_task799_byok_credentials.py` | Dropped the `service.api_gateway_key` allow-list entry. Its justification ("guarded by API-key auth") was wrong |
| `scripts/generated/python-env-surface.json` | Regenerated with `python scripts/python-env-surface.py` (363 → 362 names); `--check` OK |
| `apps/{tts,nlp}/.env.sample`, `env-surface.generated.md` | The `API_GATEWAY_KEY` block/rows for tts and nlp removed **by hand**; see the follow-up below |
| `apps/{tts,nlp}/README.md` | Credential sentence corrected |

`API_GATEWAY_KEY` itself stays: `apps/stt` and the gateway still use it, and it remains in
`turbo.json#globalEnv`.

### Tests (only the touched files were run)

```
$ python -m pytest apps/tts/src/tts/tests/unit/test_model_credentials.py -q      # RED, before the fix
FAILED ...::TestTransportShape::test_the_service_query_param_names_this_service
FAILED ...::TestTransportShape::test_x_service_token_is_sent_not_the_stt_only_header
FAILED ...::TestProcessClient::test_presents_the_shared_internal_access_token_as_the_tts_service
3 failed, 19 passed
$ python -m pytest apps/nlp/tests/test_model_credentials.py -q                   # RED, before the fix
  ('/api/v1/internal/model-registry-credential', None, None) != (..., 'nlp', 'shared-token')
3 failed, 20 passed

# GREEN, after the fix
$ python -m pytest apps/tts/src/tts/tests/unit/test_model_credentials.py apps/tts/src/tts/tests/unit/test_task799_byok_credentials.py -q
41 passed, 3 skipped
$ python -m pytest apps/nlp/tests/test_model_credentials.py apps/nlp/tests/test_task799_byok_credentials.py -q
40 passed
$ python scripts/python-env-surface.py --check
env:python-surface --check OK — 362 distinct env names declared across 7 Python services.
$ ruff check <touched files>   → All checks passed!
$ black --check -l 100 <touched files> → clean
$ mypy apps/{tts,nlp}/src/*/core/{model_credentials,config}.py → no issues
```

(Run with `~/miniconda3/envs/arcaenv/bin/python` from the worktree; the worktree source guard
passed. `conda run` refused to start in this shell.)

### Follow-ups

- **`pnpm env:sync:check` was not run.** The worktree has no built `@arcaai/applications`, which the
  generator imports. The two `.env.sample` blocks and the two `env-surface.generated.md` rows were
  removed by hand to match the regenerated manifest. Run `pnpm env:sync:check` once after merging
  to `dev-2.2`; it should report no drift.
- **Deployment repo.** Any `API_GATEWAY_KEY` delivered to the tts/nlp pods is now unread. Removing
  it from `hope-v2-deployment` is optional cleanup; `envfrom-coverage` only checks reads that are
  missing, not supply that is unused.
- **Live proof not done.** No cluster or local stack call was made. The contract is proved by the
  client tests plus the gateway's own guard tests, not by a live 200.

## Change History

| Date | Change |
|---|---|
| 2026-09-29 | Ticket opened after a static read; defect confirmed with failing client tests; fix + orphan removal on `agent/focused-driscoll-a2624a` |
