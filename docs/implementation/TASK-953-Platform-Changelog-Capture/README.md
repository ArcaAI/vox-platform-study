# TASK-953 — The platform changelog was never captured: the missing CI draft, the missing publish path, and the `ALL-2.2.0` release note

| | |
|---|---|
| **Status** | `Completed` — 2026-09-12 |
| **Type** | `bugfix` + `infrastructure` + `docs` |
| **Branch** | `dev-2.2` |
| **Reported as** | "we have many changes since the last release tag ALL-2.1.0, but i don't see any change log captured in the admin console" |

---

## 1. Requirement Analysis

The admin console's **What's New** screen (`/(console)/(shared)/changelog`) was empty, and the
platform had shipped 1,257 first-parent commits and 40 migrations since `ALL-2.1.0`.

The ask was to review why and fix it. The review found the feature itself is complete and
correct — schema, service, both controllers, the screen, the authoring drawer, the one-time
popup, acknowledgements, scopes and audience filtering all exist and work. **Nothing was
populating it, and nothing could have.**

### Owner decisions taken before implementation

| # | Question | Decision |
|---|---|---|
| D-1 | `ALL-2.2.0` is tagged with no note, while `ALL-3.0.0.md` and `ALL-4.0.0.md` are untagged drafts covering overlapping ground. Which version carries the published entry? | **`2.2.0`, absorbing both drafts.** Merge them into one `ALL-2.2.0.md` covering `ALL-2.1.0..ALL-2.2.0`; retire the placeholder naming. |
| D-2 | How far beyond authoring the note? | **Both gaps** — add the missing route AND wire the CI job, so the documented flow becomes real. |

---

## 2. Current State Evaluation

Three independent defects, none of them in the console.

### 2.1 The CI step every document promises does not exist

[`versioning.md`](../../operations/versioning.md) §3 step 6 and
[`release-runbook.md`](../../operations/release-runbook.md) §5 step 5 both stated that *"CI …
creates a **DRAFT** `ChangelogEntry`"*. No such job existed: `.gitlab/ci/**` contained zero
references to changelog authoring.

`scripts/changelog-from-commits.ts` — written and unit-tested under TASK-648, including
`buildDraftChangelogPayload` whose docstring says *"CI creates a DRAFT via `POST /admin/changelog`"* —
is a pure stdout CLI. It had **no root `pnpm` alias and no caller anywhere in the repo.**

```
core."ChangelogEntry"  →  0 rows      (core."ServiceRelease" → 4 rows)
```

### 2.2 A super admin could not publish an entry even by hand

`GET /admin/changelog/:id` **did not exist at any layer**: not in
`ChangelogAdminController` (only `POST`, `PATCH :id`, `POST :id/publish`), and not in
`IChangelogService`. The console depends on it:

- `changelog-entry-drawer.tsx` reads the entry through `useChangelogEntryWithEtag` purely to
  obtain the ETag.
- `handlePublish` opens `if (!entryId || !existing?.etag) return;` — a **silent no-op**.
- The Publish button never renders at all, because `isDraft` requires `existing`.
- `handleSave` while editing falls through to the `create` branch, hitting the
  `ChangelogEntry_platformVersion_unique` constraint.

So even a hand-created draft was stranded in `DRAFT` forever, invisible to every tenant. The
feature's tests mock the fetch layer, which is why this shipped green.

### 2.3 Release notes did not line up with tags

| File | Tagged? | Covers |
|---|---|---|
| `ALL-3.0.0.md` | never | API-plane hardening (TASK-754…768), drafted 2026-08-18 |
| `ALL-4.0.0.md` | never — "working name only" | everything after 2026-08-18; the R1 removal draft |
| **`ALL-2.2.0`** | **tagged 2026-09-11** | **no note existed** |

Both drafts flag the naming as an open owner call (TASK-859 OD-2).

### 2.4 Stale comment found in passing

`changelog.service.ts`'s header carried an INTEGRATION NOTE claiming `ChangelogEntry` was absent
from `SYSTEM_SHARED_READ_MODELS`, so tenant-scoped readers "see nothing". It **is** in that set
(`tenant-scope.ts:486`). Corrected, since it describes the exact feature under repair.

---

## 3. Implementation

### Lane A — the missing authoring read

| File | Change |
|---|---|
| `packages/applications/src/services/changelog/IChangelogService.ts` | `get(id)` added to the interface |
| `packages/applications/src/services/changelog/changelog.service.ts` | `get(id)` — `assertSuperAdmin()` **before** the read, `findById`, `ResourceViewed`, mapped response. Stale header note corrected |
| `apps/api/src/modules/changelog/changelog-admin.controller.ts` | `@Get(':id')` with the class `AUTH-NOTE`, tag, summary, description and 403/404 responses |

No new DTO: `ChangelogEntryResponse` already carries `version`, and `ETagInterceptor` stamps
`ETag: "<version>"` off it for any JSON GET, so the route is OCC-correct by construction.

The super-admin gate runs **before** `findById` deliberately. It is row-INDEPENDENT (a release
note is platform-wide SYSTEM data), so there is no id space to protect and no existence oracle —
the same reasoning `05-nestjs-api.md` records for the promotion routes. This is a **403 privilege
boundary, not the 404-over-403 cross-tenant posture.**

### Lane B — the CI wiring

| File | Change |
|---|---|
| `scripts/changelog-draft.ts` | **new.** Resolves the tag → range → entries → draft payload; always writes it to `--out`; POSTs to `/admin/changelog` under `--post` |
| `scripts/__tests__/changelog-draft.test.ts` | **new.** Argument defaults and credential handling |
| `.gitlab/ci/publish.yml` | **new job `changelog-draft`**, `rules: $CI_COMMIT_TAG =~ /^ALL-/` |
| `package.json` | `changelog:generate`, `changelog:draft` |
| `.gitignore` | `changelog-draft.json` — a pipeline artifact and local scratch file, never committed |

Three design points, each a deliberate choice rather than an omission:

1. **RENDER always runs; POST is opt-in on `HOPE_GATEWAY_URL`.** A tag pipeline builds *images*.
   It has no inherent knowledge of which deployed gateway should receive the note, and nothing
   else in this pipeline talks to a running gateway (promotion goes through the deployment repo
   over git). Setting the variable is how an operator says *"this train's note belongs there."*
   The payload is kept as a pipeline artifact for a year either way.
2. **It is never a silent skip.** Without the variable the job prints why and names the by-hand
   command; with the variable but incomplete credentials the script hard-errors, naming each
   missing one. Silence is exactly how §2.1 went unnoticed for a year.
3. **`GIT_DEPTH: 0`.** The range comes from `git tag --list 'ALL-*'` plus a commit walk. A shallow
   clone has neither and would silently produce a draft covering the last few commits.

The credential is a **service account** and can be nothing else — `/admin/*` is `@ForbidApiKey()`,
so an API key cannot reach the route under any scope. `workingTenantId` is not sent: a
service-account token binds its tenant at exchange, and omitting it resolves SYSTEM, which is
where a `ChangelogEntry` belongs. A 409 (entry already exists for that version) is treated as
success, so re-running a tag's pipeline is idempotent.

**Nothing in this lane publishes.** The gateway forces `DRAFT`.

### Lane C — the release note and the docs that pointed at nothing

| File | Change |
|---|---|
| `docs/operations/release-notes/ALL-2.2.0.md` | **new.** The consolidated note: 10 sections, six breaking changes, 40 migrations, a 9-step upgrade checklist, known gaps |
| `docs/operations/release-notes/ALL-3.0.0.md` | reduced to a superseded stub with a section-by-section redirect table |
| `docs/operations/release-notes/ALL-4.0.0.md` | same, plus what it means for the register |
| `docs/operations/deprecation-register.md` | `R1 = <tag TBD>` → **`R1 = ALL-2.2.0`**; `R2`–`R4` still unnamed |
| `docs/operations/release-runbook.md` | §5 step 5 now describes the real job and its opt-in; worked example repointed |
| `docs/operations/versioning.md` | §3 step 6 and §4's worked example now describe what CI actually does |

The two drafts are **stubs, not deletions**: `deprecation-register.md`, `release-runbook.md`,
`TASK-890/README.md`, `TASK-802/README.md` (archived) and `agentic-sdk-v2/CHANGELOG.md` all link
to them by name, and dangling links would be a worse outcome than a ten-line redirect.

---

## 4. Verification

### 4.1 Gates

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/applications build` | pass |
| `pnpm api:build` | pass (12/12 tasks) |
| `applications` + `api` typecheck, `vox-node` typecheck | pass, no output |
| `eslint src/services/changelog` (applications) | **0 errors, 0 warnings** |
| `eslint src/modules/changelog` (api) | **0 errors, 0 warnings** |
| `pnpm --filter @arcaai/applications lint` / `@arcaai/api lint` | 0 errors (pre-existing warnings only, none added) |
| changelog service tests | **23 passed** (6 new) |
| changelog controller tests | **8 passed** (1 new; the "EVERY admin route" case now actually covers every route) |
| `scripts/__tests__` changelog tests | **33 passed** (9 new) |
| `pnpm api:openapi:check` | `OK — every served route is either documented or deliberately excluded` |
| `pnpm api:portal:check` | `no drift (admin 663 ops, business 200 ops)` |
| `pnpm --filter @arcaai/vox-node gen:admin:check` | `no drift (49 areas, 423 routes, 428 schemas)` |
| `.gitlab/ci/publish.yml` | parses; job well-formed (stage `publish`, `extends .node-base`, `GIT_DEPTH: 0`, artifact declared) |
| `pnpm --filter @arcaai/api test` | **298 files passed, 4403 tests passed**, 0 failed |
| `pnpm --filter @arcaai/admin-console test` | **319 files passed, 2913 tests passed**, 0 failed |
| `pnpm --filter @arcaai/applications test` | **801 files passed, 13,225 tests passed, 0 test failures** — 1 FILE failed, see below |

**The one red is environmental and out of scope.**
`src/services/agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts`
fails in `beforeAll`/`afterAll` with
`Authentication failed against the database server, the provided database credentials for 'test'
are not valid`; both of its tests are SKIPPED, so zero assertions ran. It is an integration test
against the live test database (the root vitest config excludes `**/integration/**`), it is in a
service this ticket does not touch, and a local credential mismatch cannot be caused by adding a
method to a different service. Reported, not fixed.

All five API artifacts were regenerated together, per `05-nestjs-api.md` §Definition of Done.
`route-manifest.json` went 744 → **745 routes**; `openapi.json` carries the new path.

### 4.2 Live proof against the running dev gateway

The chain that was previously impossible, against `http://localhost:8868`:

```
POST   /api/v1/admin/changelog                  → 201  DRAFT, version 1
GET    /api/v1/admin/changelog/{id}             → 200  ETag: "1"        ← the added route
GET    …  as tenant_admin                       → 403                   ← privilege, not 404
GET    /api/v1/changelog       as tenant_admin  → count: 0              ← DRAFT invisible
POST   …/{id}/publish   (no If-Match)           → 428
POST   …/{id}/publish   (If-Match: "99")        → 412
POST   …/{id}/publish   (If-Match: "1")         → 200  PUBLISHED, version 2
GET    /api/v1/changelog       as tenant_admin  → count: 1
GET    /api/v1/changelog/unseen as tenant_admin → 1 entry               ← What's New will fire
```

The generator was also run over the real range:

```
$ pnpm changelog:draft ALL-2.2.0 --out draft.json
[changelog-draft] ALL-2.1.0..HEAD — 2335 commit(s) → draft.json
[changelog-draft] 559 change(s), 1 breaking, in 2.2.0.
```

559 highlight commits is exactly why the runbook calls the draft *"not publishable as-is"*.

### 4.3 Verified in the admin console

`pnpm --filter @arcaai/admin-console dev` on :5176, signed in as `super_admin`:

1. **The What's New dialog fires on login** with the `2.2.0` entry — `BREAKING` badge, version
   chip, rendered markdown, `Got it` / `See all changes`.
2. **The What's New screen** (`/changelog`) shows `1 entries`, the timeline item with `New` +
   `BREAKING`, the date and the full body.
3. **The authoring drawer opens hydrated** — `PUBLISHED` badge, platform version (disabled, as it
   should be on an edit), title, summary, severity `Breaking`, audience `All` and the markdown
   body. **This is the path that was previously impossible.**
4. Network log: `GET /api/hope/admin/changelog/01a09320-… → 200 OK` through the BFF proxy — the
   exact call that used to 404. `read_console_messages` (errors only): none.

### 4.4 The published entry on the dev database

A curated `2.2.0` entry (`BREAKING`, audience `ALL`), written from `ALL-2.2.0.md`, was created
and published on the **local dev database** so the console has something real to render. In a
true release this is steps 3–6 of the runbook: note in the repo → tag → CI drafts → a super
admin rewrites and publishes.

---

## 5. Open items for the owner

| # | Item |
|---|---|
| O-1 | **Set `HOPE_GATEWAY_URL` + `HOPE_SVC_CLIENT_ID` / `HOPE_SVC_CLIENT_SECRET`** (masked, protected) if CI should create the draft directly. Until then `changelog-draft` renders the artifact only. The account needs `svc:admin:changelog:manage`. |
| O-2 | **Publish the `2.2.0` note on any non-dev environment.** This ticket published only on local dev. |
| O-3 | **`R2`–`R4` are still unnamed** (the remainder of TASK-859 OD-2). R1 is now `ALL-2.2.0`. |
| O-4 | The commit parser found **1** breaking commit across 2,335, while `ALL-2.2.0.md` documents six breaking changes — they were written in prose, not in `BREAKING CHANGE:` footers or `!` markers. `assertBreakingRequiresMajorBump` is therefore weaker in practice than on paper. Worth a convention decision, not fixed here. |

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Ticket opened from the owner's report. Review found three defects (§2). Owner decisions D-1/D-2 taken. Lanes A, B, C implemented; gates in §4.1 green; the authoring chain proven live in §4.2; a curated `2.2.0` entry published on the dev database. Status `Completed`; four owner items in §5. Not pushed. |
