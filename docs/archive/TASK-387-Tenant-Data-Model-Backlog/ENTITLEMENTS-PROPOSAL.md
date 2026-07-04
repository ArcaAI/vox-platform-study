# TASK-387 — Tenant Plan Entitlements Matrix (PROPOSAL → RATIFIED)

> **✅ RATIFIED / ACCEPTED AS-IS (2026-07-02).** This document originated the entitlements
> design. The user has since **ratified the matrix as-is** and it shipped under **TASK-392**.
> The **concrete, ratified numbers are in `docs/implementation/TASK-392-Plan-Entitlements/README.md` §2**
> (mirrored by `seed/15-entitlements.ts` + `entitlements.constants.ts`) — that is the source of truth.
> The §2 tables **below** are the ORIGINAL `⟨DRAFT⟩` placeholders and are retained **for provenance
> only** (they are intentionally left unchanged and are NOT the final values). The §6 Q1–Q10 answers
> below are the ratified decisions. Enforcement is ratified **ON for DEV + STAGING** (OFF for TEST/CI).


|                 |                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket**      | TASK-387 (follow-up design artifact)                                                                                                                                                                                                                                                                             |
| **Title**       | Draft entitlement matrix for `Tenant.plan` tiers (ENTERPRISE / PRO / TRIAL / STARTER)                                                                                                                                                                                                                            |
| **Created**     | 2026-07-01                                                                                                                                                                                                                                                                                                       |
| **Updated**     | 2026-07-02                                                                                                                                                                                                                                                                                                       |
| **Status**      | **RATIFIED / ACCEPTED AS-IS** — shipped as TASK-392; ratified numbers live in TASK-392 §2 (this doc's §2 tables are original draft placeholders, kept for provenance)                                                                                                                                             |
| **Context**     | The `Tenant.plan` enum landed in TASK-387 as **display-only** (see README §3 FLAG #1: "any billing/entitlement semantics attached to a plan … are product decisions — deliberately **not** wired"). This doc proposes what those semantics *could* be, grounded in what the codebase can actually enforce today. |
| **Scope guard** | Read-only research + this markdown file. No edits to code, schema, the TASK-387 README, `apps/admin/`**, the api-key backend, or the TASK-390 README.                                                                                                                                                            |


---



## 0. How to read this document

- `⟨DRAFT⟩` on a value = a placeholder the user must confirm or replace.
- **Enforceability** column uses three grades:
  - **Yes** — the limit value *and* the live measurement both exist today, and there is an obvious single place to add the check. Only the check itself is missing.
  - **Partial** — one side exists (usually the *measurement* via `getUsageStats` / consumption roll-up) but there is **no limit field** and **no enforcement**, or the value is stored but only surfaced as display.
  - **Needs-work** — neither a per-tenant limit nor a per-tenant meter exists; requires **new schema, metering, or config** before it can gate anything.
- "Layer chain" refers to the house order from `01-development-workflow.mdc`: **Database → Domain → Applications (service) → API (controller) → SDK/FE**.

---



## 1. Capability inventory — what a plan could gate, and whether it's real today

Each row cites the **exact model/field/service** so the user can see what's real vs. aspirational. "Source of truth" is where the number would be read from; "Limit stored where?" is where the *cap* would live (almost always **"none yet"** today).

### 1a. Quantity limits (countable resources)


| #   | Capability / limit                     | Source of truth (measurement)                                                                                                                                                             | Limit stored where?                                  | Enforceable today                                                                                                                                                               |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **Storage quota (bytes)**              | `TenantBucket.quotaBytes` (BigInt?, TASK-386) as the cap; usage = `SUM(Media.size)` via `TenantService.getUsageStats` → `storageUsedBytes` / `ConsumptionRollupResponse.storageUsedBytes` | `TenantBucket.quotaBytes` (**per-bucket**, nullable) | **Partial** — cap + usage both exist, but it is **display-only**: no upload path blocks on exceed, and quota is per-**bucket**, not per-**tenant**                              |
| C2  | **Seats / max users per tenant**       | `getUsageStats.totalUsers` = distinct `UserRoleAssignment` + `UserDepartment` assignments for the tenant (`User` has no `tenantId`; tenancy is via those join tables)                     | none yet                                             | **Partial** — usage is measurable; no `maxUsers` field, no create-time check                                                                                                    |
| C3  | **Departments count**                  | `getUsageStats.totalDepartments` = `COUNT(Department WHERE tenantId)`                                                                                                                     | none yet                                             | **Partial** — measurable; no cap                                                                                                                                                |
| C4  | **Agent/prompt templates count**       | `getUsageStats.totalPromptTemplates` = `COUNT(PromptTemplate WHERE tenantId)`                                                                                                             | none yet                                             | **Partial** — measurable; no cap                                                                                                                                                |
| C5  | **ASR pipelines count**                | `getUsageStats.totalPipelines` = `COUNT(AsrPipeline WHERE tenantId)`                                                                                                                      | none yet                                             | **Partial** — measurable; no cap                                                                                                                                                |
| C6  | **API keys count**                     | `COUNT(ApiKey WHERE tenantId)` (not currently in `getUsageStats`; trivial to add)                                                                                                         | none yet                                             | **Partial** — countable; no cap enforced                                                                                                                                        |
| C7  | **Per-department default-agent slots** | **Fixed layout of 4 slots** per department (`preSummary` / `newVisit` / `revisit` / `dnaStyle`) via `Department.*PromptId` (`slot-config.ts` `DEFAULT_AGENT_SLOTS`)                       | n/a (fixed count, not a metered quantity)            | **Needs-work** — this is a fixed 4-slot layout, **not** a variable count; "N slots per plan" doesn't map to anything today. Better modeled as a *feature toggle* (see F-series) |




### 1b. Consumption meters (usage over time)


| #   | Capability / limit              | Source of truth (measurement)                                                                                                                  | Windowing today                       | Enforceable today                                                                                        |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M1  | **Consultation volume**         | `ConsumptionRollupResponse.consultations` = `COUNT(Consultation)` **total** + **today** (per-tenant when `?tenantId=`)                         | all-time total + "since UTC midnight" | **Partial** — measurable; **no monthly meter**, no cap                                                   |
| M2  | **Transcription minutes (STT)** | `getUsageStats.transcriptionMinutes` / `ConsumptionRollupResponse.transcriptionMinutes` = `SUM(AudioRecording.duration ms)/60000` (per-tenant) | **cumulative all-time** only          | **Partial** — cumulative is measurable, but a **billing-style rolling/monthly quota needs new metering** |
| M3  | **Summaries generated**         | `getUsageStats.summaries24h` = `COUNT(SummaryMeta WHERE generatedAt ≥ now−24h)` (per-tenant)                                                   | **24h window only**                   | **Partial** — 24h measurable; **monthly meter needs new metering**                                       |
| M4  | **DNA report generations**      | `DnaWritingStyleReport` rows (`dna-writing-style.prisma`), doctor-scoped generation                                                            | none                                  | **Needs-work** — countable but no per-tenant meter surfaced; generation is doctor-self-scoped today      |


> **Metering caveat (important):** the Prometheus metrics from TASK-386 (`stt_v2_audio_duration_seconds`, `smr_v2_generation_total`, etc.) are **platform-wide observability with no** `tenantId` **label** — they **cannot** be used for per-tenant billing quotas. Per-tenant consumption must come from **Postgres aggregation** (the `getUsageStats` / `ConsumptionRollupResponse` path), which is real and live-testable, but is **cumulative/point-in-time**, not a rolling monthly counter. A true "X minutes per month" quota needs a new metering table or a windowed aggregate.



### 1c. Feature toggles (on/off capabilities)


| #   | Capability                               | Source of truth / where it lives                                                                                                                                                                                                                       | Enforceable today                                                                                                                               |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Model access (which models per tier)** | `AiModel` rows are **tenant-scoped** (`@@unique([tenantId, slug])`). On tenant create, `TenantService.provisionTenantModelCatalog` **clones the entire** `SYSTEM_TENANT_ID` **model catalog** into the new tenant. Pipelines reference models by slug. | **Needs-work** — no "plan → allowed models" concept, but the **clone-at-create hook is a concrete gating point** (clone a plan-specific subset) |
| F2  | **DNA writing-style slot / DNA reports** | `Department.dnaWritingStylePromptId` (TASK-387 #7) + `DnaWritingStyleReport`                                                                                                                                                                           | **Needs-work** — feature exists; gating it on/off per plan is new logic                                                                         |
| F3  | **Voice enrollment / diarization**       | `TenantFrontendConfig.voiceEnrollment` / `.diarization` / `.noiseCancel` / `.vad` (per-tenant booleans) + `UserVoiceProfile`                                                                                                                           | **Needs-work** — tenant toggles exist but are **not** derived from plan                                                                         |
| F4  | **Guardrail / NLP pipeline features**    | Pipeline stages resolved via `PipelinePolicy` cascade (DOCTOR→DEPT→TENANT→SYSTEM) + `TenantFrontendConfig`                                                                                                                                             | **Needs-work** — no plan gating; would need plan→policy defaults                                                                                |
| F5  | **Monitoring / telemetry access**        | `GET /monitoring/sessions` + `GET /health/services` are `manage all`-gated (super-admin only); tenant-scoped telemetry is a known gap (TASK-380 review)                                                                                                | **Needs-work** — would be a plan feature *and* needs the tenant-scoped read endpoint first                                                      |
| F6  | **API key rotation**                     | Schema ready: `ApiKey.rotatedFromKeyId` / `rotatedToKeyId` / `rotationExpiresAt`; rotate **endpoint** is a known gap (review K5), **being built by a concurrent worker (api-key backend / TASK-390)**                                                  | **Partial** — schema ready; endpoint in-flight (not owned here)                                                                                 |
| F7  | **Per-key request rate limit**           | `ApiKey.rateLimit` (Int?, requests/min) — a per-key field                                                                                                                                                                                              | **Partial** — field exists; see R1 for how rate limiting actually works                                                                         |




### 1d. Global / gateway-level knobs (not per-tenant today)


| #   | Capability                    | Source of truth / where it lives                                                                                                                                                                                                                                                                                                               | Enforceable today                                                                                                                                                        |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | **Rate limits**               | Gateway-wide concern. 4 named tiers (`default` / `strict` / `heavy` / `relaxed`) + per-route overrides, persisted as `rate-limit.`* `GlobalSetting` rows on the platform tenant (`rate-limit.constants.ts`, `IRateLimitAdminService`). `RateLimitingService` keys by **user / IP / apiKey / endpoint / global** — **never by tenant or plan**. | **Needs-work** — to make rate limits plan-scoped, add a **plan→tier mapping** or a per-tenant limit; today the "Rate Limits" admin surface tunes global tiers, not plans |
| R2  | **Queues / jobs concurrency** | `hope_job_active_count` gauge (by `queue`), `hope_job_processing_total` (by `queue,status,processor`). Worker concurrency is a **global** config, not per-tenant.                                                                                                                                                                              | **Needs-work** — not naturally per-tenant; would need per-tenant queue partitioning or weighting                                                                         |


---



## 2. Draft tier matrix

> **Columns are ascending: STARTER → TRIAL → PRO → ENTERPRISE.** Every number is a `⟨DRAFT⟩` **placeholder** — the user sets the real values. `∞` = unlimited/ungated. `—` = not offered on that tier. `✓`/`✗` = feature on/off.



### 2a. Quantity limits & meters


| Capability                       | STARTER        | TRIAL          | PRO              | ENTERPRISE           |
| -------------------------------- | -------------- | -------------- | ---------------- | -------------------- |
| C1 Storage quota                 | `⟨DRAFT⟩` 5 GB | `⟨DRAFT⟩` 2 GB | `⟨DRAFT⟩` 100 GB | `⟨DRAFT⟩` ∞ / custom |
| C2 Max users (seats)             | `⟨DRAFT⟩` 5    | `⟨DRAFT⟩` 3    | `⟨DRAFT⟩` 50     | `⟨DRAFT⟩` ∞          |
| C3 Departments                   | `⟨DRAFT⟩` 2    | `⟨DRAFT⟩` 1    | `⟨DRAFT⟩` 20     | `⟨DRAFT⟩` ∞          |
| C4 Prompt/agent templates        | `⟨DRAFT⟩` 10   | `⟨DRAFT⟩` 5    | `⟨DRAFT⟩` 100    | `⟨DRAFT⟩` ∞          |
| C5 ASR pipelines                 | `⟨DRAFT⟩` 1    | `⟨DRAFT⟩` 1    | `⟨DRAFT⟩` 5      | `⟨DRAFT⟩` ∞          |
| C6 API keys                      | `⟨DRAFT⟩` 2    | `⟨DRAFT⟩` 1    | `⟨DRAFT⟩` 10     | `⟨DRAFT⟩` ∞          |
| M1 Consultations / month         | `⟨DRAFT⟩` 200  | `⟨DRAFT⟩` 50   | `⟨DRAFT⟩` 5,000  | `⟨DRAFT⟩` ∞          |
| M2 Transcription minutes / month | `⟨DRAFT⟩` 500  | `⟨DRAFT⟩` 120  | `⟨DRAFT⟩` 10,000 | `⟨DRAFT⟩` ∞          |
| M3 Summaries / month             | `⟨DRAFT⟩` 200  | `⟨DRAFT⟩` 50   | `⟨DRAFT⟩` 5,000  | `⟨DRAFT⟩` ∞          |




### 2b. Feature toggles & rate knobs


| Capability                        | STARTER                     | TRIAL               | PRO                     | ENTERPRISE                        |
| --------------------------------- | --------------------------- | ------------------- | ----------------------- | --------------------------------- |
| F1 Model access                   | `⟨DRAFT⟩` base STT+SMR only | `⟨DRAFT⟩` base only | `⟨DRAFT⟩` full catalog  | `⟨DRAFT⟩` full + custom/finetuned |
| F2 DNA writing-style + reports    | `⟨DRAFT⟩` ✗                 | `⟨DRAFT⟩` ✓         | `⟨DRAFT⟩` ✓             | `⟨DRAFT⟩` ✓                       |
| F3 Voice enrollment / diarization | `⟨DRAFT⟩` ✗                 | `⟨DRAFT⟩` ✓         | `⟨DRAFT⟩` ✓             | `⟨DRAFT⟩` ✓                       |
| F4 Guardrail / advanced NLP       | `⟨DRAFT⟩` basic             | `⟨DRAFT⟩` full      | `⟨DRAFT⟩` full          | `⟨DRAFT⟩` full + custom policy    |
| F5 Monitoring / telemetry access  | `⟨DRAFT⟩` ✗                 | `⟨DRAFT⟩` ✗         | `⟨DRAFT⟩` tenant-scoped | `⟨DRAFT⟩` tenant-scoped           |
| F6 API key rotation               | `⟨DRAFT⟩` ✓                 | `⟨DRAFT⟩` ✓         | `⟨DRAFT⟩` ✓             | `⟨DRAFT⟩` ✓                       |
| R1 Rate-limit tier                | `⟨DRAFT⟩` strict            | `⟨DRAFT⟩` strict    | `⟨DRAFT⟩` default       | `⟨DRAFT⟩` relaxed                 |
| R2 Queue priority/concurrency     | `⟨DRAFT⟩` standard          | `⟨DRAFT⟩` standard  | `⟨DRAFT⟩` standard      | `⟨DRAFT⟩` priority                |


> Reminder: TRIAL is intentionally drawn as a **time-boxed PRO-like experience with small quotas** (feature-rich, low volume). The user may instead want TRIAL = "full PRO for N days, then downgrade". See §4.

---



## 3. Proposed enforcement style per capability

Three styles, and **where in the layer chain** each would live:

- **hard-block** — reject the write at the API with a typed error (e.g. `403 Forbidden` or `409 Conflict` with a `quota_exceeded` code). Check lives in the **application service** (so both API and any internal caller are covered), surfaced by the **controller**.
- **soft-warn** — allow the action, but return/emit a warning the SDK/FE surfaces (banner/toast). Computed in the **service**, carried in the **response DTO**.
- **display-only** — no gate; show usage vs. limit in the Admin Console. Lives entirely in **SDK/FE** reading `getUsageStats` / consumption roll-up.


| #     | Capability                                     | Proposed style                                                                       | Where it lives                                                                                                   | Notes                                                                                                       |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| C1    | Storage quota                                  | **hard-block** on upload once metering is per-tenant; **soft-warn** at ≥`⟨DRAFT⟩`80% | media/upload service (create path) → controller `413`/`409`                                                      | Today display-only; needs a per-tenant quota convention (sum of bucket quotas, or a new tenant-level field) |
| C2    | Max users                                      | **hard-block** on user create/assign                                                 | `UserService` / assignment service create path                                                                   | Count distinct assignments before insert                                                                    |
| C3–C6 | Departments / templates / pipelines / API keys | **hard-block** on create                                                             | each resource's `create` service method                                                                          | Cheap `COUNT` precheck                                                                                      |
| M1–M3 | Consultation / transcription / summary meters  | **soft-warn** approaching, **hard-block** at 100% (config per meter)                 | consultation-start / STT-submit / summary-generate services                                                      | Requires monthly metering (see §7)                                                                          |
| M4    | DNA report generations                         | **soft-warn** or **display-only**                                                    | DNA service                                                                                                      | Low priority                                                                                                |
| F1    | Model access                                   | **hard-block** (model simply absent for the tenant)                                  | `provisionTenantModelCatalog` clones a plan subset; pipeline resolution naturally can't reference an absent slug | Most "enforcement" is just *not provisioning* the row                                                       |
| F2–F4 | DNA / voice / guardrail features               | **hard-block** (feature disabled) or **display-only** (hidden in FE)                 | service guard + FE capability flag                                                                               | Prefer FE-hide + service guard (defense in depth)                                                           |
| F5    | Monitoring access                              | **hard-block** (route guard)                                                         | controller guard, gated on plan capability                                                                       | Also blocked on the tenant-scoped telemetry endpoint gap                                                    |
| F6    | API key rotation                               | **display-only** gate (allow all tiers) unless product wants otherwise               | api-key backend (not owned here)                                                                                 | Coordinate with TASK-390 worker                                                                             |
| R1    | Rate-limit tier                                | **hard-block** (429) via plan→tier map                                               | rate-limit guard + `plan→tier` resolver                                                                          | Extends `RateLimitingService` to key on tenant/plan                                                         |
| R2    | Queue concurrency                              | **display-only** near-term                                                           | —                                                                                                                | Per-tenant queue weighting is a larger infra change                                                         |


**Recommended near-term subset (cheapest, highest-signal):** C1 storage (soft-warn + display), C2 seats (hard-block), C3–C6 counts (hard-block) — all use existing `COUNT`/`getUsageStats` reads and only need a limit source + a service precheck. Meters (M1–M3) and rate-limit-by-plan (R1) are the "needs metering/config" tier.

---



## 4. Proposed TRIAL behavior

> All values `⟨DRAFT⟩`. There is **no** `trialEndsAt` **field today** — trial expiry needs one **new nullable column** (additive), e.g. `Tenant.trialEndsAt DateTime?`. Nothing about trials is wired yet.

- **Trial duration:** `⟨DRAFT⟩` **14 days** (alt: 30) from tenant creation (or from the moment plan is first set to `TRIAL`).
- **Entitlements during trial:** feature-rich (PRO-like features) but **low quotas** (see §2), so the trial demonstrates capability without becoming a free production tier.
- **Expiry behavior — proposed default: auto-downgrade to** `STARTER` (non-destructive, keeps the tenant usable). Rationale: downgrade is reversible, avoids data-access surprises, and maps cleanly onto the existing lifecycle. **Alternative:** `suspend` (harder stop; better for paid-conversion pressure). This is an **open decision** (§6 Q4).
- **Interaction with the TASK-387 lifecycle (**`ResourceStatusType`**):**
  - The plan (`TenantPlan`) and the lifecycle status (`ResourceStatusType`: `ENABLED`/`DISABLED`/`SUSPENDED`/`ARCHIVED`/`DELETED`) are **orthogonal axes** — plan = *what you're entitled to*, status = *whether the tenant is operable*. Keep them independent.
  - **Auto-downgrade path:** on expiry, set `plan = STARTER`, leave `resourceStatus = ENABLED`. Pure plan change; no lifecycle transition.
  - **Suspend path (if chosen):** call the existing `suspend` action → `resourceStatus = SUSPENDED` (reversible operator hold from TASK-387). A later "convert to paid" sets `plan = PRO` and `restore` → `ENABLED`.
  - The **system/default tenant** (`__GLOBAL__` key or reserved `00000000-…` id) must never be trial-managed — it is already guarded by `assertNotSystemTenant` (DEF-ADM-002); any trial-expiry job must reuse that guard.
- **Who runs expiry:** a scheduled job (there is an existing scheduler-admin pattern) evaluates `trialEndsAt < now` and applies the chosen action, emitting a `SysEvent` for audit. Outline only — not designed here.

---



## 5. Default tier for new tenants + backfill

- **Default tier for new tenants — proposed:** `TRIAL`**.** This directly resolves the open **FLAG #1** in the TASK-387 README ("whether new tenants should auto-default to `TRIAL`"). Setting the default requires either a DB `@default` on the column **or** (preferred) defaulting in `TenantFactory` / `TenantService.create` so it stays overridable and non-destructive. **Recommendation: default in the factory/service, not the DB**, to avoid a schema default that implies retroactive semantics.
- **Backfill for existing tenants (additive only — no destructive changes):**
  - `Tenant.plan` is **nullable with no DB default** today; existing rows read `NULL` **= "unspecified / legacy"**. **Do not** mass-rewrite them.
  - **Proposed:** treat `NULL` as a distinct **"legacy / ungated"** state at the entitlement-resolution layer (i.e., `resolveEntitlements(null)` → unlimited/ungated), so **turning on enforcement never breaks an existing tenant**. Operators can then set plans deliberately, tenant by tenant.
  - Alternative (needs explicit sign-off): a **one-time, opt-in** admin backfill that sets `NULL → STARTER` (or `ENTERPRISE` for grandfathered customers). This is a **data decision**, not a migration — must be user-approved and reversible. (§6 Q3.)
  - The reserved **system tenant** stays `NULL`/ungated regardless.

---



## 6. Open questions / decisions needed before implementation

1. **Q1 — Entitlement source of truth:** a **static config map** (`PLAN_ENTITLEMENTS: Record<TenantPlan, Entitlements>`, mirroring `RATE_LIMIT_TIER_DEFAULTS`) vs. a **DB-backed table** (per-tenant overrides, admin-editable)? Static is simplest and versioned in code; DB allows per-tenant custom deals (esp. ENTERPRISE). *Recommendation: static map + optional per-tenant override JSON later.*
Answer: **DB-backed table** (per-tenant overrides, admin-editable)
2. **Q2 — Real limit values:** every `⟨DRAFT⟩` number in §2 needs product-owner values (storage GB, seats, monthly meters, which models per tier).
Answer: suggest a starting point for 100 concurrent doctor users per Enterprise tenant
3. **Q3 — Backfill policy for the** `NULL` **plan rows:** treat `NULL` as ungated-legacy (safe, recommended) **or** opt-in backfill to `STARTER`/grandfathered `ENTERPRISE`? (Requires explicit approval — data change.)
Answer: There is no production now, we are still in development so do we need backfill?
4. **Q4 — Trial expiry action:** auto-downgrade to `STARTER` (recommended) vs. `suspend`? And trial length (14 vs 30 days), and does the clock start at create or at first `TRIAL` assignment?
Answer: Trial must be 1-week PRO plan, then auto-downgrade to Starter
5. **Q5 — Metering model for M1–M3:** cumulative Postgres aggregate is real but not a monthly meter. Do we need **rolling monthly quotas** (new metering table / windowed aggregate + reset job) or are **cumulative + display** enough for v1?
Answer: **rolling monthly quotas** (new metering table / windowed aggregate + reset job) as we need to capture usage near realtime.
6. **Q6 — Storage quota granularity:** `quotaBytes` is **per-bucket**. Do we want a **tenant-level** quota (new field or "sum of bucket quotas" convention), and do uploads **hard-block** or **soft-warn**?
Answer: **tenant-level** quota and do uploads **soft-warn**
7. **Q7 — Rate-limit-by-plan:** should plan drive the rate-limit tier (R1)? If so, confirm the `plan→tier` mapping and whether it's per-tenant keyed (needs `RateLimitingService` extension).
Answer: `plan→tier` and we need to increase the rate-limite by tenant on demand
8. **Q8 — Model access mechanism:** enforce F1 by **cloning a plan-specific subset** at tenant create (leverages `provisionTenantModelCatalog`) vs. a runtime **allowlist** checked at pipeline resolution? Clone-subset is closest to today's design.
Answer: Clone-subset, we need to freeze tenant, and also doing rollout features by tenant in the future (new default pipelines, new models, etc.)
9. **Q9 — Enforcement rollout safety:** ship enforcement **disabled by default** behind a global kill-switch (like `rate-limit.enabled`) so it can be enabled per-environment after the numbers are validated?
Answer: Yes
10. **Q10 — Downgrade over-limit handling:** when a tenant downgrades (or trial expires) while **already over** the new limit (e.g., 8 users, new cap 5), do we **block new** only (grandfather existing) or force remediation? *Recommendation: block-new-only; never auto-delete.*
Answer: block-new-only and also disable redundant resources by newest created-at time.

---



## 7. Phased implementation outline (outline only — NOT code)

> Strict layer chain per `01-development-workflow.mdc`. Each phase is independently shippable and **additive**. Enforcement ships **off by default** (Q9).

- **Phase 0 — Decisions (this doc):** user fills in §2 numbers and resolves §6 Q1–Q10. **Gate:** approved matrix.
- **Phase 1 — Entitlement resolution (no enforcement):**
  - Add `resolveEntitlements(plan | null)` (static `PLAN_ENTITLEMENTS` map per Q1; `null → ungated`).
  - Surface a read-only **capability/usage DTO** (compose existing `getUsageStats` + limits) so the Admin Console can show **usage vs. limit (display-only)**.
  - New nullable `Tenant.trialEndsAt` column *if* trials are in v1 (additive migration).
  - **Verify:** unit tests on the resolver; FE shows limits with no behavior change.
- **Phase 2 — Metering (only for M1–M3 if Q5 = monthly):**
  - Add a windowed per-tenant usage aggregate (new table or scheduled roll-up) for consultations / transcription-minutes / summaries; reset/rollover job.
  - **Verify:** metered counts reconcile against the Postgres aggregates.
- **Phase 3 — Service-level checks (hard-block/soft-warn):**
  - Add `COUNT`/meter prechecks in the relevant `create`/submit service methods (C2–C6, C1, M1–M3), returning typed `quota_exceeded` errors; broadcast `SysEvent` on block.
  - Behind the global kill-switch (Q9).
  - **Verify:** unit tests for at/over/under limit; kill-switch off = no change.
- **Phase 4 — API enforcement + feature gates:**
  - Controllers map service quota errors to `403`/`409`/`413`/`429`; add plan-capability route guards for F-series (e.g., F5 monitoring).
  - Model access (F1) via plan-subset clone in `provisionTenantModelCatalog` (Q8).
  - Rate-limit-by-plan (R1) via `plan→tier` resolver in the rate-limit guard (Q7).
  - **Verify:** E2E for a capped tenant (block) and an uncapped/`ENTERPRISE`/`NULL` tenant (allow).
- **Phase 5 — SDK / FE surfacing:**
  - SDK exposes entitlements + usage; Admin Console shows quota bars, near-limit warnings, and blocked-action messaging; trial countdown + expiry banner.
  - **Verify:** FE reflects each tier; over-limit UX is clear and non-destructive.

---



## 8. Grounding index (what was read to write this)


| Claim                                                                      | Cited source                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan` enum + nullable, display-only                                       | `packages/database/src/prisma/db_main/enums.prisma` (`TenantPlan`), `tenant.prisma` (`plan TenantPlan?`), TASK-387 README §3 FLAG #1             |
| Lifecycle statuses incl. SUSPENDED/ARCHIVED                                | `enums.prisma` (`ResourceStatusType`); TASK-387 README §3/§5                                                                                     |
| Storage quota field + usage                                                | `tenant-bucket.prisma` (`quotaBytes BigInt?`); `tenant.service.ts` `getUsageStats`; `tenant-usage.response.ts`; `consumption-rollup.response.ts` |
| Per-tenant consumption is Postgres-derived (no tenant label in Prometheus) | `TASK-386 METRIC-CONTRACT.md` (metrics have no `tenantId`); `ConsumptionRollupResponse` (per-tenant via `?tenantId=`)                            |
| Seats measured via assignments, no cap                                     | `getUsageStats` (`distinctUserAssignments`); `user.prisma` (`User` has no `tenantId`)                                                            |
| Fixed 4 agent slots per department                                         | `apps/admin/src/features/agents/slot-config.ts` `DEFAULT_AGENT_SLOTS`; `department.prisma` (`*PromptId`)                                         |
| Rate limits are global tiers/routes, not per-plan                          | `rate-limit.constants.ts`, `IRateLimitAdminService.ts`, `rate-limiting.service.ts` (keys: user/ip/apikey/endpoint/global)                        |
| API key rate/rotation fields                                               | `apikey.prisma` (`rateLimit`, `rotated*`, `rotationExpiresAt`)                                                                                   |
| Model catalog cloned per tenant at create                                  | `tenant.service.ts` `provisionTenantModelCatalog`; `stt.prisma` `AiModel` (`@@unique([tenantId, slug])`)                                         |
| System-tenant guard reused for trial jobs                                  | `tenant.service.ts` `assertNotSystemTenant` (DEF-ADM-002)                                                                                        |
| Feature toggles exist per tenant                                           | `tenant.prisma` `TenantFrontendConfig` (`voiceEnrollment`/`diarization`/…); `pipeline-policy.prisma`; `dna-writing-style.prisma`                 |
| Surface backlog context                                                    | `docs/admin-console-open-items-review.md` §3a (#3 plan, #5 storage, K5 rotate, T1 metrics, tenant-scoped telemetry)                              |


---

**END OF PROPOSAL — RATIFIED.** The §6 Q1–Q10 decisions were accepted and the matrix was ratified
**as-is** (no number changes). Implementation shipped under **TASK-392**; the ratified, live values
are in `docs/implementation/TASK-392-Plan-Entitlements/README.md` §2. The §2 draft placeholders above
are retained unchanged for provenance only. Enforcement is ratified **ON for DEV + STAGING**, **OFF
for TEST/CI**.