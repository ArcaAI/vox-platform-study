# Walkthrough sequence & progress tracker

This is the single place to check **what to read next** and **what documentation already exists**.
It is a tracker, not a tutorial — open the linked file for the actual content.

**Last updated:** 2026-11-05
**Repo state:** `project-hope` branch `dev-2.2`, HEAD `8cb2e5e8e`
**Scope:** read-only notes under `review/api_explore/read/`. Nothing in `project-hope/` is modified.

---

## Status legend

| Symbol | Meaning |
|---|---|
| ✅ | **Complete** — written, cross-linked, and verified against the working tree |
| 🟡 | **In progress** — file exists but is partial, stale, or needs a revision pass |
| ⬜ | **Planned** — not written yet; the row tells you what it will contain |
| ⏸ | **Deferred** — deliberately out of scope for now |

A document is only ✅ when its relative links resolve and its line numbers/counts were checked at the HEAD above. All existing documents pass that check.

---

## Master sequence

Read top to bottom. Each phase assumes the previous one.

| Order | Phase | Document | You learn | Status | Link |
|---|---|---|---|---|---|
| 0 | 1 · Orientation | Repo root map | Which directory is the live repo; what every top-level folder is | ✅ | [00-REPO-ROOT-MAP.md](./00-REPO-ROOT-MAP.md) |
| 1 | 1 · Orientation | `apps/api` map | The gateway's shape: 78 feature modules, route prefixes, tests, entrypoints | ✅ | [01-APPS-API-MAP.md](./01-APPS-API-MAP.md) |
| 2 | 2 · Boot & pipeline | Boot sequence & request pipeline | `main.ts` 24-step boot, 8 guards, interceptor/filter order, 12 audits | ✅ | [02-API-BOOT-AND-REQUEST-PIPELINE.md](./02-API-BOOT-AND-REQUEST-PIPELINE.md) |
| 2a | 2 · Boot & pipeline | **Subfolder:** imports explained | NestJS concepts, every `@nestjs/*` package, npm libraries, `@arcaai/*` packages, local files | ✅ | [02-main-ts/00-README.md](./02-main-ts/00-README.md) |
| 2b | 2 · Boot & pipeline | Diagram: `main.ts` | Seven boot phases + full step tree with file references | ✅ | [02-main-ts/07-visual-boot-flow.md](./02-main-ts/07-visual-boot-flow.md) |
| 2c | 2 · Boot & pipeline | Diagram: `app.module.ts` | DI composition, 8 guards, hooks, filters, feature-module anatomy | ✅ | [02-main-ts/08-visual-request-pipeline.md](./02-main-ts/08-visual-request-pipeline.md) |
| 2d | 2 · Boot & pipeline | Diagram: imports | Four kinds of import and where each one comes from | ✅ | [02-main-ts/09-visual-import-map.md](./02-main-ts/09-visual-import-map.md) |
| 3 | 3 · First slice | Tenant-allowed-origin walkthrough | One request from controller → service → repository → Prisma, plus OCC/ETag, the wildcard/SYSTEM gates, and the CORS invalidation loop | ✅ | [03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md](./03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md) |
| 4 | 4 · Layers | Applications layer | How a service module is built, DTOs, secrets, auth, queues | ⬜ | `04-APPLICATIONS-LAYER.md` |
| 5 | 4 · Layers | Domains layer | Entities, factories, mappers, repositories, unit of work | ⬜ | `05-DOMAINS-LAYER.md` |
| 6 | 4 · Layers | Database layer | Prisma client, soft delete, tenant scope, migrations, seeds | ⬜ | `06-DATABASE-LAYER.md` |
| 7 | 5 · Auth | Auth deep dive | `UnifiedAuthGuard`, 3 credential classes, CASL, consent | ⬜ | `07-AUTH-DEEP-DIVE.md` |
| 8 | 6 · Largest domain | Consultation walkthrough | The 57-file domain: lifecycle, attachments, consent, events | ⬜ | `08-CONSULTATION-WALKTHROUGH.md` |

**Progress:** 14 / 19 walkthrough documents complete · 0 in progress · 5 planned. (Two additional meta files: this tracker and `README.md`.) Counted by sequence step: `02-main-ts/` and `03-tenant-allowed-origin/` each count as one unit, however many files they contain.

---

## Phase detail

### Phase 1 · Orientation (✅ complete)

```
00  repo root        ──► 01  apps/api map
     where am I?           what is in the gateway?
```

Do not skip `01`: it is the map you will return to whenever a walkthrough mentions a module you have not seen.

### Phase 2 · Boot & pipeline (✅ complete)

```
02  main.ts + app.module.ts
 │
 └─ 02-main-ts/
     ├─ 01  NestJS in 10 minutes          ← concepts first
     ├─ 02  framework packages            ← @nestjs/*
     ├─ 03  third-party libraries         ← express-session, zod, OTel…
     ├─ 04  @arcaai packages              ← applications / domains / database
     ├─ 05  local app code                ← ./bootstrap, ./config, ./guards
     ├─ 06  import reference              ← lookup table
     ├─ 07  visual: boot flow             ← diagrams
     ├─ 08  visual: request pipeline      ← diagrams
     └─ 09  visual: import map            ← diagrams
```

**Visual learners can read `07 → 08 → 09` first** and use `01–06` as the glossary.

### Phase 3 · First vertical slice (✅ complete)

[03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md](./03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md) follows the smallest complete module instead of the whole app. It is the bridge between the boot-level reading in Phase 2 and the layer deep dives in Phase 4.

```
modules/tenant-allowed-origin/tenant-allowed-origin.module.ts
        │
        ▼
modules/tenant-allowed-origin/tenant-allowed-origin.controller.ts
        │  @CanManage · @RequiresIfMatch · @ForbidApiKey
        ▼
packages/applications/src/services/tenant-allowed-origin/
        ├─ tenant-allowed-origin.service.module.ts
        └─ tenant-allowed-origin.service.ts
        │  exact vs wildcard origin · system-tenant rule · 404-over-403
        ▼
packages/domains/src/repositories/generated/core/TenantAllowedOriginRepository.ts
        │
        ▼
packages/database/src/prisma/db_main/tenant-allowed-origin.prisma
```

Why this module first: it is only **4 local files** plus one service and one repository, and it explains the CORS gate used at `main.ts:291` — so it connects back to Phase 2 instead of starting a new topic.

### Phase 4 · The three layers (⬜ planned)

```
04  @arcaai/applications  →  what a "service module" is and how it is wired
05  @arcaai/domains       →  entities, repositories, transactions
06  @arcaai/database      →  Prisma, soft delete, tenant scope, migrations
```

Read in that order. It is the dependency direction, reversed: `database → domains → applications`.

### Phase 5 · Auth (⬜ planned)

```
07  UnifiedAuthGuard
     ├─ JWT branch
     ├─ API-key branch
     └─ service-account branch
     + CASL policy engine + consent choke point
```

Do not read this before Phase 4. The guard resolves services from `@arcaai/applications`, and the permission model is defined there.

### Phase 6 · Largest domain (⬜ planned)

```
08  modules/consultation/  (57 files)
     ├─ lifecycle + attachments + feedback + telemetry
     ├─ internal controllers (harness, consent, read)
     └─ consent + OCC + tenant-scope boundaries
```

This is intentionally last: it assumes guards, CASL, consent, repositories, and OCC (ETag/If-Match) are already understood.

---

## `02-main-ts/` subfolder detail

Use this table when you need one specific file.

| # | File | Answers | Status |
|---|---|---|---|
| 00 | [00-README.md](./02-main-ts/00-README.md) | Index, reading order, Nest-vs-project table | ✅ |
| 01 | [01-nestjs-in-10-minutes.md](./02-main-ts/01-nestjs-in-10-minutes.md) | Module, controller, provider, DI, guard, interceptor, pipe, filter | ✅ |
| 02 | [02-framework-packages.md](./02-main-ts/02-framework-packages.md) | Every `@nestjs/*` package; core vs official vs community | ✅ |
| 03 | [03-third-party-libraries.md](./02-main-ts/03-third-party-libraries.md) | `express-session`, `uuidv7`, `zod`, OpenTelemetry, `bullmq`… | ✅ |
| 04 | [04-arcaai-workspace-packages.md](./02-main-ts/04-arcaai-workspace-packages.md) | `@arcaai/applications` / `domains` / `database` / `exceptions` | ✅ |
| 05 | [05-local-app-code.md](./02-main-ts/05-local-app-code.md) | Every `./` import, all 14 boot audits, `src/` tree | ✅ |
| 06 | [06-import-reference.md](./02-main-ts/06-import-reference.md) | One-line lookup for every import in `main.ts` / `app.module.ts` | ✅ |
| 07 | [07-visual-boot-flow.md](./02-main-ts/07-visual-boot-flow.md) | Diagram: 7 phases, full `main.ts` tree, ordering constraints | ✅ |
| 08 | [08-visual-request-pipeline.md](./02-main-ts/08-visual-request-pipeline.md) | Diagram: module graph, 8 guards, filters, feature anatomy | ✅ |
| 09 | [09-visual-import-map.md](./02-main-ts/09-visual-import-map.md) | Diagram: import provenance + dependency direction | ✅ |

## `03-tenant-allowed-origin/` subfolder detail

The walkthrough has a short overview (the main file) and five chapters. Read them in
order; each is self-contained and links back to the overview.

| # | File | Answers | Status |
|---|---|---|---|
| — | [03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md](./03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md) | Feature, file map, 60-second mental model, chapter index | ✅ |
| 01 | [01-http-to-controller.md](./03-tenant-allowed-origin/01-http-to-controller.md) | URL math, routes, decorators, guard pipeline, CLS, controller, OCC header | ✅ |
| 02 | [02-service-rules.md](./03-tenant-allowed-origin/02-service-rules.md) | `BaseService`, four gates, create/update/delete, restore, audit + invalidation, errors | ✅ |
| 03 | [03-data-layer.md](./03-tenant-allowed-origin/03-data-layer.md) | Repository, entity/factory/mapper, Prisma model, tenant scope, CAS | ✅ |
| 04 | [04-cors-loop.md](./03-tenant-allowed-origin/04-cors-loop.md) | `main.ts`, `isOriginAllowed`, registry, invalidation + backstop | ✅ |
| 05 | [05-tests-and-trace.md](./03-tenant-allowed-origin/05-tests-and-trace.md) | Test map, 20-step PATCH trace, glossary, exercises | ✅ |

---

## Planned documents — acceptance checklist

Use this when writing the next file. A planned document becomes ✅ only when all boxes are true.

- [ ] It states the exact source files and line numbers it relies on.
- [ ] It distinguishes **NestJS default** from **project code**.
- [ ] Every imported symbol is either explained or linked to an existing explanation.
- [ ] It contains at least one vertical ASCII tree with file references.
- [ ] It links back to the previous phase and forward to the next.
- [ ] All relative links resolve (run the checker below).
- [ ] The status row in this file and in `README.md` is updated.

Link checker used for every ✅:

```bash
cd review/api_explore/read
python3 - <<'EOF'
import os, re
root = os.getcwd(); bad = []
for dp, _, fs in os.walk(root):
    for f in fs:
        if not f.endswith('.md'): continue
        p = os.path.join(dp, f); txt = open(p).read()
        if len(re.findall(r'^```', txt, re.M)) % 2:
            bad.append((os.path.relpath(p, root), 'unbalanced fences'))
        for m in re.finditer(r'\]\((\.[^)#]+)(#[^)]*)?\)', txt):
            if not os.path.exists(os.path.normpath(os.path.join(dp, m.group(1)))):
                bad.append((os.path.relpath(p, root), m.group(1)))
print('issues:', len(bad))
for b in bad: print(' ', b)
EOF
```

---

## How to keep this file current

1. **Before writing:** change the row from ⬜ to 🟡.
2. **After writing and checking links:** change it to ✅ and add the real relative link.
3. **If the plan changes:** edit the row rather than deleting it, and record the reason in a short note under the table.
4. **Never renumber a completed document.** Append new phases at the end; the sequence is what readers follow, not a strict numbering system.

**Next action:** write `04-APPLICATIONS-LAYER.md` (Phase 4).

Back to the index: [README.md](./README.md).
