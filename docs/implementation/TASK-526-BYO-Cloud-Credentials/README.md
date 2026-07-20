# TASK-526 — BYO Cloud Provider Credentials + Tenant AI Configuration Screen

- **Status**: Review
- **Type**: feature
- **Program**: Agentic Platform Program Phase 1 — [program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §4 Phase 1 · [findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) (E5-cloud, GAP-C1 tenant lane, M-05, M-11, E3-D1/D-16/D-18 residue)
- **Ticket number**: TASK-526 is the program plan's suggested number (plan §Numbering: confirm at open time per the CLAUDE.md ticket workflow — highest allocated in `docs/` + git history was TASK-522; 523–534 are program-reserved).
- **Size**: M · **Lanes**: B (applications/api) + C (admin-console)
- **Dependencies**: **TASK-524** (Config-Plane Core) MUST have landed — this ticket extends the `AiProviderConnection` table/service/controller that 524 creates. The AD-2 contract (plan §3) is FROZEN; this README builds against it, and the child re-verifies 524's actual file/route names at implementation start (the folder `docs/implementation/TASK-524-Config-Plane-Core/` exists but is being authored in parallel).
- **Preconditions** (rule 12 design gate): the tenant "AI Configuration" screen needs an **approved Figma frame OR a recorded owner waiver** (frame inventory or waiver text + date recorded in this README) before any screen code is written. The TASK-512 wave precedent was an explicit waiver (plan §2.3).

### Design-gate waiver (recorded 2026-07-20, BEFORE screen code)

> **Owner waiver, 2026-07-20** — the rule 12 design gate for the TASK-526 tenant "AI Configuration" screen is **explicitly waived** in lieu of a Figma frame, following the TASK-512 wave precedent. The screen is to be built by composing already-approved, already-shipped patterns: `ScreenTemplate` (frame 09 contract), `WorkingTenantGate` + `TenantScopeBanner`, the `CredentialCard` interaction from `features/tenant-tts-config/components/tts-credentials-tab.tsx`, and the `EffectiveLine` treatment from `features/ai-task-defaults/components/task-default-card.tsx`. No new visual pattern is introduced. All other gates (rule 10 skeletons, rule 11 a11y with axe 0 violations, both themes) remain in force.

Recorded verbatim per the rule 12 gate; screen implementation (Phase C) started only after this entry existed.

---

## 1. Requirement Analysis

Owner expectation **E5-cloud** (findings §3-E5): *"azure/cloud → global AND tenant admins configure endpoint + key; hyperparameters global-admin-only."* The dual-admin split: TASK-524 delivers the SYSTEM (global-admin) lane of `AiProviderConnection`; **this ticket delivers the tenant lane** — a tenant admin brings their own Azure OpenAI / Bedrock endpoint + API key, Vault-encrypted at rest, injected at request time into SMR calls, never revealed by any read. Hyperparameters stay out of the tenant lane entirely (`AiRuntimeProfile` is SYSTEM-only per AD-2).

Owner expectation **E2** (tenant visibility) without violating **E3** (guardrail/nlp global-admin-only): the tenant tier currently has **zero** models/providers visibility (findings M-11) and the one screen that existed is a dead-end EmptyState (M-05). The fix is a **read-only** effective task-model table (which model actually serves each of the 9 task keys, and which cascade tier won) — visibility, not control, so E3's write-lock is untouched.

Closes / advances:

| ID | What | How |
|---|---|---|
| GAP-C1 (tenant lane) | No admin surface for LLM provider connections | Tenant BYO endpoints on the 524 controller + gateway injection |
| M-05 | `/ai-model-defaults` is a 100 % static EmptyState dead-end | Rebuilt as the tenant "AI Configuration" screen |
| M-11 | Tenant tier lacks AI config visibility; `/tts-config` is the only BYO surface | Effective view + BYO LLM credential cards |
| M-04 (part) | `/ai-models` vs `/ai-task-defaults` vs `/ai-model-defaults` naming cluster | Tenant route renamed `/ai-configuration` (+ redirect); the rest of M-04 stays with TASK-532 |
| E5-cloud (part) | "no admin of any tier, via any route, can set endpoint or key" for SMR providers (findings §3-E5) | Tenant lane here; SYSTEM lane is 524 |

Requirement restated as verifiable outcomes:

1. A tenant admin (or an elevated admin with a working tenant) can set, rotate, disable, and remove an Azure OpenAI or Bedrock credential (endpoint/region + API key) for their tenant — key encrypted via Vault Transit, never returned by any read, no reveal flow.
2. SMR generation requests whose resolved provider is `azure` or `bedrock` carry the caller tenant's enabled credential as a request-time override; broken/disabled credentials degrade to the platform (SYSTEM/env) credentials without failing the request.
3. The tenant tier gets a truthful AI-configuration surface: which model actually serves each of the 9 task keys and which cascade tier decided it — read-only, so the E3 global-admin-only write posture is untouched.
4. The dead-end route is renamed to match its new scope, with deep-link continuity.

## 2. Current State Evaluation (code-verified 2026-07-20, working tree on `fix/2605-review`)

### 2.1 The dead-end tenant screen (M-05)

- `apps/admin-console/src/features/ai-task-defaults/components/ai-model-defaults-tenant-screen.tsx:18-53` — the whole screen is `WorkingTenantGate` → `ScreenTemplate` → a static `EmptyState` ("Platform-managed AI models…"). No data fetch, no table, nothing actionable. The header comment (`:10-17`) documents the removal of the tenant NLP pickers.
- `apps/admin-console/src/app/(console)/(tenant)/ai-model-defaults/page.tsx:6` — stale comment "tenant NLP model defaults (tier 30-49…)".
- `apps/admin-console/src/shared/navigation/nav-config.ts:311` — stale comment "TASK-506 — tenant overrides for the NLP task defaults" above the `/ai-model-defaults` entry (`:312-322`, label "AI model defaults", tier 30-49, required `read|manage AiTaskDefault`, `implemented: true`). This is D-18's nav-comment leg — owned by TASK-523 §0.9; **if 523 has not landed when this ticket starts, this ticket fixes it** (same file is in our manifest anyway).
- `apps/admin-console/src/features/ai-task-defaults/api/types.ts:8` — the console's `AI_TASK_KEYS` mirror is stale at **3 keys** (`guardrail.validate`, `nlp.ner`, `nlp.classification`) vs the backend's **9** (`packages/applications/src/services/ai-task-default/constants.ts:18-…`, incl. `smr.live/finalize`, `harness.judge`, `nlp.diagnosis`, `guardrail.safety/groundedness`). `types.ts:16` still exports the dead `NLP_TASK_KEYS` (D-18, referenced only by its own test `__tests__/ai-task-defaults-api.test.ts`).
- The read path the table needs already exists and is tenant-accessible: `GET admin/ai-task-defaults` returns effective defaults for ALL keys in one round-trip (`apps/admin-console/src/features/ai-task-defaults/api/client.ts:23-25`; controller read routes at `apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts:53,75,99` — only the `@Put('row')` at `:116` is service-enforced 403 for the global-only prefixes, `:37`).

### 2.2 The exemplar: TTS BYO credentials (TASK-496/504/506 — the E5-cloud seed pattern)

Backend (`packages/applications/src/services/tenant-tts-config/tenant-tts-config.service.ts`):
- Write: `setCredential` (`:344-385`) — provider allow-list check (`:348-350`), **Vault-gate: no SecretsService → reject, no plaintext-at-rest fallback** (`:351-353`), `encryptSecretField` (`:355`), factory-create or change-tracked update, sys-event per mutation.
- Read: `maskCredential` (`:430-439`) — `hasKey` boolean + `keyVersion`, **never the key**.
- Injection: `resolveProviderOverrides` (`:405-428`) — decrypts only `enabled` rows; **fails OPEN per credential**: the per-row `catch { continue; }` (`:423`) skips a credential whose decrypt fails so tts-v2 falls back to platform creds. NOTE: that catch is **silent** — no log. The controller-level wrapper `applyTenantConfig` (`apps/api/src/modules/speech/speech-proxy.controller.ts:64-91`) fails open on the whole lookup with a `logger.warn` (`:84-90`, message only, no secret) and folds `provider_overrides` into the forwarded body (`:79`). WS twin: `apps/api/src/modules/speech/tts-ws.gateway.ts:130-135,256-257`.
- Controller routes (`apps/api/src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts:37,115-143`): `GET admin/tts-config/credentials` (masked list), `PUT credentials/:provider`, `DELETE credentials/:provider`. The credentials PUT is **not** OCC-versioned (client comment `apps/admin-console/src/features/tenant-tts-config/api/client.ts:3-4` "non-versioned BYO CREDENTIALS") — this ticket deliberately diverges (see §3.5).

Console (`apps/admin-console/src/features/tenant-tts-config/components/`):
- `tts-credentials-tab.tsx:29-141` — the `CredentialCard` interaction exemplar: configured/not-configured + enabled badges, write-only password input ("•••••••• (write-only — never shown)"), endpoint field, enabled switch, rotate/remove with inline confirm, toasts, `Spinner` in buttons, `CredentialsSkeleton` (`:143-150`).
- `tenant-tts-config-screen.tsx` — `WorkingTenantGate` + `ScreenTemplate` + nuqs-backed `Tabs` (`config` | `credentials`) — the screen-frame exemplar.

### 2.3 SMR call path (the injection target)

- `apps/api/src/modules/streaming/smr-proxy.controller.ts` (1011 lines, `@Controller('text')`): `applySmrModelSelection` (`:170-179`) resolves `{provider, model}` when the caller omits them — **FAIL CLOSED** by design (comment `:164-168`). Forward sites of the generate payload: `generate()` `:387-401` (call `:393`) and the assembled-generate path `:568-595` (call `:582`), both POSTing to `${SMR_URL}/api/v1/generate` with `getForwardHeaders()` (`:191-203`, `X-Service-Token` only — no credential material today).
- **Negative evidence** (findings §3-E5, re-confirmed): `encryptSecretField` has exactly one production consumer (TTS); grep for `resolveProviderOverrides` outside speech/tts returns nothing; no `TenantLlmProviderConfig`-class model exists. For SMR Azure/Bedrock, endpoint+key are 100 % env (`SMR_V2_AZURE_*`, `SMR_V2_BEDROCK_*` in `apps/smr/src/smr_v2/core/config.py`).

### 2.4 Absence of any LLM BYO surface (the findings' negative-search evidence, re-run this pass)

- `resolveProviderOverrides` call sites: exactly two, both TTS (`apps/api/src/modules/speech/speech-proxy.controller.ts:70`, `apps/api/src/modules/speech/tts-ws.gateway.ts:135`) — grep over `apps/api` + `packages/applications`, test files excluded.
- `provider_overrides` on the wire: only the TTS request interfaces (`speech-proxy.controller.ts:23`, `tts-ws.gateway.ts:256-257`). The SMR forwarded interface has no such field.
- `encryptSecretField` consumers: `tenant-tts-config.service.ts:355` is the sole production caller (its own header `secret-field.util.ts:5-8` says as much: "TenantTtsProviderCredential today, future SSO/SMTP/webhook secrets").
- Findings §3-E5 (verbatim, independently re-confirmed): "For SMR/guardrail LLM providers (Azure OpenAI, Bedrock): no admin of any tier, via any route, can set endpoint or key — env/deploy-only; … no `TenantLlmProviderConfig`-class model exists (exhaustive negative search)."

### 2.5 Console plumbing (verified)

- BFF proxy `apps/admin-console/src/server/hope-proxy.ts`: header allowlist `:11` forwards `if-match`; ETag surfaces back (`:16`); elevated users get `x-tenant-id` from the working tenant (`:34-36`). Nothing new needed for this ticket's calls.
- Tier guard `apps/admin-console/src/app/(console)/(tenant)/layout.tsx:13-18`: non-elevated non-TENANT_ADMIN → `notFound()` (404-over-403). Per-screen `WorkingTenantGate` (`src/shared/tenant-scope/working-tenant-gate.tsx`) + "Acting on «Tenant»" banner (`tenant-scope-banner.tsx:24`) for elevated users on mutating surfaces.
- `EffectiveLine` pattern to reuse: `apps/admin-console/src/features/ai-task-defaults/components/task-default-card.tsx:30-51` (model name + slug + provider badge + cascade-source badge from `SOURCE_BADGES` `:19-23`), with its layout-matched `CardSkeleton` `:53-64`.
- Nav tests exist and assert entries: `apps/admin-console/src/shared/navigation/__tests__/nav-config.test.ts`.

## 3. Architecture, Patterns & Best Practices

### 3.1 The generalized BYO pattern (frozen by plan AD-2)

`AiProviderConnection` (created by TASK-524): SYSTEM row = platform default, tenant row = BYO; `@@unique([tenantId, provider])`; `encryptedApiKey Bytes?` via `encryptSecretField`/`decryptSecretField` (`packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts:51-74` — the single audited crypto path; its header `:1-8` names "future consumers", updated by 524). Resolution order (AD-2, frozen): **tenant row (enabled) → SYSTEM row → service env fallback**. Tenant rows are allowed **only** for cloud API providers — this ticket's set: `azure`, `bedrock` (`sarvam`-class later). Self-host providers (`ollama`, `lm-studio`, `vllm`, `llama-cpp`, `built-in`) reject tenant writes with a service-layer `ForbiddenException` (403) — mirroring the `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` enforcement style (`ai-task-default` service). 403 not 404: the route is the caller's own tenant surface (no existence to hide); 403 not 400: it is a policy boundary, not malformed input — same reasoning as the task-default write lock (findings E3, "deliberate 403" comment at `ai-task-default-admin.controller.ts:37`).

### 3.2 Fail-open per credential ON DECRYPT ERROR ONLY — vs fail-closed selection

Two different failure classes, two different postures, both copied from verified code:
- **Model/provider selection stays FAIL CLOSED** (`applySmrModelSelection`, smr-proxy `:167-168`): an unresolved selection rethrows. Rationale: silently generating with the wrong model is a clinical-quality failure.
- **Credential override injection FAILS OPEN per credential** (TTS `resolveProviderOverrides:411-426`): a decrypt error (Vault down, key rotated badly, corrupt ciphertext) skips that one credential so the request proceeds on SYSTEM/env platform credentials. Rationale: a tenant's broken BYO key must degrade to the platform default, not take down generation. **One deliberate improvement over the exemplar**: TTS's per-credential `catch { continue; }` (`:423`) is silent — our resolver logs a `warn` with `{tenantId, provider, keyVersion}` (never ciphertext/plaintext/key material) so decrypt failures are observable (feeds the §7 observability risk). The TTS service itself is NOT changed (out of scope).

### 3.3 Injection point decision: applications-layer resolver + thin controller fold-in

**Decision**: mirror the TTS split exactly —
1. `AiProviderConnectionService.resolveTenantCloudOverrides(tenantId): Promise<LlmProviderOverrides>` lives in `packages/applications` (next to the repository and the Vault decrypt path). Controllers hold no business logic and no Prisma (rule 05); decrypt belongs where `SecretsService` and the repo are injected — precedent `tenant-tts-config.service.ts:405-428`.
2. `SmrProxyController` gains a private `applyTenantProviderOverrides(body)` (mirror of `speech-proxy.controller.ts:64-91`): resolves the CLS tenant, calls the service, and folds `provider_overrides` into the forwarded body **only when the resolved `body.provider` is `azure` or `bedrock` and an enabled tenant credential exists** — called immediately after `applySmrModelSelection` at both forward sites (`:393`, `:582`; the ticket audits the controller for any other `/api/v1/generate` forward path before closing). Rejected alternative — resolving inside the controller request build: duplicates Vault/decrypt handling into a controller, untestable without HTTP scaffolding, and diverges from the proven TTS layering.

**Cross-ticket contract (frozen here)**: the SMR request body gains an optional `provider_overrides: { [provider]: { api_key: string; base_url?: string; region?: string; api_version?: string; deployment_name?: string } }` (snake_case, matching the TTS wire shape `speech-proxy.controller.ts:23`). The gateway injects it in this ticket; **the SMR Python side consumes it in TASK-525** (lane E, service pull-paths). Until 525's consumption lands, the injected field is inert on the Python side (pydantic extra-ignore) — injection and consumption are independently shippable, which is exactly how TASK-496 phased TTS. Coordinate the field name in both tickets' manifests; neither edits the other's files.

### 3.4 Screen IA + naming decision

**Naming (M-04 tenant leg) — decision: rename `/ai-model-defaults` → `/ai-configuration`, label "AI Configuration".** Justification: the screen no longer edits "model defaults" (that died with the E3 lock — the current name advertises a capability that doesn't exist, findings M-05); the rebuilt scope is visibility (effective models) + credentials, i.e. the tenant's AI *configuration*; and it kills one corner of the `/ai-models` / `/ai-task-defaults` / `/ai-model-defaults` near-synonym cluster (M-04). Deep links survive via a redirect page at the old route for one release (plan §7 risk row). The remaining M-04 legs (platform screen file names, `/ai-models` unhide) stay with TASK-532/528.

**Screen** (`WorkingTenantGate` → `ScreenTemplate`, nuqs-tabbed like `tenant-tts-config-screen.tsx`):
- Tab 1 "Effective models" (default): read-only table/card list of **all 9 task keys** — per key the `EffectiveLine` treatment (model name, slug, provider badge, cascade-source badge tenant/system/service-default) fed by ONE `GET admin/ai-task-defaults` round-trip (`client.ts:23-25`). No pickers, no writes — an explicit copy line states models are platform-managed (truthful successor to today's EmptyState copy).
- Tab 2 "Cloud credentials": two `CredentialCard`-pattern cards (Azure OpenAI, Bedrock) — Configured/None + enabled badges, write-only key input, endpoint/region fields (azure: `baseUrl` + `apiVersion` + `deploymentName`; bedrock: `region`), enabled switch, set/rotate/remove with confirm, toasts. `TenantScopeBanner` ("Acting on «Tenant»") in the `statusBanner` slot for elevated users, since this tab mutates (rule 13).
- Feature placement: the screen stays in `src/features/ai-task-defaults/` (same domain family; features never import each other — rule 13 — so moving it out would force duplicating the task-defaults client). The tenant screen file is renamed `tenant-ai-configuration-screen.tsx`; the BYO lane gets its own `api/providers-client.ts|providers-hooks.ts|providers-types.ts` inside the feature. Folder-level renames stay with TASK-532.

### 3.5 Secrets posture + OCC

- **No reveal endpoint, ever, for provider keys** — responses carry Configured/None (`hasKey`) + `keyVersion` only, per the plan's risk row ("no new reveal for provider keys"). The deliberate contrast: `GlobalSetting` reveal exists but demands global-admin + **step-up re-auth** (current password verified server-side) + per-call audit, single-`:id`-only (`apps/api/src/modules/global-setting/global-setting.controller.ts:175-199`). A tenant-lane secret gets no such flow — the key is write-only, period.
- **OCC on the tenant PUT** (house constraint; deliberate divergence from the non-versioned TTS credentials PUT): `AiProviderConnection` carries the house `_version`, so `PUT admin/ai-providers/tenant/:provider` is `@RequiresIfMatch()` + `@ExpectedVersion()` — missing header 428, drift 412 — with the `If-Match: "0"` create convention proven by `admin/ai-task-defaults/row` (`client.ts:15-20`) and `admin/tts-config/row`. The GET returns the masked row **or a `version: 0` placeholder** (ETag `"0"`) so the card always has a precondition to send. DELETE (soft delete) needs no If-Match, mirroring TTS.

### 3.6 Endpoint contract (this ticket's additions to the 524 controller)

| Route | Auth | Behavior |
|---|---|---|
| `GET admin/ai-providers/tenant` | `read` on the 524-chosen resource | Masked list of the caller tenant's BYO rows (never the key) |
| `GET admin/ai-providers/tenant/:provider` | read | Masked row or `version: 0` placeholder + ETag |
| `PUT admin/ai-providers/tenant/:provider` | manage + `@RequiresIfMatch` | Cloud providers only (`azure`,`bedrock`; else 403); Vault-gate (no Transit → reject, no plaintext fallback, TTS `:351-353` precedent); `encryptSecretField`; sys-event; masked response |
| `DELETE admin/ai-providers/tenant/:provider` | manage | Soft delete + sys-event; 404 when absent |

Tenant scoping rides the CLS tenant (tenant-scope `$extends` injects `tenantId`) — a tenant admin structurally cannot address another tenant's row; elevated callers scope via `X-Tenant-Id` (hope-proxy `:34-36`). Cross-tenant probes surface as 404 (house posture).

DTO shapes (class-validator + `@ApiProperty` on every field — the global pipe is `whitelist + forbidNonWhitelisted`):

```ts
// PUT body — set-tenant-provider-credential.request.ts
{ apiKey: string;            // write-only; never echoed
  baseUrl?: string;          // azure endpoint (https://<res>.openai.azure.com)
  region?: string;           // bedrock
  apiVersion?: string;       // azure
  deploymentName?: string;   // azure
  enabled?: boolean;         // default true
  expectedVersion: number }  // OCC token, 0 = create (If-Match header overrides)

// Read shape — tenant-provider-credential.response.ts (masked; NO key fields)
{ provider: 'azure' | 'bedrock';
  baseUrl: string | null; region: string | null;
  apiVersion: string | null; deploymentName: string | null;
  enabled: boolean;
  hasKey: boolean;           // the "Configured/None" signal (TTS maskCredential parity)
  keyVersion: number | null; version: number; updatedAt?: string }
```

Injected wire shape (frozen contract with TASK-525, snake_case per the TTS precedent):

```jsonc
// folded into the SMR /api/v1/generate body when body.provider ∈ {azure, bedrock}
"provider_overrides": {
  "azure":   { "api_key": "…", "base_url": "…", "api_version": "…", "deployment_name": "…" },
  "bedrock": { "api_key": "…", "region": "…" }
}
```

## 4. Implementation Plan (ordered; layer chain applications → api → console)

Execution order with per-step verification (rule 01 layer gates — complete each before the next):

| Phase | Steps (from the manifest below) | Verify |
|---|---|---|
| A. Applications | 1–3 (tenant-lane service methods + resolver, DTOs, RED→GREEN unit tests) | `pnpm --filter @arcaai/applications build test` |
| B. API | 4–6 (controller tenant routes, smr-proxy fold-in, controller/proxy tests) | `pnpm build:api && pnpm test:unit` |
| C. Console | 7–14 (types 3→9, providers client/hooks, screen rebuild, route rename + redirect, nav, tests) | `pnpm --filter @arcaai/admin-console build lint test` + runtime pass (`next-dev-loop` skill) |
| D. Evidence | 15–16 (e2e spec authored for P7, README closure) | spec compiles; §5 gate outputs pasted |

Exclusive file-ownership manifest — no file below is owned by another in-flight P1 ticket (524 hands over `ai-provider-connection` service/controller files when it lands; re-verify exact names then; paths marked ⚠ are 524-created and UPDATE-only here):

| # | Action | File |
|---|---|---|
| 1 | UPDATE ⚠ | `packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts` — tenant-lane methods (`getTenantCredentials`, `getTenantCredential`, `setTenantCredential`, `removeTenantCredential` — masked DTOs, cloud-only 403, Vault-gate, OCC via `updateWithVersion`) + `resolveTenantCloudOverrides` (fail-open per credential, non-secret warn log) |
| 2 | UPDATE ⚠ | same folder: `ITenantAiProviderConnectionService` additions, DTOs (`set-provider-credential.request.ts` with `expectedVersion`, masked `provider-credential.response.ts`), dto.mapper, barrel `index.ts` (append-only, plan §7) |
| 3 | NEW | `packages/applications/src/services/ai-provider-connection/__tests__/ai-provider-connection.tenant-lane.test.ts` (RED first — §5) |
| 4 | UPDATE ⚠ | `apps/api/src/modules/ai-provider/ai-provider-admin.controller.ts` (524's controller; folder name per 524) — the four tenant routes of §3.6 |
| 5 | UPDATE | `apps/api/src/modules/streaming/smr-proxy.controller.ts` — `applyTenantProviderOverrides` + calls after `:393`/`:582` selection; `provider_overrides` on the forwarded interface |
| 6 | NEW/UPDATE | controller unit tests: `apps/api/src/modules/ai-provider/__tests__/ai-provider-admin.controller.tenant.test.ts`; UPDATE the existing smr-proxy controller test file (path re-verified in-ticket — unverified) |
| 7 | UPDATE | `apps/admin-console/src/features/ai-task-defaults/api/types.ts` — `AI_TASK_KEYS` 3→9 keys (mirror `constants.ts`); delete dead `NLP_TASK_KEYS` + its test refs if TASK-523 §0.9 hasn't already (coordination check at start) |
| 8 | NEW | `…/ai-task-defaults/api/providers-client.ts`, `providers-hooks.ts`, `providers-types.ts`, `providers-keys.ts` — the §3.6 routes via the BFF |
| 9 | NEW | `…/ai-task-defaults/components/tenant-ai-configuration-screen.tsx` (replaces the EmptyState screen — old file deleted), `effective-models-table.tsx` (EffectiveLine reuse), `byo-credential-card.tsx` (CredentialCard pattern + OCC via `OccConflictAlert`) |
| 10 | NEW | `apps/admin-console/src/app/(console)/(tenant)/ai-configuration/page.tsx` + `loading.tsx` (Skeleton matching the table+cards layout, rule 10) |
| 11 | UPDATE | `apps/admin-console/src/app/(console)/(tenant)/ai-model-defaults/page.tsx` → `redirect('/ai-configuration')` (keep one release; `loading.tsx` removed); fix its stale `:6` comment in passing |
| 12 | UPDATE | `apps/admin-console/src/shared/navigation/nav-config.ts:311-322` — route `/ai-configuration`, label "AI Configuration", stale comment corrected (D-18 nav leg, if 523 hasn't landed it) |
| 13 | UPDATE | `apps/admin-console/src/shared/navigation/__tests__/nav-config.test.ts` + `…/components/__tests__/ai-task-defaults-screens.test.tsx` (screen renamed) |
| 14 | NEW | screen tests: `…/components/__tests__/tenant-ai-configuration-screen.test.tsx` (§5) |
| 15 | NEW (authored, executed in P7) | `apps/api/tests/e2e/task-526-ai-provider-byo-cross-tenant.spec.ts` |
| 16 | UPDATE | this README (Implementation Summary, evidence, Change History) |

**Comment/doc deltas (binding, plan §2.3)**: nav-config `:311` (D-18 leg, conditional on 523), `(tenant)/ai-model-defaults/page.tsx:6`, the new screen's header comment states the E3 posture truthfully, `secret-field.util.ts` header gains the new consumer name (unless 524 already reworded it — check), `docs/traceability-matrix.md` row for the new tenant routes.

**Out of scope**: SYSTEM connection rows + the settings write-lane (= TASK-524); SMR Python consumption of `provider_overrides` (= TASK-525; contract frozen in §3.3); non-cloud providers permanently excluded from the tenant lane (AD-2); `AiRuntimeProfile`/hyperparameters (SYSTEM-only, 524); TTS behavior unchanged (no edits to `tenant-tts-config` service/screens — the silent-catch stays as-is there); `/ai-models` hub + platform file renames (TASK-528/532); harness/guardrail/nlp BYO (cloud LLM = SMR path only this ticket).

## 5. TDD Plan (RED first — paste failing output in this README before implementing)

Applications — `packages/applications/src/services/ai-provider-connection/__tests__/ai-provider-connection.tenant-lane.test.ts`:
1. `setTenantCredential('ollama'|'vllm'|'lm-studio'|'llama-cpp')` → `ForbiddenException` (403, self-host rejected); `azure`/`bedrock` → allowed.
2. No SecretsService → write rejected (no plaintext-at-rest fallback — TTS `:351-353` parity).
3. **Key never echoed**: `toResponse` snapshot test over set/rotate/get/list — no `apiKey`/`encryptedApiKey`/ciphertext bytes in any response shape.
4. Tenant A sets an azure key → resolution for tenant B unaffected (reuse `tests/cross-tenant/fixtures.ts`); tenant B's `resolveTenantCloudOverrides` returns `{}`.
5. **Disabled credential → SYSTEM fallback**: `enabled: false` tenant row is skipped by `resolveTenantCloudOverrides` (AD-2 order tenant-enabled → SYSTEM → env).
6. Decrypt throws → credential skipped (fail-open) AND a warn was logged with no secret material (assert log args).
7. Factory-created entities on create; `broadcastSysEvent` on set/rotate/remove; OCC drift on stale `expectedVersion` → `OptimisticConcurrencyException`.

API — controller + proxy tests:
8. `PUT …/tenant/:provider` without `If-Match` → 428; version drift → 412; `If-Match: "0"` creates (ai-task-defaults `client.ts:15-20` convention).
9. Cross-tenant by-id probe → 404 (never 403).
10. smr-proxy: resolved provider `azure` + enabled tenant credential → forwarded body carries `provider_overrides.azure.{api_key,…}`; provider `ollama` → field absent; resolver throws → request proceeds without overrides + warn (fail-open), while `applySmrModelSelection` failure still rethrows (fail-closed selection preserved).
11. e2e (authored now, executed P7): `task-526-ai-provider-byo-cross-tenant.spec.ts` — full-HTTP secret-never-echoed + cross-tenant 404 + OCC matrix.

Console — `tenant-ai-configuration-screen.test.tsx` (+ axe):
12. States: loading (Skeleton matches table+card layout, rule 10) / effective table populated with all 9 keys + source badges / credentials tab Configured & None cards / error (`ErrorState` + retry).
13. `vitest-axe`: 0 violations per tab; both themes rendered (`.dark` class toggle).
14. Working-tenant gate: elevated user without a working tenant → gate empty-state, with one → screen + "Acting on «Tenant»" banner visible on the credentials tab.
15. OCC conflict on save → `OccConflictAlert` path (draft preserved, reload-merge — `task-default-card.tsx:169-176` pattern).
16. nav-config test asserts `/ai-configuration` (old route gone from nav); redirect page test.

Gates (all pasted as evidence):
```
pnpm --filter @arcaai/applications build test
pnpm build:api && pnpm test:unit
pnpm --filter @arcaai/admin-console build lint test
pnpm lint          # only-warn in packages/* treated as errors
```

## 6. Acceptance & DoD

- [ ] Design frame or recorded waiver logged in this README **before** screen code (rule 12)
- [ ] Tenant admin can set/rotate/remove Azure + Bedrock credentials; key Vault-encrypted; **no response ever contains key material** (snapshot-tested + e2e-asserted)
- [ ] Self-host provider tenant PUT → 403; cross-tenant → 404; OCC 428/412 on PUT; sys-events on every mutation
- [ ] SMR azure/bedrock requests carry tenant overrides when configured+enabled; disabled/broken credentials fall back to SYSTEM/env; decrypt failures logged without secrets
- [ ] `/ai-configuration` live: effective 9-key table (cascade source shown) + credential cards; `/ai-model-defaults` redirects; nav + tests updated
- [ ] axe 0 violations, both themes, skeleton/empty/error states; WorkingTenantGate + Acting-on banner for elevated users
- [ ] All §5 gates green with output pasted; RED evidence pasted; comment deltas done; traceability matrix updated

## 7. Risks & Rollback

| Risk | Mitigation |
|---|---|
| Credential material leaks into logs/telemetry from the injection path | Resolver logs only `{tenantId, provider, keyVersion}`; the smr-proxy upstream-error handler already redacts bodies (`smr-proxy.controller.ts:230-246`) — tests assert log-arg shapes; e2e snapshot on every response |
| Decrypt failures invisible (the TTS silent-catch lesson, `tenant-tts-config.service.ts:423`) | Per-credential warn log is part of the DoD; consider a counter metric in TASK-529's metrics wave (out of scope here) |
| Route rename breaks deep links / bookmarks | `/ai-model-defaults` keeps a `redirect()` page for one release; nav-config tests lock the mapping (plan §7 precedent) |
| TASK-524 contract drift (file/route names differ from AD-2) | Child re-verifies 524's landed names at start; AD-2 shapes are frozen — semantic drift escalates to the program owner, not silently adapted |
| Injected `provider_overrides` breaks SMR before TASK-525 lands | SMR pydantic ignores unknown fields (verified posture: gateway forwards, service owns validation); staged rollout — injection is additive and inert until consumed |
| Rollback | Feature is additive: revert the console route + nav entry (redirect page keeps links alive), drop the controller tenant routes, remove the proxy fold-in call — no migration owned by this ticket (table is 524's) |

## 8. References

- Rules: `.claude/rules/10-skeleton-loading.md`, `11-ux-ui-principles.md` (§1 ScreenTemplate, §11 a11y), `12-design-workflow.md` (design gate), `13-nextjs-apps.md` (BFF, TanStack Query, tier 30-49)
- Program: [findings 2026-07-20](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) §3-E5, §6 M-04/M-05/M-11, §7 GAP-C1 · [program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §3 AD-1/AD-2, §4 Phase 1
- Exemplars: `packages/applications/src/services/tenant-tts-config/tenant-tts-config.service.ts` (BYO service), `apps/api/src/modules/speech/speech-proxy.controller.ts:64-91` (injection wrapper), `apps/admin-console/src/features/tenant-tts-config/components/` (screens), `apps/admin-console/src/features/ai-task-defaults/components/task-default-card.tsx:30-51` (EffectiveLine)
- TTS BYO ticket TASK-496: archived — if `docs/archive/` lacks it in the working tree, recover via `git show HEAD:docs/archive/TASK-496-Tenant-TTS-Config/README.md` (adjust path from `git show HEAD:docs/archive -- | grep 496` if it moved)
- Secrets contrast: `apps/api/src/modules/global-setting/global-setting.controller.ts:175-199` (reveal step-up — the flow provider keys deliberately do NOT get)

## 9. Implementation Summary

**Status: implemented (Phases A–D), all gates green.** Implemented 2026-07-20 on `fix/2605-review`, uncommitted.

### 9.1 TASK-524 re-verification — what had ALREADY landed

The §4 manifest was written before 524 landed and guessed several names. Actual landed surface (re-verified at implementation start):

| Ticket assumption | Reality |
|---|---|
| `apps/api/src/modules/ai-provider/ai-provider-admin.controller.ts` | `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts` |
| `ITenantAiProviderConnectionService` additions needed | `IAiProviderConnectionService` exists; extended in place |
| `set-provider-credential.request.ts` / `provider-credential.response.ts` to be created | `UpsertAiProviderConnectionRequest` / `AiProviderConnectionResponse` already exist and already carry `expectedVersion` + the masked `hasKey`/`keyVersion` shape |
| The four §3.6 tenant routes to be added | **Already present** at `admin/ai-providers` — with tenant pinning (`resolveScopedTenantId`), cloud-only 403, Vault-gate, `@RequiresIfMatch()` OCC, and a `version: 0` placeholder GET |

**Decision D-1 — no `/tenant/*` route aliases.** 524's landed `admin/ai-providers` routes already satisfy every semantic behavior frozen in §3.6, including the tenant lane: `resolveScopedTenantId` pins a tenant admin to its own CLS tenant (a foreign `?tenantId=` → 403), `assertWriteAllowed` rejects self-host providers with 403, and the PUT is `If-Match`-guarded. Adding a parallel `/tenant/*` family would be a *redundant implementation* — precisely what the §2.5 Completion & Cleanup Doctrine says to converge, not create. AD-2 semantics are unchanged; only the ticket's guessed path strings differ, which the ticket itself flags as non-frozen. **The console calls the landed routes.**

Auth check performed before adopting them: `TENANT_ADMIN`'s seeded `tenant-full-access` policy already grants `manage GlobalSetting` scoped to `${context.tenantId}` (`packages/database/src/prisma/db_main/seed/01-policy.ts:109`), so the controller's `@CanRead('GlobalSetting')` / `@CanManage('GlobalSetting')` decorators admit tenant admins on their own tenant. No RBAC seed change was needed.

### 9.2 What this ticket actually built

**Phase A — applications** (`packages/applications/src/services/ai-provider-connection/`)

- `IAiProviderConnectionService.ts` — added `LlmProviderOverrideEntry` / `LlmProviderOverrides` (snake_case, the frozen TASK-525 wire contract) and the `resolveTenantCloudOverrides(tenantId)` method contract.
- `ai-provider-connection.service.ts` — implemented `resolveTenantCloudOverrides`: decrypts only ENABLED **cloud BYO** rows that carry key material, via the single audited `decryptSecretField` path. Fails open per credential on decrypt error only, logging `{message, tenantId, provider, keyVersion}` and nothing else — the deliberate improvement over the TTS exemplar's silent `catch { continue; }` (`tenant-tts-config.service.ts:423`, left untouched as out of scope). Added a `Logger` to the service.
- **Decision D-2** — `deleteRow` on an absent row now throws `NotFoundException` (was `ArgumentInvalidException` → 400). §3.6 freezes "404 when absent"; this also matches `TenantTtsConfigService.removeCredential` and the house 404-over-403 posture. No existing test asserted the old status.

**Phase B — api**

- `apps/api/src/modules/streaming/smr-proxy.controller.ts` — new private `applyTenantProviderOverrides`, called from `applySmrModelSelection` (which now awaits `applySmrRuntimeProfile` then folds in credentials). **Decision D-3**: hooking the single `applySmrModelSelection` chokepoint covers BOTH forward sites (`generate()` and the assembled path) plus any future one, instead of two parallel call sites as the manifest suggested — audited: those are the only two `/api/v1/generate` forwards. Three invariants, all test-locked: cloud-only (a self-host provider does not even trigger a lookup), **minimal exposure** (only the resolved provider's entry is forwarded, never a tenant's unused second key), and fail-open (a throwing resolver forwards without overrides + warn). Model-identity selection remains fail-closed — separately asserted.
- `provider_overrides` added to the forwarded `SmrGenerateRequest` interface (documented as gateway-injected, never client-accepted).
- `streaming.module.ts` — imports `AiProviderConnectionServiceModule`.

**Phase C — admin console** (design-gate waiver recorded above, before any screen code)

- `features/ai-task-defaults/api/` — new `providers-types.ts`, `providers-client.ts`, `providers-keys.ts`, `providers-hooks.ts` (append-only barrel update). OCC via `getWithEtag` + `If-Match`, `"0"` on create.
- `api/types.ts` — `AI_TASK_KEYS` widened **3 → 9** to match the backend (the D-18 mirror drift); its api test now asserts all nine.
- `components/effective-models-table.tsx` — read-only 9-row table (task key · model · provider · resolved-by badge) from ONE `GET admin/ai-task-defaults`. No pickers: the E3 global-admin-only write posture is untouched.
- `components/byo-credential-card.tsx` — Azure OpenAI + Amazon Bedrock cards on the TTS `CredentialCard` pattern, with the OCC divergence (`OccConflictAlert` reload-merge on 412).
- `components/tenant-ai-configuration-screen.tsx` — `WorkingTenantGate` → nuqs `Tabs` → `ScreenTemplate`; `TenantScopeBanner` in `statusBanner` **on the mutating tab only**.
- Route `/(tenant)/ai-configuration/{page,loading}.tsx`; `/(tenant)/ai-model-defaults/page.tsx` reduced to `permanentRedirect('/ai-configuration')` (its `loading.tsx` deleted); `ai-model-defaults-tenant-screen.tsx` **deleted** (§2.5: the incorrect implementation is removed with the fix, not left beside it).
- `nav-config.ts` — entry now `/ai-configuration` / "AI Configuration", stale TASK-506 comment replaced (the D-18 nav leg; TASK-523 had not landed it).
- Tests: new `tenant-ai-configuration-screen.test.tsx` (13 cases incl. vitest-axe 0 violations per tab and a dark-theme pass); `nav-config.test.ts` locks the rename AND asserts the old route is gone from nav; the old screens test lost its tenant-screen block and its now-partial `OPTIONS` fixture was retyped.

**Phase D — evidence**

- `apps/api/tests/e2e/task-526-ai-provider-byo-cross-tenant.spec.ts` — authored, executed in P7. Deep-key secret scan (no `apikey`/`encryptedapikey`/`ciphertext` at any depth, no `vault:v` in the raw body) on list/read/write, no-reveal-route probe, self-host 403, cross-tenant, 428/412 matrix. Typechecks under `apps/api`.
- `docs/traceability-matrix.md` — new rows 38 (provider connections + BYO injection) and 39 (the console screen).

### 9.3 Security posture as shipped

| Requirement | How it is enforced | Test |
|---|---|---|
| Key write-only, no reveal ever | No DTO carries key material (524's mapper); no reveal route exists | 524 deep-key test + e2e no-reveal probe + e2e deep scan |
| Vault-gate, no plaintext-at-rest | `encryptKey` throws without `SecretsService` | 524 service test |
| Fail-open per credential ON DECRYPT ERROR ONLY | `resolveTenantCloudOverrides` per-row try/catch | tenant-lane test: broken credential skipped, healthy one survives |
| Warn carries no secret material | Log arg allow-list `{message, tenantId, provider, keyVersion}` | tenant-lane test asserts exact key set + absence of `vault:`/plaintext substrings |
| Selection stays fail-closed | `applySmrModelSelection` rethrows | smr-proxy BYO test |
| Self-host → 403 · cross-tenant → 404 · OCC 428/412 | Service + controller (524) | 524 tests + e2e |
| Minimal exposure on the wire | Only the resolved provider's entry is forwarded | smr-proxy BYO test asserts the unused key never appears |

### 9.4 Gate evidence (actual output)

RED first, in both TDD units:

```
# packages/applications — before implementing resolveTenantCloudOverrides
$ pnpm --filter @arcaai/applications test -- ai-provider-connection.tenant-lane
Error: The vi.spyOn() function could not find an object to spy upon. The first argument must be defined.
 ❯ makeService .../ai-provider-connection.tenant-lane.test.ts:79:19
 Test Files  1 failed | 314 passed | 1 skipped (316)
      Tests  8 failed | 6506 passed | 4 skipped (6518)

# apps/api — before implementing applyTenantProviderOverrides
$ npx vitest run apps/api/src/modules/streaming/__tests__/smr-proxy-tenant-byo.controller.test.ts
 FAIL  ... > folds the tenant azure credential into the forwarded body
 FAIL  ... > forwards ONLY the resolved provider entry, never the unused one
TypeError: Cannot convert undefined or null to object
 Test Files  1 failed (1)
      Tests  2 failed | 4 passed (6)

# admin-console — before the screen existed
$ npx vitest run src/features/ai-task-defaults/components/__tests__/tenant-ai-configuration-screen.test.tsx
Error: Failed to resolve import "../tenant-ai-configuration-screen"
 Test Files  1 failed (1)
      Tests  no tests
```

GREEN gates:

```
$ pnpm --filter @arcaai/applications build      # (the ticket's combined `build test` is not a valid
> rimraf dist tsconfig.tsbuildinfo && tsc       #  pnpm invocation — `tsc test` errors TS6231; run separately)
   (clean)
$ pnpm --filter @arcaai/applications test
 Test Files  315 passed | 1 skipped (316)
      Tests  6516 passed | 4 skipped (6520)

$ pnpm build:api
 Tasks:    8 successful, 8 total
  Time:    17.772s
$ pnpm test:unit
 Test Files  944 passed | 2 skipped (946)
      Tests  16659 passed | 4 skipped | 9 todo (16672)

$ pnpm --filter @arcaai/admin-console build
✓ Compiled successfully in 12.5s
├ ƒ /ai-configuration
├ ƒ /ai-model-defaults          # redirect page
$ pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
   (clean, 0 problems)
$ pnpm --filter @arcaai/admin-console test
 Test Files  135 passed (135)
      Tests  1003 passed (1003)

$ pnpm lint
 Tasks:    29 successful, 29 total
  Time:    26.574s
```

### 9.5 Honest notes / open items

- **`pnpm lint` reports 145 pre-existing prettier warnings in `packages/applications` (0 errors).** They are treated as errors by rule 01, but **none are in TASK-526-owned files** — `npx eslint src/services/ai-provider-connection` exits 0 with no output. They live in untouched files (live-documentation, user*, tenant-idp-config, …) and pre-date this ticket; fixing them repo-wide is out of this ticket's ownership manifest.
- **Transient cross-agent noise**: one intermediate `pnpm --filter @arcaai/applications test` run showed 2 failures in `src/services/stt/model/__tests__/aiModel.service.test.ts` — files owned by the concurrently-running TASK-527 agent (confirmed `M` in `git status`). They were green on re-run and in the final `pnpm test:unit` (16659 passed). Not touched by this ticket.
- **e2e not executed** — `task-526-*.spec.ts` is authored and typechecks, but needs a live gateway (`pnpm test:api:up`) + seeded DB; per §4 it runs in P7.
- **Runtime browser verification not performed.** The `next-dev-loop` skill's floor needs a running `next dev` + `agent-browser`; this session verified the screen through the production build, lint, and 13 jsdom tests (incl. axe in both themes) only. A headed pass remains for the P7 design-QA step.
- **Not fixed (out of scope, flagged)**: `ai-task-defaults-platform-screen.tsx` still hardcodes only **3** of the 9 task keys, so six platform defaults have no global-admin editor. This is a real gap surfaced by the 3→9 widening, but the platform screen belongs to TASK-532's file-rename/hub wave — recorded here rather than silently expanded into.
- SMR Python consumption of `provider_overrides` is TASK-525; the injected field is inert until then (SMR ignores unknown body fields), exactly as TASK-496 phased TTS.

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored (execution-ready): code-verified current state, frozen AD-2-aligned endpoint contract, injection-point + naming decisions, ordered plan with ownership manifest, RED-first TDD plan. Status Pending — awaits TASK-524 landing + design frame/waiver. |
| 2026-07-20 | **Design-gate waiver recorded** (owner, in lieu of a Figma frame; TASK-512 precedent) before any screen code — see the Preconditions block. |
| 2026-07-20 | **Implemented, Phases A–D; status Pending → Review.** TASK-524 re-verified: its landed `admin/ai-providers` routes already satisfied the whole §3.6 endpoint contract, so no `/tenant/*` aliases were created (decision D-1, §2.5 redundancy doctrine); the ticket's guessed file/route names were adapted to the landed ones. Built: `resolveTenantCloudOverrides` (fail-open per credential on decrypt error only, non-secret structured warn), the smr-proxy `provider_overrides` fold-in at the single `applySmrModelSelection` chokepoint (decision D-3), the tenant `/ai-configuration` screen (9-key read-only effective table + Azure/Bedrock BYO cards with OCC), `AI_TASK_KEYS` 3→9 (D-18), the `/ai-model-defaults` → `/ai-configuration` redirect + nav rename, the dead EmptyState screen deleted, an authored e2e secret/OCC/cross-tenant spec, and traceability rows 38–39. `deleteRow` absent-row now 404 not 400 (decision D-2). RED evidence and all four gate outputs pasted in §9.4; §9.5 records the pre-existing `packages/applications` prettier warnings (none in owned files), the un-run e2e, the missing headed-browser pass, and the out-of-scope platform-screen 3-of-9-keys gap. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
