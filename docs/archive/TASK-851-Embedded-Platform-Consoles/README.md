# TASK-851 — Embedded MLflow, Temporal and MinIO Consoles

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track E |
| **Tier / Effort** | `sonnet` / medium (proxy + layout); `opus` / high (authorization); `haiku` (upstream header probe) |
| **Depends on** | TASK-838 ✅, TASK-842 ✅, TASK-840 |
| **Blocked by** | TASK-840 (MLflow must be running) |

## 1. Requirement Analysis

Embed the MLflow, Temporal and MinIO consoles in the admin console.

**⚠ Access rule (OD-6): platform admin (SUPER_ADMIN) ONLY. Tenant admins are not eligible for any of the three.** This is a **403 privilege boundary**, not the 404-over-403 cross-tenant posture. Each route carries a `// AUTH-NOTE:` marker and a class- or handler-level decorator so the deny-by-default boot audit stays green. **OD-6 is what makes this safe** — Temporal's ui-server performs no namespace-level authorization at all, and MinIO's console performs none either; embedding them would be indefensible if any tenant principal could reach them.

## 2. Current State Evaluation

Program finding **F-18**. All three services **already have native shipped console surfaces** (`features/storage-browser`, `features/mlflow`, `features/harness-ops` — the last already tenant-filtered with cancel/terminate/signal), so the request is largely delivered by a better pattern than embedding. `features/db-studio` + `modules/pstudio/` is a **working same-origin embed template**: the gateway serves the HTML behind an ability check, the cookie rides along, and no token reaches the browser.

**Hard constraint:** the session cookie is **host-only, `SameSite=Lax`** (`session.ts:88-96`), so any cross-origin embed — **including a subdomain** — will not receive it. Traefik and subdomain patterns are eliminated unless the cookie is widened, which for PHI is a regression to refuse. **Same-origin BFF is the only viable pattern.**

**MLflow is the fast win** — `mlflow-screen.tsx` already renders a conditional iframe the moment a live `X-Frame-Options` probe flips `embeddable`, so enabling it is a deployment action, not a code change. **MinIO cookie hazard (TASK-842 §3.5):** its console cookie is named `token` at `Path=/` and must be scoped or stripped by the proxy.

## 3. Implementation Plan

The authoritative step-by-step plan is **[TASK-837 §4 → TASK-851 — Embedded MLflow, Temporal and MinIO Consoles](../TASK-837-AI-Platform-Consolidation-Program/README.md)**,
which carries the numbered steps, the traps, and the per-step evidence requirements. It is reproduced here by
reference rather than copied, so the two cannot drift while this ticket is unstarted.

**Expand this section into the full step list at the moment work starts**, per
`01-development-workflow.md` Phase 3 — and get owner approval before any code is written.

## 4. Verification Criteria

See TASK-837 §4 for this ticket's verification block. Program-wide gates in TASK-837 §3.5 apply regardless.

## 5. Implementation Summary

Not started.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket document created and aligned to TASK-837 §4. Not started. |
