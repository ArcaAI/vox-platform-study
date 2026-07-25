# TASK-465 — NLP + Guardrail Service-Token Enforcement (C4-02 receiver half)

- **Status**: Completed — adversarial review APPROVE: constant-time hmac.compare_digest (no early-return leak), safe dev-bypass (empty=bypass, any set token always enforced), WS gap closed, PHI never in auth logs, + a real High-sev canonical-token config fix. NLP 18 + guardrail 10 auth tests green. Live smoke + Vault provisioning are ops steps (skip per owner). Only the owner's push/PR remains.
- **Type**: bugfix (security — completes the fail-closed posture; **fixes a discovered High-severity config bug**) + infrastructure (secret provisioning)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 follow-up (pairs with [TASK-460](../TASK-460-Gateway-Auth-Retry-Hygiene/README.md))
- **Origin**: TASK-460 (C4-02) made the gateway **send** `X-Service-Token` to NLP + Guardrail, but the receivers didn't **enforce** it — so C4-02 was not fully fail-closed end-to-end until this landed.
- **Severity**: Med baseline (defense-in-depth for PHI-bearing internal hops). Elevated by a **High-severity** config bug found during implementation: Guardrail's `service_token` read `GUARDRAIL_V2_SERVICE_TOKEN` (env_prefix) while the gateway provisions `GUARDRAIL_SERVICE_TOKEN` — left unchanged, prod would have **silently never enforced**. Fixed via `validation_alias` (see Implementation Summary).
- **Branch**: `fix/task-465-nlp-guardrail-auth` (based on `fix/2605-review`)
- **Size**: S–M

## ⚠️ Ops rollout ordering (secret provisioning) — REQUIRED

Enforcement is **bypassed only while the token is empty**. Once a receiver resolves a non-empty `service_token`, it enforces on every non-exempt surface that lacks a matching `X-Service-Token`: HTTP requests get a **401**, and NLP WebSocket handshakes (`/ws/classify/*`) are **refused at connect with close code 1008** — the WS surface is NOT covered by the HTTP middleware (`BaseHTTPMiddleware` never sees WS scopes), so the handlers call an explicit guard; that gap was caught and closed in review (see Change History 2026-07-10). The gateway (TASK-460) already sends the header on every hop (empty string when unresolved). Therefore the same token **value** must be provisioned for the gateway and each receiver together:

1. **Provision the shared secret** under BOTH keys with the **same value**: `NLP_SERVICE_TOKEN` (NLP receiver + gateway) and `GUARDRAIL_SERVICE_TOKEN` (Guardrail receiver + gateway) — Vault / host env. The gateway resolves them via `SecretsService`; the receivers read them via pydantic-settings.
2. Gateway sending the token — **done** (TASK-460, `ai-inference.client.ts`).
3. Deploy receivers **enforcing** — this ticket.

Provisioning (1) must precede or ship atomically with (3). If a receiver gets a non-empty token before the gateway is provisioned with the **same** value, the hop is rejected (HTTP 401 / WS close 1008). Leaving all three empty keeps the dev/hermetic-CI bypass (current default) intact.

## Requirement Analysis

TASK-460 closed C4-02's gateway half. The full fix requires the NLP + Guardrail FastAPI services to reject requests whose `X-Service-Token` is missing/empty/mismatched — mirroring the proven SMR middleware. Pre-implementation state:
- `apps/guardrail` had a `service_token: SecretStr("")` setting but **no enforcing middleware**, and it read the **wrong env key** (`GUARDRAIL_V2_` prefix).
- `apps/nlp` had **neither** the setting nor middleware.
- Reference mirrored: `apps/smr/src/smr/api/middleware/auth.py` — `X-Service-Token` shared-secret middleware with constant-time compare (`hmac.compare_digest`); EMPTY token = dev-mode bypass; health/docs/metrics paths exempt.

### Acceptance criteria

- [x] **AC-1**: `apps/guardrail` and `apps/nlp` each gain `X-Service-Token` middleware mirroring `apps/smr`'s (constant-time compare; health/docs/metrics exempt; empty-configured-token = dev bypass). EXEMPT_PATHS tailored per service (NLP health at `/api/v1/health*`; Guardrail health at `/api/health*`).
- [x] **AC-2**: `apps/nlp` gains `service_token: SecretStr` under `env_prefix="NLP_"` → reads `NLP_SERVICE_TOKEN` (matches gateway). `apps/guardrail`'s existing field is **corrected** to read the canonical `GUARDRAIL_SERVICE_TOKEN` via `validation_alias` (was silently reading `GUARDRAIL_V2_SERVICE_TOKEN`).
- [x] **AC-3 (red first)**: TDD — RED captured (NLP 12 failed; Guardrail 7 failed, incl. `test_legacy_v2_env_no_longer_read` asserting the old key was being read) → GREEN. Missing/wrong token → 401; matching token → passes (404 route-probe); empty token → bypass; exempt paths reachable.
- [x] **AC-4 (config/docs)**: `GUARDRAIL_SERVICE_TOKEN` / `NLP_SERVICE_TOKEN` present in `turbo.json#globalEnv` and the root `.env.example` (added by TASK-460). Per-app `.env.example`: Guardrail's already carried `GUARDRAIL_SERVICE_TOKEN=""`; `NLP_SERVICE_TOKEN=""` was **added to `apps/nlp/.env.example`** on 2026-07-11 (was missing — the only per-app config gap). Rollout order (provision → enforce, same value both sides) documented above; Vault provisioning is the ops action in step 1.
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
- **NEW** `src/nlp/api/middleware/__init__.py`, `src/nlp/api/middleware/auth.py` — `ServiceAuthMiddleware` (BaseHTTPMiddleware): constant-time `hmac.compare_digest`, empty-token bypass, 401 JSON `{"detail":"Invalid or missing service token"}`. Reads the token at **dispatch time** from the `nlp.core.config` module singleton (NLP has no per-app settings container). `EXEMPT_PATHS = /`, `/api/v1/health[/live|/ready]`, `/metrics`, `/docs`, `/redoc`, `/openapi.json`. The module also exports `enforce_service_token_ws(websocket)` — the **WebSocket counterpart** (a `BaseHTTPMiddleware` never sees WS scopes), same empty-token bypass + constant-time compare, refusing a bad handshake with `await websocket.close(code=1008)`.
- `src/nlp/core/config.py` — import `SecretStr`; add `service_token: SecretStr = SecretStr("")` to `NLPServiceConfig` (`env_prefix="NLP_"` → reads `NLP_SERVICE_TOKEN`, the gateway key).
- `src/nlp/app.py` — set `app.state.settings = settings` (parity) and `app.add_middleware(ServiceAuthMiddleware)` (added before CORS so CORS stays outermost).
- `src/nlp/api/v1/ws/classify.py` — both WS handlers (`/ws/classify/token/{id}`, `/ws/classify/text/{id}`) call `enforce_service_token_ws(websocket)` at the top and `return` if denied, **before `accept()`** (review fix — the WS surface was previously bypassing auth).
- **NEW** `tests/test_auth_middleware.py` — reuses the conftest `client` fixture; monkeypatches `nlp.core.config.settings.service.service_token`. HTTP tests use a `GET /api/v1/__auth_probe__` 404-probe; WS tests call `enforce_service_token_ws` directly against a fake WebSocket (bypass / missing / wrong / correct → close 1008) plus a real `/ws/classify/*` handshake-rejection test; an env-binding test proves `NLP_SERVICE_TOKEN` binds (not just a monkeypatched attribute).

_Guardrail (`apps/guardrail`)_
- **NEW** `src/guardrail/api/middleware/__init__.py`, `src/guardrail/api/middleware/auth.py` — same middleware, structlog logger, reading the token from `request.app.state.settings.service_token` at dispatch. `EXEMPT_PATHS = /api/health[/ready|/live]`, `/metrics`, `/docs`, `/redoc`, `/openapi.json` (tailored — NOT SMR's `/api/v1/...` set).
- `src/guardrail/core/config.py` — **the High-severity fix**: import `AliasChoices`; change `service_token` to `Field(default=SecretStr(""), validation_alias=AliasChoices("GUARDRAIL_SERVICE_TOKEN"))`. `validation_alias` overrides the class `env_prefix="GUARDRAIL_V2_"`, so the field now reads the canonical `GUARDRAIL_SERVICE_TOKEN` verbatim (the key the gateway/turbo.json/.env.example use). The legacy `GUARDRAIL_V2_SERVICE_TOKEN` is no longer consulted.
- `src/guardrail/main.py` — `app.add_middleware(ServiceAuthMiddleware)` in `create_app()` after `app.state.settings = settings`.
- **NEW** `src/guardrail/tests/test_auth_middleware.py` — builds `create_app()` and drives it with `httpx.ASGITransport` **without entering the lifespan** (no Redis/GLiNER/provider init). Includes dedicated alias tests: setting `GUARDRAIL_SERVICE_TOKEN` populates `service_token` and fires enforcement; setting only the legacy `GUARDRAIL_V2_SERVICE_TOKEN` leaves it empty.

**Empty-token bypass preserved**: both `service_token` defaults are `SecretStr("")`, so with no provisioned secret (local dev + hermetic CI) auth is bypassed — the full existing suites stay green.

### Verification evidence (gates)

Run from the isolated worktree; because `nlp`/`guardrail` are editable-installed against the shared checkout, the worktree source was forced onto the import path with `PYTHONPATH=<worktree>/apps/<svc>/src` for the **test** gates (lint/typecheck are path-based and needed no override). On the merged shared checkout the gates run unmodified.

```
pnpm py:nlp:test        → 70 passed  (18 new auth tests incl. WS + env-binding + 52 existing)
pnpm py:guardrail:test  → 54 passed  (10 new auth tests + 44 existing); auth.py coverage 100%
pnpm py:nlp:lint        → All checks passed!
pnpm py:guardrail:lint  → All checks passed!
pnpm py:nlp:typecheck   → Success: no issues found in 38 source files
pnpm py:guardrail:typecheck → Success: no issues found in 24 source files
```

RED→GREEN: pre-implementation the new Guardrail suite failed 7/10 — including `test_legacy_v2_env_no_longer_read` (`assert 'legacy-token-should-be-ignored' == ''`), directly proving the field was reading `GUARDRAIL_V2_SERVICE_TOKEN`; and the NLP suite failed 12/12 (pydantic rejected setting the not-yet-existent `service_token` field + missing middleware module). After the fix all pass.

### Re-verification on the merged `fix/2605-review` base (2026-07-11)

The auth-middleware code was already merged onto `fix/2605-review` (commits `886f6c4ff`, `7f8412a25`). Gates re-run on that base from an isolated worktree (worktree source forced onto the import path with `PYTHONPATH=<worktree>/apps/<svc>/src` because the conda env editable-installs against the shared checkout; lint/typecheck are path-based and unmodified). Suite counts are higher than the original 465 branch because this base also carries TASK-476 (NLP linker) and TASK-479 (Guardrail groundedness) tests:

```
NLP     pytest apps/nlp/tests/                          → 83 passed  (incl. 18 auth: HTTP + WS + env-binding)
Guardrail pytest apps/guardrail/src/guardrail/tests/    → 88 passed  (incl. 10 auth; auth.py coverage 100%)
ruff  apps/nlp/src apps/nlp/tests                        → All checks passed!
ruff  apps/guardrail/src                                 → All checks passed!
mypy  apps/nlp/src        (--config apps/nlp/pyproject)  → Success: no issues found in 39 source files
mypy  apps/guardrail/src  (--config apps/guardrail/…)    → 1 error at core/config.py:298 — PRE-EXISTING, NOT this ticket
```

The single Guardrail mypy error is on the `groundedness: GroundednessConfig = Field(default_factory=GroundednessConfig)` line (introduced by TASK-479 commit `6a409f7f97`), unrelated to the auth surface — the `service_token` field (config.py:277) and `auth.py` typecheck clean. It is outside this ticket's manifest (TASK-479 owns the Guardrail groundedness surface) and left untouched; flagged for that ticket.

Config gap closed on re-verification: `apps/nlp/.env.example` was missing `NLP_SERVICE_TOKEN` (Guardrail's `.env.example` already had `GUARDRAIL_SERVICE_TOKEN`); added `NLP_SERVICE_TOKEN=""` with a rollout comment (AC-4). Root `.env.example` / `turbo.json` were already correct and were not touched.

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | **Closed (Status → Completed).** Adversarial review = APPROVE (no Critical/Important): the token compare is genuinely constant-time (`hmac.compare_digest`; the only short-circuit is on the attacker-controlled `not provided`, leaking nothing about the secret), dev-bypass is safe (empty configured token = bypass; ANY set token always enforced on every non-exempt path), no bypass hole (exact-match exempt set; the WS gap is closed — both NLP WS endpoints guard before `accept()`), PHI never reaches the auth-path logs. Also fixed a real HIGH-severity config bug: `validation_alias=AliasChoices('GUARDRAIL_SERVICE_TOKEN')` overrides the `GUARDRAIL_V2_` prefix so prod reads the canonical key the gateway provisions (else it would have silently never enforced). Tests meaningful (NLP 18 + guardrail 10). Live cross-service smoke + Vault provisioning are ops/deploy steps. No external work remains — only the owner's push/PR. |
| 2026-07-09 | Ticket scaffolded from TASK-460's C4-02 coordination finding (gateway sends the token; NLP/Guardrail don't enforce it). Reference middleware (`apps/smr`) and the secret-provisioning rollout-order risk recorded. Awaiting prioritization. |
| 2026-07-10 | Implemented via strict TDD on `fix/task-465-nlp-guardrail-auth`. Added `ServiceAuthMiddleware` + `service_token` config to NLP; added the same middleware to Guardrail and **fixed the High-severity env-key mismatch** (Guardrail read `GUARDRAIL_V2_SERVICE_TOKEN`; now reads canonical `GUARDRAIL_SERVICE_TOKEN` via `validation_alias`). Empty-token dev/CI bypass preserved. All 6 gates green (NLP 64 / Guardrail 54 tests; lint + mypy clean). Rollout ordering (provision same value both sides → enforce) documented. Status → Review. |
| 2026-07-10 (review) | Adversarial review caught an **Important** gap: `ServiceAuthMiddleware` is a `BaseHTTPMiddleware`, whose `dispatch()` never runs for WebSocket scopes, so NLP `/ws/classify/token/{id}` and `/ws/classify/text/{id}` accepted unauthenticated connections when a token was configured. Fix: added `enforce_service_token_ws()` (mirrors the HTTP guard exactly — empty-token bypass, constant-time compare, refuse with close 1008) and called it at the top of both WS handlers before `accept()`. Added 4 WS-guard unit tests + a real-endpoint handshake-rejection test + an `NLP_SERVICE_TOKEN` env-binding test; corrected the README's HTTP-only enforcement wording. Guardrail exposes no WS endpoints, so its HTTP-only surface is unaffected. Gates re-run green: **NLP 70 passed, Guardrail 54 passed, NLP lint + mypy clean**. |
| 2026-07-11 | Verified the already-merged implementation on `fix/2605-review` (commits `886f6c4ff`, `7f8412a25`) from an isolated worktree. Closed the one remaining per-app config gap: added `NLP_SERVICE_TOKEN=""` to `apps/nlp/.env.example` (Guardrail's already had its key; root `.env.example`/`turbo.json` untouched). Re-ran all six gates on this base: **NLP 83 passed (18 auth), Guardrail 88 passed (10 auth), ruff clean both, NLP mypy clean, Guardrail mypy 1 PRE-EXISTING error** at `core/config.py:298` (`GroundednessConfig` default_factory, TASK-479 commit `6a409f7f97`) — unrelated to the auth surface, outside this manifest, left untouched and flagged for TASK-479. Higher suite counts vs the 465 branch reflect TASK-476/479 tests now on the base. Status stays **Review** — the only remaining gaps are the ops-gated live cross-service smoke (AC-5) and Vault provisioning of the shared secret on both sides (§ Ops rollout). |
