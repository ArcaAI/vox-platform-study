# TASK-846 — MCP Connector Tenant Scoping

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `feature` |
| **Parent program** | TASK-837 §4 (AI Platform Consolidation) |
| **Branch** | `worktree-agent-ae7533eff611c1692` → merges into `dev-2.2` |
| **Scope** | **Connector half ONLY.** The node-descriptor tool/MCP fields are TASK-847. |
| **Opened / worked** | 2026-09-01 |

---

## 1. Owner decisions this ticket implements

Both were taken in decision round 2 of TASK-837 on 2026-09-01 and are recorded here as the
instrument that changes the code.

### OD-7 — tenant admins MAY configure MCP connectors and tools

This **explicitly reverses** `.claude/rules/05-nestjs-api.md`, which named "MCP writes" as a
deliberate super-admin-only exception in its Imperative Privilege Checks table. That rule file is
**amended in this same change** (§4) — the codebase and its rules must not disagree.

The declarative half of the grant already existed: seeded tenant-admin roles hold
`manage:McpServer` in CASL (`packages/database/src/prisma/db_main/seed/01-policy.ts:224-225`).
Only the imperative `assertSuperAdmin()` in the service overrode it. **No seed or policy change was
needed** — this ticket removes an override, it does not widen a grant.

### OD-11 — MCP tools are PER-TENANT

`HarnessPolicy.mcpToolsEnabled` becomes a per-tenant setting resolved on the standard
tenant → SYSTEM cascade. A platform-wide emergency kill-switch may sit above it, but it is not the
per-tenant control. Without this, OD-7 is cosmetic: connectors become configurable and nothing
becomes invocable.

---

## 2. Requirement analysis

One screen manages MCP connectors — interfaces to external MCP services that the agentic harness
may call. Tenant admins must be able to configure their own; the shared platform registry must stay
platform-owned; and the PHI containment posture must not weaken anywhere.

The three things that had to stay exactly true while the gate opened:

1. **404-over-403 for cross-tenant.** A connector belonging to another customer tenant must remain
   indistinguishable from one that does not exist.
2. **403 for privilege.** A refusal on a row the caller can already READ is a privilege boundary,
   and saying so leaks nothing.
3. **No credential in a DB column.** Outbound connector auth stays a Vault reference.

---

## 3. Current state evaluation (verified 2026-09-01, extends finding F-15)

Substantially more was built than "MCP is a stub" suggests:

| Piece | Location | State |
|---|---|---|
| Prisma model | `packages/database/src/prisma/db_main/mcp-server.prisma:31-79` | Real, tenant-scoped, `_version` OCC, soft delete |
| Gateway module | `apps/api/src/modules/mcp-admin/mcp-admin.controller.ts` | Real, full CRUD, If-Match OCC |
| Admin screen | `apps/admin-console/src/features/tools-mcp/` | Real, tested, full CRUD |
| MCP protocol client | `apps/harness/src/harness/tools/mcp_client.py` | Genuine, wraps the official `mcp` Python SDK |

Gated four independent ways: the `(global)` route group, a UI `isElevated` check, the imperative
`assertSuperAdmin()`, and the platform-wide `HarnessPolicy.mcpToolsEnabled`.

### Two findings this ticket adds to F-15

**F-15a — the "secrets" and "allow-list" work items were already done.** The brief asked whether
outbound connector credentials sit in a plaintext DB column, and asked for a per-tenant tool
allow-list. Reading the model settles both:

- `McpServer.authRef` is **a Vault PATH only** (`mcp-server.prisma:50-52`), documented as such in
  the model header, validated path-like by the DTO, and never echoed as secret material. **There is
  no column that could hold a bearer/OAuth token.** No schema change is needed, and none was made.
- `McpServer.toolAllowlist` **already exists** (`mcp-server.prisma:56`), and the model header
  already declares the effective allow-list as `HarnessPolicy.toolAllowlist ∩ McpServer.toolAllowlist`.
  Both halves are per-tenant once OD-7 and OD-11 land, and the intersection is already **enforced
  fail-closed at call time** in the harness activity (`activities.py:1114`) — so the containment
  boundary becomes per-tenant **as a consequence of this ticket**, with no new table and no new
  enforcement code. See §8 for what is genuinely still open.

**F-15b — a silent second blocker the brief did not name.** `HarnessPolicyService.resolveMcpServers()`
read `where: { tenantId: SYSTEM_TENANT_ID }` — **SYSTEM rows only**. Under OD-7 a tenant admin
registers an OWN-TENANT connector, which would therefore never appear in the effective policy and
never reach the Temporal worker. The tenant would have been handed a switch wired to nothing. Fixed
here; pinned by a test.

---

## 4. Implementation summary

### 4.1 Authorization — the SYSTEM-vs-tenant-owned split gate

`packages/applications/src/services/mcp-server/mcp-server-admin.service.ts`

`assertSuperAdmin()` (an unconditional 403 for any non-super-admin write) is replaced by two gates
that follow the **precedent already documented in `05-nestjs-api.md`** — `assertCanApprove` on
`POST admin/prompt-templates/:id/approve`:

| Write target | Super admin | Tenant admin | Why |
|---|---|---|---|
| SYSTEM (`00000000-…`) registry row | allowed | **403** | Privilege. The row is READABLE by every tenant (it is a `SYSTEM_SHARED_READ_MODELS` model), so hiding its existence would be a lie. |
| Another customer tenant's row | allowed | **404** | 404-over-403 — never leak existence. |
| Its OWN tenant's row | allowed | **allowed** | OD-7. |

- `assertCanWriteTenant(targetTenantId)` gates **create** — no row exists yet, so nothing can be
  hidden and every refusal is a 403.
- `assertCanWriteRow(rowTenantId)` gates **update/delete** on an already-resolved row.

**Ordering is load-bearing and changed.** The old code gated BEFORE the row lookup, so an unknown id
returned 403 while a real-but-foreign id returned 404 — an existence oracle over the id space. Both
gates now run AFTER `findEnabledById`, so an unknown id is 404 for every caller.

In practice the extended client's `[caller, SYSTEM]` widening already makes a foreign row invisible;
`assertCanWriteRow`'s 404 branch is what keeps that true if a row ever arrives through the unscoped
super-admin base-client lane.

**The `// AUTH-NOTE:` marker is kept and rewritten** at the route
(`apps/api/src/modules/mcp-admin/mcp-admin.controller.ts`), verbatim:

> `AUTH-NOTE: SYSTEM-vs-tenant-owned SPLIT GATE — the decorators UNDERSTATE the real rule, which
> McpServerAdminService enforces imperatively. Per OWNER DECISION OD-7 (2026-09-01) a tenant admin
> holding manage:McpServer MAY create, update and delete connectors owned by its own tenant; a write
> aimed at the SYSTEM (00000000-…) shared registry stays SUPER_ADMIN-only and returns 403 — a
> privilege boundary, and the row is readable so its existence is not hidden. A row belonging to
> ANOTHER tenant returns 404 (404-over-403), and existence is resolved BEFORE privilege so an unknown
> id is 404 for everyone. This reverses the former "MCP writes are super-admin only" rule;
> .claude/rules/05-nestjs-api.md was amended in the same change. No single decorator can express
> "super-admin for the SYSTEM row, ability-gated for every other row of the same resource" — same
> shape as POST admin/prompt-templates/:id/approve.`

**No decorator changed**, so `apps/api/route-manifest.json` is byte-identical after regeneration —
the route-authz matrix's expectations for this controller are unaffected.

### 4.2 `mcpToolsEnabled` per-tenant (OD-11)

`packages/applications/src/services/harness-policy/harness-policy.service.ts`

1. **Left `SUPER_ADMIN_ONLY_POLICY_KEYS`.** Membership in that list does two things at once: it 403s
   a tenant PATCH, and it makes `getEffectivePolicy` OVERLAY the SYSTEM value on top of any tenant
   row. Removing the key fixes both — the tenant's own value now wins, and a tenant admin may set it
   through the `PATCH admin/harness/policy` route it already holds `manage:HarnessPolicy` for.
2. **Added `TENANT_INHERITS_ON_NULL_KEYS`.** A tenant policy row is created on the first edit of
   *any* knob (a clinical threshold, say). Without null-widening, that unrelated edit would freeze
   `mcpToolsEnabled` at `null ⇒ OFF` for the tenant, silently revoking a platform default it had
   been inheriting — a tenant would disable MCP by editing a faithfulness threshold. `null` is
   therefore treated as **"no opinion"** and widens to SYSTEM, which is the two-tier cascade every
   other config surface uses. Unset in both tiers still means OFF.
3. **`resolveMcpServers(tenantId)` widened to `[tenant, SYSTEM]`** (F-15b). This is a **union**, not
   an override cascade — a registry, where the shared platform servers stay available to every
   tenant and the tenant's own are added. Scoping to two tiers keeps the boundary: no other
   customer's rows, ever. A SYSTEM-tenant caller still resolves SYSTEM only.

### 4.3 Console — tier move to 20–29 and both modes

- **Route moved** `(console)/(global)/tools-mcp` → `(console)/(shared)/tools-mcp`. The `(global)`
  layout `notFound()`s every non-elevated session, which is the route-group-level gate that had to go.
- **No redirect stub, deliberately.** `13-nextjs-apps.md` requires a one-release `redirect()` for a
  **retired or renamed** route. This is a **retier, not a rename**: Next.js route groups are excluded
  from the URL, so the path is `/tools-mcp` before and after. No bookmark, deep link or nav entry
  changes, so there is nothing to redirect — and a stub left at `(global)/tools-mcp` would resolve to
  the *same* path and fail the build as a duplicate route. The reasoning is recorded in the page's
  own doc comment so the next reader does not file it as a missed step.
- **Nav** (`nav-config.ts`): tier `10-19` → `20-29`, and the ability gate narrows from the
  `manage:all` super-admin proxy to the resource's own `manage:McpServer` (which `manage:all` still
  matches, so super admins are unaffected). Domain stays `ai-platform` — domain and tier are
  orthogonal by OD-2/OD-3.
- **Both modes, resolved per ROW rather than per screen.** The screen-wide "Super Admins only" empty
  state is gone.

  | Caller | Sees | Writes |
  |---|---|---|
  | Super admin, no working tenant | SYSTEM registry | everything |
  | Super admin, working tenant selected | that tenant's rows + SYSTEM | everything |
  | Tenant admin | own connectors + SYSTEM (shared, read-only) | own rows only |

  An "Owner" column distinguishes *Platform* from *This tenant*. Locked controls are `disabled` with
  the reason in the accessible name (`Edit X — unavailable: Platform connector — managed by super
  administrators`) rather than colour alone, per rule 11 §5/§11. The UI never offers an action the
  gateway would refuse.
- **OD-11 status banner.** When the effective gate is off the screen says so: connectors are
  configurable but the harness will not call any of them. The banner is **advisory** — a caller
  without `read:HarnessPolicy` simply gets no banner, never a "disabled" claim we cannot substantiate.

### 4.4 `DetailDrawer` deviation fixed

`mcp-server-form-dialog.tsx` hand-rolled a `Dialog` for record edit — one of only two such deviations
on this surface (rule 11 §Detail Surface). It now uses the console-wide `DetailDrawer`.

Two things worth flagging for the reviewer, because the naive conversion is wrong:

- `DetailDrawer` takes its body and its pinned footer as **two separate nodes**, and one component
  cannot render into both. The form is therefore a **hook** (`useMcpServerForm`) returning
  `{ body, footer }`, with the `<form>` element wrapping the footer controls and the inputs as
  controlled state in the body — the `setting-drawer.tsx` pattern.
- The old dialog re-initialised field state by remounting the form with `key={server.id}`. A hook
  cannot be remounted, so it uses React's sanctioned **"adjust state during render when a prop
  changes"** pattern instead. Same effect, no `useEffect`, and the drawer itself never remounts
  (which would reset focus and replay the open animation).

### 4.5 Rule amendment — `.claude/rules/05-nestjs-api.md`

See §5 for the exact diff. Three edits: MCP writes removed from the super-admin-only row, added to
the split-gate row, and a dated OD-7/OD-11 amendment note plus the existence-before-privilege
ordering rule that both split-gate implementations now share.

---

## 5. Files changed

| File | Change |
|---|---|
| `.claude/rules/05-nestjs-api.md` | **Rule amendment** (OD-7/OD-11) — §4.5 |
| `packages/applications/.../mcp-server/mcp-server-admin.service.ts` | Split gate replaces `assertSuperAdmin()`; existence resolved before privilege |
| `packages/applications/.../mcp-server/__tests__/mcp-server-admin.service.test.ts` | 3 reversed assertions retargeted at the SYSTEM tier |
| `packages/applications/.../mcp-server/__tests__/mcp-server-admin.tenant-scoping.task846.test.ts` | **NEW** — 10 tests: own-tenant CRUD, SYSTEM 403, cross-tenant 404, unknown-id 404, secret hygiene |
| `packages/applications/.../harness-policy/harness-policy.service.ts` | `mcpToolsEnabled` per-tenant; `TENANT_INHERITS_ON_NULL_KEYS`; `resolveMcpServers([tenant, SYSTEM])` |
| `packages/applications/.../harness-policy/__tests__/harness-policy.mcp.test.ts` | 2 reversed assertions updated with the OD-11 citation |
| `packages/applications/.../harness-policy/__tests__/harness-policy.mcp-per-tenant.task846.test.ts` | **NEW** — 8 tests: cascade both directions, null-widening, tenant PATCH, registry union |
| `apps/api/src/modules/mcp-admin/mcp-admin.controller.ts` | Rewritten `AUTH-NOTE`, Swagger summaries/descriptions/403 texts |
| `apps/admin-console/src/app/(console)/(global)/tools-mcp/**` → `(shared)/tools-mcp/**` | Tier move (git rename) |
| `apps/admin-console/src/shared/navigation/nav-config.ts` | `/tools-mcp` tier `20-29`, gate `manage:McpServer` |
| `apps/admin-console/src/shared/navigation/__tests__/nav-config.test.ts` | Frozen rail table + tier counts follow the move |
| `apps/admin-console/src/shared/layout/__tests__/app-sidebar.test.tsx` | AI Platform now spans three tiers |
| `apps/admin-console/src/features/tools-mcp/components/tools-mcp-screen.tsx` | Both modes; per-row write gate; OD-11 banner |
| `apps/admin-console/src/features/tools-mcp/components/mcp-server-form-dialog.tsx` | `Dialog` → `DetailDrawer` |
| `apps/admin-console/src/features/tools-mcp/api/{client,hooks,keys,types}.ts` | `useMcpGate` for the OD-11 banner |
| `apps/admin-console/src/features/tools-mcp/components/__tests__/tools-mcp-screen.test.tsx` | Super-admin gate test replaced by 6 OD-7/OD-11 tests |
| `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/openapi.admin.json`, `packages/vox-node/src/resources/admin/mcp-server.ts` | **Regenerated** |

`apps/api/route-manifest.json` is unchanged — no decorator or scope changed.

### The exact rule-file diff

```diff
-| **Super-admin-only action on a tenant-manageable resource** | `SUPER_ADMIN_ONLY_TASK_PREFIXES` (AiTaskDefault), `SUPER_ADMIN_ONLY_POLICY_KEYS` (HarnessPolicy), the `globalOnly` descriptor lock (PipelinePolicy), MCP writes | There is no "super admin" subject; … |
+| **Super-admin-only action on a tenant-manageable resource** | `SUPER_ADMIN_ONLY_TASK_PREFIXES` (AiTaskDefault), `SUPER_ADMIN_ONLY_POLICY_KEYS` (HarnessPolicy), the `globalOnly` descriptor lock (PipelinePolicy) | There is no "super admin" subject; … |

 | **SYSTEM-vs-tenant-owned split gate** | `POST admin/prompt-templates/:id/approve` … (404-over-403)
+. **Also `POST`/`PATCH`/`DELETE admin/mcp-servers` since OD-7** (`assertCanWriteTenant` /
+`assertCanWriteRow` in `mcp-server-admin.service.ts`) | … |

 These are 403s (privilege), NOT the 404-over-403 cross-tenant posture …
+
+**Order matters in a split gate: resolve EXISTENCE first, privilege second.** Gating before the
+row lookup makes an unknown id 403 while a real-but-foreign id is 404, which hands a caller an
+existence oracle over the id space. Both split-gate implementations look the row up first, then
+decide — copy that ordering, not just the two branches.
+
+> **AMENDED 2026-09-01 — OWNER DECISION OD-7 (TASK-846).** MCP writes were previously listed in the
+> first row above as a deliberate super-admin-only exception. **That is reversed: tenant admins MAY
+> configure MCP connectors and tools.** `manage:McpServer` was already granted to the seeded
+> tenant-admin roles in CASL (`seed/01-policy.ts`); only the imperative `assertSuperAdmin()` in
+> `McpServerAdminService` overrode the declarative grant, and it has been replaced by the
+> SYSTEM-vs-tenant-owned split gate in the third row. A tenant admin now CRUDs its OWN tenant's
+> connectors; the SYSTEM (`00000000-…`) shared registry stays super-admin-only (403), and another
+> tenant's row stays 404. Per **OD-11** of the same decision round, `HarnessPolicy.mcpToolsEnabled`
+> is likewise PER-TENANT — it left `SUPER_ADMIN_ONLY_POLICY_KEYS` and resolves on the standard
+> tenant → SYSTEM cascade, widening only on absence.
```

---

## 6. Verification evidence

### RED first (TDD) — 11 failures before any implementation

```
FAIL  harness-policy.mcp-per-tenant.task846.test.ts > a tenant's own TRUE wins over a SYSTEM false
FAIL  harness-policy.mcp-per-tenant.task846.test.ts > a tenant's own FALSE wins over a SYSTEM true
FAIL  harness-policy.mcp-per-tenant.task846.test.ts > a tenant admin may PATCH it on its own policy row
FAIL  harness-policy.mcp-per-tenant.task846.test.ts > resolveMcpServers scopes to [tenant, SYSTEM]
FAIL  mcp-server-admin.tenant-scoping.task846.test.ts > create writes a row owned by the CALLER tenant
FAIL  mcp-server-admin.tenant-scoping.task846.test.ts > update of an own-tenant row succeeds under CAS
FAIL  mcp-server-admin.tenant-scoping.task846.test.ts > delete of an own-tenant row soft-deletes
FAIL  mcp-server-admin.tenant-scoping.task846.test.ts > an id belonging to another tenant is 404
FAIL  mcp-server-admin.tenant-scoping.task846.test.ts > a foreign row … is still 404 for a tenant admin
FAIL  mcp-server-admin.tenant-scoping.task846.test.ts > an UNKNOWN id is 404 … existence before privilege
FAIL  mcp-server-admin.tenant-scoping.task846.test.ts > a tenant-admin create stores … a Vault PATH only
Test Files  2 failed (2)
Tests  11 failed | 8 passed (19)
```

Representative failure messages, showing the tests were exercising the real old behaviour:

```
ForbiddenException: HarnessPolicy fields [mcpToolsEnabled] are managed by super administrators only.
 ❯ HarnessPolicyService.assertNoSuperAdminOnlyPolicyWrites harness-policy.service.ts:660:11

AssertionError: expected '00000000-0000-0000-0000-000000000000' to deeply equal { in: [ 'tenant-1', …(1) ] }
```

### GREEN

```
# the two new suites
Test Files  2 passed (2)
Tests  19 passed (19)

# pnpm --filter @arcaai/applications test
Test Files  625 passed | 1 skipped (626)
Tests  10653 passed | 4 skipped (10657)

# pnpm --filter @arcaai/api test
Test Files  267 passed | 2 skipped (269)
Tests  4109 passed | 4 skipped (4113)

# pnpm --filter @arcaai/admin-console test   (incl. the axe 0-violations scan)
Test Files  255 passed (255)
Tests  2222 passed (2222)
```

The three required authorization outcomes, each asserted by name:

| Requirement | Test |
|---|---|
| Tenant admin CRUDs own-tenant connectors | `create writes a row owned by the CALLER tenant, not the SYSTEM registry` + update + delete |
| Cross-tenant id → **404** | `an id belonging to another tenant is 404` and `a foreign row reached through the super-admin base-client lane is still 404` |
| Insufficient privilege → **403** | `a tenant admin updating a SYSTEM-owned row gets 403, not 404` (+ delete, + create) |
| `mcpToolsEnabled` off ⇒ configurable, not invocable, with a clear UI state | `warns that connectors are configurable but NOT invocable while the per-tenant gate is off` |
| No plaintext credential | `a tenant-admin create stores and echoes a Vault PATH only — never credential material` |

### Builds, lint, generated artifacts

```
# pnpm --filter @arcaai/applications build      -> tsc, clean
# pnpm api:build                                -> Tasks: 12 successful, 12 total
# pnpm --filter @arcaai/api lint                -> 65 problems (0 errors, 65 warnings)   [warnings pre-existing]
# pnpm --filter @arcaai/admin-console lint      -> eslint src --max-warnings 0, clean

[emit-route-manifest] wrote 700 routes (438 admin, 408 machine-reachable)   # unchanged vs committed
[emit-openapi] wrote 480 paths to apps/api/openapi.json
[gen-api-portal] wrote 623 admin / 185 business operations
[vox-node-codegen] wrote 55 files (52 areas, 408 routes, 372 schemas)

[openapi-coverage] OK — every served route is either documented or deliberately excluded.
[gen-api-portal] no drift (admin 623 ops, business 185 ops)
[vox-node-codegen] no drift (52 areas, 408 routes, 372 schemas)
```

### One gate NOT green, and it is not ours

`pnpm --filter @arcaai/admin-console build` fails. **Verified pre-existing**: the failure is entirely
in `apps/admin-console/instrumentation.ts` (Edge-Runtime rejections of `node:fs/promises`, `node:os`,
`process.pid`, `process.once`), a file this ticket never touches and which last changed on
2026-08-13 (`b7f0b85a7`). Proven by restoring the baseline console source over the change
(`git checkout HEAD~1 -- apps/admin-console/`) and rebuilding — the identical four
`instrumentation.ts` errors appear:

```
./apps/admin-console/instrumentation.ts:196:3   Ecmascript file had an error
./apps/admin-console/instrumentation.ts:197:3   Ecmascript file had an error
./apps/admin-console/instrumentation.ts:116:27  Ecmascript file had an error
./apps/admin-console/instrumentation.ts:69:32   Ecmascript file had an error
```

The change's own console gates — `lint`, `test` (255 files / 2222 tests, axe included) and
`tsc --noEmit` — are all green.

---

## 7. Runtime verification NOT performed

`13-nextjs-apps.md` requires runtime verification in a running app (`next-dev-loop` or a headed
browser pass). **Not done here**, for a reason worth stating rather than burying: `next build` cannot
complete in this tree (§6), and `next dev` for this app needs the gateway plus the seeded local
infra, which is the orchestrator's shared surface and off-limits to a worktree agent. Both themes and
the WCAG pass therefore rest on the jsdom + axe suite only. **A headed pass on `/tools-mcp` as both a
super admin and a tenant admin should be part of accepting this ticket.**

---

## 8. Deferred — schema work, with the proposed design

The brief flagged credentials and the tool allow-list as possible schema work. Neither needed a
schema change (§3, F-15a), so none was made — `packages/database/src/prisma/db_main/**` and
`packages/domains/**` were **not touched**, per the TASK-843 collision warning. What genuinely
remains:

### D-1 — the tenant-side half of the allow-list intersection (small, no schema change)

`HarnessPolicy.toolAllowlist` already exists and is already tenant-overridable (it is NOT in
`SUPER_ADMIN_ONLY_POLICY_KEYS`), so `HarnessPolicy.toolAllowlist ∩ McpServer.toolAllowlist` is a
per-tenant containment boundary today. What is missing is **surface, not storage**: the console has
no editor for `toolAllowlist` on the policy side, so a tenant admin can restrict tools per-server but
not per-tenant-across-servers. Proposal: add the field to the `/agentic-policy` knob editor
(`agentic-knobs.ts`), which already owns that row. No migration.

### D-2 — nothing to do: the intersection is already enforced (checked, not assumed)

Worth recording because the shape of the code invites the opposite conclusion.
`_select_mcp_server` (`workflows.py:211`) tests only `tool in server.tool_allowlist`, which reads
like the policy half of the intersection was dropped. It was not — that function is a *deterministic
pre-selection* inside the workflow body, and the authoritative check happens at call time in the
activity: `_effective_mcp_allowlist(payload.policy_tool_allowlist, server.tool_allowlist)`
(`activities.py:1114`, documented at `activities.py:1046`), reached from both the legacy workflow
(`workflows.py:665`) and the interpreter node (`interpreter/nodes/consultation_nlp.py:230`).

So `HarnessPolicy.toolAllowlist ∩ McpServer.toolAllowlist` is enforced fail-closed today, and since
both operands are per-tenant, **the containment boundary this ticket was asked to build already
exists end to end.** The only missing piece is D-1's editor.

### D-3 — egress allow-list for tenant-authored `baseUrl` (needs a design decision, likely schema)

OD-7 lets a tenant admin point a connector at an arbitrary host reachable from inside the cluster.
`phiBoundary` defaults to `external` and the harness PHI-egress guard screens outbound args
fail-closed for external servers, so PHI does not leak by default — but SSRF reachability is a
separate axis from PHI screening. Proposed design, for an owner decision rather than an agent's:
a platform-level host allow-list (a `global-kv` `GlobalSetting`, no migration) validated at
`McpServer` create/update, plus a NetworkPolicy egress restriction on the harness worker. A
per-tenant override would need a new table; a platform-wide list would not. **Recommend starting
platform-wide.**

### D-4 — a stale comment in a tree this ticket must not touch

`packages/database/src/prisma/db_main/seed/01-policy.ts:219-224` still reads *"MCP WRITES remain
super-admin-only regardless — `McpServerAdminService` throws 403 for a tenant admin (defense in
depth)"*. The **grant itself is correct and unchanged**; only the comment is now wrong. It was left
alone because that tree is owned by a concurrent TASK-843 agent (§one writer per file). One-line
follow-up.

---

## 9. Change history

| Date | Change |
|---|---|
| 2026-09-01 | Ticket opened from TASK-837 §4. Implemented OD-7 (split gate, existence-before-privilege), OD-11 (per-tenant `mcpToolsEnabled` + null-widening + `[tenant, SYSTEM]` registry union), the tier 10-19 → 20-29 console move with both modes, the `DetailDrawer` conversion, and the `05-nestjs-api.md` amendment. Found and fixed F-15b (`resolveMcpServers` was SYSTEM-only). Confirmed F-15a — credentials and the per-server allow-list needed no schema change. Status `Review`. |
