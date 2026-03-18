# TASK-240: SMR Tenant Model Defaults

| Field       | Value                                      |
|-------------|--------------------------------------------|
| Ticket      | TASK-240                                   |
| Created     | 2026-03-08                                 |
| Updated     | 2026-03-08                                 |
| Status      | Completed                                  |
| Type        | Feature / Refactor                         |

## Requirement Analysis

### Description

Implement a static, seeded catalog of available text-generation providers and models (with size metadata) for the SMR v2 service. Tenant administrators select a default provider and model from this catalog. Provider naming must be consistent end-to-end (`ollama`, `lm-studio`, `azure-openai`) across the API gateway, SMR runtime, seed data, and admin UI.

### Business Context

Doctors and tenant admins need a reliable way to select which LLM provider and model their organisation uses for summarization. Currently, the default provider/model are free-text tenant settings with no validation against available options, leading to potential misconfiguration. A seeded catalog ensures only known-good combinations are selectable.

### Acceptance Criteria

1. A static JSON catalog of providers and their models (with `name` and `size`) is seeded per-tenant in GlobalSettings under the `ux-constants` namespace.
2. The `GET /text/providers` endpoint returns the full catalog with the tenant's selected default marked.
3. SMR v2 runtime registers providers using tenant-facing keys (`ollama`, `lm-studio`, `azure-openai`) instead of internal-only keys (`azure`, `openai_compat`).
4. Tenant config update validates that `default-smr-provider` and `default-smr-model` belong to the seeded catalog.
5. All changes are covered by TDD (red-green-refactor) unit tests.
6. Backward compatibility: existing tenants with `ollama` / `granite4:latest` defaults continue to work.

## Current State Evaluation

### Existing Code

- **Seed data** (`packages/database/src/prisma/db_main/seed/11-global-setting.ts`): Seeds `default-smr-provider` (string) and `default-smr-model` (string) per tenant. No provider/model catalog exists for SMR.
- **API gateway** (`apps/api/src/modules/streaming/smr-proxy.controller.ts`): `GET /text/providers` synthesizes a single-provider response from the two default settings. No catalog awareness.
- **SMR runtime** (`apps/smr/src/smr_v2/main.py`): Registers providers as `ollama`, `azure`, `bedrock`, `openai_compat`. Timeout/config maps use same internal keys.
- **SDK config** (`packages/agentic-sdk-v2/src/types/config.ts`): `TENANT_CONFIG_KEYS` references `default-smr-provider` and `default-smr-model`. `parseTenantConfig()` maps them to `defaultSmrProvider` / `defaultSmrModel`.

### Impact Areas

| Layer          | Package / App                     | Impact |
|----------------|-----------------------------------|--------|
| Database seed  | `packages/database`               | New catalog seed constants + IDs |
| API gateway    | `apps/api`                        | Refactored `/text/providers` endpoint |
| SMR runtime    | `apps/smr`                        | Provider key rename + alias support |
| Tenant service | `packages/applications`           | Validation on config update |
| SDK types      | `packages/agentic-sdk-v2`         | New catalog config key constant |

## Implementation Plan

### Phase 1: Seed Data (Database Layer)

1. Add SMR provider/model catalog constants to `seed/11-global-setting.ts`
2. Add new GlobalSetting IDs to `seed/00-constants.ts`
3. Seed `smr-provider-models` key (JSON, `ux-constants` namespace) per tenant

### Phase 2: API Gateway

4. Refactor `SmrProxyController.buildProvidersFromTenantSettings()` to parse catalog
5. Return full provider list with models, sizes, and default selection markers
6. Update `SmrProxyController` tests

### Phase 3: SMR Runtime

7. Rename provider registry keys: `azure` -> `azure-openai`, `openai_compat` -> `lm-studio`
8. Update timeout/config maps and provider_configs dict
9. Add backward-compatible alias support
10. Update SMR unit tests

### Phase 4: Tenant Config Validation

11. Add catalog-aware validation to tenant config update service
12. Reject invalid provider/model pairs
13. Update tenant service tests

### Testing Strategy

- Strict TDD: RED test first, verify failure, GREEN minimal code, verify pass
- Unit tests per layer (Vitest for TS, pytest for Python)
- Behavior-focused assertions (no mock-only verification)

## Implementation Summary

### What Was Built

A static, seeded catalog of SMR text-generation providers and models (with size metadata) that tenant administrators can use to select defaults. Provider naming is consistent end-to-end (`ollama`, `lm-studio`, `azure-openai`) across all layers.

### Files Changed

| File | Purpose |
|------|---------|
| `packages/database/src/prisma/db_main/seed/00-constants.ts` | Added 4 new seed IDs (`*_UX_SMR_PROVIDER_MODELS`) for the per-tenant catalog setting |
| `packages/database/src/prisma/db_main/seed/11-global-setting.ts` | Added `SMR_PROVIDER_MODELS` and `SMR_PROVIDER_NAMES` constants; added `smr-provider-models` (JSON, ux-constants namespace) to per-tenant seed |
| `packages/database/src/__tests__/seed-smr-provider-models.test.ts` | **New** — 18 tests for catalog shape, provider counts, model entries, and seed IDs |
| `packages/database/src/__tests__/seed-global-settings.test.ts` | Updated `CORE_SUFFIXES` to include `UX_SMR_PROVIDER_MODELS` |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | Refactored `buildProvidersFromTenantSettings()` to parse catalog JSON; added `parseProviderCatalog()` helper; returns full provider list with `is_default` marker |
| `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` | Added 3 catalog-based tests for `/text/providers` endpoint |
| `apps/smr/src/smr_v2/main.py` | Renamed provider registration keys (`azure` -> `azure-openai`, `openai_compat` -> `lm-studio`) with backward-compatible aliases; updated `provider_configs` dicts |
| `apps/smr/src/smr_v2/api/endpoints/generate.py` | Updated `_get_provider_timeout()` config map with tenant-facing keys + backward aliases |
| `apps/smr/src/smr_v2/tests/unit/test_provider_key_consistency.py` | **New** — 8 tests for registry acceptance, timeout resolution, and generate endpoint with tenant-facing keys |
| `packages/applications/src/services/tenant/tenant.service.ts` | Added `validateSmrConfigValue()`, `loadSmrCatalog()`, `getCurrentSmrProvider()` methods for catalog-aware validation on config update |
| `packages/applications/src/services/tenant/__tests__/tenant.service.test.ts` | Added 3 tests for SMR provider/model validation against catalog |

### Providers Catalog (Seeded)

| Provider | Models | Notes |
|----------|--------|-------|
| `ollama` | 11 models (granite4, gemma3, qwen3.5, medgemma, gpt-oss, translategemma) | Local inference |
| `lm-studio` | 13 models (qwen3.5, lfm2, glm, medgemma, gpt-oss, translategemma) | OpenAI-compatible local server |
| `azure-openai` | 1 model (gpt-4o-mini) | Cloud API |

### API Changes

- `GET /text/providers` now returns full catalog (all 3 providers with models + sizes) when `smr-provider-models` setting exists, with `is_default` boolean per provider
- Falls back to legacy single-provider response when catalog setting is absent

### Backward Compatibility

- SMR runtime registers both new keys (`azure-openai`, `lm-studio`) and legacy aliases (`azure`, `openai_compat`)
- Timeout and config maps include both key sets
- Gateway falls back to legacy behavior when no catalog setting exists
- Existing tenant defaults (`ollama` / `granite4:latest`) continue to work unchanged

### Test Evidence

- **TypeScript**: 158 tests pass across 4 test files (seed, gateway, tenant service)
- **Python**: 28 tests pass across 3 test files (registry, generate endpoint, key consistency)
- **Lint**: No new lint errors on any modified files

## Change History

| Date       | Description | Files Modified |
|------------|-------------|----------------|
| 2026-03-08 | Initial plan created and approved | README.md |
| 2026-03-08 | Full implementation: seeded catalog, gateway refactor, SMR runtime key rename, tenant validation | See Files Changed table above |
