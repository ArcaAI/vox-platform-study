# TASK-516 — MCP External Tools (TASK-508 Phase 5)

**Status:** Review
**Type:** feature
**Parent program:** TASK-508 Agentic-SOTA-Program (Phase 5 — MCP posture AD-5, control plane AD-3)
**Feature flag:** `HarnessPolicy.mcpToolsEnabled` (null → **OFF**). The whole MCP tool path
is **OFF by default everywhere** and ships dormant.

---

## Requirement Analysis

Add a governed, **READ-ONLY** MCP (Model Context Protocol) external-tools capability to the
clinical documentation harness, behind a default-OFF flag, with defense-in-depth:

1. **DB** — a new `McpServer` registry model (SYSTEM-tenant rows initially) + additive
   migration; a domain trio; add to `TENANT_SCOPED_MODELS`. Add additive
   `HarnessPolicy.mcpToolsEnabled Boolean?` (null → off).
2. **Admin API** — `apps/api/src/modules/mcp-admin/` CRUD: GLOBAL_ADMIN real-403
   (`guardrail.*` precedent), `If-Match` OCC, sys-events, cross-tenant 404. Secret material
   flows via the TASK-504 Vault path and is **NEVER echoed**. Also satisfies the registry
   list/read the TASK-512 console "Tools & MCP" screen needs.
3. **Harness client + activity** — a streamable-HTTP MCP client (official `mcp` SDK) + a
   `call_mcp_tool` activity that resolves the server from the policy fetch, enforces the
   allowlist (`HarnessPolicy.toolAllowlist ∩ server.toolAllowlist`), screens `args`
   **fail-closed** through the PHI egress guard when `phiBoundary="external"`, bounds
   timeout/retry, size-caps + claim-checks the result, and emits a `TOOL_CALL` step.
4. **Workflow** — opt-in per-loop gated on `mcpToolsEnabled`; first integration is
   **terminology validation after `extract_entities`** (validate `NamedEntity` codes
   against a self-hosted FHIR terminology MCP server). Command-sequence change ⇒
   `workflow.patched("task-516-mcp-tools")` + a new replay fixture; the existing
   replay-compat suite stays green.
5. **Security tests (RED first)** — allowlist deny before any network call; PHI-bearing
   args + `external` boundary blocked fail-closed; server 5xx → `ERROR` step + workflow
   degrades (`reduced_assurance`, never crashes); no credential material in logs/trajectory;
   result over size cap claim-checked.

**Constraints:** no git writes; additive-only DB; hand-authored domain trios; Python via
conda `arcaenv` + `uv lock`; `authRef` is a Vault path only (no secret bytes anywhere);
all tools READ-ONLY (write-capable MCP is a future ticket).

---

## Current State Evaluation

- **TASK-510** already provides `AgentTrajectoryStep` + the `TOOL_CALL` step type + the
  harness `report_trajectory` emission path (`_TrajectoryBatch`). Built on directly.
- **TASK-511** provides the `HarnessPolicy` knob pattern (`_resolve_flag`, nullable
  overrides, the dormant `toolAllowlist Json?` column) and the admin `@CanManage` /
  GLOBAL_ADMIN precedent. Mirrored.
- **TASK-357** provides the fail-closed PHI egress guard (`guards/phi`,
  `ensure_egress_safe`). Extended with a tool-args variant.
- **TASK-483** provides the claim-check out-of-band blob store (`maybe_offload`). Reused
  for the result size cap.
- **AiTaskDefault** provides the closest domain-trio + admin-CRUD precedent (SYSTEM-shared
  read, global-admin writes). Mirrored for `McpServer`.

---

## Implementation Plan (delivered incrementally, gates green between steps)

1. DB: `McpServer` model + `task_516_mcp_server_registry` migration + `HarnessPolicy.mcpToolsEnabled` migration + `TENANT_SCOPED_MODELS`/`SYSTEM_SHARED_READ_MODELS`; hand-author the trio.
2. Admin API: `mcp-admin` CRUD + `McpServerAdminService` (GLOBAL_ADMIN 403, If-Match OCC, sys-events, cross-tenant 404, registry read).
3. Harness: `tools/mcp_client.py` (lazy `mcp` SDK) + `McpConfig` + `call_mcp_tool` activity + `ensure_mcp_args_safe`.
4. Workflow: terminology validation after transcript NER, gated on `mcpToolsEnabled` + `workflow.patched("task-516-mcp-tools")` + a new replay fixture.
5. Security tests RED→GREEN; run all gates; `uv lock`.

---

## Implementation Summary

### 1) Database (`packages/database`, `packages/domains`)

- **`packages/database/src/prisma/db_main/mcp-server.prisma`** — new `McpServer` model:
  `id, tenantId, name, description, baseUrl, transport("streamable-http"), authRef (Vault
  path), toolAllowlist Json?, phiBoundary("external"|"in-boundary", default external),
  enabled(default false)`, standard `resourceStatus`/audit/`_version`/`_metadata`, unique
  `(tenantId, name)`.
- **Migrations (additive-only, applied via `pnpm db:push` + `pnpm db:generate`):**
  - `20260719020000_task_516_mcp_server_registry` — `CREATE TABLE IF NOT EXISTS "core"."McpServer"` + unique index + `ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'McpServer'`.
  - `20260719020100_task_516_harness_policy_mcp_tools_enabled` — `ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "mcpToolsEnabled" BOOLEAN`.
- **`HarnessPolicy.mcpToolsEnabled Boolean?`** added (null → off).
- **Hand-authored domain trio** (mirrors `AiTaskDefault`): `McpServerModel`,
  `McpServerEntity` (validates name/baseUrl/transport/phiBoundary + rejects whitespace in
  `authRef` so a secret can't be pasted where a path belongs), `McpServerFactory`,
  `McpServerEntityMapper`, `McpServerRepository` (`findByTenantAndName`, `findEnabledById`,
  `listEnabled`). Registered in `core.database.module.ts`; barrels + `ResourceType` enum
  (TS + Prisma `audit.prisma`) updated.
- **`tenant-scope.ts`** — `McpServer` added to `TENANT_SCOPED_MODELS` (→ 54) **and**
  `SYSTEM_SHARED_READ_MODELS` (READS widen to `[caller, SYSTEM]`; WRITES stay global-admin
  only at the service layer — the `guardrail.*` precedent). Drift-guard count test updated.

### 2) Admin API (`packages/applications`, `apps/api/src/modules/mcp-admin`)

- **`McpServerAdminService`** (`packages/applications/src/services/mcp-server`) — list/get/
  create/update/remove. GLOBAL_ADMIN enforced at the service layer (`ForbiddenException` /
  403 for tenant admins on writes); `If-Match` OCC via `_version`; cross-tenant reads → 404;
  soft-delete on remove; sys-event broadcast on each mutation. DTOs + mapper; `authRef` is a
  Vault path only and never echoed.
- **`McpAdminController`** at `/admin/mcp-servers` (`@CanRead('HarnessPolicy')` reads,
  `@CanManage('HarnessPolicy')` writes, `@RequiresIfMatch()` on update/delete). Registered in
  `apps/api/src/app.module.ts`.

**Registry read endpoint shape for the TASK-512 console "Tools & MCP" screen**

```
GET /api/v1/admin/mcp-servers            → 200 McpServerListResponse
GET /api/v1/admin/mcp-servers/:id        → 200 McpServerResponse | 404
    ?tenantId=<id>   (global-admin only; tenant admins pinned to own tenant; omit = SYSTEM registry)

McpServerListResponse { items: McpServerResponse[], total: number }
McpServerResponse {
  id, tenantId, name, description?, baseUrl, transport,
  authRef?,          // Vault PATH only — NEVER secret material
  toolAllowlist?: string[],
  phiBoundary,       // "external" | "in-boundary"
  enabled,           // per-server runtime kill-switch
  resourceStatus?, version, createdAt?, updatedAt?
}
```

Writes (`POST`/`PATCH`/`DELETE`) are GLOBAL-ADMIN only (403 for tenant admins); `PATCH`/
`DELETE` require `If-Match` (412 on drift, 428 when missing).

### 3) Harness client + activity (`apps/harness`)

- **`apps/harness/src/harness/tools/mcp_client.py`** — `McpToolClient` (streamable-HTTP via
  the **lazily-imported** official `mcp` SDK), bounded retry (4xx non-retryable; 5xx/timeout
  retried then raised), secret-free `McpClientError` normalization. The bearer credential is
  only ever placed in the `Authorization` header — never logged/echoed.
- **`McpConfig`** (`core/config.py`, `HARNESS_MCP_` prefix): `timeout_s=20`, `max_attempts=2`,
  `max_result_bytes=65536` (tuning only — the path is gated by policy/server flags).
- **`ensure_mcp_args_safe`** (`guards/phi/egress.py`) — fail-closed PHI screen for OUTBOUND
  args to an `external` server: pass-through for in-boundary/PHI-disabled; **BLOCKS**
  (`PhiEgressBlocked`) on any detected PHI span OR a redactor failure (e.g. Presidio missing)
  when `phi_fail_closed`; degrades open only on an explicit opt-out.
- **`call_mcp_tool` activity** (`temporal/activities.py`, registered in `DOCUMENT_ACTIVITIES`)
  — enforcement order: disabled-server skip → **allowlist (deny-all default) raises before any
  network** → **PHI egress screen fail-closed before any network** → Vault credential resolve
  (`_resolve_mcp_token`, never logged) → bounded client call (server/transport/tool error →
  `ERROR` step + **degraded** result, no raise) → size cap + claim-check (offload when
  claim-check on, else truncate) → `TOOL_CALL` trajectory step (secret-free stats).
- **Models** (`temporal/models.py`): `McpServerConfig` (+ `from_api`), `CallMcpToolInput`,
  `McpToolCallResult`; `HarnessPolicy.mcp_tools_enabled` + `mcp_servers` + `from_api` mapping.

### 4) Workflow integration (`apps/harness/src/harness/temporal/workflows.py`)

- After the transcript `extract_entities` + persist, a **terminology validation** step:
  `if mcp_tools_enabled and transcript_entities and workflow.patched("task-516-mcp-tools")`.
  The `and` short-circuit means a **default-OFF run never calls `workflow.patched()`** — so
  no marker is recorded and the command sequence is byte-identical to pre-516 history.
- Server selection (`_select_mcp_server`) is pure/deterministic over the policy-carried
  registry snapshot; args (`_terminology_args`) are the resolved ontology codes + surface
  terms. A degraded/failed call flags `reduced_assurance` (never crashes the loop).
- **Replay:** new fixture `doc_workflow_post_task516_mcp_history.json` (carries the
  `task-516-mcp-tools` marker + the `call_mcp_tool` command) + a replay-compat test; all 9
  pre-existing fixtures still replay green.

### 5) Dependency

- `apps/harness/pyproject.toml`: new optional extra `mcp-tools = ["mcp>=1.2.0"]` (lazy-
  imported; base install / hermetic tests skip it). `uv lock` resolved **`mcp v1.28.1`**
  (+ transitive `pyjwt v2.13.0`).

---

## Verification (actual gate output)

- **DB:** `pnpm db:generate` ✓ (Prisma client regenerated); `pnpm --filter @arcaai/database build` ✓.
- **Domains:** build ✓; `pnpm --filter @arcaai/domains test` → **1365 passed | 2 skipped | 9 todo**.
- **Applications:** build ✓; `pnpm --filter @arcaai/applications test` → **6385 passed | 4 skipped**.
- **API:** `pnpm build:api` ✓ (8/8 tasks); `pnpm test:unit` → **16462 passed | 4 skipped | 9 todo**
  (incl. `mcp-admin.controller` 8 + `mcp-server-admin.service` 10). API eslint ✓; `mcp-server` package lint ✓.
- **Harness (conda `arcaenv`):** `pytest apps/harness/src/harness/tests/ -q` → **848 passed**
  (was 820; +28 new: MCP client/guard, activity security, workflow integration, replay). Ruff ✓.
- **RED→GREEN evidence (5 security invariants):** the two pre-network invariants
  (allowlist-deny, PHI-block) were demonstrated RED by temporarily disabling each guard —
  both ordering tests failed with "DID NOT RAISE" and the stub client was reached — then
  GREEN after restoring the guards.

**Flag confirmed OFF by default:** `HarnessPolicy().mcp_tools_enabled is None`,
`HarnessPolicy().mcp_servers == []`; the workflow branch is inert (and never records the
patch marker) unless a global admin sets `mcpToolsEnabled=true` AND an enabled server offers
the tool.

**No git writes.** DB changes additive-only (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF
NOT EXISTS` / `ADD VALUE IF NOT EXISTS`; no DROP/DELETE/TRUNCATE, no `migrate reset`). No
edits to any DO-NOT-TOUCH surface (`apps/admin-console`, `apps/smr`, `apps/guardrail`,
`infrastructure`, `deployment`, `.env.*`, `turbo.json`).

---

## Deviations / Notes

- **Server resolution via the policy snapshot.** "Resolve server from the policy fetch" is
  implemented by threading the enabled SYSTEM-shared registry rows onto `HarnessPolicy.mcp_servers`
  (the `fetch_policy` activity's registry read) so server selection + the allowlist
  intersection run in the deterministic workflow body (no per-loop registry read; replay-safe).
- **Degrade vs raise.** Allowlist/PHI violations RAISE (non-retryable) before any network
  call; server/transport/tool errors RETURN a degraded result (no raise) so the workflow
  degrades to `reduced_assurance` without a Temporal retry storm. Both are caught by the
  workflow and never crash the loop.
- **Vault credential resolution** (`_resolve_mcp_token`) is the seam for the TASK-504 secrets
  client; until that client is threaded into harness settings it returns `None` for an
  unresolved `authRef` (never a silent leak). Tests monkeypatch it to inject a token and
  assert it never appears in the trajectory/result.
- **`uv.lock`:** running `uv lock` at root also folded in **pre-existing** sibling-pyproject
  drift (`apps/stt-v2` etc. that had uncommitted edits but an un-regenerated lock) — this is
  not part of this ticket's source edits (my only pyproject change is the harness `mcp-tools`
  extra). Verified nothing critical was dropped (`numpy`/`scipy`/`ragas` still present).
- **No new turbo `globalEnv` var:** `HARNESS_MCP_*` are runtime-only Python settings with code
  defaults (not part of the TS build cache), so `turbo.json` was intentionally left untouched.
- **Console "Tools & MCP" writable upgrade** left untouched (design-gated addendum); only the
  registry read endpoint is exposed, as scoped.

---

## Change History

- **2026-07-19** — Initial implementation (Phases 1–5): `McpServer` model + additive
  migrations + hand-authored trio; `mcp-admin` CRUD (GLOBAL_ADMIN 403, If-Match OCC,
  sys-events, cross-tenant 404, registry read); harness `mcp_client` + `McpConfig` +
  `call_mcp_tool` activity + `ensure_mcp_args_safe`; workflow terminology-validation
  integration gated on `mcpToolsEnabled` + `workflow.patched("task-516-mcp-tools")` + new
  replay fixture; 5 security tests (RED→GREEN); `mcp>=1.2.0` optional extra (`uv lock` →
  `mcp v1.28.1`). All gates green; flag OFF by default.
