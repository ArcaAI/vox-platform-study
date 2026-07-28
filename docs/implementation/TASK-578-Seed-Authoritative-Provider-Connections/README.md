# TASK-578 — Seed-Authoritative Provider Connections (enable built-in-local SYSTEM rows)

- **Status**: Pending (BLOCKED on OD-1)
- **Type**: infrastructure (seed) + bugfix
- **Tier**: opus-4-8-high (reverses a deliberate architectural guard; cross-service behavioral-regression risk)
- **Program**: [Provider-Plane Day-1 Defaults](../SOTA-Track/2026-07-28-provider-plane-day1-defaults-followups.md) — finding **F2**
- **Owner gate**: **OD-1** (flip to seed-authoritative) must be confirmed before any code change.

## Requirement Analysis

Criterion 2 requires the seed to be the **Day-1 authority** for built-in providers. Today the seed does the **opposite by design**: all 17 SYSTEM `AiProviderConnection` rows are `enabled:false`, and `seed/index.ts:122-124` documents this as the *"silent-change guard"* — *"every resolution still falls through to the consuming service's env defaults."* So env, not seed, is the Day-1 authority for the LLM path.

Goal: make the **built-in-local** SYSTEM connection rows (`ollama`, `lm-studio`, `built-in`, `vllm`, `llama-cpp`) `enabled:true` so `resolveConnection('llm', …)` returns a DB row Day-1, and env becomes a pure fallback. **Cloud-BYO** rows (`azure`, `bedrock`, `openai`, `anthropic`, `vertex`, and all STT/TTS cloud rows) stay `enabled:false` — they require a tenant to bring a key, so an enabled-but-keyless cloud row must never serve.

## Current State Evaluation (code-verified 2026-07-28)

- Seed data: `seed/17-ai-provider-connection.ts:57-313`, 17 rows, every one `enabled:false` with `metaData:{placeholder:true}` on the local ones (`:71,:87,…`).
- Resolver: `resolveConnection` (`ai-provider-connection.service.ts:228-241`) treats a **disabled row as absent** (`:236-238`) and returns `null` when neither tenant nor SYSTEM row is enabled. Enabling the SYSTEM local rows makes it return the SYSTEM row.
- **Behavioral unknown to resolve in Discovery:** identify every runtime consumer of `resolveConnection('llm', …)` and confirm what changes when it returns a row instead of `null`. The LLM *base* provider/model today is selected via `AiTaskDefault` (`smr.live`/`smr.finalize` → lm-studio) and SMR's own env-config provider registry; `smr-proxy.controller.ts` injects only `resolveTenantCloudOverrides` (cloud BYO). So enabling local rows may be **behavior-neutral for LLM serving** and only make the DB the *declared* source of truth — or it may repoint a base-URL lookup. **Do not proceed to GREEN until this is proven**, because a wrong assumption here silently breaks SMR.
- STT/TTS local engines are deliberately **not** in the connection plane (self-host endpoints are platform infra, `17-…:34/:235`); their Day-1 defaults come from `AsrPipeline` (STT, already DB-authoritative) and TASK-577's SYSTEM `TenantTtsConfig` (TTS). This ticket therefore only affects the **LLM** local rows.

## Implementation Plan (TDD)

### Phase A — Discovery (opus, low tier acceptable)

1. Map every caller of `resolveConnection` and `findByTenantServiceProvider` for `service='llm'`. Produce a short note in this README's Implementation Summary: "enabling the local SYSTEM rows changes X / changes nothing at runtime." This decides whether Phase C regression is behavior-neutral or behavior-changing.

### Phase B — Enable built-in-local SYSTEM rows

2. **RED** — extend `seed/__tests__/ai-provider-connection*.test.ts`: assert the five built-in-local `llm` rows (`ollama`, `lm-studio`, `built-in`, `vllm`, `llama-cpp`) seed `enabled:true`, and that **all cloud-BYO rows across all services stay `enabled:false`**. Run → fails.
3. **GREEN** — in `seed/17-ai-provider-connection.ts` flip `enabled:true` only for the five built-in-local `llm` rows; drop their `metaData.placeholder` flag (they are now active, not placeholders — keep the base-URL note). Leave every cloud row `enabled:false`.
4. Update the `seed/index.ts:122-124` comment to describe the new posture (built-in-local connections active Day-1; cloud rows inert until a tenant brings a key). **Note:** §5 of the program doc assigns `index.ts` to TASK-577 — coordinate a single edit to that comment, or (preferred) TASK-578 leaves `index.ts` untouched and only edits `17-…ts` + its test, updating the stale-comment wording via TASK-577's `index.ts` edit. Record which path was taken.

### Phase C — Regression gate (the risk)

5. Run the full shipped LLM BYOK unit + e2e suites (`ai-provider-connection*.spec.ts`) and the SMR resolution tests. Prove no serving regression. If Discovery (A) found a real behavioral change, add a test that pins the new (intended) behavior and document it as an intentional change under the program's invariant §6.3.
6. Reseed a throwaway test DB; `psql` SELECT showing the five local rows `enabled=true` and cloud rows `enabled=false`; re-seed twice for idempotency.

## TDD Test List (RED first)

- Seed-shape test: 5 built-in-local `llm` rows `enabled:true`; all cloud rows `enabled:false`.
- Resolver test: `resolveConnection('llm','lm-studio',SYSTEM)` returns the SYSTEM row (not null) after seed.
- Resolver test: `resolveConnection('llm','azure',SYSTEM)` still returns null (cloud stays disabled).
- Regression: shipped LLM BYOK suite green.

## Verification Criteria (Definition of Done)

- [ ] OD-1 confirmed and recorded.
- [ ] Discovery note: runtime impact of enabling local rows, stated explicitly.
- [ ] `pnpm --filter @arcaai/database test` + shipped LLM BYOK suite green.
- [ ] `psql` proof: local rows enabled, cloud rows disabled; idempotent re-seed.
- [ ] No cloud-BYO row is enabled without a key (invariant §6.2).

## Implementation Summary

_(fill on completion — Discovery note, files changed, command output, psql proof)_

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F2). Status Pending, blocked on OD-1.
