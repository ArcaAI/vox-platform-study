# TASK-338: Admin-Configurable LLM Engines (Guardrail + Azure) via Console

- **Ticket Number**: TASK-338
- **Created Date**: 2026-06-07
- **Last Updated**: 2026-06-07
- **Status**: Completed (2026-06-07)
- **Classification**: feature
- **Depends on**: **TASK-337** (Python engine standardization — provides the `provider` switch + renamed env vars this ticket configures)
- **Related**: TASK-238 (SMR provider/model GlobalSetting pattern), TASK-302 (Vault secret encryption — gates admin-set API keys), TASK-330 (Harness)

---

## 1. Requirement Analysis

### Objective

Let administrators configure the **LLM engine, provider, and model** for the **Guardrail** service
(and the **Azure OpenAI deployment name** for SMR/Guardrail) through the **admin console
(`apps/ui-playground`)**, following the established **SMR provider/model GlobalSetting pattern** —
and make the Guardrail service **apply that configuration at runtime by reading tenant config
directly from the database** (decision Q3c).

### Resolved decisions (from TASK-337 approval round 2)

- **Admin console = `apps/ui-playground`** (`features/admin/configurations`, reuse `provider-model-select.tsx`).
- **Azure: deployment-name configurable via console; API key stays env/Vault** (raw key never in a non-secret GlobalSetting — blocked on TASK-302 Phase 4D).
- **Q3c — Guardrail reads tenant config from DB directly** (SQLAlchemy + asyncpg; precedent: STT-v2).

### Acceptance criteria

1. New GlobalSettings exist (seeded, per tenant): `default-guardrail-provider`, `default-guardrail-model`, a `guardrail-provider-models` catalog, and Azure deployment-name settings — validated and editable through the console.
2. The console (`ui-playground`) renders guardrail provider/model selectors + Azure deployment field and persists changes via the existing tenant-config API.
3. The Guardrail service resolves the admin-chosen provider/model **per tenant** at request time from the DB (with caching), falling back to env defaults when unset.
4. Azure API key is never stored in a plaintext GlobalSetting; only the deployment name is DB-driven.
5. Full test coverage (seed, applications validation, API, ui-playground, guardrail DB-config resolution).

---

## 2. Current State (from exploration)

- **SMR pattern (reuse as template):** `default-smr-provider`/`default-smr-model` seeded in `seed/11-global-setting.ts` (`namespace='smr'`, `locked`), catalog in `ux-constants/smr-provider-models`; validated in `tenant.service.ts` (`validateSmrConfigValue`, `loadSmrCatalog`, `getCurrentSmrProvider`); exposed via `GET /api/v1/text/providers` in `smr-proxy.controller.ts`; consumed in UI by `provider-model-select.tsx` + `useSmrProviders()`.
- **GlobalSetting model** already supports everything needed (namespace/key/value/defaultValue/dataType/locked, `encryptedValue`/`keyVersion` for future secrets). No new DB model required.
- **Secrets:** `SecretsService` (env|vault|aws|azure). Azure key is env/Vault-only today; `encryptedValue` Vault-Transit path (TASK-302 Phase 4) not fully wired (Phase 4D pending) → no admin-set raw keys yet.
- **Guardrail service:** env-only config (`GUARDRAIL_*`), no DB access. Called only by SMR's `ExternalGuardrailClient` → `POST /api/medical/validate` (not yet wired into SMR generate). **No tenant context is currently propagated to guardrail.**
- **Python DB precedent:** STT-v2 uses `sqlalchemy` + `asyncpg` (`create_async_engine`) against the core DB.

---

## 3. ✅ Resolved Open Questions

- **OQ1 — Tenant propagation:** caller passes **`X-Tenant-Id`** to `/api/medical/validate`; guardrail falls back to a system/default tenant when absent.
- **OQ2 — Caching:** **simple TTL cache (~60s)** for resolved per-tenant guardrail config.
- **OQ3 — Azure deployment:** **per-service** settings — `smr-azure-deployment` + `guardrail-azure-deployment`.
- **OQ4 — Catalog/defaults:** **`locked: true`** (SUPER_ADMIN-only), seeded server-side (mirrors SMR).
- **OQ5 — Wire `ExternalGuardrailClient` into SMR generate in this ticket** — guardrail becomes actually invoked per generate, and SMR forwards `X-Tenant-Id` for end-to-end testability.

---

## 4. Implementation Plan (high-level; refine after OQ answers)

### Phase 1 — DB seed + constants
- `seed/00-constants.ts`: add SEED IDs for guardrail settings + catalog (per tenant: GLOBAL/ARCAAI/FOURBITS/MUMBAI) + azure deployment settings.
- `seed/11-global-setting.ts`: add `namespace='guardrail'` rows (`default-guardrail-provider`=`lm-studio`, `default-guardrail-model`=`granite-guardian-4.1-8b`, `locked`), `ux-constants/guardrail-provider-models` catalog + exported `GUARDRAIL_PROVIDER_NAMES`/`GUARDRAIL_PROVIDER_MODELS`, and `*-azure-deployment` settings (non-secret). Ensure `provisionTenantConfigs()` clones them for new tenants.
- Tests: `seed.test.ts` / new `seed-guardrail-provider-models.test.ts`.

### Phase 2 — Applications validation
- Generalize `validateSmrConfigValue` → `validateProviderModel(prefix, catalogKey, providerKey, modelKey, ...)`; apply to both `smr` and `guardrail`.
- Add `getCurrentGuardrailProvider()`, `loadGuardrailCatalog()`.
- Tests: `tenant.service.test.ts` (valid/invalid guardrail provider+model, locked enforcement).

### Phase 3 — API gateway
- `smr-proxy.controller.ts` (or new `guardrail-config.controller.ts`): `GET /api/v1/text/guardrail-providers` mirroring `GET /text/providers`. Expose azure deployment via existing configs endpoints.
- Tests: controller unit tests.

### Phase 4 — Guardrail service reads DB (Q3c)
- Add `sqlalchemy[asyncpg]` to `apps/guardrail/pyproject.toml`; `GUARDRAIL_DATABASE_URL` config (+ a `db_config_enabled` flag so env-only deployments keep working).
- New `guardrail/core/tenant_config.py`: async repository reading `core.GlobalSetting` by `(tenantId, namespace, key)` for `default-guardrail-provider`/`model` + `guardrail-azure-deployment`; **TTL cache ~60s** (OQ2); resolves the **`X-Tenant-Id`** header, falling back to a **system/default tenant** then env defaults (OQ1).
- Resolve tenant + config in `api/endpoints/medical.py`/`guardrails.py`; select provider/model from resolved config.
- Tests: tenant-config resolver (cache hit/miss/expiry, header-present vs fallback), endpoint override behavior.

### Phase 4b — Wire `ExternalGuardrailClient` into SMR generate (OQ5)
- Wire `ExternalGuardrailClient` into `apps/smr/.../main.py` lifespan + `api/endpoints/generate.py` so guardrail is invoked per generate (currently defined but unconnected).
- SMR forwards the consultation **`X-Tenant-Id`** to guardrail's `/api/medical/validate`; honor `ExternalGuardrailConfig.fail_open`.
- Tests: SMR generate → guardrail call (mocked), tenant header propagation, fail-open/closed behavior.

### Phase 5 — `ui-playground` admin console
- `features/admin/configurations/`: add Guardrail provider/model section (reuse `provider-model-select.tsx` or generalize it) + Azure deployment-name field.
- API hooks: `useGuardrailProviders()` (calls `/text/guardrail-providers`); persist via existing tenant-config PATCH.
- Tests: `configurations.test.tsx` extensions; new component tests.

### Phase 6 — Secrets + docs
- Document Azure key remains env/Vault; only deployment name is DB-driven. Note TASK-302 Phase 4D as the unblock for admin-set keys.
- Update `apps/guardrail/README.md`, `GUARDIAN_INTEGRATION.md`, `knowledge/02_TECHNICAL_ARCHITECTURE.md`.

### Verification order
`seed → applications → api → guardrail-service → ui-playground → docs`, with layer gates (TS unit tests, pytest under conda `arcaenv`, ReadLints) per the workflow.

---

## 5. Implementation Summary

Implemented 2026-06-07 via two parallel workers split by language/ownership, coding against a fixed GlobalSetting contract.

### Cross-worker contract (verified consistent on both sides)
| namespace | key | default | dataType | locked |
| --- | --- | --- | --- | --- |
| `guardrail` | `default-guardrail-provider` | `lm-studio` | String | ✅ |
| `guardrail` | `default-guardrail-model` | `granite-guardian-4.1-8b` | String | ✅ |
| `guardrail` | `guardrail-azure-deployment` | `""` | String | ✗ (non-secret) |
| `smr` | `smr-azure-deployment` | `""` | String | ✗ (non-secret) |
| `ux-constants` | `guardrail-provider-models` | catalog; order `['lm-studio','ollama','azure-openai']`, lm-studio includes `granite-guardian-4.1-8b` | JSON | ✅ |

Table read by Python = `core."GlobalSetting"` (cols `id, tenantId, name, key, namespace, value, defaultValue, dataType, resourceStatus`), filtered `resourceStatus = 'ENABLED'`. No column mismatches.

### Workstream A — TypeScript stack (seed → applications → api → ui → docs)
- **Seed** (`packages/database`): `00-constants.ts` gained 5 SEED IDs ×4 tenants (smr-azure-deployment, guardrail provider/model/azure-deployment, ux guardrail catalog); `11-global-setting.ts` added `GUARDRAIL_PROVIDER_NAMES`/`GUARDRAIL_PROVIDER_MODELS` + 5 rows/tenant (header counts 19→24). `provisionTenantConfigs()` needed no change (clones `__GLOBAL__` rows dynamically → new tenants inherit automatically).
- **Applications** (`packages/applications`): generalized `validateSmrConfigValue` → `validateProviderModel`; added `loadGuardrailCatalog`/`getCurrentGuardrailProvider` (+ generic `loadCatalog`/`getCurrentProvider`). SMR error messages preserved verbatim.
- **API** (`apps/api`): `GET /api/v1/text/guardrail-providers` (mirrors `/text/providers`; `?tenantKey=__GLOBAL__` for SUPER_ADMIN; no upstream fallback since catalog is always seeded). Azure deployment names flow through existing tenant-config GET/PATCH.
- **ui-playground** (`apps/ui-playground`): new **Guardrail Engine** card (provider/model selects + Azure deployment field, OCC per-row PATCH via `If-Match`), `useGuardrailProviders()` hook. Built a dedicated `GuardrailConfigSection` rather than coupling to the summarization-feature `provider-model-select.tsx`.
- **Docs**: `knowledge/02_TECHNICAL_ARCHITECTURE.md` admin-configurable settings subsection; Azure API key stays env/Vault (TASK-302 Phase 4D = unblock).
- **Tests**: database 801; applications 4826 pass/4 skip (tenant.service 90); api streaming 141 (smr-proxy 62); ui-playground configurations 65. ESLint clean on touched files.

### Workstream B — Python services (guardrail DB resolution + SMR wiring)
- **Guardrail DB config** (`apps/guardrail`): added `sqlalchemy[asyncpg]`; new `DatabaseConfig` (`GUARDRAIL_DB_CONFIG_ENABLED` default **false**, `GUARDRAIL_DATABASE_URL`, `GUARDRAIL_DEFAULT_TENANT_ID`, `GUARDRAIL_CONFIG_CACHE_TTL_S`) with `postgres://`→asyncpg normalization. New `core/tenant_config.py` (`TenantConfigResolver`, per-tenant TTL cache ~60s, `resolve_guardian_engine`/`build_guardian_provider`). `/medical/validate(/batch)` resolve provider per request; lifespan creates/disposes the async engine only when enabled.
- **Tenant resolution** (OQ1/OQ2): `X-Tenant-Id` header → `default_tenant_id` (seeded GLOBAL `50000000-…-0000`, configurable) → env defaults. DB errors fail-safe to env and are not cached. Fallback is tenant-level (a tenant with no rows defers entirely to default, so a default-tenant Azure deployment can't bleed into a different-provider tenant). Resolved config overrides only the model; `base_url`/`api_key` stay env-sourced.
- **SMR wiring** (Phase 4b, `apps/smr`): `ExternalGuardrailClient` wired into `main.py` lifespan + `/generate`; forwards consultation `X-Tenant-Id` to `/api/medical/validate`; disallowed → HTTP 422; `fail_open=true` proceeds on guardrail failure, `false` rejects.
- **Docs**: guardrail `README.md`, `GUARDIAN_INTEGRATION.md`, `.env.example`.
- **Tests** (under `arcaenv`): guardrail 42; SMR full unit 726 (27 new); ruff clean. One pre-existing test fix (`test_code_quality` type-hints → runtime import of `ExternalGuardrailClient` in `generate.py`).

## 6. Change History

- **2026-06-07** — Initial implementation via two parallel workers (TS full-stack + Python services); contract verified consistent across both. Status → Completed.

## 7. Follow-ups / Operational notes

- **Enable DB config in k3s (opt-in)**: `GUARDRAIL_DB_CONFIG_ENABLED` defaults to **false**, so `deployment/k3s/base/configmap.yaml` was intentionally **not** changed (env-only deployments unaffected). To activate admin-configurability in-cluster, set `GUARDRAIL_DB_CONFIG_ENABLED: "true"` and provide `GUARDRAIL_DATABASE_URL` — the latter carries DB credentials, so it should reference a **Secret**, not the plain ConfigMap. Decide the secret wiring before flipping this on.
- **Integration check**: confirm the seeded guardrail rows persist with `resourceStatus = 'ENABLED'` (Python resolver filters on it) once the seed runs against a real DB.
- **Azure API key** remains env/Vault-only; only the deployment name is DB-driven. Admin-set raw keys stay blocked on **TASK-302 Phase 4D**.
- **`provider-model-select.tsx` generalization** was deferred — guardrail uses its own `GuardrailConfigSection`. A future refactor could unify the two if a third consumer appears.
