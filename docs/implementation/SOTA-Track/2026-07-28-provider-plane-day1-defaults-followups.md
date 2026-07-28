# Program — Provider-Plane Day-1 Defaults: Env-Zeroing + Seed-Authoritative Follow-ups

- **Program status**: Planned (2026-07-28)
- **Branch of record**: `thuynh/2607`
- **Author**: platform review (multi-agent audit, opus-4-8)
- **Child tickets**: TASK-577 … TASK-581 (5 tickets)
- **Parent program**: [Unified Provider-Connection Plane](2026-07-28-unified-provider-plane-program.md) (TASK-569–576). This is the **remediation follow-up** — the unification landed the DB control plane; these tickets close the Day-1-defaults gaps the unification did not touch.

This document is the **single source of truth** for the audit findings (§2), the two owner decisions (§3), the ticket index + tier assignments (§4), and the file-ownership matrix (§5). Every child ticket references this file. **Read this before opening any child ticket.**

---

## 1. The requirement being verified

Two owner acceptance criteria for the BYO-provider program:

1. **Env-zeroing** — environment variables must NOT carry any specific STT/TTS/LLM **provider or model *selection* default** that acts as the default for ALL tenants. Env may carry connection identity/topology for platform-run built-in engines (per the Configuration-Tiers rule in `09-infrastructure-devops.md`), but not "tenant X gets provider Azure because the env says so."
2. **Seed-authoritative Day-1** — the seed must ship a set of **built-in** providers (LLM local engines + STT/VAD/noise/speaker-embedding + TTS local voices, plus a text/RAG embedder) so the platform serves on Day-1 **from the DB**, with no per-tenant configuration and no reliance on env selection.

Tenant admins then (a) BYO-key their own cloud providers and (b) configure per-tenant default/fallback providers — both already shipped (TASK-567/496/569–576).

---

## 2. Findings (code-verified 2026-07-28 on `thuynh/2607`)

The **TypeScript gateway plane is compliant**: `AiProviderConnectionService.resolveConnection` is `tenant → SYSTEM → null` (`packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts:228`), and its header explicitly states it *"Replaces per-service env configuration"* (`:38`). `.env.example` and `turbo.json#globalEnv` carry only credential/URL passthrough names — no selection defaults. NLP filters model-identity keys out of env entirely (`apps/nlp/src/nlp/core/config.py:24-74`). STT selection is DB-driven via `AsrPipeline`.

The gaps are all (a) in the **Python consuming services** where a selection default is still baked, and (b) in **seed activation**, where the SYSTEM rows are deliberately inert.

| # | Finding | Severity | Ticket |
|---|---|---|---|
| F1 | **TTS `routing_en`/`routing_ml` hardcode an Azure-first provider chain for ALL tenants**, fail-open. `apps/tts/src/tts/core/config.py:162-167` defaults `routing_en=["azure","kokoro"]`, `routing_ml=["azure","sarvam","indic_parler"]`; `routing/router.py:161-163` falls back to it when the gateway injects no per-tenant routing. There is **no seeded SYSTEM `TenantTtsConfig`**, so `getEffective` (`tenant-tts-config.service.ts:62`) returns empty routing and the code default always wins Day-1. | **Violation** (the one clear breach of criterion 1) | **TASK-577** |
| F2 | **All 17 SYSTEM `AiProviderConnection` rows seed `enabled:false`** (`seed/17-ai-provider-connection.ts:70…`), by explicit design: `seed/index.ts:122-124` — *"Connections seed DISABLED … so every resolution still falls through to the consuming service's env defaults (the silent-change guard)."* This makes **env the Day-1 authority**, the direct inverse of criterion 2. Built-in local engines are catalog placeholders, not active connections. | **Architectural gap** (criterion 2) | **TASK-578** |
| F3 | **SMR cloud sub-configs carry a per-provider `default_model`** (`config.py:61,80,172,197,223` — Azure `gpt-5-mini`, OpenAI `gpt-4o-mini`, Anthropic `claude-3-5-haiku`, Vertex `gemini-2.0-flash`, Bedrock `claude-3-5-haiku`). When the gateway omits a model, the env value substitutes one — a soft tension with `failMode=closed` for SELECTION. Per-provider (not one global default), so borderline, not a clear breach. | **Borderline** | **TASK-579** |
| F4 | **Guardrail's `DatabaseConfig` docstring (`config.py:277-279`) claims fail-OPEN to the env-selected engine**, but the resolver (`core/dependencies.py:94-99`) correctly fails **CLOSED (503)**. Stale, misleading comment on a safety-critical path. Plus hygiene: stale Azure block in the gitignored `.env.dev` template (`SUMMARY_SERVICE_PROVIDER=azure_openai`, a since-rotated endpoint host) and a committed `HARNESS_JUDGE_PROVIDER/_MODEL` in `.env.production` (eval infra, informational). | **Doc/hygiene** | **TASK-580** |
| F5 | **No general text/RAG embedding provider or model is seeded** — only diarization `SPEAKER_EMBEDDING` models. The `FEATURE_EXTRACTION`/`SENTENCE_SIMILARITY` enum values (`enums.prisma:131,135`) have no seed row. If the Day-1 built-in set is meant to include a knowledge/RAG text embedder, it is missing. | **Gap (investigate-then-seed)** | **TASK-581** |

**Non-findings (compliant, no ticket):** `.env.example`, `turbo.json#globalEnv`, NLP config, STT config. Documented here so a later reviewer does not re-flag them.

---

## 3. Owner decisions (confirm before/at implementation)

- **OD-1 — Flip to seed-authoritative? (blocks TASK-578).** The current "silent-change guard" is a *deliberate* choice that env is the Day-1 default and SYSTEM connections are inert. Criterion 2 requires the inverse. TASK-578 is written to **enable the built-in-local SYSTEM connection rows** (ollama, lm-studio, built-in, vllm, llama-cpp) so the DB is authoritative, keeping cloud-BYO rows disabled. Confirm this reversal is intended — it changes runtime resolution behavior for the LLM path and must be regression-gated. If instead the owner wants env to remain the built-in-topology source (treating seed rows as pure catalog), TASK-578 narrows to "document the split" and criterion 2 is satisfied by the `AiModel` catalog alone.
- **OD-2 — TTS Day-1 default provider order (drives TASK-577 seed values).** The remediation seeds a SYSTEM `TenantTtsConfig` with a built-in-first chain so no cloud vendor is the implicit default. Proposed: `routingEn=["kokoro"]`, `routingMl=["indic_parler"]` (both local). Confirm, or supply the desired built-in-first order. Azure/Sarvam remain available strictly as tenant-configured BYO entries.

Neither decision blocks documentation; both are recorded in the child READMEs as gates before the code change merges.

---

## 4. Ticket index + model-tier assignment

Tiers per the owner's roster for this program: **sonnet-5-xhigh** for simple/scoped tasks, **opus-4-8-high** for complex/cross-layer/behavior-risk tasks. **Opus 5 is NOT to be used.** Every ticket runs Discovery → Implement (TDD) → Verify; the tier below is the implementation tier.

| Ticket | Title | Tier | Why this tier |
|---|---|---|---|
| **TASK-577** | TTS Default Routing — Seed SYSTEM `TenantTtsConfig` + Fail-Closed Router | **opus-4-8-high** | Cross-layer (DB seed + gateway resolution + Python router/config) **and** changes a fail-mode on a serving path. The one clear criterion-1 violation. |
| **TASK-578** | Seed-Authoritative Provider Connections (enable built-in-local SYSTEM rows) | **opus-4-8-high** | Reverses a deliberate architectural guard (`silent-change guard`) across the LLM resolution path; behavioral-regression risk across shipped BYOK; needs adversarial verification of what actually consumes `resolveConnection`. Gated on OD-1. |
| **TASK-579** | SMR Cloud `default_model` — Align to `failMode=closed` | **sonnet-5-xhigh** | Scoped to `apps/smr` pydantic config + resolution; a decision + small edits, no new integration. |
| **TASK-580** | Provider-Config Hygiene (guardrail docstring, env template cleanup) | **sonnet-5-xhigh** | Doc/comment + local-template hygiene; no runtime behavior change. |
| **TASK-581** | Default Text/RAG Embedding Provider Seed | **sonnet-5-xhigh** | Discovery-then-seed; seed-file addition following the existing `AiModel` pattern. |

Parallelism: 579, 580, 581 are independent and can run concurrently from day 1. 577 and 578 both touch the seed layer and its tests (see §5) — they may run in parallel but share one DB-reset/reseed + seed-test gate at integration. 578 is gated on OD-1; 577 on OD-2.

---

## 5. File-ownership matrix (zero concurrent edits)

| Path (glob) | Owner |
|---|---|
| `apps/tts/src/tts/core/config.py` · `apps/tts/src/tts/routing/router.py` · `apps/tts/**/tests/**` (router/config) | **TASK-577** |
| new `packages/database/src/prisma/db_main/seed/19-tenant-tts-config.ts` · its barrel line + step in `seed/index.ts` | **TASK-577** |
| `apps/api/src/modules/speech/tts-ws.gateway.ts` · `speech-proxy.controller.ts` (only if the fail-open-on-error tightening in §Impl is taken) | **TASK-577** |
| `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts` · `seed/__tests__/ai-provider-connection*.test.ts` | **TASK-578** |
| `apps/smr/src/smr/core/config.py` · `apps/smr/src/smr/**/tests/**` (provider config) | **TASK-579** |
| `apps/guardrail/src/guardrail/core/config.py` (docstring only) · `.env.dev` template · `.env.production` (comment) · `.env.example` | **TASK-580** |
| `packages/database/src/prisma/db_main/seed/ai-models/*` (new embedding entry) · `seed/16-ai-task-default.ts` (if a task default is added) | **TASK-581** |

**Shared-file discipline:** the only shared file is `seed/index.ts` — **only TASK-577** edits it (adds the `seedTenantTtsConfig` step). TASK-578 edits an existing seed data file in place (no index change). TASK-581 adds to an existing `ai-models/*` list (no index change). No two tickets author a migration (none of these need a schema change — all fields already exist).

---

## 6. Cross-cutting invariants (every lane enforces)

1. **No provider/model *selection* default in env after this program.** Env keeps connection identity (URLs, keys, regions) only; the *choice* of provider/model resolves from DB (`TenantTtsConfig`/`AsrPipeline`/`AiTaskDefault`/`AiProviderConnection`) → SYSTEM default → fail-closed.
2. **Built-in-first defaults.** Every seeded SYSTEM default points at a platform-run built-in engine, never a cloud vendor. Cloud providers are tenant-opt-in only.
3. **Behaviour-neutral where required, behaviour-changing where intended.** TASK-580/579/581 must not change serving behavior for an already-configured deployment. TASK-577/578 intentionally change Day-1 behavior (that is the point) and therefore carry the full regression gate (§7).
4. **Secrets discipline unchanged.** No key material in seeds, logs, or Redis; Vault-Transit ciphertext only (inherited from the parent program §5).
5. **No `pnpm gen:mapper`** (destructive). No schema/migration in this program.

---

## 7. Verification strategy (evidence required to close each ticket)

Per `verification-before-completion` — every Implementation Summary pastes **actual** command output.

- **Static gates (each ticket, scoped):** TS lanes `pnpm --filter <pkg> build test lint typecheck`; Python lanes `pnpm py:<svc>:test|lint|typecheck`, `uv lock` if deps changed; seed lanes `pnpm --filter @arcaai/database test`.
- **Seed lanes (577, 578, 581):** reseed a throwaway test DB (`pnpm setup:test` / `pnpm test:db:reset` + `pnpm test:db:seed`) and prove the new/changed rows with a `psql` SELECT; assert idempotency (re-seed twice, row counts stable).
- **Behavioral gates (577, 578):** the shipped TTS + LLM BYOK unit/e2e suites stay green (regression), plus a new test proving DB-sourced routing/connection wins over the code/env default.
- **577 runtime proof:** with no per-tenant `TenantTtsConfig`, the gateway injects the SYSTEM routing and TTS synthesizes via a **built-in** provider (not Azure) — captured from a live `apps/tts` run or the router unit test with the SYSTEM chain.

---

## 8. Ticket table

| Ticket | Doc |
|---|---|
| TASK-577 | `TASK-577-TTS-Default-Routing-Fail-Closed/README.md` |
| TASK-578 | `TASK-578-Seed-Authoritative-Provider-Connections/README.md` |
| TASK-579 | `TASK-579-SMR-Cloud-Default-Model-Fail-Closed/README.md` |
| TASK-580 | `TASK-580-Provider-Config-Hygiene/README.md` |
| TASK-581 | `TASK-581-Default-Embedding-Provider-Seed/README.md` |
