# TASK-574 — LLM BYOK: Runtime Verification

- **Status**: Pending
- **Type**: verification
- **Program**: [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) — Wave 0 (independent, starts day 1)
- **Branch of record**: `thuynh/2607`
- **Size**: S · **Wave**: 0 · **Depends on**: nothing (closes TASK-524 §9.8)
- **Runs fully parallel** — no code-file overlap.

> Closes the runtime-verification tail the shipped LLM BYOK (TASK-524/526) left open. **No code change expected** — this is boot + live-DB + Vault + e2e execution with captured evidence. If a real defect surfaces, file a fix ticket rather than expanding scope here.

## Agent execution

| Phase | Tier | Goal |
|---|---|---|
| Discovery | **claude-sonnet-5-low** | Read TASK-524 §9.8 + `apps/api/tests/e2e/byo-llm-credentials.spec.ts`; determine exactly what the env-gate needs (an `SMR_URL` stub listener, applied migration, seeded rows) and what "green" looks like. |
| Implementation | **claude-sonnet-5-high** | Stand up the prerequisites, run boot + the e2e + a Vault-live encrypt/decrypt round-trip; capture output. |
| Review/close | **claude-sonnet-5-xhigh** | Confirm evidence is real and complete; update TASK-524 §9.8 to Verified; if a defect was found, ensure it's filed. |

**Ownership (exclusive):** `docs/implementation/TASK-524/**` (verification section) and the execution/run of `byo-llm-credentials.spec.ts`. **Do NOT** modify LLM app/service code — TASK-569/572 own it; a change here would collide.

## 1. Requirement Analysis
Produce the runtime evidence TASK-524 §9.8 marked outstanding: (a) service boots with the kill-switch/route audit observed firing; (b) migration applied to the test DB; (c) Vault-live encrypt→store→decrypt round-trip for a BYO key; (d) the env-gated `byo-llm-credentials.spec.ts` executed against a live stack and green.

## 2. Current State Evaluation (2026-07-28)
- TASK-524 README §9.8: no runtime boot, no live-DB integration run, no Vault round-trip (mocked only), migration not on test DB; `byo-llm-credentials.spec.ts` env-gated + skipped by default (needs an operator-provided `SMR_URL` stub because the gateway resolves `SMR_URL` once at bootstrap).
- All static gates already green (README §9.1).

## 3. Implementation Plan
1. `pnpm infra:test:up`; apply migrations; seed; confirm `AiProviderConnection` SYSTEM rows present.
2. Boot the gateway (or the minimal module) with a stub `SMR_URL` listener; observe the kill-switch `onModuleInit` guard + deny-by-default route audit firing (capture logs).
3. Vault round-trip: with a dev Vault Transit key, PUT a BYO cred, read masked (`hasKey:true`), and prove the ciphertext decrypts to the input (test-only decrypt).
4. Run `byo-llm-credentials.spec.ts` with the stub; capture the BYO→SMR override injection assertion green.
5. Update TASK-524 §9.8 → Verified with pasted evidence. Note: if TASK-569's migration has already landed, run against the unified schema and note the `service='llm'` filter path.

## 4. Verification
- Boot log excerpt (guard + audit firing), migration status clean, Vault round-trip proof, e2e green output — all pasted into TASK-524 §9.8.

## 5. Implementation Summary
_(fill on completion.)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 0 LLM runtime verification). |
