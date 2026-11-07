# `read/` — Deep-read notes for HOPE / VOX

Progressive, evidence-based reading notes. Each file maps one layer of the platform, verified against the working tree rather than copied from existing docs.

**Repo state captured:** `project-hope` branch `dev-2.2`, HEAD `8cb2e5e8e`.
**Rule:** everything here is observation. No files under `project-hope/` are modified.

> **Start here if you are following the sequence:** [WALKTHROUGH-SEQUENCE.md](./WALKTHROUGH-SEQUENCE.md) — the ordered reading path, a status column for every document, and links to the finished files and subfolders.

## Index

| # | Document | Layer | Scope | Status |
|---|---|---|---|---|
| — | [WALKTHROUGH-SEQUENCE.md](./WALKTHROUGH-SEQUENCE.md) | Tracker | Ordered walkthrough path + documentation progress | ✅ |
| 00 | [00-REPO-ROOT-MAP.md](./00-REPO-ROOT-MAP.md) | Workspace + repo root | Every top-level file/folder in `/Users/apple/repos/VOX` and `project-hope/`, with purpose and drift notes. | ✅ |
| 01 | [01-APPS-API-MAP.md](./01-APPS-API-MAP.md) | `apps/api` | App root files, `src/` structure, all 78 feature modules grouped with route prefixes, tests, runtime entrypoints. | ✅ |
| 02 | [02-API-BOOT-AND-REQUEST-PIPELINE.md](./02-API-BOOT-AND-REQUEST-PIPELINE.md) | `apps/api/src/main.ts` + `app.module.ts` | 24-step boot sequence, 8-guard pipeline, interceptor/filter order, 12 boot-time audits, server tuning. | ✅ |
| 02a | [02-main-ts/](./02-main-ts/00-README.md) | Imports explained | Beginner companion: NestJS concepts, every `@nestjs/*` package, third-party libraries, `@arcaai/*` packages, local files, import lookup. | ✅ |
| 02a-07 | [07-visual-boot-flow.md](./02-main-ts/07-visual-boot-flow.md) | Diagram | Seven boot phases + a full vertical tree of every `main.ts` step, with file references. | ✅ |
| 02a-08 | [08-visual-request-pipeline.md](./02-main-ts/08-visual-request-pipeline.md) | Diagram | `app.module.ts` composition, the 8-guard pipeline, interceptor/filter order, feature-module anatomy. | ✅ |
| 02a-09 | [09-visual-import-map.md](./02-main-ts/09-visual-import-map.md) | Diagram | Where every import comes from (Nest / `@arcaai` / local / npm) and what it does. | ✅ |
| 03 | [03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md](./03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md) | First vertical slice | One request end to end: routing, guards, DTOs, OCC/ETag, service rules, repository, Prisma, CORS invalidation, tests. | ✅ |

**Progress:** 14 walkthroughs complete (03 is a 5-chapter subfolder); 5 planned (see the tracker for the full table).

## Reading order

1. **00** — orient yourself in the workspace; confirm which directory is the live repo.
2. **01** — learn the gateway's shape and where each capability lives.
3. **02** — follow one request from process start to handler: the highest-value read.
4. **02-main-ts** — if NestJS is new to you, read `01-nestjs-in-10-minutes.md` before (or alongside) **02**; use `06-import-reference.md` as a lookup.
5. **02-main-ts/07 → 08 → 09** — if you learn visually, start with the three diagram files instead; each box cites the file it comes from.
6. **03** — follow one request through every layer: `TenantAllowedOrigin` is the smallest complete slice, including the CORS loop that uses its rows.
7. **04 → 08** — the planned deep dives (applications, domains, database, auth, consultation). Their order and status live in [WALKTHROUGH-SEQUENCE.md](./WALKTHROUGH-SEQUENCE.md).

## Recurring drift findings

Tracked per document; consolidated here for quick reference.

| Claim | Documented | Actual |
|---|---|---|
| Feature module dirs | 70 (apps/api README) | **78** |
| Routes in authz oracle | 749 (apps/api README) | **818** |
| E2E spec files | 147 (apps/api README) | **165** (31 cross-tenant) |
| Guard chain | 7 guards (README) | **8** — `TenantLockGuard` is undocumented |
| Catch-all exception filter | `HttpExceptionEnvelopeFilter` (README) | `AllExceptionsFilter` |
| `.claude/rules/*.md` | Referenced throughout | **Not present in this checkout** |
| `apps/vllm` | Absent from README layout | Present in `apps/` |
| `.env.prod` | — | Tracked in git; audit for secrets |

## Conventions used in these notes

- All counts were produced from the working tree on 2026-11-04/05, not from prose docs.
- Line numbers refer to the files at HEAD `8cb2e5e8e`.
- "Generated — never hand-edit" marks artifacts produced by scripts (`openapi.json`, `route-manifest.json`, `.env.sample`, `dist/`, `coverage/`).
- Cross-links point at the upstream repo where useful, but the notes deliberately avoid copying upstream docs verbatim.
