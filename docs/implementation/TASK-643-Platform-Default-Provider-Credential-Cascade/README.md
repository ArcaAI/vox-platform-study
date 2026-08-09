# TASK-643 — Wire the platform-default (SYSTEM-tenant) provider credential into the injection resolver

| Field | Value |
|---|---|
| **Status** | `Pending` — plan only, no code written. Awaiting the Phase 3 approval gate (`01-development-workflow.md`). |
| **Type** | `bugfix` (with a **blocking** billing-attribution sub-task that is functionally a `feature`) |
| **Raised from** | 2026-08-09 — TTS review under TASK-642; the defect is not TTS-specific |
| **Blocks** | TASK-642 Step 4 (Malayalam routing needs a working platform cloud credential) |
| **Related** | TASK-569/572/576 (unified provider plane), TASK-524 (SYSTEM connection seed), TASK-578 OD-1 (seed-authoritative Day-1 posture), TASK-602 (env credential fallback removed — the reason the gap is now load-bearing), TASK-615 (usage metering), TASK-638 (allowance ordering + BYOK baseline rating) |
| **Owner decisions** | OD-1 … OD-7 **ALL DECIDED 2026-08-09** (§5). **Plan APPROVED for implementation.** OD-6 → *honour* the kill switch AND flip `entitlements.enabled` on first, which adds a **pre-flight audit** as a hard prerequisite: turning that switch on activates every other quota check at the same time, so any tenant already over an unenforced limit starts receiving 409s. OD-7 → `false` on all four plans, granted per tenant |

---

## 0. ⚠ Read first — four things the OD-3 entitlement gate collides with

The owner chose an **entitlement gate**: a tenant may consume the platform-default
credential only if an explicit per-tenant or per-plan entitlement grants it. That is
buildable on the existing entitlements plane, but four facts about that plane change
what "gate" means here, and three of them are load-bearing enough that the owner
should see them before approving. All four were verified against the working tree on
2026-08-09.

**(1) The entitlements kill switch defaults OFF, so a conventional gate is a no-op today.**
`entitlements.enabled` (`entitlements.constants.ts:25`, default
`ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT = false` at `:69`) is checked **first in every
enforcement method** — `assertQuantityQuota:214`, `assertMeterQuota:251`,
`assertConcurrencyQuota:266`, `evaluateStorageSoftWarn:354` all return early when it
is off. If this gate follows that convention, then on `hope-v2-dev` (switch off) the
gate grants everyone the platform default and provides **zero** commercial
containment — the exact exposure OD-3 was chosen to close. If the gate ignores the
switch, it becomes the **first** enforcement path in the system that a global admin
cannot turn off in an incident. There is no third option. **This is OD-6 and it must
be answered before §3.5 is built.**

**(2) A boolean entitlement is enforced nowhere today — this would be the first.**
`PlanEntitlement` / `TenantEntitlement` already carry three booleans
(`featureDnaReports`, `featureVoiceEnrollment`, `featureMonitoringAccess`;
`entitlement.prisma:99-101` and `:169-171`), resolved into `ResolvedFeatures`
(`resolve-entitlements.ts:48-52`) with a proper tri-state tenant override. But a
repo-wide search finds **zero enforcement call sites** — every one is display-only,
read only by `getCapabilities`, the SDK's `useEntitlements`, and the console. There
is **no `assertFeature` / `isFeatureEnabled` method on `IEntitlementsService`**. The
schema, DTOs, admin CRUD and even the HTTP mapping (`exception.interceptor.ts:331`,
`capability.startsWith('feature') → 403`) are pre-wired and unused. So the shape is
proven; the enforcement is new work, and this ticket owns writing the first one.

**(3) `UNGATED_ENTITLEMENTS` grants every boolean feature `true`.**
`resolve-entitlements.ts:145` gives a null-plan ("ungated-legacy") tenant
`features: { dnaReports: true, voiceEnrollment: true, monitoringAccess: true }`. A new
boolean added by copying the neighbours therefore **grants the platform default to
every ungated tenant automatically** — precisely inverted from a fail-closed gate.
The new member must be the first in that object to resolve `false`, breaking the
"ungated ⇒ everything on" symmetry that the surrounding code teaches. It needs a
comment and a test, or the next reader will "fix" it.

**(4) The plan matrix's two copies have no drift guard at all.**
Confirmed by search: **no test imports both copies.** `seed/15-entitlements.ts:25-28`
states the sync is manual ("the database package must not depend on
`@arcaai/applications`"); `00-constants.ts:706-710` repeats it. The TASK-638
"seed-invariant guard" is `seed/__tests__/managed-asr-addon-posture.test.ts`, which
locks the self-hosted-ASR posture — **not** matrix agreement. Adding a per-plan field
today is two hand edits with nothing catching a mismatch, and the mismatch would be
silent (seed writes the DB, the constant is only the resolver fallback, so they
diverge only for tenants whose row is missing). §3.5.7 proposes closing this.

**Honest verdict on the tier contract.** `09-infrastructure-devops.md` §Configuration
Tiers says the `entitlement` tier holds "plan/tier CEILINGS — bounds what a tenant may
set; never supplies a value". A boolean "may consume the platform default" grant
**supplies no value** — the credential still comes from `AiProviderConnection`; the
entitlement only bounds whether the SYSTEM tier is in this tenant's cascade. It fits
the letter of the contract, exactly as `featureDnaReports` does. What it strains is
the *practice*: every existing entitlement is either a number or a display-only flag,
and `failMode` on all three existing feature descriptors is `open-to-default`
(`settings-registry/descriptors/entitlements.descriptors.ts:29-51`), whereas this one
must be `closed`. That is a difference the owner should know about, not a blocker.

---

## 1. Requirement Analysis

`AiProviderConnection` is designed as a **two-tier** credential plane: a tenant's own
BYO row, over a SYSTEM-tenant (`00000000-0000-0000-0000-000000000000`) **platform
default** that serves tenants which have not brought their own key. Three
independent places in the codebase state that this is how it works:

- `packages/database/src/extensions/tenant-scope.ts:305-321` — *"Every tenant's
  `resolveConnection` cascade (tenant row → SYSTEM row → env) runs under tenant CLS
  at request time and would otherwise read nothing."*
- `packages/applications/src/services/ai-provider-connection/IProviderConnectionService.ts`
  — the `resolveConnection` doc-comment: *"ENABLED tenant row → ENABLED SYSTEM row → null."*
- `apps/tts/src/tts/providers/azure_speech.py:41-43` — *"The platform default and
  per-tenant keys both arrive as a request `provider_override`."*

**The tier was never wired into any production path.** The single resolver that
production actually calls reads the caller's tenant only. This ticket wires it,
and — because "the tenant has a credential row" is currently the de-facto signal
that a call is BYOK — it must simultaneously fix usage attribution so a
platform-funded call is not silently rated and invoiced as if the tenant paid the
vendor.

### Classification of the requirement

| # | Requirement | Kind |
|---|---|---|
| R1 | A tenant with no row for a cloud provider resolves the SYSTEM row's credential | bugfix |
| R2 | A tenant's own row always beats the SYSTEM row; a tenant's row is never visible to another tenant | invariant (must not regress) |
| R3 | A call served by the SYSTEM (platform-paid) credential is metered as `CLOUD` + `INTERNAL`, **never** `BYOK`/`BYOK_NOTIONAL` | **merge blocker** — see §2.4, §3.3 (OD-2 decided: `CLOUD`) |
| R4 | A tenant can refuse the platform default (PHI / shared-vendor-account posture), per (service, provider), failing **closed** | **merge blocker** — §3.4 (OD-1 decided: option (a), disabled tenant row = VETO) |
| R5 | The behaviour change on the SMR and STT paths is deliberate and evidenced, not incidental | risk control — §2.5 |
| R6 | A tenant consumes the platform default **only** with an explicit per-tenant or per-plan entitlement; without it the SYSTEM tier is invisible and the call fails closed with an attributable 403 | **merge blocker** — §3.5 (OD-3 decided: entitlement gate) |

**Not in scope:** changing which *provider/model* is selected (that is
`AiTaskDefault` / `TenantSttConfig` / `TenantTtsConfig` territory), changing the
seed's disabled-by-default posture, and the four duplicated `SELF_HOSTED_*`
allow-lists noted in §2.4 (worth a separate ticket).

---

## 2. Current State Evaluation

Verified against the working tree on `dev-2.1`, 2026-08-09. Line numbers are from
that state.

### 2.1 The resolver that production calls does not cascade

`AiProviderConnectionService.resolveTenantCloudOverrides`
(`packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts:260-303`)
is the **only** injection resolver on any production path. Its read is:

```ts
const tx = this.crossTenantLane(tenantId);
const rows = await this.connectionRepository.findByTenantIdAndService(service, tenantId, tx);
```

`AiProviderConnectionRepository.findByTenantIdAndService`
(`packages/domains/src/repositories/generated/core/AiProviderConnectionRepository.ts:111-124`)
builds:

```ts
const where = { tenantId, service, resourceStatus: ResourceStatusType.ENABLED };
```

— an **explicit** `tenantId`.

`AiProviderConnection` *is* in `SYSTEM_SHARED_READ_MODELS`
(`tenant-scope.ts:321`), but `mergeSharedReadTenantIntoWhere`
(`tenant-scope.ts:635-648`) only injects `tenantId IN [caller, SYSTEM]` **when the
caller supplied no `tenantId` at all**; an explicit one is validated and passed
through verbatim. So the widening never fires here and the SYSTEM row is never
returned. The widening is doing its job — the query is simply not shaped to
benefit from it.

**One important consequence of that same code, which the fix depends on:** an
explicit `tenantId: SYSTEM_TENANT_ID` is *permitted* from any tenant's CLS (the
allowed set is exactly `[caller, SYSTEM]`). A second, explicitly SYSTEM-pinned
read therefore needs no elevated client and no repository change.

### 2.2 The cascade that exists has zero production callers

`resolveConnection(service, provider, tenantId)`
(`ai-provider-connection.service.ts:228-241`) implements the tenant→SYSTEM cascade
correctly, including the "a DISABLED row counts as absent" rule. A repo-wide
search finds it referenced only by the interface, the compiled `.d.ts`, and two
seed comments. It is dead code that documents the intent.

It is also **provider-keyed** (`service, provider, tenantId`), whereas every
production call site needs the **whole map for a service**. That shape mismatch is
why it was never adopted, and it is why "just call `resolveConnection` from the six
sites" is the weakest of the three options in §3.1.

### 2.3 `crossTenantLane` — what it does, and why widening what it reads matters

```ts
/** See `AiTaskDefaultService.crossTenantLane` for the full rationale. */
private crossTenantLane(targetTenantId: string): CoreDatabaseService['baseClient'] | undefined {
  if (targetTenantId !== this.tenantId && isSuperAdmin(this.requestUser)) {
    return this.databaseService.baseClient;
  }
  return undefined;
}
```
(`ai-provider-connection.service.ts:420-426`)

It returns the **UNSCOPED base client** — the one that bypasses *both* the
tenant-scope extension and the soft-delete filter — but only when **(a)** the
target tenant differs from the caller's CLS tenant **and (b)** the caller is a
global admin. Otherwise it returns `undefined` and the repository falls back to
`this.findAll(...)` on the extended client, where the tenant-scope extension is
authoritative.

It exists for the admin console: a global admin acting under working tenant `W`
must be able to read and write SYSTEM rows and foreign-tenant rows, which the
extension would otherwise reject (`mergeTenantIntoWhere` throws on a mismatch).

**Why this is the central safety fact for this ticket.** On the base-client lane,
*the only thing keeping the query inside one tenant is the explicit `tenantId` in
the `where`*. Any change that removes or loosens that predicate in
`findByTenantIdAndService` becomes, for a global-admin caller, an unrestricted
cross-tenant read of a **secret-bearing** table — every tenant's ciphertext, and
(because the base client also skips the soft-delete filter) their tombstones too.
That is the argument against the repository-layer option in §3.1.

For an ordinary tenant caller, `crossTenantLane` returns `undefined`, so a second
read pinned to `SYSTEM_TENANT_ID` goes through the extended client and is accepted
by `mergeSharedReadTenantIntoWhere` — the mechanism the widening was added for.

### 2.4 ⚠ BLOCKING — billing attribution is decided by "did this request carry provider_overrides"

This is the part of the change that cannot be shipped as a footnote.

**No metering code queries `AiProviderConnection` at all.** Every lane infers BYOK
from the *presence of an override on the request*:

| Lane | Deciding code | Rule |
|---|---|---|
| STT (batch + streaming) | `apps/stt/src/stt/transcription/batch_service.py:70-112` `resolve_usage_attribution` | `is_byok = asr_format in _CLOUD_ASR_OVERRIDE_FORMATS and bool(provider_overrides)` — **dict truthiness**, not even key-specific |
| SMR / LLM | `apps/smr/src/smr/api/endpoints/generate.py:158-166` `_used_byok_credential` | `overrides is not None and request_body.provider in overrides` |
| TTS (HTTP) | `apps/api/src/modules/speech/speech-proxy.controller.ts:238-250` `classifyTtsProvider` | `provider in providerOverrides` → `BYOK` + `BYOK_NOTIONAL` |
| TTS (WS) | `apps/api/src/modules/speech/tts-ws.gateway.ts:424-434` | identical duplicated copy |

Downstream, `deployment`/`costBasis` drive real money:

- `packages/applications/src/services/usageLedger/usage-outbox.drainer.ts:202-205` —
  `costMicros` contributes **0** to platform-cost aggregates when
  `costBasis === BYOK_NOTIONAL`. Platform COGS on SYSTEM-key calls would vanish.
- `packages/applications/src/services/billing/invoice-math.ts:89-94` —
  `DEPLOYMENT_ALLOWANCE_ORDER = [SELF_HOSTED, BYOK, CLOUD]`. Misattributed usage
  consumes allowance in the *middle* tier, displacing genuinely-CLOUD usage into
  overage — attribution moves, and with per-provider premium rows the invoice total
  moves too.
- `packages/applications/src/services/billing/billing.service.ts:567-580` — BYOK
  deliberately resolves the **provider-agnostic baseline** SELL price, *"because a
  premium recovers platform COGS the platform did not bear on a tenant's own key."*
  On a SYSTEM key the platform **does** bear it.
- TASK-615 D14 (`docs/implementation/TASK-615-Usage-Metering-And-Billing/README.md:181-183`):
  BYOK is *"metered fully, rated notionally, invoiced [plan fee only]"* — i.e. **not
  invoiced**.

**Therefore:** wiring the cascade without touching metering converts every
platform-funded cloud call into a zero-COGS, baseline-rated, never-invoiced BYOK
event. It is a direct revenue leak *and* it blinds the COGS plane, and nothing in
the system would raise an error — the shadow-metering reconciliation
(`services/metering/reconciliation/shadow-metering.service.ts:431-438`) filters to
CLOUD, so the misattributed events drop out of the very check that would notice.
The one guardrail that exists
(`usageLedger/usage-ledger.service.ts:98-115`) warns when `deployment === BYOK` and
`costBasis !== BYOK_NOTIONAL` — the *consistent-but-wrong* pair we would produce
does not trip it.

R3 is consequently a **hard prerequisite for merging R1**, not a follow-up.

Secondary observation (not caused by this ticket, made worse by it): the STT rule
is `bool(provider_overrides)` on the *whole dict*. Once the gateway starts sending
SYSTEM-sourced entries, an override map containing an unrelated provider marks a
cloud ASR call BYOK. The predicate must become key-specific regardless of how R3 is
solved.

### 2.5 Blast radius — the six production call sites

The change is **not** TTS-only. All six go through the non-cascading resolver.

| # | Call site | Service | Today, for a tenant with NO row | After the cascade (assuming an ENABLED, keyed SYSTEM row exists) |
|---|---|---|---|---|
| 1 | `apps/api/src/modules/speech/tts-ws.gateway.ts:226` | `tts` | `{}` → no `provider_overrides` in the `init` frame → Azure/Sarvam TTS unusable; only self-hosted (`kokoro`, `indic_parler`) can serve | Cloud TTS becomes reachable on the platform key — **this is what unblocks TASK-642 Step 4 (Malayalam)** |
| 2 | `apps/api/src/modules/speech/speech-proxy.controller.ts:106` | `tts` | same; `provider_overrides` omitted entirely when the map is empty (`:115`) | same |
| 3 | `apps/api/src/modules/streaming/smr-proxy.controller.ts:261` | `llm` | Cloud LLM provider selected ⇒ SMR has no env key (TASK-602) ⇒ `ProviderCredentialsError` → **503** | The call succeeds on the platform key. A tenant that is 503-ing today starts transacting real money |
| 4 | `apps/api/src/modules/smr-compat/smr-compat.controller.ts:260` (`resolveSarvamByok`) | `stt` (Sarvam) | **Already cascades** — it calls the resolver twice, tenant then `SYSTEM_TENANT_ID` (`:264`). This is the working precedent | No behaviour change if the shared helper preserves the semantics. Should be refactored onto it, not left as a second implementation |
| 5 | `apps/api/src/modules/smr-compat/smr-compat.controller.ts:658` (`attachLlmByok`) | `llm` | same as #3 — cloud provider ⇒ 503 | same as #3 |
| 6 | `packages/applications/src/services/tenant-stt-config/tenant-stt-config.service.ts:498` (`resolveProviderOverrides`) | `stt` | `{}` → cloud ASR (Azure Speech / Foundry / Sarvam / OpenAI) unusable; self-hosted whisper serves | Cloud ASR becomes reachable on the platform key. **Note the second call at `:504`** — `this.providerConnectionService.list(STT_SERVICE, tenantId)` reads `extraJson` for the per-provider `model`, and is *also* tenant-pinned. If it is not cascaded too, SYSTEM-sourced STT overrides silently lose their model id |

**The mitigating fact, verified:** `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts:19-26` seeds **every cloud-BYO row (`llm` azure/bedrock/openai/anthropic/vertex/sarvam, and all `stt`/`tts` cloud rows) as `enabled: false`, with no key material ever seeded.** A DISABLED row is treated as absent by the cascade. So on a freshly-seeded environment this change is **behaviour-neutral until a global admin deliberately enables and keys a SYSTEM row** — the blast radius is opt-in, per (service, provider), by a global admin.

That is a genuine safety property, but it is not a substitute for R3: the moment
the first SYSTEM key is enabled (which is precisely what TASK-642 Step 4 needs),
misattribution begins.

**Unverified / needs checking during implementation:** whether any *deployed*
environment already has an ENABLED, keyed SYSTEM row (the seed is CREATE-ONLY and
admins can have edited rows at runtime). This must be checked against
`hope-v2-dev` before merge — if such a row exists, R1 changes behaviour on deploy
day, not on the day an admin enables one.

---

## 3. Implementation Plan

### 3.1 Where the cascade belongs — three options weighed

| Option | Mechanism | Verdict |
|---|---|---|
| **A. Repository layer** — make `findByTenantIdAndService` return `tenantId IN [caller, SYSTEM]` (or drop the predicate and lean on the shared-read widening) | One change, every caller benefits | **Reject.** Widest blast radius, and specifically unsafe: on the `crossTenantLane` base-client lane the explicit `tenantId` is the *only* tenant boundary (§2.3). Loosening it turns the global-admin admin-console read into an unrestricted cross-tenant read of a secret-bearing table, including soft-deleted rows. It would also silently change `list()` — the admin console's per-tenant grid — so a tenant admin would see SYSTEM rows in their own picker (the exact `PromptTemplate` LIST-SURFACE trap documented at `tenant-scope.ts:388-397`) |
| **B. Per-call-site** — each of the six sites calls the resolver twice and merges, as `resolveSarvamByok` already does | No shared-code change; smallest immediate diff | **Reject as the primary.** Six copies of a precedence rule that must never drift, on paths owned by four different modules; two of them are Python-facing and one is Malayalam-critical. `resolveSarvamByok` is proof the pattern gets copied rather than shared |
| **C. Inside `resolveTenantCloudOverrides`** — one private cascade helper: read the tenant's ENABLED rows, read the SYSTEM ENABLED rows pinned explicitly, merge tenant-over-SYSTEM per provider | Exactly the six call sites change behaviour, nothing else does; the repository, `list()`, `getRow()` and every admin surface are untouched | **RECOMMENDED** |

**Why C.** The defect is "the injection resolver reads one tier"; C fixes the
resolver and nothing else. The SYSTEM read is a second query pinned to
`tenantId: SYSTEM_TENANT_ID`, which `mergeSharedReadTenantIntoWhere` already
permits from any tenant's CLS (§2.1) — so no repository signature changes, no
client elevation, no new lint exception, and the admin read surfaces keep their
existing single-tier semantics. `resolveConnection` (§2.2) is refactored to share
the same private helper so there is one precedence rule in the codebase, and
`resolveSarvamByok` (call site #4) collapses onto it.

One caveat to encode in the helper: it must **not** pass the `crossTenantLane`
client to the SYSTEM read in a way that changes the predicate. Keep both reads
explicitly pinned; the lane selection stays exactly as it is today.

### 3.2 Precedence and safety rules to encode

1. **Tenant beats SYSTEM, per provider key** — merge with the tenant map applied
   *over* the SYSTEM map, never a whole-map "tenant if non-empty" short-circuit
   (a tenant with an Azure key but no Sarvam key must still get platform Sarvam).
2. **DISABLED counts as absent** at both tiers — preserves the seed's
   behaviour-neutral posture and matches `resolveConnection`'s existing rule.
3. **Never another tenant** — the only two `tenantId` values that may appear in
   either read are the caller's and `SYSTEM_TENANT_ID`. Asserted by test, not by
   comment.
4. **`isCloudByoProvider(service, provider)` still filters both tiers** — the
   SYSTEM tier must not become a back door for injecting a self-host row's
   `base_url` as a credential override.
5. **Fail-open-per-credential is preserved** at both tiers (a SYSTEM credential
   that will not decrypt is skipped with the existing non-secret warn, and the
   tenant tier still resolves).
6. **Provenance is carried out of the resolver** (§3.3) — this is the R3 hook.
7. **The tenant tier is read first and unconditionally**; the SYSTEM tier is read
   only after the veto (§3.4) and the entitlement gate (§3.5) have both been
   evaluated. A tenant that is neither vetoing nor entitled must cost exactly one
   query — the same as today.
8. **A suppressed SYSTEM tier is recorded, never silently empty.** The resolver
   returns *why* a provider has no override, so the call site can raise an
   attributable error instead of letting the Python service report a generic
   missing-credential 503 (§3.5.4).

### 3.3 R3 — correct billing attribution (blocking sub-task)

The resolver must stop being an unlabelled bag of keys. Proposed contract change
in `IProviderConnectionService.ts`:

```ts
/** Which tier supplied each provider's override. Absent provider ⇒ no override. */
export type ProviderOverrideSources = Record<string, 'tenant' | 'system'>;

export interface ResolvedProviderOverrides {
  overrides: ProviderOverrides;          // unchanged wire shape, still gateway-only
  sources: ProviderOverrideSources;      // NEVER serialized to a Python service as-is
  /** Why the SYSTEM tier did not contribute. Absent ⇒ it was consulted normally. */
  platformDefault?: PlatformDefaultOutcome;   // added by §3.5 — see there
}
```

Then, per lane:

| Lane | Change |
|---|---|
| TTS HTTP + WS | `classifyTtsProvider` takes `sources`; `sources[provider] === 'tenant'` ⇒ `BYOK` + `BYOK_NOTIONAL`; `'system'` ⇒ `CLOUD` + `INTERNAL`. Both duplicated copies (`speech-proxy.controller.ts:238`, `tts-ws.gateway.ts:424`) must change together — **or** be deduplicated into one shared helper as part of this ticket (recommended; see OD-4) |
| SMR / LLM | The gateway must tell SMR explicitly rather than let SMR infer. Add an explicit funding field to the SMR request body (working name `provider_overrides_funding: 'tenant' \| 'platform'`), set at `smr-proxy.controller.ts` and `smr-compat.controller.ts`, and change `_used_byok_credential` (`apps/smr/src/smr/api/endpoints/generate.py:158`) to honour it, defaulting to the current inference when the field is absent (older gateway ⇒ unchanged behaviour) |
| STT | Same shape on the STT request path; `resolve_usage_attribution` (`apps/stt/src/stt/transcription/batch_service.py:70`) takes the funding signal instead of `bool(provider_overrides)`, and — independently — becomes key-specific rather than dict-truthy (§2.4). Both batch and the streaming teardown summary (`session_manager.py:3552`) must carry it |
| Guardrail (ledger) | Extend the existing consistency warn (`usage-ledger.service.ts:98-115`) with the converse assertion, so a future regression is loud |

**Alternative considered and rejected:** deriving funding on the gateway *after* the
Python service reports its provider (the gateway does know `sources`). It fails for
STT streaming, where the usage summary is produced inside the STT service at
teardown and only the resolved engine comes back — and it leaves the Python-side
`byok` field lying, which the next reader will trust. Explicit beats inferred.

**OD-2 — DECIDED 2026-08-09: meter as `CLOUD`.** A SYSTEM-key call is economically a
platform-funded vendor call, which is exactly what `CLOUD` means
(`ws-b-contract.md:126-128`). Concretely, this means:

- **No new `AiDeploymentKind` member, no `ALTER TYPE` migration.** The Prisma enum,
  the `AiUsageRollup` unique tuple, `DEPLOYMENT_ALLOWANCE_ORDER`
  (`invoice-math.ts:89-94`) and the invoice math's unknown-member handling are all
  **untouched** by R3.
- Every lane in the table above emits `deployment = CLOUD`, `costBasis = INTERNAL`
  for a `sources[provider] === 'system'` call — i.e. **identical** to a call the
  platform serves on its own key today. No metering consumer needs to learn a new
  value; a SYSTEM-key call is indistinguishable from platform-funded cloud usage in
  the ledger, which is the intended economics.
- Allowance consumption therefore lands in the `CLOUD` tier of
  `DEPLOYMENT_ALLOWANCE_ORDER` (last), after `SELF_HOSTED` and `BYOK` — matching
  TASK-638's provider-aware ordering with no change to it.
- The one caveat to test explicitly: because `CLOUD` is not a new value, a
  regression that mis-stamps a SYSTEM call as `BYOK` is *not* detectable by a
  "did an unknown enum member appear" check. Test 16 (§3.6) and the extended
  consistency assertion in `usage-ledger.service.ts` are the only guards, so they
  are not optional.

The **only** Prisma/migration work in this ticket now comes from R6 (§3.5) — two
boolean columns on the entitlement tables. R3 itself is schema-free.

### 3.4 R4 — opt-out — **DECIDED 2026-08-09: option (a), disabled tenant row = VETO**

OD-1 is answered: opt-out is **in scope**, expressed with the existing schema. A
tenant-owned `AiProviderConnection` row with `enabled: false` is a **VETO** of the
platform default for that exact `(service, provider)` pair.

#### 3.4.1 The data check that decided it

Run against the live `hope-v2-dev` database on 2026-08-09 — all non-SYSTEM rows of
`core."AiProviderConnection"`:

```
               tenantId               | service | provider | enabled | has_key | resourceStatus
--------------------------------------+---------+----------+---------+---------+----------------
 50000000-0000-0000-0000-000000000001 | llm     | azure    | t       | t       | ENABLED
 50000000-0000-0000-0000-000000000001 | stt     | sarvam   | t       | t       | ENABLED
(2 rows)
```

**Zero disabled tenant-owned rows exist**, so option (a) reinterprets nothing that is
already on disk. The objection that killed (a) in the original draft — "it changes the
meaning of an existing state" — does not apply, because there is no such state.

**This proves nothing about staging or production.** The check is per-environment and
must be re-run before the change ships anywhere else. The query to run, verbatim:

```sql
SELECT "tenantId", service, provider, enabled,
       ("encryptedApiKey" IS NOT NULL) AS has_key, "resourceStatus"
FROM core."AiProviderConnection"
WHERE "tenantId" <> '00000000-0000-0000-0000-000000000000'
ORDER BY "tenantId", service, provider;
```

**If any row comes back with `enabled = false` in another environment, do not ship
option (a) there — fall back to option (b)** (a per-provider settings-registry
descriptor, below), because in that environment a disabled row was created under the
old "means absent" semantics and silently promoting it to a veto would change a
tenant's routing without anyone deciding to.

#### 3.4.2 The three-state truth table (load-bearing — write it down, do not infer it)

Evaluated per `(service, provider)`, for a tenant `T`:

| Tenant row for (service, provider) | Meaning | Result |
|---|---|---|
| **absent** | "no opinion" | Platform default **applies** — subject to the §3.5 entitlement gate. If the gate denies, fail closed per §3.5.4 |
| **present, `resourceStatus = ENABLED`, key material present** | tenant BYOK | **Tenant credential wins.** SYSTEM tier is not consulted for this provider. Metered `BYOK` + `BYOK_NOTIONAL` (unchanged) |
| **present, `resourceStatus <> ENABLED` (disabled/archived/suspended)** | **VETO** | Fail **closed** for this provider: no override is emitted, the SYSTEM tier is suppressed, and the call raises an attributable error. **Never** falls through to the platform default and **never** falls through to a different provider |

Two edge cases the tests must pin, because neither is obvious:

- **Present, ENABLED, but keyless (`encryptedApiKey IS NULL`).** This is *not* a veto —
  it is an incomplete BYOK setup. Today it is skipped as absent, and it must keep being
  skipped as absent, so the platform default applies (gate permitting). A tenant that
  wants to veto disables the row; a tenant that is mid-setup does not.
- **A credential that fails to decrypt.** Unchanged: skipped per-credential with the
  existing non-secret warn (§3.2 rule 5). It is a fault, not a veto, and must not be
  promoted into one.

#### 3.4.3 Where the new semantics get written down (not only in this ticket)

Option (a) makes "disabled" carry a meaning it does not carry today. An operator
debugging a 409 will not read this README. The semantics must land in all four of
these, in the same change:

| File | What to add |
|---|---|
| `packages/applications/src/services/ai-provider-connection/dto/upsert-ai-provider-connection.request.ts` | `@ApiProperty` description on the `enabled` field: disabling is a **veto** of the platform default for this (service, provider), not merely "unused" |
| `packages/applications/src/services/ai-provider-connection/dto/ai-provider-connection.response.ts` | Same wording on the response `enabled` field, so it shows in `/api/v1/docs` |
| `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts` | `@ApiOperation` summary/description on the upsert + delete routes stating the three-state rule |
| `apps/admin-console/src/features/ai-providers/components/provider-credential-card.tsx` (and the tab shell `provider-credentials-tab.tsx`) | The enable/disable control needs visible helper text — disabled ⇒ "this provider is blocked for your tenant, including the platform-provided key". A tenant admin must not have to guess |

`packages/applications/src/services/ai-provider-connection/constants.ts` is the right
home for a single exported doc-comment constant the three backend surfaces can point
at, so the wording cannot drift between them.

#### 3.4.4 The error a veto produces

A veto must be **attributable** and must be distinguishable from "not entitled"
(§3.5.4) and from "nothing configured", because the remediation differs in each case
and all three would otherwise arrive as the same generic 503 from a Python service.

- **Veto ⇒ HTTP 409.** The tenant's own configuration forbids the call; a tenant admin
  can fix it in the console. Proposed: a new `ProviderCredentialVetoedException` in
  `packages/exceptions/src/domain/` (code `PROVIDER_CREDENTIAL_VETOED`, metadata
  `{ service, provider, tenantId }`), mapped in
  `apps/api/src/interceptors/exception.interceptor.ts`.
- It is raised **on the gateway, before dispatch** — the Python service is never
  called, so no vendor request and no usage event is produced.
- Contrast with §3.5.4: a missing entitlement is **403**, because the tenant cannot
  fix it themselves.

> **Uncertain / verify during implementation:** whether a new exception class is
> warranted or whether an existing `@arcaai/exceptions` member already maps to 409
> with usable metadata. Check `packages/exceptions/src/domain/` before adding one —
> the plan's requirement is "distinct, attributable, 409", not "a new class".

### 3.5 R6 — the entitlement gate — **DECIDED 2026-08-09 (OD-3)**

The owner chose the entitlement gate over "ship with R3 as the gate". A tenant may
consume the platform-default credential **only** where an explicit per-tenant or
per-plan entitlement grants it. Read §0 first — four properties of the existing
entitlements plane shape this design, and two of them invert the obvious approach.

#### 3.5.1 What already exists (verified, not assumed)

| Layer | State today | Path |
|---|---|---|
| Per-plan table | `PlanEntitlement`, keyed `plan TenantPlan @unique`, **no `tenantId`** — a platform reference table | `packages/database/src/prisma/db_main/entitlement.prisma:50` |
| Per-tenant override | `TenantEntitlement`, keyed `tenantId @unique`, every column **nullable = inherit** | `entitlement.prisma:127` |
| Boolean features | 3 of them, `Boolean @default(false)` on plan / `Boolean?` tri-state on tenant | `entitlement.prisma:99-101`, `:169-171` |
| Resolver | `ResolvedFeatures` merged with the same `pick()` precedence as the numerics | `resolve-entitlements.ts:48-52`, merge at `:224-228` |
| Ungated fallback | **all features `true`** — see §0(3) | `resolve-entitlements.ts:145` |
| Read API | `getCapabilities` → `EntitlementCapabilitiesResponse.features` → `GET /entitlements/me` | `entitlements.service.ts:148` |
| Admin write API | `UpdatePlanEntitlementRequest` / `UpsertTenantEntitlementRequest` already carry `featureX?: boolean` | `dto/plan-entitlement.dto.ts:180`, `dto/tenant-entitlement.dto.ts:183` |
| HTTP mapping | `capability.startsWith('feature') → 403` — **already wired, never yet fired** | `apps/api/src/interceptors/exception.interceptor.ts:331` |
| Enforcement | **none.** No `assertFeature`; zero call sites read `resolved.features` | — |

So: the storage, override, resolution, CRUD and status mapping all exist. What does
not exist is a way to *enforce* a boolean. This ticket writes it.

**Entitlements are column-per-key, not key/value.** There is no entitlement-key enum
and no free-string key; `EntitlementLimitKey` is literally `keyof ResolvedLimits`
(`enforcement.ts:13`). Adding a grant therefore means adding a **column**, and the
migration for it is the only Prisma work in this ticket.

#### 3.5.2 The grant

New boolean, named consistently with its three neighbours:

| Surface | Value |
|---|---|
| `PlanEntitlement.featurePlatformDefaultCredential` | `Boolean @default(false)` |
| `TenantEntitlement.featurePlatformDefaultCredential` | `Boolean?` (tri-state: `null` = inherit plan, `true` = grant, `false` = explicit deny) |
| `ResolvedFeatures.platformDefaultCredential` | `boolean` |
| `UNGATED_ENTITLEMENTS.features.platformDefaultCredential` | **`false`** — the one member that is not `true`; see §0(3). Carries a comment naming this ticket |
| Settings descriptor | `entitlements.featurePlatformDefaultCredential`, `tier: 'entitlement'`, `editableBy: 'PlanEntitlement'`, `globalOnly: true`, `maxScope: 'tenant'`, **`failMode: 'closed'`** (the other three are `open-to-default`) |

**Which plan tiers carry it by default: none — `false` on all four (STARTER, TRIAL,
PRO, ENTERPRISE), granted per tenant via `TenantEntitlement`.**

Rationale, and it is not arbitrary: TASK-638 ratified that the SYSTEM default stays
**self-hosted** and that **managed (cloud) ASR is a paid add-on**, locked by
`seed/__tests__/managed-asr-addon-posture.test.ts`. A plan-level `true` on PRO or
ENTERPRISE would hand every tenant on that plan a platform-funded cloud path, which is
the same margin hole that finding closed — at STARTER's $50/mo · 50 consultations and
PRO's $100/mo · 250 it is straightforwardly loss-making at cloud vendor rates. A
per-tenant grant also matches how ENTERPRISE is actually sold ("negotiated"), which is
per-tenant by definition. It has the further property that the whole change is
**behaviour-neutral on deploy**: nobody is granted anything until someone deliberately
sets a tenant row, which composes with the seed posture (§2.5) rather than relying on
it alone.

> Owner may reasonably prefer `ENTERPRISE: true`. That is a one-line change in both
> matrix copies plus both tests; it is called out so it is a decision, not a default.

#### 3.5.3 Where the gate is enforced — **one place**

Inside the private cascade helper added by §3.1 option C, in
`packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts`.
Sketch (shape, not final code):

```ts
private async cascadeRows(service: string, tenantId: string) {
  const tenantRows = await this.connectionRepository
    .findByTenantIdAndService(service, tenantId, this.crossTenantLane(tenantId));

  const vetoed = new Set(                                   // §3.4
    tenantRows.filter(r => r.resourceStatus !== ENABLED).map(r => r.provider));

  if (!(await this.mayConsumePlatformDefault(tenantId))) {  // §3.5 — the gate
    return { tenantRows, systemRows: [], vetoed,
             platformDefault: { suppressed: 'entitlement' as const } };
  }
  const systemRows = await this.connectionRepository
    .findByTenantIdAndService(service, SYSTEM_TENANT_ID, undefined);
  return { tenantRows, systemRows, vetoed, platformDefault: undefined };
}
```

This is the **single choke point**. All six production call sites (§2.5) reach the
SYSTEM tier only through `resolveTenantCloudOverrides` → `cascadeRows`, and
`resolveConnection` is refactored onto the same helper (§3.1), so there is exactly one
`if` in the codebase that decides whether a tenant may see the platform default. That
property is the entire reason option C was chosen over option B and it must be
asserted by test 24 (§3.6), not left as an invariant in prose.

Note the ordering, which is deliberate: **the tenant read happens first and always**,
and the gate is evaluated **before** the SYSTEM read. A non-entitled tenant therefore
costs exactly one query — identical to today — and the platform's ciphertext is never
even fetched for a tenant not allowed to use it.

New method on `IEntitlementsService`
(`packages/applications/src/services/entitlements/IEntitlementsService.ts` +
`entitlements.service.ts`):

```ts
/** Non-throwing feature read. Returns the resolved boolean for `tenantId`. */
isFeatureEnabled(tenantId: EntityId, feature: keyof ResolvedFeatures): Promise<boolean>;
```

**Non-throwing on purpose.** The resolver's job is to *shape the cascade*, not to
reject a request — at `cascadeRows` time nobody knows yet which provider will be
selected, so throwing there would 403 a tenant who was about to use a self-hosted
provider and never needed the platform key at all. The throw belongs at the point of
selection (§3.5.4). A companion `assertFeature(tenantId, feature)` throwing
`QuotaExceededException` may be added for future callers, but this ticket's gate does
not use it.

**OD-6 (the kill switch) determines one line of this method** — see §0(1) and §5.
Recommendation: `isFeatureEnabled` does **not** consult `isEnforcementEnabled()`, on
the grounds that `entitlements.enabled` is a *quota* kill switch whose documented
posture is "default OFF so customers are never blocked", whereas this gate's failure
mode is *spending the platform's money*. Failing open here is not the safe direction.
If the owner instead requires consistency with the other four enforcement methods,
then the gate is inert until `entitlements.enabled` is turned on, and the plan must say
so out loud in §3.9 rather than implying protection that is switched off.

#### 3.5.4 What happens when a tenant lacks the grant — and how it differs from a veto

The gate suppresses the SYSTEM tier. On its own that produces the *current* failure
shape — no override → the Python service raises `ProviderCredentialsError` → 503 — which
is unattributable and indistinguishable from a misconfiguration. That is not
acceptable for a commercial gate, so the resolver reports the suppression:

```ts
export type PlatformDefaultOutcome =
  | { suppressed: 'entitlement' }                    // tenant-wide: no grant
  | { suppressed: 'veto'; providers: string[] };     // per-provider: §3.4
```

and one shared helper — proposed
`packages/applications/src/services/ai-provider-connection/assert-provider-available.ts`,
exported from the folder barrel — is called at each site **after** it has chosen a
provider and found no override for it:

```ts
assertProviderAvailable(resolved, service, provider); // throws, or returns void
```

| Situation | Exception | HTTP | Who can fix it |
|---|---|---|---|
| Tenant vetoed this provider (§3.4) | `ProviderCredentialVetoedException` | **409** | Tenant admin, in the console |
| No entitlement grant | `QuotaExceededException`, `capability: 'featurePlatformDefaultCredential'` | **403** — via the pre-existing `startsWith('feature')` branch at `exception.interceptor.ts:331` | Global admin / commercial owner |
| Neither — genuinely nothing configured | unchanged: downstream `ProviderCredentialsError` → **503** | 503 | Global admin, by keying a SYSTEM row |

The two errors are deliberately different because the remediation is different, and
because a tenant hitting 403 needs to be told to talk to their account owner, not to
go looking at their own credential tab.

**One honest wrinkle.** With the recommended design the gate skips the SYSTEM read
entirely, so at throw time the gateway does **not** know whether a SYSTEM row for that
provider actually exists. A tenant with no grant gets the 403 even when the platform
has nothing configured either — technically the "wrong" of the two errors. The
alternative is to read the SYSTEM rows anyway, discard them, and report the precise
reason; that costs a query and a decrypt of credentials the caller is not permitted to
use, for every non-entitled request. **Recommended: keep the skip.** The 403 is the
more actionable message in both cases, and not fetching secrets you may not use is the
better hygiene. Flagging it because a future bug report will read "403 says not
entitled but nothing was configured either" and it should be a known behaviour, not a
surprise.

#### 3.5.5 Grant present **and** tenant opted out ⇒ **the veto wins**

This is the interaction OD-1 and OD-3 create together, and it has exactly one correct
answer: the tenant's explicit refusal beats a commercial grant. A grant says "you *may*
buy this"; a veto says "we *will not* send PHI to a shared vendor account". A platform
entitlement must never override a tenant's own data-handling decision.

Mechanically this falls out of the scope difference and needs no precedence rule of its
own: the veto is per `(service, provider)`, the grant is per tenant. The vetoed
provider is removed from **both** tiers before the merge, so a grant cannot reintroduce
it. Evaluation order in `cascadeRows` is veto-set first, gate second — which also means
a vetoing, non-entitled tenant gets the **409** (veto), not the 403, because the veto is
the more specific and more local fact. Test 35 (§3.6) pins exactly this.

#### 3.5.6 Migration and seed work

1. **Schema** — `packages/database/src/prisma/db_main/entitlement.prisma`: add the
   column to `PlanEntitlement` (near the feature block at `:99-101`) and
   `TenantEntitlement` (near `:169-171`).
2. **Migration** — `pnpm db:migrate:create`, named `task_643_platform_default_credential_entitlement`
   → `<timestamp>_task_643_platform_default_credential_entitlement/migration.sql`.
   Two statements, precedent `20260806000000_task_615_usage_ledger_and_billing/migration.sql`:
   `ALTER TABLE core."PlanEntitlement" ADD COLUMN "featurePlatformDefaultCredential" BOOLEAN NOT NULL DEFAULT false;`
   and the same on `core."TenantEntitlement"` **without** `NOT NULL`/default (nullable
   tri-state). Review before applying; roll forward only.
3. **Domain layer** — `pnpm db:generate`, then `pnpm gen:model`. The entity, factory
   and mapper for `PlanEntitlement`/`TenantEntitlement` are **hand-edited** per
   `03-domain-layer.md`; `gen:entity` + `gen:factory` reconcile barrels and prove
   schema coverage. **Never run `gen:mapper`** — it strips the `_version` OCC guard.
4. **Copy A of the plan matrix** — `packages/database/src/prisma/db_main/seed/15-entitlements.ts`:
   field on `PlanEntitlementSeed` (`:73-113`), then a value in `PRO_VALUES` (`:116-139`),
   `STARTER` (`:142-167`) and `ENTERPRISE` (`:170-197`). `TRIAL` spreads `PRO_VALUES`.
   All four `false` per §3.5.2. The upsert is create-only (`update: {}`), so **existing
   deployed rows do not pick the column up from a re-seed** — they take the SQL default
   `false`, which is the desired fail-closed outcome. Say this out loud in the ticket
   because "the seed says false" and "the deployed row is false" are true here for two
   different reasons.
5. **Copy B of the plan matrix** — `packages/applications/src/services/entitlements/entitlements.constants.ts`:
   field on `PlanEntitlementValues` (`:84-120`), then `PRO_VALUES` (`:123-146`),
   `STARTER` (`:149-172`), `ENTERPRISE` (`:175-199`). **This is the unguarded hand-sync
   step — see §3.5.7.**
6. **Resolver** — `resolve-entitlements.ts`: `ResolvedFeatures` (`:48-52`), the plan-row
   input type, the tenant-override input type, `UNGATED_ENTITLEMENTS.features` (`:145`,
   **`false`**, with a comment), and the feature merge layer (`:224-228`).
7. **Service + DTOs** — `entitlements.service.ts`: `getCapabilities` feature block,
   `applyTenantOverrideFields` (`:579`), `clearTenantEntitlement` (`:504`),
   `toPlanResponse` (`:626`), `toTenantResponse` (`:654`); plus
   `dto/plan-entitlement.dto.ts` and `dto/tenant-entitlement.dto.ts` (response +
   request fields with `@ApiPropertyOptional`).
8. **Descriptor** — `settings-registry/descriptors/entitlements.descriptors.ts:29-51`,
   fourth entry, `failMode: 'closed'`.
9. **Console read surface** — `apps/admin-console/src/features/entitlements/api/types.ts`
   (and the SDK's `packages/agentic-sdk-v2/src/hooks/useEntitlements.ts:43-45`, which
   mirrors the feature list) so the grant is visible where the other three are.

**No `ResourceType` / audit-enum work**: no new model is introduced, only columns on
two existing ones.

#### 3.5.7 Close the plan-matrix drift hole (§0(4)) — in this ticket

Adding a per-plan field with no parity guard is how the two copies drift, and this
field's failure mode is a security-relevant one (a `true` in the seed and a `false` in
the constant, or the reverse, silently grants or denies spend). Add:

`packages/applications/src/services/entitlements/__tests__/plan-matrix-parity.test.ts` —
imports `PLAN_ENTITLEMENT_DEFAULTS` from `entitlements.constants.ts` and the seed's
`PLAN_ENTITLEMENTS` and asserts every plan agrees field-for-field (normalising
`bigint` vs `number` and the `GIB` byte helper).

The direction works — `@arcaai/applications` already depends on `@arcaai/database`, and
the ban documented at `15-entitlements.ts:28` is the *reverse* direction. What is
**uncertain** is whether the seed module's symbols are importable: `15-entitlements.ts`
is not on the `@arcaai/database` public barrel, so this needs either a deep source
import or a small named export added to the database package. **Verify during
implementation.** If neither is clean, the fallback is a repo-level test under
`tests/contracts/` (run by `pnpm test:unit`) which can read both files as source. Do
not skip the guard because the import is awkward — this is the fourth time the manual
sync has been noted in a ticket and the first time anything has been proposed about it.

### 3.6 TDD test list (RED first, in this order)

**Build order.** The list below is written in file order, but the *dependency* order is
`22-29` (entitlement resolution + `isFeatureEnabled`) → `1-11` and `30-38` (cascade,
gate, veto, HTTP mapping) → `12-16` (attribution) → `17-21` and `39-41` (contracts,
seed, parity). Tests `1-3` and `9` now
require a **granted** tenant fixture (`featurePlatformDefaultCredential = true`), so
they cannot go RED-then-GREEN until `22-27` exist — build the entitlement layer first
even though it appears second in the file table (§3.7 reflects this).

**Unit — entitlement gate, resolution layer (R6)**

`packages/applications/src/services/entitlements/__tests__/resolve-entitlements.test.ts` — extend:

22. plan grants `featurePlatformDefaultCredential = true`, no tenant override →
    `resolved.features.platformDefaultCredential === true`
23. plan `false`, tenant override `true` → `true` (per-tenant grant over plan default —
    the primary sales path per §3.5.2)
24. plan `true`, tenant override `false` → `false` (explicit tenant deny beats the plan;
    the tri-state's third state is not decorative)
25. tenant override `null` → inherits the plan value (not `false`, not `true` — inherit)
26. **`UNGATED_ENTITLEMENTS.features.platformDefaultCredential === false`** — asserted
    directly, with a comment in both test and source naming §0(3). This is the one
    feature that is `false` for a null-plan tenant and the assertion exists to stop a
    future reader "restoring" the symmetry
27. all four seeded plans (`STARTER`, `TRIAL`, `PRO`, `ENTERPRISE`) resolve `false` by
    default from `PLAN_ENTITLEMENT_DEFAULTS` (pins §3.5.2's "none by default")

`packages/applications/src/services/entitlements/__tests__/entitlements.service.test.ts` — extend:

28. `isFeatureEnabled(tenantId, 'platformDefaultCredential')` returns the resolved
    boolean and **does not throw** for either value
29. **kill-switch behaviour, per the OD-6 answer** — with `entitlements.enabled = false`,
    `isFeatureEnabled` returns *(the OD-6 answer: the resolved value under the
    recommendation, or `true`/ungated under the consistency alternative)*. Whichever is
    chosen, this test is the one that documents it; it must be written **after** OD-6 is
    answered and must fail if someone later flips the behaviour

**Unit — cascade gate + veto (R6 × R4), `ai-provider-connection` (Vitest)**

New file `ai-provider-connection.platform-default-gate.test.ts`:

30. tenant **not** entitled, SYSTEM has an ENABLED keyed row → result is `{}`, and — the
    load-bearing assertion — **the SYSTEM read never happened**: exactly ONE repository
    call, `where.tenantId === callerTenantId`. Pins §3.5.3's "one query for a
    non-entitled tenant" and proves the platform's ciphertext is not fetched
31. tenant entitled → the SYSTEM read happens and the cascade behaves as tests 1-3
32. **single choke point**: `resolveConnection` (the by-provider counterpart, §3.1) is
    gated identically — an ungranted tenant gets `null`, not the SYSTEM row. Guards
    against the gate living in `resolveTenantCloudOverrides` only
33. `platformDefault: { suppressed: 'entitlement' }` is present on the result when the
    gate denies, and absent when it does not
34. **veto**: tenant row `resourceStatus = DISABLED` for `(tts, azure)` → no override for
    `azure` from **either** tier, `platformDefault.suppressed === 'veto'` with
    `providers: ['azure']`; a *different* provider (`sarvam`) in the same call still
    resolves from SYSTEM. Pins "never falls through to another provider"
35. **veto beats grant (§3.5.5)**: tenant entitled **and** vetoing `(tts, azure)` →
    still no `azure` override; `assertProviderAvailable` throws the **409**
    `ProviderCredentialVetoedException`, not the 403
36. **keyless ENABLED tenant row is not a veto** (§3.4.2 edge case) → treated as absent,
    SYSTEM row serves (tenant entitled)
37. `assertProviderAvailable` matrix: `suppressed: 'entitlement'` → `QuotaExceededException`
    with `capability === 'featurePlatformDefaultCredential'`; `suppressed: 'veto'` →
    `ProviderCredentialVetoedException`; neither → returns void (the 503 path is
    unchanged and belongs downstream)

`apps/api/src/interceptors/__tests__/exception.interceptor.test.ts` — extend:

38. `QuotaExceededException` with `capability: 'featurePlatformDefaultCredential'` maps to
    **403** (first exercise of the `startsWith('feature')` branch at `:331`, which has
    never fired) and `ProviderCredentialVetoedException` maps to **409**

**Unit — `packages/applications/src/services/ai-provider-connection/__tests__/` (Vitest)**

New file `ai-provider-connection.platform-default.test.ts` (all cases assume a
**granted** tenant unless stated — see Build order above):

1. tenant has no row, SYSTEM has an ENABLED keyed row → resolver returns the SYSTEM
   entry, `sources[provider] === 'system'` *(RED against today's code)*
2. tenant has an ENABLED keyed row, SYSTEM also does → tenant entry wins,
   `sources[provider] === 'tenant'`, SYSTEM value absent from the result
3. per-provider merge: tenant has `azure` only, SYSTEM has `azure` + `sarvam` →
   `azure` from tenant, `sarvam` from SYSTEM
4. SYSTEM row `enabled: false` → treated as absent → `{}` (pins the seed's
   behaviour-neutral posture)
5. SYSTEM row enabled but `encryptedApiKey === null` → skipped (no keyless entry)
6. SYSTEM row for a non-cloud-BYO provider → never injected
   (`isCloudByoProvider` applies at both tiers)
7. SYSTEM credential fails to decrypt → skipped with the non-secret warn; a valid
   tenant credential in the same call still resolves
8. `!this.secretsService` → still `{}` (unchanged short-circuit)
9. **the two-read assertion**: capture the `where` of every repository call and
   assert `tenantId` ∈ `{callerTenantId, SYSTEM_TENANT_ID}` and nothing else
10. `resolveConnection` still passes its existing tests after being refactored onto
    the shared helper (regression)

Extend `ai-provider-connection.tenant-lane.test.ts`:

11. global admin under working tenant `W`: the SYSTEM read must not become an
    unpinned base-client read (assert the explicit predicate survives the lane)

**Unit — attribution (R3)**

12. `speech-proxy.controller.test.ts` / `tts-ws.gateway.test.ts`: `sources='system'`
    ⇒ `CLOUD` + `INTERNAL`; `sources='tenant'` ⇒ `BYOK` + `BYOK_NOTIONAL`
    (extends the existing cases at `:372-405` and `:337-375`)
13. `tenant-stt-config` resolver: SYSTEM-sourced entry keeps its `extraJson.model`
    (the `list()` call at `:504` must cascade too)
14. Python `apps/stt/tests/unit/test_batch_service_usage_attribution.py`: explicit
    funding signal wins; absent signal preserves today's rule; key-specific rather
    than dict-truthy
15. Python SMR test for `_used_byok_credential` honouring the explicit field,
    defaulting to inference when absent
16. `usage-ledger.service.test.ts`: the extended consistency assertion fires on the
    `CLOUD` + `BYOK_NOTIONAL` and `BYOK` + `INTERNAL` pairs

**Cross-tenant contract (R2)** — the house posture lives in
`apps/api/tests/e2e/*-cross-tenant.spec.ts`, with shared fixtures in
`tests/cross-tenant/fixtures.ts` (`tests/cross-tenant/` currently holds only
`fixtures.ts` + `example.test.ts` — the real probes are the e2e specs).

17. **`apps/api/tests/e2e/ai-provider-connections-cross-tenant.spec.ts` — extend.**
    Its four locked contracts (no secret echoed; self-host on a tenant row → 403;
    foreign `?tenantId=` → never 200; RFC 7232 OCC) must all still hold, plus a new
    one: **tenant A's key is never served to tenant B**. Concretely — key a row for
    A, key the SYSTEM row, then exercise a tenant-B-scoped path and assert B is
    served the SYSTEM credential and never A's.
18. **`apps/api/tests/e2e/byo-llm-credentials.spec.ts` — extend** with the LLM
    fallback: a **granted** tenant with no row on a cloud provider gets served (not
    503) once a SYSTEM row is enabled, and 503 again when it is disabled.
19. **`apps/api/tests/e2e/task-615-usage-ledger.spec.ts` — extend**: a
    SYSTEM-credential call writes a ledger row with `deployment=CLOUD`,
    `costBasis=INTERNAL`, non-zero cost contribution.
20. **New** `apps/api/tests/e2e/task-643-platform-default-opt-out.spec.ts` (OD-1
    decided — this spec is required, not conditional): a vetoing tenant gets an
    attributable **409**, and the response never names another provider or falls
    through to one.
21. **New** `apps/api/tests/e2e/task-643-platform-default-entitlement.spec.ts`: the
    full gate through real HTTP —
    (a) ungranted tenant, SYSTEM row enabled + keyed → **403** with
    `capability: featurePlatformDefaultCredential`, and **no `AiUsageEvent` row is
    written** (a denied call must cost nothing);
    (b) grant it via `PUT /api/v1/admin/entitlements/tenants/:tenantId` → the same
    call now succeeds and writes `deployment=CLOUD` + `costBasis=INTERNAL`;
    (c) revoke the grant → 403 again (proves the resolution is not cached past the
    write — if `AppSettingsService`-style caching is involved anywhere on this path,
    this is the test that catches it);
    (d) a tenant with its own ENABLED keyed row succeeds **regardless** of the grant —
    the gate governs the platform default only and must never gate BYOK.

**Seed / drift / parity**

39. `packages/database/src/prisma/db_main/seed/__tests__/config-plane-seed.test.ts`
    — add an explicit assertion that every cloud-BYO SYSTEM seed row stays
    `enabled: false` and keyless, so a future seed edit cannot silently arm the
    cascade. *(This was item 21 in the pre-revision list; renumbered.)*
40. `packages/database/src/prisma/db_main/seed/__tests__/entitlements-seed.test.ts`
    — assert all four seeded plans carry `featurePlatformDefaultCredential: false`
    (§3.5.2). Seed-side counterpart of test 27 and companion to
    `managed-asr-addon-posture.test.ts`, whose add-on posture it upholds.
41. **New** `packages/applications/src/services/entitlements/__tests__/plan-matrix-parity.test.ts`
    — §3.5.7. Field-for-field agreement between the two matrix copies, for all four
    plans. Verify RED by deliberately changing one value in one copy.

### 3.7 File creation / modification order

**Changed by this revision.** OD-2 (`CLOUD`) removes the `AiDeploymentKind` migration,
but OD-3 (the entitlement gate) adds a **different** one — two boolean columns on
`PlanEntitlement` / `TenantEntitlement` (§3.5.6). So `02-database-prisma.md` and
`03-domain-layer.md` **do** apply, to the entitlement models only. The
`AiProviderConnection` repository remains deliberately untouched, and `gen:mapper` is
never run (it strips the `_version` OCC guard).

The entitlement layer (rows 0a-0f) is built **first**, because the cascade tests need a
granted-tenant fixture (§3.6 Build order).

| # | File | Change |
|---|---|---|
| 0a | `packages/applications/src/services/entitlements/__tests__/resolve-entitlements.test.ts`, `entitlements.service.test.ts` | tests 22-29 (RED) |
| 0b | `packages/database/src/prisma/db_main/entitlement.prisma` + new migration `<ts>_task_643_platform_default_credential_entitlement/` | `featurePlatformDefaultCredential` on both models (§3.5.6 steps 1-2) |
| 0c | `packages/domains` generated models + **hand-edited** entity/factory/mapper for `PlanEntitlement` / `TenantEntitlement` | `pnpm db:generate` → `gen:model`; hand-author the rest; `gen:entity` + `gen:factory` to reconcile |
| 0d | `packages/database/src/prisma/db_main/seed/15-entitlements.ts` **and** `packages/applications/src/services/entitlements/entitlements.constants.ts` | both matrix copies, `false` on all four plans (§3.5.2) — **edit together, in the same commit** |
| 0e | `packages/applications/src/services/entitlements/resolve-entitlements.ts`, `entitlements.service.ts`, `IEntitlementsService.ts`, `dto/plan-entitlement.dto.ts`, `dto/tenant-entitlement.dto.ts`, `settings-registry/descriptors/entitlements.descriptors.ts` | `ResolvedFeatures` member (+ `UNGATED_ENTITLEMENTS` = **`false`**), merge layer, `isFeatureEnabled`, DTO fields, `failMode: 'closed'` descriptor |
| 0f | `packages/applications/src/services/entitlements/__tests__/plan-matrix-parity.test.ts` | test 41 — the drift guard (§3.5.7) |
| 1 | `packages/applications/src/services/ai-provider-connection/__tests__/ai-provider-connection.platform-default.test.ts` + `…platform-default-gate.test.ts` | **new** — tests 1-10 and 30-38 (RED) |
| 2 | `packages/applications/src/services/ai-provider-connection/IProviderConnectionService.ts` | `ResolvedProviderOverrides` + `ProviderOverrideSources` + `PlatformDefaultOutcome`; document the two-tier contract **and the three-state veto rule** on `resolveTenantCloudOverrides` |
| 3 | `packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts` | private `cascadeRows(service, tenantId)` helper — veto set, **entitlement gate (the single choke point, §3.5.3)**, SYSTEM read, tenant-over-SYSTEM merge, `sources` + `platformDefault`; `resolveConnection` refactored onto the same helper |
| 3b | `packages/applications/src/services/ai-provider-connection/assert-provider-available.ts` (**new**) + `constants.ts` + folder barrel | the shared surfacing helper (§3.5.4) and the single doc-comment constant for the veto semantics (§3.4.3) |
| 3c | `packages/exceptions/src/domain/providerCredentialVetoed.exception.ts` (**new**, if no existing 409 member fits) + `apps/api/src/interceptors/exception.interceptor.ts` | 409 mapping for the veto; the 403 mapping for `feature*` already exists at `:331` and is exercised for the first time |
| 4 | `packages/applications/src/services/ai-provider-connection/__tests__/ai-provider-connection.tenant-lane.test.ts` | test 11 |
| 5 | `packages/applications/src/services/tenant-stt-config/tenant-stt-config.service.ts` | consume sources; cascade the `list()` read at `:504` so SYSTEM `extraJson.model` survives |
| 6 | `apps/api/src/modules/speech/speech-proxy.controller.ts` + `apps/api/src/modules/speech/tts-ws.gateway.ts` | funding-aware `classifyTtsProvider` (deduplicated — OD-4) |
| 7 | `apps/api/src/modules/streaming/smr-proxy.controller.ts`, `apps/api/src/modules/smr-compat/smr-compat.controller.ts` | send the explicit funding field; `resolveSarvamByok` collapses onto the shared cascade |
| 8 | `apps/smr/src/smr/api/endpoints/generate.py` (+ `models/usage.py`) | honour the explicit funding field |
| 9 | `apps/stt/src/stt/transcription/batch_service.py`, `apps/stt/src/stt/streaming/session_manager.py` (+ gateway DTOs `stt/internal/dto/internal.request.ts`, `stt/streaming/dto/streaming-session.dto.ts`) | funding-aware, key-specific attribution |
| 10 | `packages/applications/src/services/usageLedger/usage-ledger.service.ts` | extended consistency assertion |
| 11 | `…/dto/upsert-ai-provider-connection.request.ts`, `…/dto/ai-provider-connection.response.ts`, `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts`, `apps/admin-console/src/features/ai-providers/components/provider-credential-card.tsx` + `provider-credentials-tab.tsx` | **write down the veto semantics where an operator will find them** (§3.4.3) |
| 12 | `apps/admin-console/src/features/entitlements/api/types.ts`, `packages/agentic-sdk-v2/src/hooks/useEntitlements.ts` | surface the new grant alongside the other three features |
| 13 | e2e specs 17-21, seed/parity tests 39-41 | contract locks |
| 14 | this README | Implementation Summary + Change History |

Barrels: no new exported symbol leaves the `ai-provider-connection` folder except
the two types in step 2 — check `packages/applications/src/index.ts` re-exports.

### 3.8 Verification criteria

- [ ] Every test in §3.6 was seen **RED** before its implementation (evidence pasted
      into §4)
- [ ] `pnpm --filter @arcaai/applications build test` green
- [ ] `pnpm --filter @arcaai/domains build test` green (the `AiProviderConnection`
      repository untouched — proves it; the two entitlement models **are** touched, so
      this is no longer a pure no-op check)
- [ ] `pnpm --filter @arcaai/database test` green; `pnpm gen:model --check`,
      `gen:entity --check`, `gen:factory --check` all report **no drift + schema
      coverage OK** (CI gates `generate-*-check` will re-run them)
- [ ] Migration SQL reviewed statement by statement before `pnpm db:migrate`
- [ ] `pnpm api:build`, `pnpm test:unit` green
- [ ] `pnpm stt:test`, `pnpm py:smr:test`, and the matching `:lint` / `:typecheck` green
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green (console types +
      credential-card copy)
- [ ] `pnpm test:e2e` green with the extended cross-tenant, BYO-LLM and usage-ledger
      specs **and** the two new specs (opt-out 20, entitlement gate 21)
- [ ] `pnpm lint` clean, including `packages/*` only-warn warnings
- [ ] **Runtime evidence, not just tests**: with an ENABLED keyed SYSTEM row **and**
      `featurePlatformDefaultCredential = true` on the tenant, a tenant that has no row
      completes one TTS synth, one SMR generate and one STT transcription; the
      resulting `AiUsageEvent` rows are inspected and show `deployment=CLOUD`,
      `costBasis=INTERNAL`, non-zero cost
- [ ] **Runtime evidence of the denials** (equally required — a gate nobody has seen
      deny is not a gate): the same three calls with the grant revoked return **403**
      and write **no** `AiUsageEvent`; with the grant restored but the tenant row
      disabled they return **409**
- [ ] Pre-merge data check re-run per environment with the §3.4.1 query — clean on
      `hope-v2-dev` as of 2026-08-09; **must be re-run against staging/prod before the
      change ships there**, falling back to opt-out option (b) if any `enabled = false`
      tenant row exists
- [ ] Pre-merge check for §2.5: are there already ENABLED, keyed SYSTEM
      `AiProviderConnection` rows in the target environment?
- [ ] TASK-642 §5 OD-1 re-evaluated with this unblocked

### 3.9 Sequencing — what must be green before this ships

The ticket now has **three** merge blockers, not one. None may be deferred to a
follow-up, because each of them is only load-bearing once R1 is merged, and R1 is the
thing everyone wants:

| Blocker | Why it blocks | Done when |
|---|---|---|
| **R3 — attribution** (§3.3) | Without it every platform-funded call is rated BYOK: zero COGS, baseline SELL price, never invoiced, and invisible to shadow metering (§2.4). Revenue leak plus a blind COGS plane | Tests 12-16 green **and** the runtime `AiUsageEvent` inspection shows `CLOUD` + `INTERNAL` |
| **R6 — entitlement gate** (§3.5) | Without it, arming one SYSTEM row turns 503s into billable traffic for **every** tenant at once (call sites #3/#5/#6). This is the exposure OD-3 was answered to close | Tests 22-38 green, migration applied, both matrix copies carry the field, parity guard (41) green, **and** the 403-denial runtime evidence captured |
| **R4 — opt-out veto** (§3.4) | Without it the change ships "your PHI may now leave on a shared vendor account" with no way to decline | Tests 34-37 + e2e 20 green, semantics written into all four operator-facing surfaces (§3.4.3) |

**Plus two decisions**: **OD-6** must be answered before §3.5.3 is written (it
determines one line of `isFeatureEnabled` and the content of test 29), and **OD-7**
before the seed values are set. Neither can be discovered by implementing.

R1 (the cascade itself) is the smallest piece of this ticket and the last to become
safe. It is fine to build R1 first — it is what the tests hang off — but **it must not
merge alone**.

#### What TASK-642 Step 4 (Malayalam) is waiting on

Step 4 needs a working platform cloud TTS credential for Malayalam. Concretely it is
unblocked only when **all** of the following hold, in this order:

1. This ticket merges with R1 + R3 + R4 + R6 green (above).
2. A global admin **enables and keys** the SYSTEM `AiProviderConnection` row for the
   chosen Malayalam-capable provider (`tts`/`azure` or `tts`/`sarvam`). The seed ships
   these `enabled: false` and keyless (§2.5), so this is a deliberate, per-provider act.
3. The tenant that runs the Malayalam path is **granted**
   `featurePlatformDefaultCredential = true` via
   `PUT /api/v1/admin/entitlements/tenants/:tenantId`. Under §3.5.2 no plan grants it,
   so **without step 3 the cascade is correct and Malayalam still fails** — with a 403,
   not the current 503. Anyone testing TASK-642 Step 4 must be told this or they will
   report the gate as a regression.
4. That tenant has **no disabled** `tts`/`<provider>` row of its own (§3.4.2) — a
   leftover disabled row is now a veto and will produce a 409.

Steps 2-4 are operator actions in the target environment, not code, and belong in
TASK-642's own runbook rather than here. What this ticket owes TASK-642 is a note in
its README saying exactly this, so the handoff does not go through a debugging session.

---

## 4. Implementation Summary

### 4.1 Entitlement layer (R6, §3.5) — **DONE** 2026-08-09

Scope built: §3.7 rows **0a–0f** only (tests 22-29 + 39-41). The cascade (§3.1),
the gate call site (§3.5.3), the veto (§3.4) and the R3 metering changes are
owned by other lanes and are NOT in this summary.

**Owner decisions as implemented.** OD-7 → `false` on all four plans, both
matrix copies, plus the SQL column default. OD-6 → the gate **HONOURS**
`entitlements.enabled`: `isFeatureEnabled` returns early exactly like
`assertQuantityQuota:215` and its three siblings, and for a boolean read their
"return without enforcing" is **`true`**. Stated plainly, per §3.9's requirement:
**with the kill switch OFF the platform-default gate is INERT and every tenant
reaches the SYSTEM credential tier.** Test 29 pins both states so the behaviour
cannot drift silently in either direction.

#### Files changed

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/entitlement.prisma` | `featurePlatformDefaultCredential` — `Boolean @default(false)` on `PlanEntitlement`, `Boolean?` (tri-state) on `TenantEntitlement` |
| `packages/database/src/prisma/db_main/migrations/20260809000000_task_643_platform_default_credential_entitlement/migration.sql` | **new** — the two `ALTER TABLE … ADD COLUMN` statements, verbatim as `prisma migrate diff` produced them |
| `packages/database/src/prisma/db_main/seed/15-entitlements.ts` | matrix copy A: field on `PlanEntitlementSeed` + `false` in `PRO_VALUES`/`STARTER`/`ENTERPRISE`; **`PLAN_ENTITLEMENTS` is now exported** for the parity guard (§4.3) |
| `packages/domains/src/models/generated/core/{Plan,Tenant}EntitlementModel.ts` | regenerated by `pnpm gen:model` (2 lines each) |
| `packages/domains/src/entities/generated/core/{Plan,Tenant}EntitlementEntity.ts` | **hand-authored** — interface field, private backing field, ctor init, getter + `setProperty` setter |
| `packages/domains/src/factories/generated/core/{Plan,Tenant}EntitlementFactory.ts` | **hand-authored** — props field + default (`?? false` on plan, `?? null` on tenant) |
| `packages/applications/src/services/entitlements/entitlements.constants.ts` | matrix copy B: field on `PlanEntitlementValues` + `false` in all three value blocks |
| `…/entitlements/resolve-entitlements.ts` | `ResolvedFeatures.platformDefaultCredential`, both input types, the plan-row and tenant-override merge layers, and `UNGATED_ENTITLEMENTS.features.platformDefaultCredential = false` with the §0(3) warning comment |
| `…/entitlements/IEntitlementsService.ts` | new `EntitlementFeatureKey = keyof ResolvedFeatures` + the `isFeatureEnabled` contract (non-throwing; honours the kill switch) |
| `…/entitlements/entitlements.service.ts` | `isFeatureEnabled` implementation + the field threaded through `updatePlanEntitlement`, the tenant-override create branch, `clearTenantEntitlement`, `applyTenantOverrideFields`, `toPlanResponse`, `toTenantResponse` |
| `…/entitlements/dto/{plan,tenant}-entitlement.dto.ts` | response + request fields on all four DTOs, `@ApiProperty`/`@ApiPropertyOptional` describing it as platform SPEND, not a display flag |
| `…/settings-registry/descriptors/entitlements.descriptors.ts` | fourth descriptor, declared **outside** the `.map` because it is the only one with **`failMode: 'closed'`** |
| `…/entitlements/__tests__/resolve-entitlements.test.ts` | tests 22-27 (+ two pre-existing `toEqual` feature-shape assertions updated for the new member) |
| `…/entitlements/__tests__/entitlements.service.test.ts` | tests 28-29 |
| `…/entitlements/__tests__/plan-matrix-parity.test.ts` | **new** — test 41 |
| `packages/database/src/prisma/db_main/seed/__tests__/entitlements-seed.test.ts` | test 40 |
| `packages/database/src/prisma/db_main/seed/__tests__/config-plane-seed.test.ts` | test 39 |

#### `gen:mapper` was NOT run (and was not needed)

`{Plan,Tenant}EntitlementEntityMapper` are field-agnostic — they delegate to
`AutoClassMapper`/`AutoEntityChangeMapper` with empty handler maps, so a new
column requires no mapper edit at all. Both keep their
`FIELDS_NOT_WRITABLE = ['version']` strip untouched.

### 4.2 Migration NOT applied through `prisma migrate` — read this

`pnpm db:migrate:create` **cannot run against the local dev database.**
`prisma migrate status` reports **all 80 committed migrations as unapplied**:
the local `hope` DB is `db push`-managed (a long-standing property of this repo,
not something this ticket caused), so `prisma migrate dev` sees the entire
history as drift and demands `prisma migrate reset` — a destructive full-database
drop that was **not** performed.

What was done instead, and what each step proves:

1. The SQL was **generated by Prisma**, not hand-written: `prisma migrate diff`
   from the pre-change schema to the post-change schema, which emitted exactly
   the two statements §3.5.6 predicted. The committed `migration.sql` is that
   output verbatim, plus a header comment explaining why statement 2 is nullable
   and default-less.
2. The two columns were applied to the local dev DB **directly and additively**
   (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`), then read back from
   `information_schema.columns`:

   ```
        table_name     |           column_name            | is_nullable | column_default
   -------------------+----------------------------------+-------------+----------------
    PlanEntitlement   | featurePlatformDefaultCredential | NO          | false
    TenantEntitlement | featurePlatformDefaultCredential | YES         |
   ```

3. `pnpm db:generate` + `pnpm gen:model` then ran against the real schema, and
   all three CI drift gates pass (§4.4).

**Owner action still owed:** the migration has never been executed *as a
migration*. On any environment with a real `_prisma_migrations` history it will
apply on the next `pnpm db:migrate:deploy`; on this laptop the columns exist but
the migration row does not. Nothing verified here proves the file applies
cleanly through `migrate deploy` — only that the SQL is Prisma's own output for
this schema delta and that both statements execute successfully on a live
Postgres 18.

### 4.3 §3.5.7 uncertainty RESOLVED — the parity guard imports the seed directly

The plan flagged one unknown: whether the seed module's symbols are importable
from `@arcaai/applications`. **They are**, with one change and one caveat:

- `PLAN_ENTITLEMENTS` was module-private; it is now `export`ed. This follows the
  existing export-for-test convention in the same directory
  (`SYSTEM_AI_PROVIDER_CONNECTIONS`, `DEFAULT_ASR_PIPELINES`, …), so it is not a
  new pattern.
- A **package-name** import cannot reach it: `15-entitlements.ts` is not on the
  `@arcaai/database` barrel and the package's `exports` map declares only `.`
  and `./client`, so no subpath resolves. The test therefore uses a **relative
  source import**, which Vitest resolves without complaint (verified: the module
  loaded and executed, including its runtime import of the generated Prisma
  client for the `TenantPlan` enum).

So the test lives at the plan's preferred location,
`packages/applications/src/services/entitlements/__tests__/plan-matrix-parity.test.ts`,
and the `tests/contracts/` fallback was **not** needed. Direction of dependency
is the allowed one (`applications → database`); the ban documented at
`15-entitlements.ts:28` is the reverse.

The guard compares all 21 matrix fields for all four plans, normalising
`bigint` → `number`, and additionally asserts that **neither copy carries a field
the other lacks** — so the next field added to one side fails here instead of
drifting silently.

### 4.4 Verification evidence (actual output)

**RED before GREEN** — every new test was seen failing first:

```
# resolve-entitlements.test.ts + plan-matrix-parity.test.ts (tests 22-27, 41)
 Test Files  2 failed (2)
      Tests  15 failed | 22 passed (37)
AssertionError: expected undefined to be false     ← UNGATED_ENTITLEMENTS.features.platformDefaultCredential
AssertionError: STARTER matrix default: expected undefined to be false
TypeError: Cannot read properties of undefined (reading 'map')   ← PLAN_ENTITLEMENTS not yet exported

# entitlements.service.test.ts (tests 28-29)
      Tests  3 failed | 49 passed (52)
TypeError: makeService(...).isFeatureEnabled is not a function

# entitlements-seed.test.ts (test 40)
      Tests  3 failed | 25 passed (28)
```

Test **39** (`config-plane-seed.test.ts`) was **GREEN on arrival** — honestly
noted, because it is a *lock* on behaviour the seed already has (every cloud-BYO
SYSTEM row already ships disabled and keyless), not a driver of new code. It has
never been RED and cannot be; its value is that arming the cascade by editing the
seed now fails a test.

**GREEN after implementation:**

```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc
        (clean — no output)

$ pnpm --filter @arcaai/applications test
 Test Files  447 passed | 1 skipped (448)
      Tests  8464 passed | 4 skipped (8468)

$ pnpm --filter @arcaai/database test
 Test Files  44 passed (44)
      Tests  1089 passed (1089)

$ pnpm --filter @arcaai/domains build
> tsc
        (clean — no output)

$ pnpm --filter @arcaai/domains test
 Test Files  133 passed | 2 skipped (135)
      Tests  1531 passed | 2 skipped | 9 todo (1542)
```

**Generator drift gates** (`pnpm gen:check` — the three CI `generate-*-check` jobs):

```
[Generate Data Model]  check: no drift — 143 generated file(s) match the committed files.
[Generate Data Entity] check: no drift — 83 generated file(s) match the committed files.
[Generate Data Entity] Schema coverage OK: 81 entity artifact(s) cover every persisted column of 85 Prisma model(s)
[generate-factory]     check: no drift — 83 generated file(s) match the committed files.
[generate-factory]     Schema coverage OK: 81 factory artifact(s) cover every persisted column of 85 Prisma model(s)
```

**Lint:**

```
$ pnpm --filter @arcaai/applications lint
✖ 182 problems (0 errors, 182 warnings)

$ pnpm --filter @arcaai/domains lint
✖ 13 problems (0 errors, 13 warnings)
```

Zero errors, and **zero warnings attributable to the files changed here** — all
195 are pre-existing `eslint-comments/require-description` noise in untouched
files. (`packages/database` has no `lint` script; `build`/`tsc` is its type gate.)

`pnpm lint` (monorepo-wide) **fails**, for a reason that predates this work and is
unrelated to it — see §4.5.

### 4.5 ⚠ Pre-existing breakage found (NOT caused by this ticket)

`pnpm lint` chains through `@arcaai/database#build` in turbo, and that build is
already broken on `dev-2.1`:

```
src/prisma/db_main/seed/__tests__/task-641-tenant-allowed-origin-policy.test.ts(33,18):
error TS2339: Property 'conditions' does not exist on type '{ action: string; subject: string; } | …'
```

**Proven pre-existing**, not assumed: the identical error reproduces with every
uncommitted `packages/database` change stashed away. The file is committed and
untouched by this work. It is a union-narrowing bug in a TASK-641 seed test
(`packages/database` compiles its `__tests__` directory, so a test-only type
error fails the package build and, transitively, `@arcaai/vox` and `@arcaai/ui`).

Consequence for this ticket's §3.8 checklist: the "**`pnpm lint` clean**" box
**cannot be ticked** until that is fixed. Per-package linting of everything this
ticket touched is clean (§4.4).

### 4.6 Not built here (other lanes / follow-ups)

- §3.7 rows **1-11, 13** — cascade, gate call site, veto, `assertProviderAvailable`,
  the 409 exception, and all R3 attribution work. Other agents.
- §3.7 row **12** — `apps/admin-console/src/features/entitlements/api/types.ts`
  and `packages/agentic-sdk-v2/src/hooks/useEntitlements.ts` still list only the
  three original features. **Not a compile break** (both declare their own
  narrower `features` shape, so an extra field on the response is ignored), but
  the new grant is consequently **invisible in the console and the SDK**. An
  operator granting it today must use `PUT /api/v1/admin/entitlements/tenants/:tenantId`
  directly. Worth closing before anyone is asked to administer this in production.
- Tests **1-21, 30-38** — cascade/gate/veto units and every e2e spec. Note that
  the e2e specs are the only place the gate is exercised end-to-end; nothing in
  this lane proves a 403 was ever produced, because this lane contains no throw
  site.
- **`entitlements.enabled` is still OFF** on `hope-v2-dev` and in `.env.test`.
  Under OD-6 that means the gate this lane built is inert until the owner flips
  it, and §3.9's pre-flight audit (every tenant already over an unenforced quota
  starts receiving 409s the moment it flips) is still owed.

### 4.2 R3 — funding attribution (+ OD-4 TTS dedup) — **DONE** 2026-08-09

Scope built: **R3 only** (§3.3, tests 12-16), plus OD-4's two-copy TTS classifier
dedup. R1 (the cascade), R4 (the veto) and R6 (the entitlement gate) are other lanes
and are NOT in this summary. R3 was built independently on purpose: the STT
misattribution below is wrong *today*, before any cascade exists, and R3 is the merge
blocker R1 cannot ship without (§3.9).

#### The wire contract — funding travels PER OVERRIDE ENTRY

`provider_overrides[<provider>].funding ∈ {"tenant", "platform"}`.

§3.3 sketched a request-level `provider_overrides_funding` as a working name. The
implementation puts it on the **entry** instead, for three reasons:

1. **A request-level field cannot express the mixed map the cascade produces.** §3.2
   rule 1 merges tenant-over-SYSTEM *per provider*, and test 3 pins exactly that
   (tenant `azure` + SYSTEM `sarvam` in one call). R3 must be right for the very case
   R1 introduces, so the label has to live at the same granularity as the merge.
2. **It rides the existing transport with no new plumbing.** The map is forwarded
   verbatim by every hop — `smr-proxy`, `smr-compat`, the TTS init frame, STT's
   `effective_config` client and the `transcribe_file` worker — so the label reaches
   both Python services without editing any of them. Several are outside this lane's
   scope and owned by concurrent work.
3. **It is inherently key-specific**, which structurally retires the
   `bool(provider_overrides)` bug class rather than patching one instance of it.

**An ABSENT `funding` means `"tenant"`, and that is exact rather than conservative.** A
sender that does not stamp funding is a gateway with no platform tier to draw from, so
every credential it is *capable* of injecting is the caller's own. In-flight requests
during a rolling deploy are therefore unchanged byte-for-byte, not merely "safe". An
*unrecognized* value degrades the same way (never silently to `platform`), so a
malformed label can never convert tenant-funded spend into a platform COGS charge.

Both services accept the field additively — the STT loaders and the TTS router read
named credential keys only, so the extra key is inert to them.

#### Changes

| File | Change |
|---|---|
| `apps/api/src/modules/speech/tts-provider-classification.ts` | **NEW.** The one TTS billing classifier — `classifyTtsProvider`, `SELF_HOSTED_TTS_PROVIDERS`, `readOverrideFunding`, `ProviderFunding`. Resolves **OD-4** for the TTS pair. Takes the map as `Record<string, unknown>` so it accepts both call sites' local wire types *and* the shared `ProviderOverrides` — and so it structurally cannot touch `api_key` |
| `apps/api/src/modules/speech/speech-proxy.controller.ts` | Local classifier + allow-list DELETED, imports the shared one; wire type carries `funding?` |
| `apps/api/src/modules/speech/tts-ws.gateway.ts` | Same — the second verbatim copy deleted |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | Wire type carries `funding?`. No logic change: the entry is already forwarded verbatim, so the label flows for free |
| `apps/smr/src/smr/models/requests.py` | `ProviderOverride.funding: ProviderFunding = "tenant"` + a `mode="before"` validator degrading an unknown value to `"tenant"` rather than 422-ing (rejecting the request would take generation down over a metering label — the opposite of this lane's fail-open posture for BYO credentials). Non-secret, so deliberately NOT a `SecretStr`: attribution must survive `model_dump()`. Inherited by `TranslateRequest`, which reuses the model |
| `apps/smr/src/smr/api/endpoints/generate.py` | `_used_byok_credential` reads the resolved provider's entry and returns `entry.funding == "tenant"` instead of testing for the key's presence |
| `apps/stt/src/stt/transcription/batch_service.py` | `resolve_usage_attribution` fixed on **two** axes: (a) new `_OVERRIDE_KEY_BY_FORMAT` makes the lookup key-specific — the old `bool(provider_overrides)` marked a Sarvam-served call BYOK because the tenant happened to hold an *Azure* key; (b) reads `entry["funding"]`, so a platform-funded call meters `CLOUD` |
| `packages/applications/src/services/usageLedger/usage-ledger.service.ts` | `warnOnUnflaggedByok` → `warnOnInconsistentCostBasis`: keeps the BYOK+INTERNAL warn and adds the **converse** — non-BYOK + `BYOK_NOTIONAL`, the mis-stamp where COGS is silently lost. Reports, never rewrites |
| `packages/applications/src/services/consultation/summary/smr-usage.ts` | **Unchanged.** `resolveDeployment(provider, byok)` is already correct once `byok` is truthful; the fix belonged upstream in SMR |

`_OVERRIDE_KEY_BY_FORMAT` records a trap the ledger's engine-id map does not:
`AZURE_FOUNDRY` meters as its own engine but takes its credential from the
**`azure-speech`** entry (`azure_foundry_loader.py`). A test imports the loaders' own
constants and asserts agreement, so the two cannot drift.

#### Tests (RED → GREEN)

| # | Test | RED evidence |
|---|---|---|
| 12 | `speech-proxy.controller.test.ts` + `tts-ws.gateway.test.ts` — platform-funded ⇒ `CLOUD`; plus a cross-provider case | 2 failures, both `deployment: "BYOK"` where `"CLOUD"` expected |
| 12 | **NEW** `tts-provider-classification.test.ts` — 13 cases over the deduplicated classifier | whole file failed (module did not exist) |
| 14 | `test_batch_service_usage_attribution.py` — key-specific (4) + funding (7) + loader-constant drift guard (4) | **5 failed, 15 passed** |
| 15 | **NEW** `test_usage_funding_attribution.py` — the `funding` field + `_used_byok_credential` (9 cases) | **5 failed, 4 passed** |
| 16 | `usage-ledger.service.test.ts` — both inconsistent pairs warn, both consistent pairs stay silent, the pair is never rewritten | 2 failures (warn not called) |
| — | `usage-outbox.drainer.test.ts` — a platform-funded call contributes its **full** cost to hourly + daily rollups, asserted beside the same call mis-stamped `BYOK_NOTIONAL` contributing `0n` | pinning (green on arrival — the drainer was always right; what was wrong was what reached it) |
| — | `smr-usage.task615.test.ts` — the platform-funded case the plan noted was missing | pinning (the decision moved to SMR, where it went RED) |

#### Verification — actual output

```
$ conda run -n arcaenv pytest apps/stt/tests/unit/test_batch_service_usage_attribution.py   # RED
5 failed, 15 passed in 0.46s
$ conda run -n arcaenv pytest apps/smr/src/smr/tests/unit/test_usage_funding_attribution.py # RED
5 failed, 4 passed in 3.63s
$ vitest run <speech + usageLedger + smr-usage>                                             # RED
Test Files  4 failed | 4 passed (8) ·  Tests  4 failed | 134 passed (138)

--- after implementation ---

$ conda run -n arcaenv pytest apps/stt/tests/unit/test_batch_service_usage_attribution.py
24 passed in 0.52s
$ conda run -n arcaenv pytest apps/smr/src/smr/tests/unit/test_usage_funding_attribution.py
9 passed in 0.01s
$ pnpm --filter @arcaai/applications build          # tsc, clean
$ pnpm --filter @arcaai/applications test
Test Files  447 passed | 1 skipped (448) ·  Tests  8464 passed | 4 skipped (8468)
$ pnpm --filter @arcaai/api build                   # nest build + tsc-alias, clean
$ pnpm test:unit                                    # exit 0
Test Files  934 passed | 2 skipped (936) ·  Tests  15915 passed | 4 skipped | 9 todo (15928)
packages/ui 656 · agentic-sdk-v2 4126 · compat-playground 223 · admin-console 1311 — all passed
$ conda run -n arcaenv pytest apps/stt/tests/unit/ apps/stt/tests/integration/
2773 passed, 44 skipped in 36.60s
$ conda run -n arcaenv pytest apps/smr/src/smr/tests/unit -p no:randomly
109 failed, 972 passed in 67.44s     # every failure is a pre-existing 401 — see below
$ conda run -n arcaenv pytest apps/smr/src/smr/tests/unit/test_usage_funding_attribution.py \
      apps/smr/src/smr/tests/unit/test_provider_overrides.py
31 passed in 0.26s
$ conda run -n arcaenv ruff check apps/stt/src/ apps/stt/tests/
All checks passed!
$ conda run -n arcaenv black --check --line-length 100 <the 5 changed .py files>
5 files would be left unchanged.
$ pnpm --filter @arcaai/applications lint
182 warnings — IDENTICAL count with the changes stashed, i.e. zero new warnings
$ pnpm --filter @arcaai/api lint
2 pre-existing prettier errors (env.descriptors.ts, task-635-live-agent-lineage.spec.ts);
0 in any file this lane touched
```

#### Pre-existing failures on `dev-2.1` HEAD — NOT caused by R3, NOT fixed here

| Command | Failure | Proof it is pre-existing |
|---|---|---|
| `pnpm api:build` | `@arcaai/database#build` — `TS2339: Property 'conditions' does not exist` at `seed/__tests__/task-641-tenant-allowed-origin-policy.test.ts:33` | Reproduced by type-checking a **pristine `git worktree` at HEAD `afa80869`**. `apps/api` itself builds clean via `pnpm --filter @arcaai/api build` |
| `pnpm stt:test` | 202 setup errors, all in `tests/e2e/test_transcription_http_api.py` — `AttributeError: module 'stt.core.database.connection' has no attribute '_engines'` (`tests/e2e/conftest.py:311`) | Both files unmodified in the working tree. Unit + integration: **2773 passed** |
| `pnpm smr:test` (unit) | **109 failures, all `assert 401 == 200`** — the TASK-639 env-leak (a module-level `app = create_app()` leaks `.env.dev`'s `SMR_SERVICE_TOKEN` into `os.environ`, so the auth middleware stops bypassing) | **A/B run.** With this lane's SMR changes stashed and the new test file moved aside: `109 failed, 963 passed`. With them applied: `109 failed, 972 passed` — same failures, `+9` = exactly the new tests. Zero regressions |
| `pnpm smr:test` (full dir) | Hangs indefinitely | `tests/e2e/` drives live Azure/Ollama/vLLM endpoints (`test_ollama_e2e.py`, `test_vllm_live.py`, …) with no local provider running. Environmental, not code |
| `pnpm smr:lint` | `I001` unsorted imports in `apps/smr/src/smr/tests/conftest.py` | File unmodified in the working tree |
| `pnpm {stt,smr}:format:check` | 316 files repo-wide | The scripts run `black` from the repo root, where the root `pyproject.toml` has no `[tool.black]`, so black falls back to line-length **88** while both apps configure **100**. A script bug, not a formatting one; CI's `lint-python` is ruff-only, so it never fires |

#### ⚠ Open R3 tail — must land before R1 merges

**STT streaming teardown is still attribution-blind.** §3.3 requires the funding signal
on the streaming summary as well; `session_manager.py:3552` computes its
`(engine, deployment)` from `self._provider_overrides` with the same dict-truthy rule
batch had. The per-entry design means the label is *already sitting in that dict* — the
call site simply needs the same key-specific + funding-aware treatment
(`_OVERRIDE_KEY_BY_FORMAT` is directly reusable). `session_manager.py` was outside this
lane's file scope. Without it, platform-funded **live** transcription mis-meters exactly
as batch did.

Also deliberately not done here: `tenant-stt-config.service.ts` (test 13 — the
`extraJson.model` cascade) belongs to R1; `IProviderConnectionService.ts` was not
touched because R1 owns it and will add `funding` to `ProviderOverrideEntry` when the
resolver starts stamping it — until then the classifier reads it structurally, so
nothing here blocks on that edit; the LLM/harness classifier pair
(`smr-usage.ts:74`, `harness-usage.mapper.ts:57`) is left alone per OD-4.

#### The one thing R1 MUST do for R3 to be worth anything

The resolver has to **stamp `funding: 'platform'` on every SYSTEM-tier entry it emits.**
Nothing in R3 can detect the omission: an unstamped platform entry defaults to `tenant`
and produces a perfectly *consistent* `BYOK` + `BYOK_NOTIONAL` pair — so the new ledger
warning stays silent, shadow metering (which filters to `CLOUD`) drops the event, and
the call bills exactly as wrongly as it does today. Test 1's
`sources[provider] === 'system'` assertion and this stamp are the same requirement.

---

## 5. Open Decisions (owner)

### Decided

| # | Decision | Owner's answer (2026-08-09) | Consequence in the plan |
|---|---|---|---|
| OD-1 | Is tenant opt-out in scope, and by which mechanism (§3.4 a/b/c)? | **DECIDED — in scope, option (a)**: a tenant-owned row with `enabled: false` is a VETO for that (service, provider). Justified by the pre-merge data check on `hope-v2-dev`, which returned **zero** disabled tenant-owned rows, so nothing existing is reinterpreted | §3.4 rewritten: three-state truth table, the exact re-run query for staging/prod with (b) as the documented fallback, the four operator-facing surfaces that must carry the semantics, and a distinct **409** error |
| OD-2 | Does a SYSTEM-key call meter as `CLOUD`, or as a new `AiDeploymentKind` member? | **DECIDED — `CLOUD`.** No new enum member, no `ALTER TYPE` | §3.3 updated: the Prisma enum, rollup tuple, `DEPLOYMENT_ALLOWANCE_ORDER` and invoice math are all untouched by R3; R3 is schema-free. Trade-off recorded: because `CLOUD` is not new, a mis-stamp is undetectable by enum-novelty checks, so test 16 and the ledger consistency assertion are not optional |
| OD-3 | Ship with R3 as the gate, or require an explicit entitlement? | **DECIDED — the ENTITLEMENT GATE.** A tenant may consume the platform default only where a per-tenant or per-plan entitlement grants it. *(This reverses the plan's prior recommendation, which was to ship with R3 + R4 and revisit)* | **New §3.5** designed against the real entitlements plane: a fourth boolean `featurePlatformDefaultCredential` on `PlanEntitlement`/`TenantEntitlement`, a new non-throwing `isFeatureEnabled` on `IEntitlementsService`, one enforcement point inside `cascadeRows`, 403 vs the veto's 409, veto-beats-grant. New R6, a Prisma migration, ~17 new tests, and **two new decisions (OD-6, OD-7)**. Four collisions with the existing entitlements plane are surfaced in **§0** |

### Open

| # | Decision | Why it cannot be defaulted | Recommendation |
|---|---|---|---|
| **OD-6** *(new — created by the OD-3 answer)* | Does the platform-default gate honour the global entitlements kill switch `entitlements.enabled`? | `entitlements.enabled` defaults to **`false`** (`entitlements.constants.ts:69`) and every one of the four existing enforcement methods returns early when it is off. **Honour it** ⇒ the gate is a no-op on `hope-v2-dev` today and provides none of the containment OD-3 was chosen for. **Ignore it** ⇒ this becomes the first enforcement path a global admin cannot switch off in an incident. There is no default that is both safe and consistent — see §0(1) | **Ignore the kill switch.** `entitlements.enabled` is a *quota* switch whose documented posture is "default OFF so customers are never blocked"; this gate's failure mode is *spending the platform's money*, where failing open is the unsafe direction. If the owner prefers consistency instead, §3.9 must state plainly that the gate is inert until the switch is turned on |
| **OD-7** *(new — created by the OD-3 answer)* | Which plan tiers carry `featurePlatformDefaultCredential = true` by default? | It is a pricing decision. TASK-638 ratified STARTER $50/mo · 50 consultations and PRO $100/mo · 250, with the SYSTEM default staying **self-hosted** and managed cloud ASR sold as an **add-on** (locked by `managed-asr-addon-posture.test.ts`). A plan-level `true` on PRO or ENTERPRISE reopens exactly that margin hole | **`false` on all four plans**; grant per tenant via `TenantEntitlement`. Keeps the change behaviour-neutral on deploy and matches how ENTERPRISE is actually sold (negotiated ⇒ per-tenant). `ENTERPRISE: true` is a defensible alternative and is a one-line change in **both** matrix copies plus tests 27 and 40 |
| OD-4 | Deduplicate `classifyTtsProvider` and the four `SELF_HOSTED_*` allow-lists now, or in a separate ticket? | Four verbatim copies of the classifier/allow-list exist (`speech-proxy.controller.ts:23`, `tts-ws.gateway.ts:23`, `smr-usage.ts:74`, `harness-usage.mapper.ts:57`); this ticket must edit two of them | **Unchanged: deduplicate the two TTS copies here** (they are edited anyway — R3 makes both funding-aware, and two hand-synced copies of a *billing* classifier is how the next mis-rating happens); leave the LLM/harness pair to its own ticket |
| OD-5 | Delete the now-redundant `resolveConnection`, or keep it as the by-provider counterpart? | It has zero production callers today; after the refactor it shares the cascade helper and costs nothing to keep | **Unchanged: keep**, sharing the cascade helper. This matters more after OD-3 than before it — a second, ungated path to the SYSTEM tier would be a hole in the single choke point, so sharing the helper is now a safety property (test 32), not just tidiness |

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-09 (rev 3) | **ENTITLEMENT LAYER (R6) IMPLEMENTED** — §3.7 rows 0a-0f, tests 22-29 + 39-41. Evidence in the new §4. OD-7 implemented as `false` on all four plans in both matrix copies and as the SQL column default; OD-6 implemented as *honour the kill switch*, so `isFeatureEnabled` returns `true` (ungated) when `entitlements.enabled` is OFF — recorded explicitly in §4.1 and pinned by test 29, because it means **the gate is inert until the owner flips the switch**. Three findings worth the owner's attention: **(1)** §3.5.7's uncertainty is RESOLVED in favour of the plan's preferred location — the parity guard lives in `@arcaai/applications/__tests__` and reaches the seed by relative source import after exporting `PLAN_ENTITLEMENTS`; the `tests/contracts/` fallback was not needed (§4.3). **(2)** `pnpm db:migrate:create` is UNUSABLE on the local dev DB — `migrate status` shows all 80 committed migrations unapplied because the database is `db push`-managed, so `migrate dev` demands a destructive reset. The migration SQL was instead generated by `prisma migrate diff` (identical to what §3.5.6 predicted) and the two columns applied additively and verified in `information_schema`; the file has never been executed *as a migration* (§4.2). **(3)** `pnpm lint` fails on a PRE-EXISTING `@arcaai/database` build error in a TASK-641 seed test — proven pre-existing by reproducing it with all local database changes stashed — so §3.8's "lint clean" box cannot be ticked by this lane (§4.5). Also noted: test 39 was green on arrival (it locks existing seed posture rather than driving new code), and the console/SDK feature lists (row 12) still omit the grant, making it administrable only via the admin API. |
| 2026-08-09 (rev 2) | **Owner answered OD-1, OD-2, OD-3; plan revised to be executable.** OD-1 → opt-out in scope, option (a) (disabled tenant row = VETO), justified by a live `hope-v2-dev` check returning **zero** disabled tenant-owned rows; §3.4 rewritten with the three-state truth table, the per-environment re-run query and (b) fallback, the four operator-facing surfaces that must carry the new meaning, and a distinct 409. OD-2 → meter as `CLOUD`; R3 is now schema-free (no `AiDeploymentKind` member, no `ALTER TYPE`). OD-3 → **the entitlement gate**, reversing this plan's prior recommendation; new §3.5 designs it against the *real* entitlements plane and adds R6 as a third merge blocker. Research findings that shaped §3.5 and are recorded in the new **§0**: **(1)** `entitlements.enabled` defaults to `false` and gates all four existing enforcement methods, so a conventional gate is a **no-op today** — raised as **OD-6**; **(2)** the three existing boolean entitlements are **enforced nowhere** (no `assertFeature`, zero call sites read `resolved.features`) — this ticket writes the first enforcement, though the schema, tri-state override, DTOs, admin CRUD and even the `feature*` → 403 mapping at `exception.interceptor.ts:331` are all pre-wired and unused; **(3)** `UNGATED_ENTITLEMENTS` resolves every boolean feature `true` (`resolve-entitlements.ts:145`), so the new member must be the first to resolve `false` or every null-plan tenant is silently granted; **(4)** the two hand-synced copies of the plan matrix (`seed/15-entitlements.ts` and `entitlements.constants.ts`) have **no parity test whatsoever** — confirmed by search; the TASK-638 "seed invariant" is `managed-asr-addon-posture.test.ts`, a different guard — so §3.5.7 adds one. Tier-contract check: a boolean grant supplies no value and only bounds whose cascade includes the SYSTEM tier, so it fits the `entitlement` tier's letter, but it is the first *enforcing* boolean and the first with `failMode: 'closed'`. Also added: **OD-7** (which plan tiers carry the grant — recommended none, per-tenant only, on TASK-638's add-on posture), §3.9 sequencing with all three merge blockers and the exact four-step precondition list for TASK-642 Step 4 (Malayalam is unblocked by the merge **plus** an admin arming the SYSTEM row **plus** a per-tenant grant — without the grant it fails with 403 instead of today's 503, which testers must be told), an entitlement/veto TDD block (tests 22-38) and three seed/parity tests (39-41), and a rewritten §3.7 file order that builds the entitlement layer first. OD-4 and OD-5 unchanged, with strengthened rationale. Still no code written. |
| 2026-08-09 | Ticket created. Defect verified end-to-end (non-cascading resolver at `ai-provider-connection.service.ts:260`, explicit `tenantId` at `AiProviderConnectionRepository.ts:111`, non-firing widening at `tenant-scope.ts:635`, dead `resolveConnection` at `:228`). Three findings that change the shape of the fix and were **not** in the raising brief: **(1)** the metering path never reads `AiProviderConnection` at all — BYOK is inferred from the presence of `provider_overrides` on the request (`batch_service.py:70`, `generate.py:158`, `classifyTtsProvider`), so the cascade would mis-rate every platform-funded call as BYOK/zero-COGS/never-invoiced, making R3 a merge blocker rather than a follow-up; **(2)** an explicit `tenantId: SYSTEM` read is already permitted from any tenant's CLS by `mergeSharedReadTenantIntoWhere`, so the fix needs no repository change and no client elevation — and conversely a repository-layer fix would be actively unsafe on the `crossTenantLane` base-client path; **(3)** call site #4 (`smr-compat.resolveSarvamByok:264`) already implements the cascade by hand, which is both the working precedent and the evidence that a per-call-site fix gets copied rather than shared. Also verified that every cloud-BYO SYSTEM seed row ships `enabled: false` and keyless, so the change is behaviour-neutral until a global admin arms it. No code written. |
