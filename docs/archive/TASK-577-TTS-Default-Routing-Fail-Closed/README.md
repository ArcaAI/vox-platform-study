# TASK-577 — TTS Default Routing: Seed SYSTEM `TenantTtsConfig` + Fail-Closed Router

- **Status**: Review
- **Type**: bugfix + infrastructure (seed)
- **Tier**: opus-4-8-high (cross-layer; changes a fail-mode on a serving path)
- **Program**: [Provider-Plane Day-1 Defaults](../SOTA-Track/2026-07-28-provider-plane-day1-defaults-followups.md) — finding **F1** (the one clear criterion-1 violation)
- **Owner gate**: **OD-2 CONFIRMED 2026-07-28** — built-in-first: `routingEn=["kokoro"]`, `routingMl=["indic_parler"]` (both local; confirm provider ids against `router.py`).

## Requirement Analysis

TTS is the only capability with a **hardcoded provider-selection default baked in code/env that applies to all tenants**. `apps/tts/src/tts/core/config.py:162-167` defaults the per-locale routing chains to `routing_en=["azure","kokoro"]` and `routing_ml=["azure","sarvam","indic_parler"]` — **Azure (a cloud vendor) first**. `routing/router.py:161-163` uses the gateway-injected per-tenant chain when present but **falls open to this code default** otherwise. Because **no SYSTEM `TenantTtsConfig` row is seeded**, `TenantTtsConfigService.getEffective` (`tenant-tts-config.service.ts:62`) returns empty routing for a tenant with no config, and the code default always wins on Day-1.

Goal: make the Day-1 TTS default **DB-sourced and built-in-first**, and make the router **fail-closed** rather than substituting a vendor. Unlike STT (`AsrPipeline`) and LLM (`AiTaskDefault`), TTS had no seeded SYSTEM default — this ticket adds it.

## Current State Evaluation (code-verified 2026-07-28)

- `getEffective` **already cascades SYSTEM → tenant** (`tenant-tts-config.service.ts:63-64`, reads `SYSTEM_TENANT_ID` row). The plumbing exists; only the **SYSTEM row is missing**.
- Gateway already injects the effective config: `tts-ws.gateway.ts:139-146` (`getEffective(tenantId)`) and `speech-proxy.controller.ts:70`. Both are **fail-open on lookup error** (leave config null → TTS uses its own settings).
- `TenantTtsConfig` schema (`tenant-tts-config.prisma:22-59`) already has `routingEn`/`routingMl`/`defaultVoiceEn`/`defaultVoiceMl`/`allowedProviders`. **No schema/migration change needed.**
- Seed `06-stt.ts` already seeds the local TTS `AiModel` rows (`kokoro`, `indic-parler-tts`) — so the built-in providers referenced by the new SYSTEM routing exist in the catalog.
- No seed file currently creates any `TenantTtsConfig` row (grep of `seed/` for `routingEn` → none).

## Implementation Plan (TDD — write the failing test first at each step)

### Phase A — Seed a SYSTEM `TenantTtsConfig` default (new file)

1. **RED** — add `packages/database/src/prisma/db_main/seed/__tests__/tenant-tts-config-seed.test.ts`: after `seedTenantTtsConfig(client)`, assert exactly one `TenantTtsConfig` row exists for `SYSTEM_TENANT_ID` with `routingEn = ['kokoro']`, `routingMl = ['indic_parler']` (per OD-2), non-empty `allowedProviders`, and that a second `seedTenantTtsConfig` call is idempotent (row count + version stable). Run → fails (no seeder).
2. **GREEN** — create `seed/19-tenant-tts-config.ts` exporting `seedTenantTtsConfig(client)`:
   - Upsert-by-`(tenantId, )` a single SYSTEM row (`tenantId = SYSTEM_TENANT_ID` from `00-constants.ts`), CREATE-ONLY (do not overwrite a global admin's edit on re-seed — mirror `seedPlatformStorageConfig`'s create-only posture, `index.ts:98-100`).
   - Values from OD-2 (built-in-first): `routingEn=['kokoro']`, `routingMl=['indic_parler']`, `allowedProviders=['kokoro','indic_parler','azure','sarvam']` (available set), `createdBy = SYSTEM user id`.
   - Provider names MUST match the router's provider ids (`router.py` — confirm `kokoro`/`indic_parler` spellings during discovery; the config default uses `indic_parler` with an underscore).
3. Wire into `seed/index.ts`: import + call `await seedTenantTtsConfig(client)` in Phase 2 **after** `seedStt` (needs the TTS `AiModel` catalog) and after `seedAiProviderConnection`, before Phase 3. Add the barrel/import line (§5 ownership: only this ticket edits `index.ts`).
4. **GREEN** — test passes. Assert `pnpm --filter @arcaai/database test` green.

### Phase B — Router fail-closed (remove the code-level vendor default)

5. **RED** — in `apps/tts/**/tests/` add a router test: `resolve_chain(locale='en', routing_en=None)` (no injected chain, simulating a caller that passed nothing) must **raise a typed "no routing configured" error** (fail-closed), NOT return `["azure", ...]`. A second test: an **injected** chain (`routing_en=['kokoro']`) resolves normally. Run → the first fails (currently returns the code default).
6. **GREEN** — change `routing/router.py:161-163` so the chain comes only from the injected argument; when it is empty/None, raise a `TtsRoutingUnconfiguredError` (503 at the API boundary) instead of `self._settings.routing_*`. Remove the `routing_en`/`routing_ml` fields from `core/config.py` (or reduce them to an empty default that the validator rejects at use) so env can no longer bake a vendor order.
7. Delete `TTS_ROUTING_EN`/`TTS_ROUTING_ML` handling if it no longer has a consumer; if kept for a documented local-dev override, its default must be empty and the "empty → fail-closed" test still holds.

### Phase C — Gateway resolution guarantee (make sure the SYSTEM default actually reaches TTS)

8. Because the router now fails closed, the gateway MUST always inject the resolved chain. Verify `getEffective` returns the SYSTEM routing for a tenant with no row (integration/unit test against the seeded DB). If the gateway's **fail-open-on-error** (`tts-ws.gateway.ts:147-153`) could leave routing empty on a transient DB error and thus 503 the synth, decide per OD/discovery whether to keep fail-open (accept a 503 when config truly can't resolve — consistent with fail-closed selection) — do **not** reintroduce a code vendor default. Document the choice in the Implementation Summary.

### Phase D — Verify + document

9. Reseed a throwaway test DB, `psql` SELECT proving the SYSTEM `TenantTtsConfig` row. Run TTS router tests + the shipped TTS BYOK suite (regression). Paste output. Capture a run/test proof that an unconfigured tenant synthesizes via **kokoro** (built-in), not azure.

## TDD Test List (must all be RED first)

- `tenant-tts-config-seed.test.ts`: SYSTEM row present with built-in-first routing; idempotent re-seed.
- `router` unit: empty/None injected chain → raises (fail-closed), does not return a vendor.
- `router` unit: injected built-in chain resolves + synthesizes.
- `getEffective` unit/integration: tenant-with-no-row returns the SYSTEM routing (not `[]`).
- Regression: existing TTS BYOK + routing suites stay green.

## Verification Criteria (Definition of Done)

- [ ] `pnpm --filter @arcaai/database test` green; SYSTEM `TenantTtsConfig` proven via `psql`.
- [ ] `pnpm py:tts:test|lint|typecheck` green; router fails closed with no vendor fallback.
- [ ] No `routing_en`/`routing_ml` vendor default remains selectable from env (grep clean).
- [ ] Shipped TTS BYOK suite green (no regression); new "built-in-first default wins" test green.
- [ ] Runtime proof: unconfigured tenant → built-in provider, captured.
- [ ] OD-2 confirmed and recorded here.

## Implementation Summary

**Status: Review — implemented via strict TDD (Red→Green per phase). Nothing committed (owner-gated); all work staged.**

### What changed

**Phase A — Seed SYSTEM `TenantTtsConfig` (built-in-first, OD-2)**
- `packages/database/src/prisma/db_main/seed/19-tenant-tts-config.ts` (NEW) — exports `seedTenantTtsConfig(client)` + the `SYSTEM_TENANT_TTS_CONFIG` row constant + `SYSTEM_TENANT_TTS_CONFIG_ID` (`00000000-0000-0000-0006-000000000001`) + `PLATFORM_TTS_PROVIDER_UNIVERSE`. CREATE-ONLY (mirrors `seedPlatformStorageConfig`): `routingEn=['kokoro']`, `routingMl=['indic_parler']`, `allowedProviders=['kokoro','indic_parler','azure','sarvam']`, `createdBy = SYSTEM user`.
- `packages/database/src/prisma/db_main/seed/index.ts` — import + `await seedTenantTtsConfig(client)` in Phase 2, after `seedAiRuntimeProfile`, before Phase 3.
- `packages/database/src/prisma/db_main/seed/__tests__/tenant-tts-config-seed.test.ts` (NEW, 7 tests) — static invariants over the exported row (built-in-first, no cloud vendor first, universe-bounded). *(This suite is static-only — `vitest run`, no DB, matching `config-plane-seed.test.ts`; the live row-existence + idempotency proof is the psql SELECT below.)*

**Phase B — Router fail-closed + remove the config vendor default (F1)**
- `apps/tts/src/tts/routing/router.py` — new `TtsRoutingUnconfiguredError(AllProvidersUnavailableError)`; `resolve_chain` now takes the chain ONLY from the injected `routing_en`/`routing_ml` and raises `TtsRoutingUnconfiguredError` on an empty/absent chain (removed both `self._settings.routing_*` fallbacks). Subclassing `AllProvidersUnavailableError` means the endpoints' existing 503 (HTTP `speech.py`) / `provider_unavailable` (WS `stream_ws.py`) handlers already surface it — no endpoint edits, no vendor substitution.
- `apps/tts/src/tts/core/config.py` — DELETED the `routing_en` / `routing_ml` fields (the Azure-first `["azure","kokoro"]` / `["azure","sarvam","indic_parler"]` code default) and dropped them from the CSV validator. Env (`TTS_ROUTING_EN/ML`) can no longer bake a provider order.
- Router/config test suites updated to inject the routing chain the gateway supplies in production (owned by this ticket, `apps/tts/**/tests/**`): `test_router.py` (+`TestFailClosedRouting`), `test_config.py`, `test_sarvam_provider.py`, `test_indic_f5_provider.py`, `test_voice_bindings_override.py`, `test_speech_endpoint.py`, `test_stream_ws.py`, `test_local_e2e.py`, `test_azure_provider.py`, `test_stream_adapter.py`.

**Phase C — Gateway resolution guarantee (decision recorded)**
- No gateway edit. `TenantTtsConfigService.getEffective` already cascades SYSTEM→tenant (`tenant-tts-config.service.ts:62`) and `resolveEffectiveTtsConfig` (`platform-limits.ts`) picks the SYSTEM row's non-empty `routingEn` (`['kokoro']`) for a tenant with no row of its own — so the gateway (`tts-ws.gateway.ts` / `speech-proxy.controller.ts`) always injects the built-in chain. The gateway's **fail-open-on-error** is kept as-is: a transient DB-lookup error leaves routing unset → the router now 503s (fail-closed) instead of substituting a vendor. That is CONSISTENT with fail-closed selection and reintroduces no code vendor default, so the fail-open-on-error tightening was deliberately NOT taken (§5 gateway files untouched).

### Evidence (actual output)

- `pnpm --filter @arcaai/database test` → **880 passed (27 files)** (7 new).
- tts pytest (`apps/tts/src/tts/tests/`) → **183 passed, 2 deselected** (shipped TTS BYOK/routing suite green + new fail-closed tests).
- `ruff check apps/tts/src/` → **All checks passed!**
- `mypy apps/tts/src/` → **17 errors in 7 files — pre-existing baseline, 0 new** (proven by stashing only the router/config edits: baseline also reports 17; all are `aclosing` type-var + missing third-party stubs on untouched code, none on TASK-577 lines).
- Grep-clean: no selectable `routing_en`/`routing_ml` vendor default remains — the only mention in `config.py` is the explanatory NOTE; `router.py` no longer reads `self._settings.routing`.
- **psql proof (test DB `hope_test` @ 5433, after reseed):**
  ```
  id=00000000-0000-0000-0006-000000000001 | tenantId=00000000-…-000000000000 |
  routingEn={kokoro} | routingMl={indic_parler} |
  allowedProviders={kokoro,indic_parler,azure,sarvam} | createdBy=60000000-…-000000000000 |
  resourceStatus=ENABLED | _version=1 | system_row_count=1
  ```
  Idempotency: second reseed → `SYSTEM TTS config already present … left untouched`; `system_rows=1, version=1` unchanged.
- Runtime proof (built-in, not azure): `test_local_e2e.py::test_english_voice_routes_to_kokoro` (routing `['kokoro']`) and `::test_malayalam_voice_routes_to_parler_with_resample` (routing `['indic_parler']`) synthesize via the local engines; `test_router.py::test_injected_builtin_chain_synthesizes_via_kokoro_not_azure` asserts kokoro serves and azure is never touched.

### Open / owner tails
- Nothing committed (owner-gated). Work is staged.
- No schema/migration (all `TenantTtsConfig` fields already existed).
- The `apps/tts` mypy/black baselines are pre-existing red on unrelated files (missing third-party stubs, `aclosing` type-var); this ticket adds no new violations to either.

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F1). Status Pending.
- 2026-07-28 — Implemented (TDD). Phase A: seeded SYSTEM `TenantTtsConfig` (built-in-first `kokoro`/`indic_parler`, CREATE-ONLY) + static seed test, wired into `seed/index.ts`. Phase B: router fails closed (`TtsRoutingUnconfiguredError`) and `core/config.py` no longer carries a `routing_en`/`routing_ml` vendor default; router/config test suites inject the gateway-supplied chain. Phase C: gateway left fail-open-on-error (decision recorded — a resolve failure 503s rather than substituting a vendor). Gates: database 880 pass, tts 183 pass, ruff clean, mypy 0 new (17 pre-existing), grep-clean, psql-proven SYSTEM row (idempotent). Status → Review. Not committed.
