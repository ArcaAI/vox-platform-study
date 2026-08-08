# TASK-638 — Reference Pricing Model, Plan Allowances, Enforcement Flip & Provider Reconciliation

| | |
|---|---|
| **Status** | Review — design, COGS/SELL formulas, enforcement-flip policy, tenant-config model and reconciler best practices all landed; **plan fees, allowances and BOTH price planes are RATIFIED and SEEDED** (book `2026-08-08-commercial-v1`), and provider-aware rating is implemented. Remaining: provider reconcilers (blocked on credentials) and revisiting the ~90% self-hosted utilization assumption against measured data. |
| **Type** | feature (billing/pricing) + infrastructure (enforcement) + docs (reconciler & tenant-config best practices) |
| **Created** | 2026-08-08 |
| **Supersedes / closes** | TASK-615 §7 owner tail #1 (SELL prices), #2 (allowances), #3 (enforcement flip), #14 (reconcilers) |
| **Companion** | [reference-pricing-model.md](./reference-pricing-model.md) — the researched provider pricing tables + the derived COST/SELL rate card |

---

## 1. Requirement Analysis

Five owner asks from the TASK-615 tail, now unblocked:

1. **A way to SET/configure SELL prices** (not just the read-only view shipped in TASK-615 #15).
2. **A reference pricing model**: (a) current AI/LLM provider pricing (researched), (b) a self-hosted COGS formula over CPU/GPU/RAM/disk/electricity, (c) a SELL/markup formula for revenue.
3. **Per-plan allowance ceilings** derived from the plan + pricing model.
4. **Enforcement flip**: meters + entitlements **ON** in every *deployed* environment (`hope-v2-dev`, staging, production) and **OFF** only in *local* development.
5. **Provider reconciler best practices**, plus a written contract for the tenant-configuration model (Global-tenant playground → SYSTEM-tenant shared defaults → tenant BYOK).

---

## 2. The tenant-configuration model (answering #5's clarification — matches the code)

Verified against `ai-provider-connection.service.ts` (resolution precedence at L229–233) and the seed's reserved tenant ids. There are **three** tenant roles in provider/config resolution:

| Tenant | UUID prefix | Role |
|---|---|---|
| **Global** | `50000000-…` | The super/global admin's **playground**. A GLOBAL_ADMIN selects it as the working tenant to configure a provider, test agents, dry-run a pipeline. Nothing here is authoritative for other tenants — it is a scratch space. |
| **SYSTEM** | `00000000-…` | The **shared platform default**. An `AiProviderConnection` (or `AiTaskDefault`, `HarnessPolicy`, `AiPriceBook` COST/SELL row) owned by SYSTEM is the default/fallback every tenant reads. E.g. the SYSTEM Azure-OpenAI connection is the default LLM for summarization/text-generation across all tenants. |
| **A customer tenant** | (its own id) | May **bring its own key (BYOK)**: a tenant admin creates an `AiProviderConnection` for its own tenant, which **overrides** the SYSTEM default *for that tenant only*. |

**Resolution is `tenant → SYSTEM → fail-closed`** (the exact `Promise.all([findByTenant…, findBySystem…])` at `ai-provider-connection.service.ts:229–233`; provider/model SELECTION fails closed with 503, never a silent env fallback — `06-python-services.md` §per-tenant config).

**The promotion workflow the owner described is therefore:**
1. GLOBAL_ADMIN configures + validates a provider under the **Global** playground tenant.
2. Once proven, the connection is **promoted to SYSTEM** (re-created/owned by `00000000-…`) → it becomes the shared default/fallback for every tenant.
3. A tenant that wants its own provider adds a **BYOK** connection under its own id → it wins over SYSTEM for that tenant.

**BYOK cost ownership (D14, already implemented):** a BYOK call runs on the *tenant's* provider account, so the tenant funds and manages that cost directly. The platform still **meters** BYOK usage (for the tenant's own visibility) but stamps `costBasis: BYOK_NOTIONAL` — it is **zero-rated on the invoice** (the plan fee is the platform fee; there is no token markup on BYOK). Only **CLOUD** (platform-funded) usage is billed and reconciled against provider bills (§6).

> Gap to close (out of this ticket's core, flag): promotion is manual re-creation today. A one-click "promote Global → SYSTEM" action on the provider screen is a small follow-up.

---

## 3. Reference pricing model — the formulas

The researched provider numbers live in [reference-pricing-model.md](./reference-pricing-model.md). This section is the **parameterized model** the owner tunes; every symbol is a knob, so re-pricing is changing a number, not the shape.

### 3.1 COST plane — what a unit costs the platform

**(a) Third-party / cloud providers** — COGS is just the provider's list price for the unit (input token, output token, cache read/write, audio-second, character), converted to integer micros. These land as **COST-plane rows keyed by `(capability, provider, model, unit)`** in `AiPriceBook`; the at-ingest rater already stamps `costMicros` from them. Re-pricing = superseding the COST row when the vendor reprices.

**(b) Self-hosted (whisper.cpp, vLLM, Kokoro, …)** — COGS is amortized infrastructure ÷ billable throughput:

```
                 (GPU_hourly × overhead)                    amortized capex + electricity + colo/ops
cost_per_unit = ───────────────────────────   where  GPU_hourly = ─────────────────────────────────────  (owned HW)
                 throughput × 3600 × util                            (or simply the cloud GPU rental $/hr)

  GPU_hourly   $/GPU-hour. Cloud rental bundles power+capex. Owned HW (below) unbundles it.
  overhead     multiplier for the non-GPU server share: CPU, RAM, disk, network, k8s/ops.  ~1.3–1.6.
  throughput   billable units a GPU produces per SECOND at full load:
                 · LLM  → tokens/sec (vLLM aggregate)         · STT → audio-seconds/sec (whisper RTFx)
                 · TTS  → characters/sec                       · EMB → tokens/sec
  util         fraction of the paid GPU-hour actually serving billable work (idle time is still paid).
               A clinical duty cycle is bursty → util ≈ 0.3–0.6. LOWER util ⇒ HIGHER cost/unit.
  3600         seconds per hour.

Owned-hardware GPU_hourly = capex_amortized + electricity + colo_ops
  capex_amortized = purchase_price / (life_years × 8766 h)         e.g. $30k H100 / (3y × 8766) ≈ $1.14/h
  electricity     = (server_watts / 1000) × PUE × price_per_kWh    e.g. 1.0 kW × 1.5 PUE × $0.12 ≈ $0.18/h
  colo_ops        = rack/network/labour share per GPU-hour         e.g. ≈ $0.20–0.40/h
```

The two forms are interchangeable — cloud rental is the owned-HW formula pre-summed by the cloud vendor. Use whichever the deployment actually pays. The researched throughput/RTFx/$-per-hour inputs (and the resulting `$/token`, `$/audio-second`) are in the companion doc; the seeded self-hosted COST rows are derived there and assume `util ≈ 0.9` — the optimistic end of the 0.3–0.6 clinical range this very formula warns about.

### 3.2 SELL plane — what the tenant pays

Two components, both `SELL`-plane rows in `AiPriceBook`:

```
SELL_unit  = COST_unit / (1 − target_gross_margin)          (cost-plus to a margin target)
           = COST_unit × markup_multiple                     (equivalent; M = 1/(1−GM))

  target_gross_margin  the platform's blended gross-margin goal. AI-SaaS norm ≈ 70–80%.
                       GM 0.75 ⇒ M = 4.0×;  GM 0.70 ⇒ 3.33×;  GM 0.80 ⇒ 5.0×.
  Overage rate         = SELL_unit at parity, or +≤15% premium per tier (D12). Soft caps for paid tiers.

PLAN_FEE_tier = fixed_platform_fee + bundled_allowance_value
  fixed_platform_fee   support, availability, R&D, the "platform" a tenant pays for regardless of usage.
  bundled_allowance    the included monthly allowances (§4) valued at SELL rates and pre-paid in the fee.

Revenue(tenant, month) = PLAN_FEE_tier + Σ_capability max(0, usage − allowance) × overage_rate − credit_memos
Gross profit           = Revenue − Σ metered COST (INTERNAL basis only; BYOK excluded)
```

The invoice engine already computes exactly this (`computeDraft`: prorated plan fee + pooled per-capability overage crossing, HALF-UP per line — TASK-615 WS-I). This ticket only supplies the **rows** it reads.

> **Ratified 2026-08-08:** `target_gross_margin = 80%` → **markup M = 5×** on all metered lines (companion §3/§5 recomputed at 5×). Still owner-pending: the `fixed_platform_fee` values (owner will supply new per-tier numbers — was STARTER $199 / PRO $999), any per-tier overage premium, and the allowance intensity constants. Nothing is seeded to production until those land.

---

## 4. Plan allowances (#3) — derived from the existing matrix

The plan matrix already exists (`seed/15-entitlements.ts`, mirrored in `entitlements.constants.ts`): `STARTER → TRIAL → PRO → ENTERPRISE`, with **business** ceilings seeded (`monthlyConsultations`, `monthlyTranscriptionMinutes`, `monthlySummaries`) but the **per-capability** ceilings (`monthlySttSessionSeconds`, `monthlyLlmTokens`, `monthlyTtsCharacters`, `monthlyNlpTextUnits`, `monthlyEmbeddingTokens`) seeded `NULL` (= unlimited, TASK-615 D11).

**Derivation rule** (proposal): translate the already-set business ceilings into per-capability unit ceilings using per-consultation intensity constants, then round to a clean bound:

```
monthlySttSessionSeconds ≈ monthlyTranscriptionMinutes × 60 × session_overhead   (session ≥ audio)
monthlyLlmTokens         ≈ monthlySummaries × avg_tokens_per_summary             (in+out, all summary passes)
monthlyTtsCharacters     ≈ monthlyConsultations × avg_tts_chars_per_consultation
monthlyNlpTextUnits      ≈ monthlyConsultations × avg_ner_text_units
monthlyEmbeddingTokens   ≈ monthlyConsultations × avg_embed_tokens_per_consultation
```

**RATIFIED + SEEDED 2026-08-08:** STARTER **$50/mo · 50 consultations**, PRO **$100/mo · 250 consultations**, ENTERPRISE **negotiated / unlimited** (TRIAL stays the free 1-week PRO window). The derived per-capability ceilings carry **×2 headroom** on purpose — `monthlyConsultations` is the commercial cap, so these exist as *runaway guards*, not a second business ceiling, which matters now that enforcement defaults ON in deployed environments (§5). Full table + the margin check: [reference-pricing-model.md §6](./reference-pricing-model.md).

**Margin posture — RESOLVED 2026-08-08.** Both fees are healthy on **self-hosted** infrastructure (93–97% gross margin), but PRO collapses to ~7% if its traffic falls back to **managed Azure** (negative at a 30-min average consultation). Owner decision: **keep the SYSTEM default self-hosted and sell managed ASR as an add-on** — fees unchanged.

The seed already satisfied that posture (self-hosted default pipeline · SYSTEM managed-ASR connections disabled and key-less · no SYSTEM fallback pipeline), so the exposure was latent rather than active. All three invariants are now locked by `packages/database/src/prisma/db_main/seed/__tests__/managed-asr-addon-posture.test.ts`.

**The add-on now carries its margin — allowance allocation is SELF-HOSTED-FIRST** (owner, 2026-08-08). Order: `SELF_HOSTED → BYOK → CLOUD`. The bundled allowance absorbs the cheap self-hosted usage, so platform-funded managed usage is what spills into overage, where a provider-keyed premium row (`azure-speech` at 1,390µ = 5× its 278µ COST) recovers the COGS. BYOK sits in the middle: it costs the platform nothing, so it must not displace self-hosted from the allowance — and it resolves the **provider-agnostic baseline**, never the premium, because a premium recovers platform COGS the platform did not bear on a tenant's own key.

This changes attribution only — total overage stays `max(0, total − allowance)` under any ordering, re-proven by the property test across all three tiers. Getting there needed a rollup grain change (`deployment`, migration `20260808120000_…`), `provider`+`deployment` threaded through billable usage *and* the compensation aggregate, and tiered consumption in the pure engine. Companion §6.3.

---

## 5. Enforcement flip (#3) — deployed ON, local OFF

**Current policy (to change):** the seed default is env-driven (`ENTITLEMENTS_ENABLED_DEFAULT` / `METERING_RECONCILE_ENABLED_DEFAULT`), but wired so **local `.env.dev` = ON** and **deployed/prod = OFF** — the inverse of what is wanted.

**New policy:** enforcement + reconcile default **ON in every deployed environment** (`hope-v2-dev`, staging, production) and **OFF only in local development** (developer laptops) and test/CI.

| Environment | `ENTITLEMENTS_ENABLED_DEFAULT` / `METERING_RECONCILE_ENABLED_DEFAULT` | Result |
|---|---|---|
| **Local dev** (laptop, `pnpm setup:dev`) | unset / `false` (committed `.env.sample` default) | OFF — a developer never fights quota locally |
| **Test / CI** | unset | OFF — the shared E2E baseline stays deterministic |
| **`hope-v2-dev` cluster** | `true` (host env / deploy overlay) | ON |
| **Staging** | `true` (host env) | ON |
| **Production** | `true` (host env) | ON |

**Implementation (LANDED):**
- In-repo: the committed local default stays `false` (local OFF). The **authoritative policy text** is corrected at its SOURCE — the two settings-registry descriptors that env-sync copies verbatim into the generated `.env.sample` files: `metering.descriptors.ts` (`metering.reconcile.enabledDefault` + its header) and `feature-flags.descriptors.ts` (`entitlements.enabledDefault`) — plus the `seed/15-entitlements.ts` comment block and one test comment. The generated `.env.sample` / `apps/api/.env.sample` regenerate from these on the next `pnpm env:sync` (the tree is currently env-sync-dirty from a concurrent observability change; that session's sync will pick up this policy text too — I did **not** run env:sync to avoid entangling their Loki work). The runtime kill-switch (`entitlements.enabled` / `metering.reconcile.enabled` GlobalSetting) is unchanged — an operator can still flip live via `PUT /admin/entitlements/enabled`.
- **The mechanism was already correct** — the committed default is `false` (local OFF) and any deployed env sets `=true` (ON). Only the *documentation* described the inverse (it said prod OFF); this ticket corrects that so the policy is authoritative and discoverable. No functional/schema change was needed.
- Deploy side (the external `hope-deployments` repo / k3s overlays own the host env): the `db-migrate` PreSync Job **and** the API/worker pods in each deployed overlay set both vars to `true`. The Job's env drives the fresh-DB seed default; the pods' env is belt-and-braces for any code that reads the default. This ticket documents the exact vars; the values live in the deploy repo (this repo has no committed cluster manifests since 2026-07-24).

> **Owner action (deploy repo):** add `ENTITLEMENTS_ENABLED_DEFAULT=true` and `METERING_RECONCILE_ENABLED_DEFAULT=true` to the host env of the `hope-v2-dev`, staging, and production overlays (both the `db-migrate` Job and the api/worker pods). That is the only remaining step to make enforcement live in deployed environments.

---

## 6. Provider usage-reconciler best practices (#14)

The reconciler INTERFACE + stubs already exist (TASK-615 WS-K, `metering/reconciliation/provider-reconciler.ts`). Best-practice contract to implement per provider once credentials exist:

1. **Read-only, org-level credentials.** Each reconciler needs a provider *usage/cost* API key with the narrowest read scope (OpenAI Usage API, Anthropic Usage & Cost, Azure Cost Management + Monitor, Bedrock via CUR/Cost Explorer). Store in Vault kv-v2 like every platform secret; never per-tenant.
2. **Reconcile CLOUD only, never BYOK.** BYOK usage bills on the *tenant's* account — the platform has no visibility and no need. Scope the reconciler to `costBasis: INTERNAL` rows.
3. **Grain = (provider, model, day).** Compare the ledger's daily rollup sum to the provider's reported usage at the coarsest grain both expose; finer grains rarely align.
4. **Respect reporting lag.** Provider usage settles at T+1..T+3 days. Reconcile a **trailing window** (e.g. yesterday-minus-2 through yesterday-minus-1), never "today".
5. **Drift threshold + alert, don't auto-correct.** Emit `metering.provider-drift-detected` when |ledger − provider| / provider > threshold (2%, matching the shadow-metering job). A human investigates; the append-only ledger is corrected only by a *compensating event*, never a mutation (D13 evidence integrity).
6. **Store each run as an audit record** (period, provider, ledger total, provider total, drift, verdict) — this is the financial control that lets an invoice dispute be answered.
7. **Fail open.** A reconciler that can't reach the provider API logs and skips — it must never block metering or billing (same posture as the at-ingest rater).

---

## 7. SELL-price configuration interface (#1)

**Backend already exists:** `admin/billing/rate-card` — `GET` (list), `POST` (create a SELL row), `POST /:id/supersede` (If-Match OCC close-old + insert-new). Supersede-only, GLOBAL_ADMIN, effective-dated (a past invoice stays reproducible). This is the correct write surface; nothing new is needed server-side.

**Console: DONE.** TASK-615 #15 shipped the rate-card tab read-only; it is now **writable** — each OPEN row carries a `Supersede` action (`supersede-rate-dialog.tsx`), closed history rows carry none. The dialog only reprices: capability/unit/provider/plan tier are shown read-only because the server inherits them. If-Match carries the version from the list read (428/412 via the shared `OccConflictAlert`), the price is stated in both micros and currency before submit, submit is disabled until price + date + book version are all present, and a non-integer-micros price is rejected client-side. The form never pre-fills a price and remounts per row by `key`.

Alternatively (or additionally) the derived rate card from the companion doc is applied once via a **seed/migration** (superseding the `2026-08-06-placeholder-v1` rows) so a fresh environment comes up on the ratified card without hand-entry.

---

## 8. Implementation Plan

1. **Design + formulas** (this doc) + **research tables** (companion) — the pricing model. ← in progress
2. **Enforcement flip** — correct the local-OFF/deployed-ON policy (seed comment + `.env.sample` guidance) + document the deploy-side vars. Low-risk config/doc. ← concrete, do now
3. **Ratify** the margin, plan fees, overage premium, and allowance intensity constants with the owner.
4. **Seed** the ratified COST + SELL rate card (supersede placeholders) and the per-plan allowance ceilings (fill the `PLAN_ENTITLEMENT_DEFAULTS` NULLs).
5. **Rate-card editing UI** (make the console tab writable via the existing supersede endpoint).
6. **Provider reconcilers** — implement per-provider against the §6 contract as credentials land.

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-08 | **Ratified rate card SEEDED** — book `2026-08-06-placeholder-v1` → **`2026-08-08-commercial-v1`**, 42 rows (26 COST · 4 PLAN_FEE · 12 SELL), placeholder markers gone. Seeding surfaced two defects in the companion doc's own §5 table, both fixed: **STT AUDIO_SECOND was 0µ** (OQ1 bills BATCH transcription on that unit — it would have made batch transcription free), and **REASONING_TOKEN had no SELL row** (all token kinds pool into `monthlyLlmTokens` and the engine fails closed, so one reasoning token in overage would have aborted the whole draft). Added managed COST rows for azure gpt-4.1-mini, anthropic Sonnet (incl. cache read/write) and openai embeddings. Applied to the live dev DB by clearing the unreferenced placeholder rows (0 invoices, 0 lines, 0 usage events) and re-seeding; verified through the running console. **Self-hosted COST is seeded at ~90% GPU utilization — the optimistic end**; at the 0.3–0.6 clinical duty cycle the model predicts, COGS is 1.5–3× higher and reported margin is flattered. Each row carries the scaling in its note. |
| 2026-08-08 | **Local dev database reset and migrated.** It had never been on the migration track — no `_prisma_migrations` table at all, `db push`-managed, 77 of 84 model tables. `prisma migrate reset` (explicit owner consent; `pg_dump` taken first) replayed all **78 migrations cleanly**, which is the first end-to-end proof that history is coherent. Verified after: 86 core tables, `AiUsageRollupDaily.deployment` present defaulting `SELF_HOSTED`, the unique index carrying `deployment` in position, and two rollup rows differing only by deployment coexisting (inserted + rolled back). Re-seeded with `RUN_SEED=all`: the ratified plan matrix is live (STARTER 50 / PRO·TRIAL 250 / ENTERPRISE ∞), plan fees $50 / $100, and both managed-ASR SELL rows at 1,390µ. **Rate-card editing UI DONE** (§7) — the last non-blocked item. |
| 2026-08-08 | **Provider-aware rating IMPLEMENTED** — owner chose **self-hosted-first** allowance allocation, so the managed-ASR add-on now carries its margin instead of being subsidised at the self-hosted rate. Order `SELF_HOSTED → BYOK → CLOUD`; BYOK resolves the baseline, never the premium (it costs the platform nothing). Required: `deployment` on the rollup grain (migration `20260808120000_task_638_rollup_deployment_dimension`, drainer, unique tuple); `provider`+`deployment` threaded through `DayUnitSum`/`DailyUnitQuantity` **and** the `sumDailyQuantitiesByOperation` aggregate (the tests caught that a mismatched key makes the D16/OQ1 deductions cancel the wrong bucket); tiered consumption in `computeCapabilityOverage` with pro-rata `(unit, provider)` split; provider-keyed SELL rows for `azure-speech` at 1,390µ. Attribution-only change — the property test now varies deployment across all three tiers and re-proves `total overage = max(0, total − allowance)`. Mutation-verified: reversing the tier order drops managed overage to the 500µ baseline and fails the guard. |
| 2026-08-08 | **Managed-ASR posture RESOLVED** (owner): SYSTEM default stays self-hosted, managed ASR is an add-on; fees unchanged. Audit found the seed already correct on all three invariants (self-hosted default pipeline · SYSTEM managed-ASR connections disabled + key-less · SYSTEM `fallbackPipelineId` NULL) — the exposure was latent, not active — so the work was to LOCK it: extracted `SYSTEM_TENANT_STT_CONFIG` as a data export (mirroring the TTS pattern) and added `seed/__tests__/managed-asr-addon-posture.test.ts`, mutation-verified. Also documented a real blocker (§6.2): `prefetchSellRates` resolves SELL rates with `provider: null` hard-coded, so a provider-keyed premium row would be dead config — the add-on is BYOK-only until rating becomes provider-aware, which first needs an allowance-allocation decision (#8). |
| 2026-08-08 | **Plan fees + allowances RATIFIED and SEEDED.** STARTER $50/mo · 50 consultations; PRO $100/mo · 250 consultations; ENTERPRISE negotiated/unlimited (business ceilings → `null`, structural caps unchanged). Per-capability allowances derived (§6) with ×2 runaway-guard headroom and seeded on STARTER/TRIAL/PRO. Files: `seed/20-ai-price-book.ts` (PLAN_FEE rows), `seed/15-entitlements.ts` + `entitlements.constants.ts` (the two hand-synced copies of the matrix), and the two entitlements test suites whose assertions encoded the old numbers. Margin check added (§6.1) — it surfaced a NEW open decision: PRO is ~7% margin if its traffic routes to managed Azure instead of self-hosted. Markup ratified at 80%/5× (owner). SELL per-unit rate card + self-hosted COST rows remain unseeded pending decisions #3/#5. |
| 2026-08-08 | Ticket created from the TASK-615 §7 owner tail (#1/#2/#3/#14). Design + COGS/SELL formulas + tenant-config model + reconciler best-practices authored; researched pricing tables + derived COST/SELL rate card + per-plan allowance proposal in the companion doc. **Enforcement-flip policy corrected at source and LANDED**: the two settings-registry descriptors (`metering.reconcile.enabledDefault`, `entitlements.enabledDefault`), the `seed/15-entitlements.ts` comment block, and one test comment now state the correct policy (ON in every deployed env — hope-v2-dev/staging/production; OFF only in local dev + test/CI). The committed default was already `false` (local OFF) and the mechanism already correct — only the docs described the inverse. Did NOT run `pnpm env:sync` (tree is env-sync-dirty from a concurrent observability change; that session's sync will regenerate the `.env.sample` files including this policy text). SELL prices + allowance ceilings remain proposals pending owner ratification before any seed. |
