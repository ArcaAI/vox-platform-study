# TASK-465 — NLP + Guardrail Service-Token Enforcement (C4-02 receiver half)

- **Status**: Review (implementation complete on `fix/task-465-nlp-guardrail-auth`; awaiting orchestrator review/merge — do not self-merge)
- **Type**: bugfix (security — completes the fail-closed posture; **fixes a discovered High-severity config bug**) + infrastructure (secret provisioning)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 follow-up (pairs with [TASK-460](../TASK-460-Gateway-Auth-Retry-Hygiene/README.md))
- **Origin**: TASK-460 (C4-02) made the gateway **send** `X-Service-Token` to NLP + Guardrail, but the receivers didn't **enforce** it — so C4-02 was not fully fail-closed end-to-end until this landed.
- **Severity**: Med baseline (defense-in-depth for PHI-bearing internal hops). Elevated by a **High-severity** config bug found during implementation: Guardrail's `service_token` read `GUARDRAIL_V2_SERVICE_TOKEN` (env_prefix) while the gateway provisions `GUARDRAIL_SERVICE_TOKEN` — left unchanged, prod would have **silently never enforced**. Fixed via `validation_alias` (see Implementation Summary).
- **Branch**: `fix/task-465-nlp-guardrail-auth` (based on `fix/2605-review`)
- **Size**: S–M

## ⚠️ Ops rollout ordering (secret provisioning) — REQUIRED

Enforcement is **fail-open only while the token is empty**. Once a receiver resolves a non-empty `service_token`, it 401s every non-exempt request that lacks a matching `X-Service-Token`. The gateway (TASK-460) already sends the header on every hop (empty string when unresolved). Therefore the same token **value** must be provisioned for the gateway and each receiver together:

1. **Provision the shared secret** under BOTH keys with the **same value**: `NLP_SERVICE_TOKEN` (NLP receiver + gateway) and `GUARDRAIL_SERVICE_TOKEN` (Guardrail receiver + gateway) — Vault / host env. The gateway resolves them via `SecretsService`; the receivers read them via pydantic-settings.
2. Gateway sending the token — **done** (TASK-460, `ai-inference.client.ts`).
3. Deploy receivers **enforcing** — this ticket.

Provisioning (1) must precede or ship atomically with (3). If a receiver gets a non-empty token before the gateway is provisioned with the **same** value, the hop 401s. Leaving all three empty keeps the dev/hermetic-CI bypass (current default) intact.

## Requirement Analysis

TASK-460 closed C4-02's gateway half. The full fix requires the NLP + Guardrail FastAPI services to reject requests whose `X-Service-Token` is missing/empty/mismatched — mirroring the proven SMR middleware. Pre-implementation state:
- `apps/guardrail` had a `service_token: SecretStr("")` setting but **no enforcing middleware**, and it read the **wrong env key** (`GUARDRAIL_V2_` prefix).
- `apps/nlp` had **neither** the setting nor middleware.
- Reference mirrored: `apps/smr/src/smr_v2/api/middleware/auth.py` — `X-Service-Token` shared-secret middleware with constant-time compare (`hmac.compare_digest`); EMPTY token = dev-mode bypass; health/docs/metrics paths exempt.

### Acceptance criteria

- [x] **AC-1**: `apps/guardrail` and `apps/nlp` each gain `X-Service-Token` middleware mirroring `apps/smr`'s (constant-time compare; health/docs/metrics exempt; empty-configured-token = dev bypass). EXEMPT_PATHS tailored per service (NLP health at `/api/v1/health*`; Guardrail health at `/api/health*`).
- [x] **AC-2**: `apps/nlp` gains `service_token: SecretStr` under `env_prefix="NLP_"` → reads `NLP_SERVICE_TOKEN` (matches gateway). `apps/guardrail`'s existing field is **corrected** to read the canonical `GUARDRAIL_SERVICE_TOKEN` via `validation_alias` (was silently reading `GUARDRAIL_V2_SERVICE_TOKEN`).
- [x] **AC-3 (red first)**: TDD — RED captured (NLP 12 failed; Guardrail 7 failed, incl. `test_legacy_v2_env_no_longer_read` asserting the old key was being read) → GREEN. Missing/wrong token → 401; matching token → passes (404 route-probe); empty token → bypass; exempt paths reachable.
- [x] **AC-4 (config/docs)**: `GUARDRAIL_SERVICE_TOKEN` / `NLP_SERVICE_TOKEN` already present in `turbo.json#globalEnv` and `.env.example` (added by TASK-460). Rollout order (provision → enforce, same value both sides) documented above; Vault provisioning is the ops action in step 1.
- [~] **AC-5**: `pnpm py:guardrail:test` + `pnpm py:nlp:test` + lint + typecheck all green (evidence below). Receiver enforcement + canonical-key sourcing proven by unit tests (incl. an env-driven end-to-end within Guardrail); a **live** gateway↔receiver handshake still to be smoke-tested against a running stack during rollout.

### Non-goals

- The gateway side (done in TASK-460). SMR's fail-open posture (out of scope).
- Rotating/short-lived service tokens (static shared secret matches the SMR pattern).

## Implementation Plan (executed)

Standard TDD Python stream, mirroring the SMR auth middleware:
1. RED: write `test_auth_middleware.py` for both services (bypass / missing / wrong / correct / 401-body / exempt), plus Guardrail alias tests → watch fail.
2. GREEN: add the middleware + config field (NLP), correct the config alias (Guardrail), wire `app.add_middleware` in each app factory.
3. Gates: test + lint + typecheck for both services.

## Implementation Summary

**Files changed** (branch `fix/task-465-nlp-guardrail-auth`):

_NLP (`apps/nlp`)_
- **NEW** `src/nlp/api/middleware/__init__.py`, `src/nlp/api/middleware/auth.py` — `ServiceAuthMiddleware` (BaseHTTPMiddleware): constant-time `hmac.compare_digest`, empty-token bypass, 401 JSON `{"detail":"Invalid or missing service token"}`. Reads the token at **dispatch time** from the `nlp.core.config` module singleton (NLP has no per-app settings container). `EXEMPT_PATHS = /`, `/api/v1/health[/live|/ready]`, `/metrics`, `/docs`, `/redoc`, `/openapi.json`.
- `src/nlp/core/config.py` — import `SecretStr`; add `service_token: SecretStr = SecretStr("")` to `NLPServiceConfig` (`env_prefix="NLP_"` → reads `NLP_SERVICE_TOKEN`, the gateway key).
- `src/nlp/app.py` — set `app.state.settings = settings` (parity) and `app.add_middleware(ServiceAuthMiddleware)` (added before CORS so CORS stays outermost).
- **NEW** `tests/test_auth_middleware.py` — reuses the conftest `client` fixture; monkeypatches `nlp.core.config.settings.service.service_token`; uses a `GET /api/v1/__auth_probe__` 404-probe to isolate the middleware from handler deps.

_Guardrail (`apps/guardrail`)_
- **NEW** `src/guardrail/api/middleware/__init__.py`, `src/guardrail/api/middleware/auth.py` — same middleware, structlog logger, reading the token from `request.app.state.settings.service_token` at dispatch. `EXEMPT_PATHS = /api/health[/ready|/live]`, `/metrics`, `/docs`, `/redoc`, `/openapi.json` (tailored — NOT SMR's `/api/v1/...` set).
- `src/guardrail/core/config.py` — **the High-severity fix**: import `AliasChoices`; change `service_token` to `Field(default=SecretStr(""), validation_alias=AliasChoices("GUARDRAIL_SERVICE_TOKEN"))`. `validation_alias` overrides the class `env_prefix="GUARDRAIL_V2_"`, so the field now reads the canonical `GUARDRAIL_SERVICE_TOKEN` verbatim (the key the gateway/turbo.json/.env.example use). The legacy `GUARDRAIL_V2_SERVICE_TOKEN` is no longer consulted.
- `src/guardrail/main.py` — `app.add_middleware(ServiceAuthMiddleware)` in `create_app()` after `app.state.settings = settings`.
- **NEW** `src/guardrail/tests/test_auth_middleware.py` — builds `create_app()` and drives it with `httpx.ASGITransport` **without entering the lifespan** (no Redis/GLiNER/provider init). Includes dedicated alias tests: setting `GUARDRAIL_SERVICE_TOKEN` populates `service_token` and fires enforcement; setting only the legacy `GUARDRAIL_V2_SERVICE_TOKEN` leaves it empty.

**Empty-token bypass preserved**: both `service_token` defaults are `SecretStr("")`, so with no provisioned secret (local dev + hermetic CI) auth is bypassed — the full existing suites stay green.

### Verification evidence (gates)

Run from the isolated worktree; because `nlp`/`guardrail` are editable-installed against the shared checkout, the worktree source was forced onto the import path with `PYTHONPATH=<worktree>/apps/<svc>/src` for the **test** gates (lint/typecheck are path-based and needed no override). On the merged shared checkout the gates run unmodified.

```
pnpm py:nlp:test        → 64 passed  (12 new auth tests + 52 existing)
pnpm py:guardrail:test  → 54 passed  (10 new auth tests + 44 existing); auth.py coverage 100%
pnpm py:nlp:lint        → All checks passed!
pnpm py:guardrail:lint  → All checks passed!
pnpm py:nlp:typecheck   → Success: no issues found in 38 source files
pnpm py:guardrail:typecheck → Success: no issues found in 24 source files
```

RED→GREEN: pre-implementation the new Guardrail suite failed 7/10 — including `test_legacy_v2_env_no_longer_read` (`assert 'legacy-token-should-be-ignored' == ''`), directly proving the field was reading `GUARDRAIL_V2_SERVICE_TOKEN`; and the NLP suite failed 12/12 (pydantic rejected setting the not-yet-existent `service_token` field + missing middleware module). After the fix all pass.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-460's C4-02 coordination finding (gateway sends the token; NLP/Guardrail don't enforce it). Reference middleware (`apps/smr`) and the secret-provisioning rollout-order risk recorded. Awaiting prioritization. |
| 2026-07-10 | Implemented via strict TDD on `fix/task-465-nlp-guardrail-auth`. Added `ServiceAuthMiddleware` + `service_token` config to NLP; added the same middleware to Guardrail and **fixed the High-severity env-key mismatch** (Guardrail read `GUARDRAIL_V2_SERVICE_TOKEN`; now reads canonical `GUARDRAIL_SERVICE_TOKEN` via `validation_alias`). Empty-token dev/CI bypass preserved. All 6 gates green (NLP 64 / Guardrail 54 tests; lint + mypy clean). Rollout ordering (provision same value both sides → enforce) documented. Status → Review. |
