# TASK-578 — Seed-Authoritative Provider Connections (enable built-in-local SYSTEM rows)

- **Status**: Review (OD-1 confirmed; implemented TDD Red→Green; DB suite green)
- **Type**: infrastructure (seed) + bugfix
- **Tier**: opus-4-8-high (reverses a deliberate architectural guard; cross-service behavioral-regression risk)
- **Program**: [Provider-Plane Day-1 Defaults](../SOTA-Track/2026-07-28-provider-plane-day1-defaults-followups.md) — finding **F2**
- **Owner gate**: **OD-1 CONFIRMED 2026-07-28** — flip to seed-authoritative; SYSTEM tenant holds the default values; enable built-in-local rows, keep cloud rows disabled.

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

- [x] OD-1 confirmed and recorded.
- [x] Discovery note: runtime impact of enabling local rows, stated explicitly (behavior-neutral for serving).
- [x] `pnpm --filter @arcaai/database test` green (882). Serving-regression: applications resolver suites (seed-independent). e2e assertion flagged as out-of-scope open item.
- [x] `psql` proof: local rows enabled, cloud rows disabled; idempotent re-seed.
- [x] No cloud-BYO row is enabled without a key (invariant §6.2).

## Implementation Summary

### Phase A — Discovery: runtime impact of enabling the built-in-local SYSTEM rows (PROVEN behavior-neutral for serving)

Mapped every runtime consumer of `resolveConnection` and `findByTenantServiceProvider` for `service='llm'`:

- **`resolveConnection` has ZERO runtime consumers.** The only `.resolveConnection(` call sites in any `src/` tree are the service's own definition (`ai-provider-connection.service.ts:228`), its interface (`IProviderConnectionService.ts:98`), and unit tests (`ai-provider-connection.service.test.ts`, `-discriminator.test.ts`). No controller, gateway, or Python-facing wiring invokes it. Enabling the SYSTEM local rows changes **what `resolveConnection` would return** (the SYSTEM row instead of `null`) but nothing at runtime consumes that return value today — it makes the DB the **declared** source of truth without repointing any live serving path.
- **`findByTenantServiceProvider` is called only inside `AiProviderConnectionService` itself** (getRow/upsert/delete/resolve). No external caller.
- **The LLM base provider/model is NOT selected via the connection plane.** SMR's base provider/model comes from the `AiTaskDefault`/`HarnessPolicy` cascade (`smr-proxy.controller.ts:489,1134`) plus SMR's own env-config registry. `smr-proxy.controller.ts` injects into the forwarded body **only** `resolveTenantCloudOverrides('llm', tenantId)` (`:242`).
- **`resolveTenantCloudOverrides` cannot pick up the newly-enabled local rows.** It skips any row where `!isCloudByoProvider(service, row.provider)` (`ai-provider-connection.service.ts:277`) and any row without `encryptedApiKey` (`:278`). `CLOUD_BYO_PROVIDERS.llm = ['azure','bedrock','openai','anthropic','vertex']` (`constants.ts:35`) — the five built-in-local providers (`ollama`, `lm-studio`, `built-in`, `vllm`, `llama-cpp`) are **not** in it, and they carry no key. So the TTS/STT/SMR BYO-injection paths are unaffected.

**Conclusion:** enabling the five built-in-local `llm` rows is **behavior-neutral for LLM/STT/TTS serving** — it makes the SYSTEM DB rows the authoritative *declared* Day-1 default (criterion 2) without changing any served request. No base-URL lookup is repointed. Safe to proceed to GREEN. No consuming service was found selecting an env provider default in preference to the SYSTEM row for the connection plane (that gap, where it exists, is SMR/guardrail-config-side and owned by TASK-579/580, not the connection plane).

### Changes

- `seed/17-ai-provider-connection.ts` — flipped the five built-in-local `llm` rows (`ollama`, `lm-studio`, `built-in`, `vllm`, `llama-cpp`) to `enabled: true`; dropped their `metaData.placeholder` flag (kept a reworded base-URL note describing it as env-tier connection identity / declared source of truth). All cloud-BYO rows (llm `azure`/`bedrock`/`openai`/`anthropic`/`vertex`/`sarvam` + all stt/tts) remain `enabled: false`. Rewrote the file header (SILENT-CHANGE GUARD → SEED-AUTHORITATIVE) and made the create-log line report enabled/disabled per row.
- `seed/__tests__/config-plane-seed.test.ts` — replaced the "every connection DISABLED" assertion with: exactly the five `llm:*` built-in-local rows enabled; every other row (all services) disabled; the built-in-local rows are not placeholders. Kept the no-key-material invariant. Updated the file docstring.
- `seed/index.ts` — updated only the stale comment block above `seedAiProviderConnection` (built-in-local connections active Day-1; cloud rows inert until a tenant brings a key; profiles still empty). **Path taken:** TASK-578 edited only that comment block (TASK-577 had already finished its `seedTenantTtsConfig` step edit to `index.ts`).

### Evidence

- `pnpm --filter @arcaai/database test` — **882 passed (27 files)**, `config-plane-seed.test.ts` included. RED first confirmed (3 failing against the all-disabled seed), then GREEN.
- Serving-regression gate: `pnpm --filter @arcaai/applications test` — **7133 passed | 4 skipped (368 files)**, 0 failed. Covers the `ai-provider-connection` resolver cascade, `smr-proxy-tenant-byo`, and `tenant-stt/tts` suites. These mock the repository, so they exercise the resolver directly and are seed-independent (the resolver logic is unchanged by this ticket; only seed DATA changed).
- psql re-seed proof against the test DB (`hope_test`, :5433). Hard-deleted only the `87000000-%` block (this ticket's rows; TASK-577's `TenantTtsConfig` untouched), then ran `seedAiProviderConnection` twice:

  ```
  Hard-deleted 16 AiProviderConnection rows (87000000-% block).
  RESEED #1 => created=16 skipped=0    ENABLED(5): llm:built-in, llm:llama-cpp, llm:lm-studio, llm:ollama, llm:vllm
  RESEED #2 => created=0  skipped=16   (idempotent — row counts stable, no drift)
  ```

  Final `SELECT service, provider, enabled ... WHERE id LIKE '87000000-%'`:
  ```
  llm | built-in/llama-cpp/lm-studio/ollama/vllm            | t   (5 built-in-local)
  llm | anthropic/azure/bedrock/openai/sarvam/vertex        | f   (6 cloud)
  stt | azure-speech/openai/sarvam                          | f   (3 cloud)
  tts | azure/sarvam                                        | f   (2 cloud)
  ```

### Open item (out of ownership — needs an apps/api e2e owner)

`apps/api/tests/e2e/ai-provider-connections.spec.ts:37` asserts *"seeds eleven SYSTEM connections, all disabled and all keyless"* (`expect(row.enabled).toBe(false)` for every row). After this change five llm rows seed enabled, so that assertion is now stale and will fail when the live e2e runs. That spec is **not** in TASK-578's file-ownership scope (§5) and was left untouched. It needs its enabled-state assertion updated to the new posture (five built-in-local llm rows enabled; cloud rows disabled) by whoever owns the apps/api e2e lane. The unit-level serving-regression gate (applications resolver suites) is unaffected.

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F2). Status Pending, blocked on OD-1.
- 2026-07-28 — OD-1 confirmed; implemented (TDD Red→Green). Discovery proved enabling the built-in-local SYSTEM rows is behavior-neutral for serving (`resolveConnection` has no runtime consumer; cloud BYO injection filters out non-cloud/keyless rows). Enabled the five built-in-local `llm` rows; all cloud rows stay disabled. `@arcaai/database` suite green (882). Flagged the stale, out-of-scope e2e assertion (`ai-provider-connections.spec.ts:37`). Status → Review.
