# TASK-702 — Dependency Blocker Resolutions (parent)

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-702 (parent). Children: TASK-703 / TASK-705 reserved for the TS sibling; Temporal hop is this ticket (TASK-704 folded here). |
| **Classification** | Parent playbook for leftover majors after TASK-691–701. Implements the Temporal 1.29 → 1.30.4 → 1.31.2 volume hop runbook. No lockfile edits. |
| **Date** | 2026-08-15 |

---

## Requirement Analysis

TASK-691 through TASK-701 landed the safe in-range, residual-security, and coordinated-major passes. What remains are **gated leftovers**: each one is blocked on an upstream pin, a rewrite, or a sequential data-format hop. This ticket is the parent tracker.

**Do not revert** what already landed (see Current State). **Do not** bump TypeScript 7, TanStack Table 9, pdfjs 6, openai-via-instructor, torch / NeMo, Vault 2, or MinIO AIStor from this ticket.

**Hard rules:** no `docker compose down -v`; no `DELETE` / `DROP` / `TRUNCATE`; no commit / push; do not edit `pnpm-lock.yaml` or `uv.lock` (sibling-owned). Do not change Qdrant / Grafana / Vault pins.

### Order of operations

| Order | Blocker | Gate | Owner |
|---|---|---|---|
| 1 | Temporal 1.29 volume → 1.31.2 | Hop **1.30.4** then **1.31.2**; never wipe | **This ticket** (TASK-704 folded here) |
| 2 | `harness[eval-ragas]` on openai 3 | `instructor` allows `openai>=3` | Python sibling |
| 3 | TypeScript 7 | Nest CLI drops the legacy compiler API | later / watch |
| 4 | pdfjs 6 | react-pdf drops the exact `5.4.296` pin | later / watch |
| 5 | TanStack Table 9 | Rewrite `VirtualizedDataGrid` | TS sibling [TASK-703](../TASK-703-TanStack-Table-9/README.md) |
| 6 | cryptography 49 | `presidio-anonymizer` allows `>=49` | Python sibling |
| 7 | langchain 1.3.9+ | `websockets` 16 vs `langgraph-sdk` `<16` | Python sibling |
| 8 | chalk 6 | `packages/tools` `moduleResolution` bundler / Node16 | TS sibling [TASK-705](../TASK-705-Chalk-6-ModuleResolution/README.md) |
| 9 | torch / NeMo | pyannote allows `torch>=2.9` or a NeMo 3 extra | later |
| 10 | Vault 2, MinIO AIStor, vLLM | product / ops | later |

TASK-703 and TASK-705 are **reserved** (do not steal those numbers). Their READMEs are created by the TS sibling; the links above are the expected paths. Temporal hop is **not** a separate child README — it lives in the [Temporal volume hop](#temporal-volume-hop-order-1) section below.

### Playbook principles

1. **Compatibility sets.** Move a family together or revert the whole set. One version of each library in the workspace.
2. **No compiler mix.** Do not run TypeScript 5 / 6 / 7 side by side. Workspace stays 5.9.x and admin-console stays 6.0.x until Nest CLI drops the legacy compiler API.
3. **Upstream first.** Wait for the pin that actually blocks (Nest CLI, react-pdf, instructor, presidio, langgraph-sdk, pyannote) rather than forking or force-resolving.
4. **Hop, do not jump.** Temporal cluster data format is compatible only across **successive minors**. Schema may `update-schema` in one pass; the **server binary** still goes 1.29 → 1.30.4 → 1.31.2.
5. **Verify with the owning suite.** TS leftovers: `@arcaai/ui` / `@arcaai/tools` / `@arcaai/api`. Python leftovers: `pnpm py:harness:test` / `py:smr:test` / `py:guardrail:test` (conda `arcaenv`). Temporal hop: `hope-temporal` healthy + harness replay-compat.

---

## Current State Evaluation

Landed 2026-08-15 (do not revert):

| Wave | Ticket | What landed | What was skipped / reverted |
|---|---|---|---|
| In-range TS + security | [TASK-691](../TASK-691-Safe-TS-Dependency-Bumps/README.md) / [TASK-696](../TASK-696-Residual-TS-Patches-Security/README.md) | In-range TS; React **19.2.8**; pnpm **10.34.5** | — |
| TS majors | [TASK-699](../TASK-699-Coordinated-TS-Major-Upgrades/README.md) | jsdom 30, jest-dom 7, ESLint 10, Vite 8, `@types/node` 26, OTEL 0.221, BullMQ 6 + ioredis 6, openid-client 6 + msal-node 5, day-picker 10, dropzone 20, motion 13, maplibre 6, nanoid 6, lexical 0.49, puppeteer 25 | **TypeScript 7** (Nest CLI 11 legacy compiler API); **TanStack Table 9** (`VirtualizedDataGrid` `getHeaderGroups()` crash); **pdfjs 6** (react-pdf 10.4.1 exact-pins 5.4.296); **chalk 6** (`packages/tools` classic `moduleResolution`) |
| Infra pins + majors | [TASK-694](../TASK-694-Infra-CI-Dependency-Pins/README.md) / [TASK-698](../TASK-698-Residual-Infra-Security-Pins/README.md) / [TASK-701](../TASK-701-Coordinated-Infra-Major-Upgrades/README.md) | Vault **1.21.4**, Prometheus **3.13.2**, Grafana **13.1.2**, Qdrant **v1.19.0**, Temporal **server / admin-tools 1.31.2** + UI **2.53.1** (auto-setup removed), `docker:28` | Vault 2, MinIO AIStor, vLLM |
| Python | [TASK-695](../TASK-695-Safe-Python-Dependency-Bumps/README.md) / [TASK-697](../TASK-697-Residual-Python-Patches-Security/README.md) / [TASK-700](../TASK-700-Coordinated-Python-Major-Upgrades/README.md) | FastAPI 0.141.1; openai **3.1.0** on SMR + `harness[eval]`; mcp 2.0; temporalio 1.31; qdrant-client 1.19; torch **2.8** ml / **2.12.1** nemo; cryptography **48** (presidio `<49`); langchain **1.3.2** | `harness[eval-ragas]` stays openai **2.54** (`instructor` pins `<3`); cryptography 49; langchain 1.3.9+ (websockets 16 vs langgraph-sdk); torch / NeMo majors |

**Temporal compose today** (`infrastructure/docker/docker-compose.dev.yml`, `temporal` profile):

| Service | Image default |
|---|---|
| `temporal-admin-tools` / `temporal-create-namespace` | `temporalio/admin-tools:${TEMPORAL_ADMINTOOLS_VERSION:-1.31.2}` |
| `temporal` (`hope-temporal`) | `temporalio/server:${TEMPORAL_VERSION:-1.31.2}` |
| `temporal-ui` | `temporalio/ui:${TEMPORAL_UI_VERSION:-2.53.1}` |

Persistence is two dedicated databases inside shared `hope-postgres` (`temporal`, `temporal_visibility`) — **not** a Temporal-only volume. Wiping Postgres to “fix” Temporal would also wipe the app `hope` DB. That is why `down -v` is forbidden.

`temporalio/auto-setup` is deprecated and has **no** 1.30 / 1.31 tags. Last auto-setup tag is **1.29.7**. `temporalio/admin-tools:1.29.7` **does not exist**.

There is no existing `docs/operations/` Temporal page (Vault / inference / observability only). The hop runbook stays in this ticket plus a compose comment and a print-only helper. No extra operations doc.

---

## Implementation Plan

1. Write this parent playbook (order table, principles, child links, landed inventory).
2. Document the Temporal hop against current compose + [TASK-701](../TASK-701-Coordinated-Infra-Major-Upgrades/README.md) I2 notes + Temporal’s sequential-minor upgrade rule.
3. Add a short hop comment on the Temporal block in `docker-compose.dev.yml` (do not change Qdrant / Grafana / Vault pins or image tags).
4. Add a **print-only** helper (`scripts/temporal-volume-hop.sh`, `pnpm infra:dev:temporal-hop`) that prints the hop commands and never wipes volumes or runs SQL DDL/DML wipes.
5. Cross-link from TASK-701, `scripts/README.md`, and `infrastructure/README.md`.
6. Set status `Review` when the runbook is complete. Sibling blockers stay tracked in the order table until their owners land them.

**TDD / suite gates for this ticket:** none (docs + print-only script). Owning suites for later rows are listed under Playbook principles.

---

## Temporal volume hop (order 1)

Canonical operator runbook for a leftover **auto-setup 1.29.x** Temporal DB after TASK-701 switched compose to server / admin-tools **1.31.2**.

Official rule ([Temporal upgrade-server](https://docs.temporal.io/production-deployment/self-hosted-guide/upgrade-server)): upgrade **one minor at a time**; patch the current minor first; backward compatibility is only between successive minors. Skipping minors can leave shard / cluster metadata unreadable.

### When you need this

`hope-temporal` crash-loops or stays unhealthy after `pnpm infra:dev:up`, and the machine previously ran `temporalio/auto-setup:1.29.x`. Fresh clones with empty `temporal` / `temporal_visibility` databases do **not** hop — admin-tools 1.31.2 creates current schema and 1.31.2 starts.

Print the commands (does not apply them):

```bash
pnpm infra:dev:temporal-hop
```

### Never

| Forbidden | Why |
|---|---|
| `docker compose down -v` / any `-v` on `down` | Drops `hope-postgres-data-pg18` (app DB + Temporal DBs). |
| `DROP` / `DELETE` / `TRUNCATE` on `temporal`, `temporal_visibility`, or `hope` | Destroys workflow history or PHI. |
| Jumping `1.29.x` → `1.31.2` on an existing cluster | Server data format is successive-minor only. |
| Pinning `temporalio/admin-tools:1.29.7` | **Tag does not exist.** |
| Changing Qdrant / Grafana / Vault image pins | Out of scope; already current. |

`pnpm infra:dev:down` is already volume-preserving (`down --remove-orphans` only). Prefer **not** taking the whole stack down; recreate Temporal via `infra:dev:up` with version overrides.

### Image map

| Hop | Server | Schema tools | Notes |
|---|---|---|---|
| 1.29.1 → 1.29.7 (fallback only) | `temporalio/auto-setup:1.29.7` | same image (last auto-setup line) | Use only if 1.30.4 refuses 1.29 data. `admin-tools:1.29.7` does not exist. |
| 1.29.x → **1.30.4** | `temporalio/server:1.30.4` | `temporalio/admin-tools:1.30.4` | First split-image line. Visibility schema → v1.13. |
| 1.30.4 → **1.31.2** | `temporalio/server:1.31.2` | `temporalio/admin-tools:1.31.2` | Compose default. Core schema v1.19, visibility v1.14. |
| UI (unchanged during hop) | — | `temporalio/ui:2.53.1` | Requires server ≥ 1.16. Leave at 2.53.1. |

SQL `update-schema` from admin-tools 1.31.2 can apply versioned migrations in one pass (`infrastructure/docker/configs/temporal/scripts/setup-postgres.sh` is idempotent: `create` / `setup-schema -v 0.0` may fail if the DB exists; `update-schema` always runs in place). The **server binary** still needs the consecutive-minor hop.

### Primary hop (1.30.4, then 1.31.2)

From the monorepo root. Shell exports win over the generated compose env file.

```bash
# 1) Recreate Temporal on the intermediate minor. Do not pass -v.
TEMPORAL_VERSION=1.30.4 TEMPORAL_ADMINTOOLS_VERSION=1.30.4 pnpm infra:dev:up

# 2) Wait until hope-temporal is healthy (gRPC :7233).
docker inspect --format '{{.State.Health.Status}}' hope-temporal
# expected: healthy
# or: pnpm infra:dev:validate / pnpm stack:dev:doctor

# 3) Recreate on the compose default (1.31.2).
pnpm infra:dev:up
```

UI stays `2.53.1`. Postgres, Vault, Qdrant, Grafana stay on their current pins.

If 1.31 admin-tools already ran `update-schema` during a failed 1.31.2 start, still hop the **server** 1.30.4 → 1.31.2. If admin-tools 1.30.4 errors because the schema is already newer, leave the schema as-is and recreate only the server:

```bash
TEMPORAL_VERSION=1.30.4 pnpm infra:dev:up
# wait healthy, then
pnpm infra:dev:up
```

### Fallback if 1.30.4 refuses 1.29 data

`admin-tools:1.29.7` does not exist. Last auto-setup is **1.29.7**. Temporarily run `temporalio/auto-setup:1.29.7` against the **same** `hope-postgres` (`DBNAME=temporal`, `VISIBILITY_DBNAME=temporal_visibility`) until that container is healthy, then take the primary hop (1.30.4 → 1.31.2). Do not restore auto-setup as the default compose layout. Do not wipe volumes.

### Read-only confirmation (optional)

`SELECT` only — never `DELETE` / `DROP` / `TRUNCATE`.

```bash
docker exec hope-postgres psql -U postgres -d temporal -c \
  "SELECT curr_version, min_compatible_version FROM schema_version;"
docker exec hope-postgres psql -U postgres -d temporal_visibility -c \
  "SELECT curr_version, min_compatible_version FROM schema_version;"
```

1.31.0 expects PostgreSQL core schema **v1.19** and visibility **v1.14**. After a successful hop, `hope-temporal` is healthy and harness replay-compat (`apps/harness` Temporal replay tests) remains the Python gate — do not revert `temporalio` 1.31.

### Verify

| Check | Expected |
|---|---|
| `docker inspect --format '{{.Config.Image}}' hope-temporal` | `temporalio/server:1.31.2` (or the digest for that tag) |
| `docker inspect --format '{{.State.Health.Status}}' hope-temporal` | `healthy` |
| Temporal UI | http://localhost:8233 |
| `pnpm infra:dev:validate` | Temporal listed healthy |
| Harness replay (if Python env is up) | `test_replay_compat` still green; `temporalio` stays 1.31 |

---

## Implementation Summary

Parent playbook and Temporal hop runbook are in this README. Status `Review` (runbook complete). Orders 2–10 remain open for their owners; this ticket does not bump those packages.

### What this ticket implemented

| Item | Detail |
|---|---|
| Parent playbook | Order-of-operations table, principles, landed inventory, child links |
| Temporal hop runbook | 1.30.4 then 1.31.2; auto-setup 1.29.7 fallback; never wipe |
| Compose comment | Temporal block in `docker-compose.dev.yml` points here |
| Print-only helper | `scripts/temporal-volume-hop.sh` → `pnpm infra:dev:temporal-hop` |
| Cross-links | TASK-701 Change History; `scripts/README.md`; `infrastructure/README.md`; `apps/harness/.env.sample` comment |

### What this ticket did **not** change

- Image pins: Temporal defaults stay **1.31.2** / UI **2.53.1**; Qdrant **v1.19.0**; Grafana **13.1.2**; Vault **1.21.4**
- `pnpm-lock.yaml`, `uv.lock`, TypeScript / Python dependency ranges
- No volume wipe, no `DELETE` / `DROP` / `TRUNCATE`, no commit / push
- No new `docs/operations/` Temporal page (none existed to append)

### Files changed

- `docs/implementation/TASK-702-Dependency-Blocker-Resolutions/README.md` (this file)
- `infrastructure/docker/docker-compose.dev.yml` (Temporal hop comment only)
- `scripts/temporal-volume-hop.sh` (new, print-only)
- `package.json` (`infra:dev:temporal-hop` alias)
- `scripts/README.md`
- `infrastructure/README.md` (Temporal hop pointer)
- `apps/harness/.env.sample` (comment-only hop knobs; source for generated `.env.sample`)
- `docs/implementation/TASK-701-Coordinated-Infra-Major-Upgrades/README.md` (Change History + hop pointer)

### Child / reserved tickets

| Ticket | Path | Role |
|---|---|---|
| TASK-703 | `docs/implementation/TASK-703-TanStack-Table-9/README.md` | Reserved — TS sibling, Table 9 / `VirtualizedDataGrid` |
| TASK-704 | *(folded into this README)* | Temporal volume hop — no separate child file |
| TASK-705 | `docs/implementation/TASK-705-Chalk-6-ModuleResolution/README.md` | Reserved — TS sibling, chalk 6 / `packages/tools` resolution |

---

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Created TASK-702 parent playbook. Documented leftover blockers in order. Implemented Temporal 1.29 → 1.30.4 → 1.31.2 hop runbook, compose comment, and print-only `pnpm infra:dev:temporal-hop`. Folded TASK-704 into this ticket. Status `Review`. |
| 2026-08-15 | Moved hop comments from generated `.env.sample` into `apps/harness/.env.sample` (env:sync source) so `scripts/__tests__/env-sync.test.ts` stays green. |
