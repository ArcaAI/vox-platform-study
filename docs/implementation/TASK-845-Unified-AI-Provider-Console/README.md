# TASK-845 — Unified AI Provider Console Screen

| Field | Value |
|---|---|
| **Status** | `Pending` — plan written 2026-09-01, awaiting owner approval before code |
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

## 3. Implementation Plan

1. **Target IA — one screen, tabs by USER INTENT, not by table.**
   - **Providers** — every provider configuration, filterable by task; the elected-default badge per task.
   - **Tasks** — the four product tasks, each showing its elected default and its ordered fallback chain
     (now real rows on `AiRoutingPolicy`, not a string join).
   - **Model catalogue** — `AiModel`, what configurations select from.
   - **Model store** — MinIO `hope-models` browser + **download from HuggingFace** (OD-2).
   - **Engines** — LM Studio / vLLM / MLflow health and runtime state (platform-admin only).
2. **Tenancy is a selector, not a route.** `/ai-task-defaults` and `/ai-configuration` collapse into one
   screen with a SYSTEM-vs-tenant control, matching the two-tier cascade the backend already implements.
3. **Move `/ai-operations/reconciliation` out of `ai-platform`** into Platform Ops. It is a FinOps tool.
4. **Retire `/ai-runtime-profiles` as a top-level screen** — surface it as a section of the provider
   configuration, not a peer screen.
5. Every retired route keeps a `redirect()` for one release, with a comment naming the deleting release.
   **Note the TASK-846 precedent:** a route-GROUP change (`(global)` → `(shared)`) does NOT change the URL,
   so it needs no stub — and adding one would be a duplicate-route build failure. Distinguish a *retier* from
   a *rename* before writing a stub.
6. **Export/import UI** over TASK-844's masked export. The UI must **never render a full secret**, and must
   state plainly that imports require re-supplying credentials. TASK-844 deliberately emits a
   `vault-transit:<service>:<provider>:v<n>` reference and `hasCredential` — **no "last 4"**, because
   producing it would require decrypting a live key, which is partial disclosure rather than masking.
7. **HuggingFace download** (model store tab): model the Hub flow — `huggingface_hub`, LFS, resumable
   transfer, disk space. **Gated models require a human to accept terms on the Hub per repo and cannot be
   automated** — surface that as an explicit, actionable error state, never a silent failure.
8. Accessibility: axe **0 violations** per tab, both themes, plus a keyboard pass.

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

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Plan written and aligned to TASK-837 §4, OD-2/OD-3/OD-8. Awaiting approval before code. |
