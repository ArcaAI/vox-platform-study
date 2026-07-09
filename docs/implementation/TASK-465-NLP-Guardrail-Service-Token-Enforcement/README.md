# TASK-465 — NLP + Guardrail Service-Token Enforcement (C4-02 receiver half, DISCOVERED)

- **Status**: Pending (discovered during TASK-460 implementation — awaiting prioritization)
- **Type**: bugfix (security — completes the fail-closed posture) + infrastructure (secret provisioning)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 2 follow-up (pairs with [TASK-460](../TASK-460-Gateway-Auth-Retry-Hygiene/README.md))
- **Origin**: TASK-460 (C4-02) made the gateway **send** `X-Service-Token` to NLP + Guardrail, but the receivers don't **enforce** it — so C4-02 is not fully fail-closed end-to-end until this lands.
- **Severity**: Med (defense-in-depth for PHI-bearing internal hops)
- **Branch (when scheduled)**: `fix/task-465-nlp-guardrail-auth` (from the Wave-2 landing)
- **Size**: S–M

## ⚠️ Needs an ops decision (secret provisioning)

This introduces two new secret keys — `GUARDRAIL_SERVICE_TOKEN` and `NLP_SERVICE_TOKEN` — that must be provisioned in **Vault / host env** (and the gateway side, added by TASK-460, resolves them via `SecretsService`). **A fail-closed receiver with an unprovisioned token will 401 all traffic**, so provisioning must precede (or ship atomically with) enabling enforcement. Confirm the rollout order with the operator: (1) provision the secrets, (2) deploy gateway sending the token (TASK-460, done), (3) deploy receivers enforcing. Until (1)+(3), the gateway sends an empty/absent token that the (future) middleware would reject.

## Requirement Analysis

TASK-460 closed C4-02's gateway half. The full fix requires the NLP + Guardrail FastAPI services to reject requests whose `X-Service-Token` is missing/empty/mismatched — mirroring the proven SMR middleware. Current state (verified by TASK-460's implementer):
- `apps/guardrail` has a `service_token: SecretStr("")` setting ([config.py:230]) but **no enforcing middleware**.
- `apps/nlp` has **neither** the setting nor middleware.
- Reference to mirror: `apps/smr/src/smr_v2/api/middleware/auth.py` — `X-Service-Token` shared-secret middleware with constant-time compare (`hmac.compare_digest`); EMPTY token = dev-mode bypass; health/docs/metrics paths exempt (per `.claude/rules/06-python-services.md`).

### Acceptance criteria

- [ ] **AC-1**: `apps/guardrail` and `apps/nlp` each gain `X-Service-Token` middleware mirroring `apps/smr`'s (constant-time compare; health/docs/metrics exempt; empty-configured-token = dev bypass so local dev without the secret still works).
- [ ] **AC-2**: `apps/nlp` gains the `service_token: SecretStr` setting with the correct `env_prefix`; `apps/guardrail` reuses its existing one.
- [ ] **AC-3 (red first)**: tests assert a missing/mismatched token → 401 and a matching token → 200 (mirror `apps/smr`'s auth-middleware tests).
- [ ] **AC-4 (config/docs)**: `GUARDRAIL_SERVICE_TOKEN` / `NLP_SERVICE_TOKEN` added to `turbo.json#globalEnv`, `.env.example`, and the Vault provisioning path; rollout order documented (provision → enforce).
- [ ] **AC-5**: `pnpm py:guardrail:test` + `pnpm py:nlp:test` (+ lint/typecheck) green; the gateway↔receiver hop works end-to-end with the token (verify against a live stack or an e2e that exercises the proxy).

### Non-goals

- The gateway side (done in TASK-460). SMR (already fail-open→handled separately if desired; TASK-460 left SMR's fail-open as-is per its scope).
- Rotating/short-lived service tokens (static shared secret matches the existing SMR pattern).

## Current State Evaluation (from TASK-460's implementer, 2026-07-09)

Gateway now attaches `X-Service-Token` on both hops (`ai-inference.client.ts`, keys `GUARDRAIL_SERVICE_TOKEN`/`NLP_SERVICE_TOKEN`, empty-when-unresolved fail-closed). Receivers: `apps/guardrail` setting present ([config.py:230]) no middleware; `apps/nlp` neither. Pattern to mirror: `apps/smr/src/smr_v2/api/middleware/auth.py`.

## Implementation Plan

_Deferred — pending prioritization + the secret-provisioning ops decision. When scheduled, standard TDD stream (Python), mirroring the SMR auth middleware, with the rollout-order guard above._

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-460's C4-02 coordination finding (gateway sends the token; NLP/Guardrail don't enforce it). Reference middleware (`apps/smr`) and the secret-provisioning rollout-order risk recorded. Awaiting prioritization. |
