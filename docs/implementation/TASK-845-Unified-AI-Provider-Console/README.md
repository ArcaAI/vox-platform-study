# TASK-845 — Unified AI Provider Console Screen

| Field | Value |
|---|---|
| **Status** | `Review` — implemented 2026-09-01 on `worktree-agent-ab0a9ff68134ad491`; unmerged, Playwright run outstanding |
| **Type** | `feature` / `refactor` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track B |
| **Tier / Effort** | `opus` / high (information architecture — the verdict acted on); `sonnet` / high (component build); `sonnet` / medium (a11y pass) |
| **Depends on** | TASK-843 ✅, TASK-844 ✅ — **both landed; this is unblocked** |
| **Owns** | `apps/admin-console/src/features/ai-*`, the `ai-platform` nav domain |

## 1. Requirement Analysis

The owner's words: *"one screen for managing all AI inference providers and configurations"*, plus
*"one interface for managing local models store in the s3/minio bucket. Including download from huggingface."*

Bounded by standing owner decisions:
- **OD-2** — HuggingFace is a model **SOURCE**, never an inference provider. The download-to-MinIO feature is
  a STORAGE capability on this screen, not a provider configuration.
- **OD-3** — `AiTaskDefault` is absorbed into `AiRoutingPolicy` (done in TASK-844). Tenancy is a SELECTOR on
  one screen, not two screens.
- **OD-8** — no Azure translation. Translation is offered only where a native endpoint exists (Sarvam).
- **TASK-799 D-6** — LM Studio / vLLM / MLflow are platform-managed; tenant admins cannot configure them.
  Already the law; needs no new gating work.

## 2. Current State Evaluation

Program findings **F-6** (the string-joined chain, now resolved by TASK-844) and the TASK-837 inventory.

**The chaos is information architecture, not component standards.** Template conformance is already good:
17/17 screens use `ScreenTemplate`; 15/17 use `DetailDrawer`. Only `/tools-mcp` and `/rate-limits` hand-roll
bespoke Dialogs — and `/tools-mcp`'s was fixed in TASK-846.

14 routes carry `domain: 'ai-platform'`, carved up by which Prisma table they write:

| Screen | What it is | Overlap |
|---|---|---|
| `/ai-task-defaults` (global) | `AiTaskDefault` at `tenantId = SYSTEM` | **Same controller, same model** as below |
| `/ai-configuration` → Models tab (tenant) | `AiTaskDefault` at `tenantId = caller` | ↑ differs only by tenant + exposed task-key prefixes |
| `/ai-models` | The catalogue both select from | — |
| `/ai-runtime-profiles` | Hyperparameter/capacity table | Consumed at **exactly one** runtime call site |
| `/ai-operations/reconciliation` | **Vendor billing auditor** — never touches `AiModel` | Belongs in Platform Ops |
| `/ai-model-defaults` | Already a `permanentRedirect` stub | — |

Credentials already have exactly ONE write surface (`/ai-configuration` → Providers → `AiProviderConnection`);
the LM Studio and vLLM screens are read-only mirrors. **There is no model-store screen** — only the generic
`/storage` browser and a filtered read-only view inside each engine screen.

## 3. Implementation Plan — as executed

The eight planned steps, expanded into what was actually done. Nothing in the
plan was dropped; two things were done differently and both are called out.

### Step 0 (unplanned, and a blocker) — the read shape TASK-844 left behind

`AiRoutingPolicy` was re-grained to one row per provider configuration, with
real `providerConnectionId` / `modelId` FKs and an `isDefault` election enforced
by a partial unique index — but `AiRoutingPolicyResponse` and its mapper stayed
on the pre-re-grain shape. All nine fields existed on the entity and in
`ProviderConfigurationRow`; **none of them was reachable over HTTP**. A console
cannot render "which provider serves this task, and which row is elected" from a
payload containing neither, so the Providers and Tasks tabs were unbuildable
until this was fixed. Widened the DTO + mapper, added
`ai-routing-policy.dto.mapper.test.ts`, and regenerated the drift-gated
artifacts (§6).

### Step 1 — one screen, tabs by USER INTENT

`/ai-platform`, five tabs:

| Tab | Owns | Backed by |
|---|---|---|
| **Providers** | onboarding or changing a vendor — its connection, the configurations selecting it, and the knobs tuning it | `AiRoutingPolicy` + `AiProviderConnection` + `AiRuntimeProfile` |
| **Tasks** | "what actually serves X?" — elected default, gated fallback chain, refused candidates, plus the tenant's own `text.*` selection | `admin/routing-policies/effective` + `AiTaskDefault` |
| **Model catalogue** | what a configuration may select (read-only; `/ai-models` stays the editor) | `AiModel` |
| **Model store** | which weights we hold, and how to acquire more | `/storage/*` + `AiModel` |
| **Engines** | are the serving engines up | discovery probe |

### Step 2 — tenancy is a selector, not a route

`useAiPlatformScope` + `ScopeControl`: a two-position tier switch (platform
default <-> working tenant), persisted in `?scope=`, parameterising every read.
Exactly two tiers — the working tenant is chosen in the shell switcher, so
"Global" (`50000000-…`) is reachable only as the customer tenant it is, never as
a third tier. A tenant-bound caller sees no switch at all rather than a disabled
one implying a scope they could reach. `/ai-task-defaults` retired into it.

### Step 3 — reconciliation out of `ai-platform`

`/ai-operations/reconciliation` retagged to `platform-ops`. **Domain retag only**
— the URL, tier and ability gate are untouched, so it is neither a rename nor a
retier and takes no stub.

### Step 4 — `/ai-runtime-profiles` retired as a rail PEER, not as a route

Its rail entry is gone; the URL survives and is reached from the Providers-tab
section it tunes. A runtime profile tunes a `(provider, model)` pair, so a rail
peer implied it was a sibling of the configurations rather than their knobs. The
URL never moved, so **no stub** — a stub would have been a duplicate route.

### Step 5 — retired routes, each CLASSIFIED before acting

| Route | Classification | Action |
|---|---|---|
| `/ai-task-defaults` | **RENAME** — same screen, new URL | `permanentRedirect('/ai-platform?tab=tasks')`, in `(shared)` so a tenant admin is forwarded rather than `notFound()`ed by the `(global)` layout. Delete one release after this ships. |
| `/ai-runtime-profiles` | nav-only retirement | none — URL unchanged |
| `/ai-operations/reconciliation` | domain retag | none — URL unchanged |
| `/ai-configuration` | **NARROWED**, not retired | none — URL unchanged |

The TASK-846 precedent held: a stub is for a URL that MOVED. The guard test now
pins both `redirect` and `permanentRedirect`, since mocking only the former made
a `permanentRedirect` page fail as a TypeError rather than as a missing redirect.

### Step 6 — export / import, secret-free

`ConfigurationTransferDrawer` renders the `credentialRef` LOCATOR and
`hasCredential`, and nothing else. Its test plants a live-looking key **inside
the artifact fixture** — the gateway never emits one, but a fixture carrying
only what the server sends would pass whether or not the component was careful.
The import tab states in the UI that credentials cannot be restored, that rows
bind to the target tenant's own connections, and that imports land as DRAFTs and
are never elected.

### Step 7 — HuggingFace acquisition (**deviation, deliberate**)

The plan says "model the Hub flow — `huggingface_hub`, LFS, resumable transfer,
disk space". **No such backend exists**, and this ticket's own risk table says
long transfers belong in a job, not a request. Shipping a download button wired
to an endpoint nobody has written would be a dead control.

What this platform actually has is the acquisition path the STT weight fetcher
already uses: catalogue a repo as `source: HUGGINGFACE` with a `hf:<org>/<repo>`
`sourceUri`, and the fetcher resolves the Hub token and the model-store S3 pair
through the `model-registry:huggingface` / `model-registry:s3` connections and
pulls on first use. So the drawer submits that acquisition INTENT, and says so
in the UI rather than implying bytes moved.

**The gated case is first-class, per the plan.** A required acknowledgement
blocks submission until the operator confirms the repo's terms were accepted on
the Hub by a human under the account whose token the platform holds; a 401/403
surfaces as an explicit error naming the repo and linking to it. Silent failure
is the outcome the design rules out.

### Step 8 — accessibility

axe at 0 violations on all five tabs in BOTH themes (10 vitest-axe cases), plus
5 Playwright axe cases against a running stack. One real defect surfaced while
writing the tests and was fixed: the tier control named its tenant button from
the ACTIVE scope, so it announced "Tenant configuration — Platform default
(SYSTEM)" while the platform tier was selected — a control describing the state
it was leaving.

### The one other deviation

**`/ai-configuration` is narrowed, not retired.** Its Models and Providers tabs
moved; Speech and Voice stayed. `TenantSttConfig` / `TenantTtsConfig` are
pipeline and voice BINDINGS resolved on their own rows, not provider
configuration on the routing cascade — folding them into a provider console
would recreate exactly the by-which-table grouping this ticket exists to remove.
The screen is relabelled "Speech & Voice" and links to where the other two went.

## 4. Verification Criteria

- `pnpm --filter @arcaai/admin-console build lint test`.
- Runtime verification in a running `next dev` via the `next-dev-loop` skill — **compiling is not working**.
- Every retired route redirects; no dead links from `nav-config.ts`.
- axe 0 violations per tab, both themes.
- A Playwright E2E covering both tenancy modes, following the `tools-mcp.spec.ts` pattern from TASK-846.

## 5. Risks

| Risk | Mitigation |
|---|---|
| A "one screen" with five tabs is just the old chaos in a tab bar | Tabs are by **user intent**; the merge only works because TASK-844 unified the model underneath |
| Retiring routes breaks deep links | One-release `redirect()`; distinguish retier from rename (step 5) |
| Secret leaks via the export UI | TASK-844's `assertNoSecretMaterial` test is the gate; the UI must not re-add a hint |
| Model-store downloads block the request thread | Long transfers belong in a job, not a request |

## 6. Implementation Summary

### Files changed

**Backend — the read-shape gap (step 0)**

| File | Change |
|---|---|
| `packages/applications/src/services/ai-routing-policy/dto/ai-routing-policy.response.ts` | +9 fields: `taskKind`, `displayName`, `providerConnectionId`, `modelId`, `modelRef`, `isDefault`, `enabled`, `residency`, `baaCovered` |
| `packages/applications/src/services/ai-routing-policy/ai-routing-policy.dto.mapper.ts` | projects them; every absent optional emits `null` rather than being dropped |
| `packages/applications/src/services/ai-routing-policy/__tests__/ai-routing-policy.dto.mapper.test.ts` | new — 3 cases |
| `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/openapi.{admin,business}.json` | regenerated (+45 lines each) |

**Console — the unified screen**

| File | Change |
|---|---|
| `apps/admin-console/src/features/ai-platform/api/{types,keys,client,hooks,index}.ts` | new — the `admin/routing-policies` plane; every query key carries its tenant |
| `apps/admin-console/src/features/ai-platform/api/{model-store-client,model-store-hooks,catalogue-client,engine-health-client,runtime-profile-client}.ts` | new — minimal read-only copies (rule 13) |
| `apps/admin-console/src/features/ai-platform/components/ai-platform-screen.tsx` | new — the five-tab shell |
| `…/components/{use-ai-platform-scope.ts,scope-control.tsx}` | new — the tenancy control |
| `…/components/{providers-tab,tasks-tab,catalogue-tab,model-store-tab,engines-tab}.tsx` | new — the five tabs |
| `…/components/{task-routing-card,provider-connections-section,configuration-transfer-drawer,huggingface-fetch-drawer}.tsx` | new |
| `…/api/__tests__/routing-policies-api.test.ts`, `…/components/__tests__/ai-platform-screen.test.tsx` | new — 17 + 32 cases |
| `apps/admin-console/src/app/(console)/(shared)/ai-platform/{page,loading}.tsx` | new route |
| `apps/admin-console/src/app/(console)/(shared)/ai-task-defaults/page.tsx` | new redirect stub |
| `apps/admin-console/src/app/(console)/(global)/ai-task-defaults/` | deleted |
| `apps/admin-console/src/shared/catalog/ai-task-keys.ts` | new — the task-key registry, declared once |
| `apps/admin-console/src/features/ai-task-defaults/api/types.ts` | re-exports it instead of duplicating |
| `apps/admin-console/src/features/ai-task-defaults/components/tenant-ai-configuration-screen.tsx` | narrowed to Speech + Voice |
| `apps/admin-console/src/shared/navigation/nav-config.ts` | `/ai-platform` added; two rail entries retired; reconciliation retagged; `/ai-configuration` relabelled + re-gated |
| `apps/admin-console/tests/e2e/ai-platform.spec.ts` | new — 17 Playwright cases |
| `…/__tests__/{nav-config,tenant-ai-configuration-screen,retired-route-redirects}` | moved to the new contracts |

### Evidence

```
$ pnpm --filter @arcaai/admin-console build
   OK Compiled successfully in 9.8s
   exit 0        # routes present: /ai-platform  /ai-task-defaults  /ai-configuration  /ai-runtime-profiles

$ pnpm --filter @arcaai/admin-console lint
   > eslint src --max-warnings 0
   exit 0

$ pnpm --filter @arcaai/admin-console typecheck
   > tsc --noEmit
   exit 0

$ pnpm --filter @arcaai/admin-console test
   Test Files  257 passed (257)
        Tests  2259 passed (2259)
   exit 0        # includes 10 axe scans: 5 tabs x 2 themes, 0 violations

$ pnpm --filter @arcaai/applications test
   Test Files  631 passed | 1 skipped (632)
        Tests  10811 passed | 4 skipped (10815)
   exit 0

$ pnpm api:openapi:check                          -> exit 0
$ pnpm api:portal:check                           -> exit 0
$ pnpm --filter @arcaai/vox-node gen:admin:check  -> exit 0

$ npx playwright test --list ai-platform.spec.ts
   Total: 17 tests in 2 files
```

### Not done

- **The Playwright RUN.** The cases collect; executing them needs `setup:test` /
  `test:up:api`, which this agent was not authorised to start. Handed to the
  orchestrator. Assertions were NOT weakened to pass without a backend.
- **Manual keyboard + 200 %-zoom pass.** Automation catches under ~57 % of WCAG
  issues (`11-ux-ui-principles.md` §11); the manual half is outstanding.
- **`next-dev-loop` runtime verification.** Same reason — no running stack.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Plan written and aligned to TASK-837 §4, OD-2/OD-3/OD-8. Awaiting approval before code. |
| 2026-09-01 | Implemented on `worktree-agent-ab0a9ff68134ad491`. Steps 1-8 done; §3 expanded to what was executed. Two deviations, both recorded above: HuggingFace acquisition is a catalogue-and-fetch intent because no download job exists to call, and `/ai-configuration` is narrowed rather than retired because speech/voice bindings are not provider configuration. Found and fixed a blocker TASK-844 left: nine re-grain fields existed on the entity but not on the wire, so no client could see the elected default. Found and fixed a tier-control label that named the active scope instead of the tenant it switches to. Status `Review` — unmerged, Playwright run outstanding. |
