# TASK-648 — Service Version & Release Registry

| Field | Value |
|---|---|
| **Status** | Pending (plan awaiting approval) |
| **Type** | feature (infrastructure + full-stack) |
| **Branch** | `dev-2.1` |
| **Design gate** | WAIVED by the user (no Figma frames required for this ticket) |
| **Related** | TASK-616 (CI/CD + digest promotion), TASK-636 (observability), TASK-645 (dev cutover) |

---

## 1. Requirement Analysis

Operators need to answer, from the admin console, without SSH or `kubectl`:

1. **What release version** of each app/service is running?
2. **Which branch + commit SHA** produced the image that is running?
3. **When** was it built, and when did it start running?
4. **Which release tag** (if any) it came from.

The information must be **captured at build time**, **stored in the database**, and **displayed in the admin console**.

### Scope — what counts as a "service"

Everything the CI builds an image for, plus the two worker processes that have no HTTP
surface (`.gitlab/ci/build.yml`):

`api` · `admin-console` · `compat-playground` · `smr` · `stt-ml-runtime` · `stt-worker` ·
`nlp` · `guardrail` · `tts` · `harness` · `harness-worker` · `database` (migration image) ·
`qdrant-init` · `hope-python-base`

The last three are one-shot/base images — they register a release row but never a running
instance.

### Out of scope

- npm SDK package versions (`@arcaai/vox`, `@arcaai/vox-node`) — already versioned and
  published by `publish-sdk`; the console may link out, but they are not deployed units.
- Rollback / promotion actions from the console. This ticket is **read-only observability**.

---

## 2. Current State Evaluation

| Area | Today | Gap |
|---|---|---|
| Git tags | `<SVC>-<ver>` (e.g. `SMR-2.1.0`) and `ALL-<ver>` already trigger builds (`build.yml:6-8`) | Grammar is convention only — nothing validates it, no documented SemVer policy |
| Image tags | `<tag-slug>` / `dev-<sha8>` / `sha-<sha8>`, no `latest` (`templates.yml` `.build-template`) | Good. Keep. |
| OCI labels | `source`, `revision`, `created`, `version` are already stamped (`templates.yml`) | **`branch` and `git tag` are NOT stamped**, and nothing inside the image can read its own labels |
| Runtime version | `apps/api` health returns `process.env.npm_package_version \|\| '0.1.0'` (`health.controller.ts:12`) | **Broken in containers** — `npm_package_version` is injected by the pnpm/npm script runner, and the API image starts `node dist/main.js` directly, so this is *always* `0.1.0` in every deployed environment |
| Python services | Return a hand-maintained `version` from pydantic settings | Not tied to the build at all |
| Persistence | none | No history: "what was running when this incident happened?" is unanswerable |
| Console | `/(console)/(global)/monitoring` exists | No version/release surface |

**Conclusion:** the build already produces every fact we need; nothing carries it into the
running process, and nothing records it.

---

## 3. Best Practices Adopted

### 3.1 Semantic Versioning policy (per-service, independent)

Keep the existing per-service tag family and formalise its grammar:

```
<SVC>-<MAJOR>.<MINOR>.<PATCH>[-<prerelease>]        e.g. SMR-2.1.0, STT-3.0.0-rc.1
ALL-<MAJOR>.<MINOR>.<PATCH>                          platform release train
v<MAJOR>.<MINOR>.<PATCH>                             production promotion trigger
```

**Correction (found by U9 against the real CI, 2026-08-09).** The first draft of this plan
conflated "the version tag" with "the deploy trigger". They are separate families and
`.gitlab-ci.yml` treats them differently:

| Tag | `PIPELINE_TYPE` | Effect |
|---|---|---|
| `ALL-*`, `<SVC>-*` | `release` | **Builds and publishes images. Deploys nothing.** |
| `v<X.Y.Z>` | `tag_release` | **Builds nothing.** Triggers the manual `promote-prod` digest copy (`deploy.yml:95-113`). |

This does not change the data model — §7's "one release row, three environments" still holds,
because promotion attaches a digest to a row a prior `dev-*`/`staging-*` build already
created. It does change two things: the promote step must find that row by **`CI_COMMIT_SHA`,
not by tag** (no build ran in a `v*` pipeline, so there is no tag-derived identity to match
on), and the release runbook must not tell an operator that `ALL-2.2.0` ships to production —
it does not, and following that would dead-end at `promote-prod` failing on a missing digest.

**Open question for the user:** `v2.2.0` and `ALL-2.2.0` are today two independent numbers
that nothing forces to agree. Either they should be the same number (promote-prod validates
that a matching `ALL-` train exists), or the console must show both and label which is which.
Flagged, not silently decided.

| Bump | Trigger |
|---|---|
| **MAJOR** | Breaking change to a published contract — gateway REST/WS shape, SDK public API, DB migration that is not backwards-compatible with the previous release, or a removed config key |
| **MINOR** | Backwards-compatible capability: new endpoint, new provider, new optional field/env var |
| **PATCH** | Bug fix, dependency bump, perf, docs, infra-only change with no contract impact |
| **Pre-release** | `-rc.N` for release candidates; `-alpha.N` / `-beta.N` allowed. Pre-releases never promote to prod. |

Rules (each is enforced by a CI gate, §5 W1):

1. **The git tag is the version.** Not `package.json`, not `pyproject.toml`, not a
   hand-edited constant. Those files may carry a version for packaging, but the deployed
   version is whatever tag the pipeline ran on. This kills the `0.1.0` class of bug.
2. **Tags are immutable and never moved.** Same rule already in force for image digests
   (TASK-616 §F3). A re-tag would silently repoint a release row at different code.
3. **Untagged builds get a pre-release-shaped identity**, never a fake SemVer:
   `0.0.0-<branch-slug>.<sha8>` (e.g. `dev-2.1` → `0.0.0-dev-2-1.0ab258f9`). The slug uses
   the same `[^a-zA-Z0-9]` → `-` rule as the image tag in `.build-template`, so the version
   string and the image tag agree. It sorts below every real release and is visually obvious
   in the console as "not a release".
4. **`ALL-<ver>` is the platform version** — the headline number in the console. Per-service
   versions sit beneath it. A service may be newer than the train (hotfix) but never older
   than the train's pinned digest for that environment.
5. **The SDK family stays in npm-SemVer lockstep** as it does today (currently 2.0.4);
   `ALL-` train bumps do not force an SDK bump.

### 3.2 Build-metadata capture — one contract, both languages

Build facts are **baked into the image at build time** and read by the process at boot.
This is the industry-standard approach (it is what `org.opencontainers.image.*` labels
model), and it is the only one that survives a pod restart, a digest promotion, and a
registry retag.

**Uniform contract: `/app/build-info.json`** written by every Dockerfile from build args,
plus the matching OCI labels on the manifest. One file path, one JSON shape, read
identically by Node and Python:

```jsonc
{
  "service":       "smr",
  "version":       "2.1.0",              // from the git tag, or 0.0.0-<branch>.<sha8>
  "releaseTag":    "SMR-2.1.0",          // null on untagged builds
  "gitBranch":     "dev-2.1",
  "gitCommitSha":  "0ab258f9…",          // full 40-char
  "buildAt":       "2026-08-09T11:22:33Z",
  "ciPipelineId":  "12345",
  "ciPipelineUrl": "https://gitlab/…/pipelines/12345"
}
```

Why a file and not env vars: env vars for this would have to be added to
`turbo.json#globalEnv` and would violate the configuration-tier rule in
`09-infrastructure-devops.md` — build identity is not configuration, it is an immutable
property of the artifact. A baked file also cannot be spoofed by a Deployment manifest edit.

**Image digest** is deliberately *not* in the file — it does not exist until after the push.
It is captured separately by the CI publish/promote step (§5 W2) and matched to the release
row by `(service, gitCommitSha, releaseTag)`.

### 3.3 Persistence model — release facts vs. runtime observations

Two tables, because they have different lifetimes and different write rates:

- **`ServiceRelease`** — *immutable build facts*. One row per (service, build). Written
  once, never updated. This is the release history.
- **`ServiceInstance`** — *runtime observation*. One row per running process, heartbeated.
  This answers "what is running right now, in which environment, since when".

Rejected alternative: a single "current version per service" row. It cannot answer
"what was running during last Tuesday's incident", which is the main reason to put this in
a database rather than just reading `/health`.

### 3.4 Ingestion — services self-register on boot (push)

On startup each process POSTs its `build-info.json` to the gateway, then heartbeats every
5 minutes.

| Option | Verdict |
|---|---|
| **(A) Push — service self-registers** | **CHOSEN.** Captures the exact rollout moment; works for `harness-worker` and `stt-worker`, which have no inbound HTTP surface; the gateway is the only DB writer |
| (B) Pull — gateway extends its `/health/services` probe | Rejected as primary: misses both workers entirely, and only notices a new version at the next poll |

Endpoint: `POST /api/v1/internal/service-releases` — internal controller, `X-Service-Token`
auth (the existing service-auth middleware pattern, `06-python-services.md`), idempotent
upsert keyed on `(service, gitCommitSha, releaseTag)`.

The gateway registers its own build info in-process at bootstrap (no self-HTTP call).

**Critically: this write path does NOT broadcast sys-events.** Every pod boot and every
5-minute heartbeat would otherwise write an AuditLog row and flood the audit trail — with
~15 processes that is ~4,300 audit rows/day of pure noise. A *version change* for a service
is worth an event; a heartbeat is not. Only the first registration of a previously-unseen
`ServiceRelease` broadcasts `ResourceCreated`.

### 3.5 Changelog — two audiences, two artifacts

A changelog has two incompatible readers, and conflating them is the usual failure. HOPE
produces **both**, from one source of truth:

| | **Technical changelog** | **Release notes ("What's New")** |
|---|---|---|
| Audience | Engineers, incident response | Admins logging into the console |
| Content | Every commit between the previous release tag and this one | A curated handful of user-visible changes |
| Authoring | **Generated** by CI, never edited | **Written by a human**, generated draft as the starting point |
| Granularity | Per service release (`SMR-2.1.0`) | Per platform train (`ALL-2.1.0`) |
| Stored on | `ServiceRelease.changelog` (JSON, immutable) | `ChangelogEntry` rows (editable until published) |
| Shown | Release detail drawer (§6) | One-time on login + the changelog screen (§6b) |

**This is the reason the one-time login popup shows the curated notes, not the commit log.**
Firing a modal at a tenant admin containing 60 lines of `chore(deps): bump …` trains them to
dismiss it unread, which destroys the one channel we have for announcing a breaking change.

#### Generation

The repo already writes Conventional Commits in practice (`feat(TASK-643): …`,
`fix(TASK-644): …`, `docs(TASK-644): …`). CI leans on that rather than imposing anything new:

1. On an `ALL-<ver>` or `<SVC>-<ver>` tag, CI collects commits since the previous tag of the
   same family, parses `type(scope): subject`, and groups them by type
   (`feat` → Added, `fix` → Fixed, `perf` → Performance, `refactor`/`chore`/`docs` → Internal).
2. `BREAKING CHANGE:` footers and `feat!:`/`fix!:` markers are hoisted into a **Breaking**
   group — these are what MAJOR bumps (§3.1) must be justified by, so CI **fails the release
   if a breaking commit appears without a MAJOR bump**.
3. The `TASK-nnn` / `BUG-nnn` id in the scope is extracted and linked to its ticket README.
4. Commits that parse as non-Conventional are not dropped — they land in an `Other` group, so
   the technical changelog is always complete.
5. For an `ALL-` train, CI additionally creates a **DRAFT `ChangelogEntry`** pre-filled with
   the `feat` + breaking items. A global admin edits it into human language and publishes.

Draft-then-publish is deliberate: nothing reaches admins' screens automatically. An
auto-published changelog is an unreviewed broadcast to every customer admin.

### 3.6 One-time-on-login display

**Server-side acknowledgement, per user, per entry** — a `UserChangelogAcknowledgement` row.

Rejected alternatives: `localStorage` (re-fires on every new device, silently lost on cache
clear, and unreadable to support when an admin asks "was I shown the breaking-change
notice?"); a single `lastSeenChangelogVersion` column on the user (cannot back-fill an entry
published out of order, and cannot express "seen the 2.1.0 note, not the 2.0.9 hotfix note").

Rules:

1. Fires on the first console page load after login, **not** on every navigation.
2. Shows only entries that are `PUBLISHED`, match the user's audience, and have no ack row
   for that user. Newest first, capped at **3** with a "See all changes" link to §6b.
3. Dismissal — button, `Esc`, or overlay click — writes the ack for every entry shown. It is
   never shown twice for the same entry.
4. **Never fires while impersonating.** Otherwise a global admin's support session silently
   acknowledges the notice on behalf of the real user, who then never sees it. Impersonation
   is detectable from the session (`ImpersonationAuditInterceptor` surface).
5. Never blocks the app: dismissible, focus-trapped and focus-restoring (Radix `Dialog`
   handles this — do not hand-roll), `prefers-reduced-motion` respected.
6. A new user's first-ever login does **not** replay the entire history — entries published
   before the user was created are auto-acked at first load.

### 3.7 Failure posture

Registration is **best-effort and never blocks startup**. A service that cannot reach the
gateway logs a warning and serves traffic. Version reporting is an observability feature; it
must never become a new startup dependency on a PHI-serving service.

---

## 4. Data Model

### `ServiceRelease` (`packages/database/src/prisma/db_main/platform.prisma`)

| Field | Type | Notes |
|---|---|---|
| meta/`_version`/`id` | per the standard template | UUIDv7 |
| `tenantId` | String | always the SYSTEM tenant `00000000-…` (platform-wide; `NULL = global` is banned) |
| `serviceName` | String | `api`, `smr`, `stt-worker`, … |
| `version` | String | SemVer or `0.0.0-<branch>.<sha8>` |
| `releaseTag` | String? | `SMR-2.1.0`, null on untagged builds |
| `gitBranch` | String | |
| `gitCommitSha` | String | full 40-char |
| `buildAt` | DateTime | from the build |
| `imageRepository` | String? | |
| `imageDigest` | String? | filled by the CI publish step (§5 W2) |
| `ciPipelineId` / `ciPipelineUrl` | String? | |
| `changelog` | Json? | generated technical changelog (§3.5), immutable; `[{ type, scope, ticket, subject, sha, breaking }]` |
| `firstSeenAt` | DateTime | first registration |
| resourceStatus + audit fields | per the standard template | |
| | | `@@unique([serviceName, gitCommitSha, releaseTag])`, `@@index([tenantId])`, `@@index([serviceName, buildAt])` |

### `ServiceInstance`

| Field | Type | Notes |
|---|---|---|
| standard meta/id/tenantId | | |
| `releaseId` | String | FK → `ServiceRelease` |
| `serviceName` | String | denormalised for cheap grouping |
| `environment` | String | `dev` / `staging` / `prod` — from `NODE_ENV`/host env |
| `instanceId` | String | pod name, or `hostname:pid` outside k8s |
| `startedAt` / `lastSeenAt` | DateTime | heartbeat updates `lastSeenAt` only |
| | | `@@unique([serviceName, environment, instanceId])`, `@@index([lastSeenAt])` |

An instance is shown as **live** if `lastSeenAt` is within 15 minutes (3 missed heartbeats),
otherwise **stale**. Rows older than 30 days are pruned by the existing scheduler surface.

### `ChangelogEntry` — curated release notes

| Field | Type | Notes |
|---|---|---|
| standard meta/id/tenantId | | SYSTEM tenant |
| `platformVersion` | String | `2.1.0` (the `ALL-` train), unique |
| `title` | String | "HOPE 2.1.0 — Malayalam TTS and per-tenant origins" |
| `summary` | String | one line; what the popup shows collapsed |
| `body` | String | markdown, rendered sanitised |
| `severity` | Enum | `INFO` \| `IMPORTANT` \| `BREAKING` — drives badge colour and whether it is pinned |
| `audience` | Enum | `ALL` \| `GLOBAL_ADMIN` \| `TENANT_ADMIN` — filters both the popup and the list |
| `publishStatus` | Enum | `DRAFT` \| `PUBLISHED` (CI creates DRAFT; a human publishes) |
| `publishedAt` | DateTime? | set on publish; null while draft |
| | | `@@unique([platformVersion])`, `@@index([publishStatus, publishedAt])` |

`ChangelogEntry` is the one model here that is **edited by humans**, so it is genuinely OCC:
its mapper carries `FIELDS_NOT_WRITABLE = ['version']`, and the PATCH route takes
`@RequiresIfMatch()` + `@ExpectedVersion()`. `ServiceRelease` and `ServiceInstance` are
machine-written and non-OCC.

### `UserChangelogAcknowledgement`

| Field | Type | Notes |
|---|---|---|
| standard meta/id/tenantId | | tenantId = the acknowledging user's tenant |
| `userId` | String | FK → User |
| `changelogEntryId` | String | FK → ChangelogEntry |
| `acknowledgedAt` | DateTime | |
| `autoAcknowledged` | Boolean | true when back-filled for a new user (§3.6 rule 6) — so support can distinguish "read it" from "predated them" |
| | | `@@unique([userId, changelogEntryId])`, `@@index([userId])` |

This table grows at users × entries. It is small (an entry per platform release, not per
commit) and is the only design that survives the support question *"was this admin actually
shown the breaking-change notice?"*.

All four models need: `TENANT_SCOPED_MODELS` entry, `ResourceType` enum values in **both**
`audit.prisma` (+ `ALTER TYPE … ADD VALUE` migration) **and**
`packages/domains/src/enums/generated/ResourceType.ts` (the TASK-366 failure mode — skipping
this makes every AuditLog INSERT throw), and hand-authored entity/factory/mapper/repository
(`gen:mapper` is destructive — never run it).

---

## 5. Implementation Plan

Ordered by the layer dependency chain. Each workstream is independently verifiable.

| # | Workstream | Files |
|---|---|---|
| **W1** | **CI: stamp + validate.** Add `--build-arg` for branch/sha/tag/pipeline + the two missing OCI labels (`ref.name`, a custom `com.arcaai.branch`) in `.build-template`. Add a `validate-release-tag` job that rejects a tag not matching the §3.1 grammar. | `.gitlab/ci/templates.yml`, `.gitlab/ci/validate.yml` |
| **W2** | **CI: digest capture.** After push, resolve the manifest digest and PATCH it onto the release row (or emit it into the promotion commit for the deployment repo). | `.gitlab/ci/templates.yml`, `.gitlab/ci/deploy.yml` |
| **W3** | **Dockerfiles: bake `/app/build-info.json`** from the build args, for all 11 image builds. | `apps/*/Dockerfile`, `apps/stt/docker/Dockerfile`, `packages/database/Dockerfile` |
| **W4** | **Readers.** `packages/applications` `BuildInfoService` (TS) and `packages/py-env` `hope_env.build_info` (Python) — read the file once at boot, fall back to a dev-mode `git rev-parse` shim so local dev shows something real. | `packages/applications/src/common/build-info/`, `packages/py-env/src/hope_env/build_info.py` |
| **W5** | **Database.** Two models + migration `<ts>_task_648_service_release_registry`, allow-list updates, `ResourceType` values in both places. | `packages/database/**` |
| **W6** | **Domain.** `gen:model`, then hand-author entity/factory/mapper/repository ×2; register in `CoreDatabaseModule`; barrels. | `packages/domains/**` |
| **W7** | **Application service.** `ServiceReleaseService` — `registerInstance()` (upsert release + upsert instance, sys-event only on a NEW release), `listReleases()`, `listCurrent()` (latest live instance per service+environment), `getHistory(serviceName)`. DTOs + mapper. | `packages/applications/src/services/serviceRelease/` |
| **W8** | **API.** `POST /api/v1/internal/service-releases` (service-token) + `GET /api/v1/admin/service-releases{,/current,/:service/history}` (`@CanAny(['manage','all'], ['read','TenantTelemetry'])` — same posture as `/health/services`). Fix the `npm_package_version` bug: `/health` now reports the real baked version. | `apps/api/src/modules/service-release/`, `apps/api/src/modules/health/health.controller.ts` |
| **W9** | **Self-registration clients.** Gateway registers in-process at bootstrap; the 6 Python services register in their `lifespan` (best-effort, `asyncio` task, never blocks); `admin-console` registers from a Next.js `instrumentation.ts`; the two workers register from their worker entrypoints. | `apps/api/src/main.ts`, `apps/*/src/*/main.py`, `apps/admin-console/instrumentation.ts` |
| **W10** | **Admin console screen** — see §6. | `apps/admin-console/src/app/(console)/(global)/releases/`, `src/features/releases/` |
| **W12** | **CI changelog generation.** Parse Conventional Commits since the previous tag of the same family, group them, extract ticket ids, fail the pipeline on a breaking commit without a MAJOR bump, attach the JSON to the release row, and create the DRAFT `ChangelogEntry` on `ALL-` tags. | `.gitlab/ci/` + a `scripts/changelog-from-commits.ts` |
| **W13** | **Changelog service + API.** `ChangelogService` (list, get, create/update/publish with OCC, `listUnseen(user)`, `acknowledge(ids)`, new-user auto-ack). Routes: `GET /api/v1/changelog` · `GET /api/v1/changelog/unseen` · `POST /api/v1/changelog/acknowledge` · global-admin `POST/PATCH /api/v1/admin/changelog{,/:id}` + `/publish`. | `packages/applications/src/services/changelog/`, `apps/api/src/modules/changelog/` |
| **W14** | **Console: changelog surfaces.** The one-time `WhatsNewDialog` mounted in the console layout, and the `/changelog` screen (list + detail + global-admin authoring). | `apps/admin-console/src/features/changelog/**`, `src/app/(console)/(shared)/changelog/**`, `src/app/(console)/layout.tsx` |
| **W11** | **Docs.** `docs/operations/versioning.md` (the §3.1 policy, as the release-manager runbook), plus rule updates to `09-infrastructure-devops.md`. | `docs/**`, `.claude/rules/09-infrastructure-devops.md` |

### TDD test list (written before the code, per `01-development-workflow.md`)

- `build-info.reader.test.ts` — reads the baked file; falls back cleanly when absent; never throws.
- `test_build_info.py` — same contract in Python.
- `service-release.service.test.ts` — upsert is idempotent for a repeated (service, sha, tag);
  a heartbeat updates `lastSeenAt` and nothing else; **a heartbeat broadcasts NO sys-event**;
  a first-seen release broadcasts exactly one `ResourceCreated`.
- `service-release.controller.test.ts` — internal route rejects a missing/incorrect
  `X-Service-Token`; admin routes reject a plain DOCTOR.
- `version-grammar.test.ts` — the §3.1 tag regex accepts `SMR-2.1.0`, `ALL-1.0.0`,
  `STT-3.0.0-rc.1`; rejects `SMR-2.1`, `smr-2.1.0`, `v2.1.0`.
- `release-registration.spec.ts` (e2e) — a registration POST followed by an admin GET returns
  the row; cross-tenant read of the admin route returns 404.
- Console: `releases-table.test.tsx` + an axe scan (0 violations), both themes.
- `changelog-from-commits.test.ts` — groups by type; hoists `feat!:` and `BREAKING CHANGE:`;
  keeps non-Conventional commits in `Other`; **fails when a breaking commit meets a
  non-MAJOR bump**.
- `changelog.service.test.ts` — `listUnseen` excludes acked, draft, and wrong-audience
  entries; acknowledging is idempotent; a user created after an entry gets it auto-acked with
  `autoAcknowledged: true`; publishing a draft twice is rejected on OCC drift.
- `whats-new-dialog.test.tsx` — renders at most 3; dismissal acks all shown; **does not
  render while impersonating**; does not re-render on the next navigation; axe clean; focus
  returns to the trigger element on close.

---

## 6. Admin Console Surface

**Route:** `/(console)/(global)/releases` — audience tier 10–19 (global admins,
cross-tenant, never requires a working tenant). Nav label **"Releases"**, grouped with
Monitoring.

Built on `ScreenTemplate` (frame 09 contract) with `contentMode="fill"`:

- **header** — title "Platform Releases", plus the current `ALL-<ver>` train version as the
  headline badge, and an environment switcher (dev / staging / prod).
- **stats** — four cards: platform version · services live · services drifted (running a
  version older than the train's pinned digest) · oldest build age.
- **statusBanner** — shown only on drift or when a service has no live instance.
- **tabs** (`variant="line"`):
  - **Current** (default) — `AdminDataGrid`, one row per service:
    service · version badge · release tag · branch · `<sha8>` (monospace, click-to-copy,
    links to the GitLab commit) · built (relative + absolute on hover) · running since ·
    instance count · live/stale badge.
  - **History** — release timeline, filterable by service, newest first; each row links to
    its pipeline.
- **footer** — `StatusFooter` with last-refresh time.

Row click opens `DetailDrawer` (the one console-wide detail surface) with the full release
record, the OCI digest, the pipeline link, and every instance that has ever run it.

Standards honoured: `<Skeleton />` loading (never a spinner), `Empty` family for a service
with no registrations, semantic tokens only, TanStack Query v5 through the BFF proxy
(never `useEffect` fetching), WCAG 2.2 AA + axe.

Untagged builds render as an `outline` badge reading `dev-2.1 · 0ab258f9` rather than a
version number, so "no release tag" is never mistaken for a release.

The release `DetailDrawer` gains a **Changes** tab rendering the technical changelog
(§3.5) — grouped by type, each row linking to its commit and, where a `TASK-nnn` scope is
present, to that ticket.

## 6b. Changelog Surfaces

### One-time "What's New" dialog

Mounted once in `(console)/layout.tsx`, so it is a console-wide behaviour rather than
something each screen re-implements. On the first load after login it calls
`GET /api/v1/changelog/unseen`; an empty response renders nothing at all.

Per `11-ux-ui-principles.md` §1 this is a **rich dialog**: `sm:max-w-[70vw] h-[70vh]`,
`flex flex-col`, header fixed, body in `min-h-0 flex-1 overflow-y-auto`, actions pinned. It
shows up to three entries newest-first — title, severity badge (`destructive` for `BREAKING`,
`default` for `IMPORTANT`, `secondary` for `INFO`), and rendered markdown body. Footer:
"See all changes" (→ `/changelog`) and "Got it" (acks and closes).

It is a **dialog, not a toast** — a toast auto-dismisses, and a breaking-change notice that
disappears on its own has not been delivered.

### `/changelog` screen

**Route:** `/(console)/(shared)/changelog` — audience tier 20–29, because both global admins
and tenant admins need it. Global admins see every entry including drafts; tenant admins see
`PUBLISHED` entries whose audience includes them (`ALL` or `TENANT_ADMIN`).

`ScreenTemplate`, `contentMode="scroll"`, a reverse-chronological timeline (the `timeline`
composite in `@arcaai/ui`) rather than a data grid — a changelog is read as a narrative:

- **header** — "What's New", plus a global-admin-only "New entry" action.
- **toolbar** — severity filter and a version search, held in the URL via `nuqs` so a link to
  a filtered view is shareable.
- **content** — one card per entry: version · date · severity badge · title · rendered body,
  with a "Technical details" disclosure linking to the per-service releases behind that
  train (deep link to `/releases`, never a cross-feature import — features stay isolated).
- Unacked entries carry a subtle "New" marker; opening the screen acks what it displays.

Authoring (global admin only) reuses `DetailDrawer` — no bespoke modal. Draft entries carry a
`DRAFT` badge and a Publish action; publishing goes through the `If-Match`/`ETag` OCC path
(428 on a missing header, 412 on drift), so two admins cannot publish conflicting edits.

Markdown is rendered **sanitised**. Changelog bodies are authored by global admins, but they
are still stored input rendered into every admin's browser — the one XSS-shaped surface in
this ticket. No `dangerouslySetInnerHTML` without sanitisation.

---

## 7. Risks & Decisions

| Risk | Mitigation |
|---|---|
| Registration becomes a startup dependency for a PHI service | Best-effort, fire-and-forget, warn-and-continue (§3.5). Covered by a test that boots with the gateway unreachable. |
| Heartbeat floods the audit log | Sys-event only on a first-seen release, never on a heartbeat (§3.4). Explicit test. |
| `ResourceType` enum omitted in one of its two homes | Both edits are in W5; `resourceType.enum-parity.test.ts` is the existing guard. |
| Version info leaks to non-admins | Admin routes carry the same gate as `/health/services`; the public `/health` keeps its sanitised shape and does **not** gain branch/sha (only the corrected `version`). |
| 11 Dockerfiles drift out of sync on the build args | W1 adds a single shared `BUILD_ARGS` fragment in `.build-template`; a lint test asserts every Dockerfile declares the four `ARG`s. |
| A changelog is auto-published to every customer admin without review | CI only ever creates a `DRAFT`; publishing is an explicit global-admin action behind OCC (§3.5). |
| The popup acks on behalf of an impersonated user, who then never sees a breaking notice | Suppressed entirely during impersonation, with a dedicated test (§3.6 rule 4). |
| Stored markdown renders as XSS into every admin's browser | Sanitised render, no raw `dangerouslySetInnerHTML` (§6b). The only injection-shaped surface in this ticket. |
| The popup becomes noise and trains admins to dismiss unread | Curated notes only — never the commit log; capped at 3; `INFO` entries do not pin (§3.5). |

### Resolved decisions

**Prod is promotion-only (confirmed by the user, 2026-08-09).** A prod release row is
therefore created by the **promote-prod** step, never by a build job. Consequences that W2
must honour:

- The `ServiceRelease` row already exists (created by the dev/staging build that produced
  the image). Promotion does **not** create a second row — it attaches the resolved
  `imageDigest` and records that this digest reached prod.
- Promotion therefore writes to `ServiceInstance`-adjacent state only via the normal
  self-registration path: when the promoted pod boots in prod it registers with the SAME
  `(service, gitCommitSha, releaseTag)` key and simply appears with `environment=prod`.
- This is what makes the console's "same digest, three environments" view truthful: one
  release row, three instance groups. Any design that re-created the release per environment
  would break that guarantee.

---

## 7b. Parallel Execution Plan (agent team)

The eleven workstreams of §5 are re-cut here into **assignable units** with frozen
interfaces, disjoint file ownership, and a model tier per unit.

### 7b.1 The rule that makes parallelism safe

**No two concurrently-running agents may write the same file.** The ownership column below
is exhaustive and disjoint within each wave. Where two workstreams of §5 would have collided
(W1 and W2 both edit `.gitlab/ci/templates.yml`), they are merged into one unit.

### 7b.2 Wave 0 — freeze the contracts (blocking, single agent)

Everything else codes against these three artifacts, so they are produced **first, alone**,
and are then read-only for the rest of the ticket. This is what converts a serial ticket into
a parallel one — nine downstream agents can start from a frozen interface instead of waiting
for an implementation.

| Artifact | Path | Consumed by |
|---|---|---|
| `build-info.json` JSON Schema + the four `ARG` names | `docs/implementation/TASK-648-…/contracts/build-info.schema.json` | U1, U2, U3, U9 |
| Version-grammar regex + `0.0.0-<branch>.<sha8>` formatter, as a **shared TS module with tests** | `packages/utils/src/version-grammar.ts` | U1, U4, U6, U8 |
| OpenAPI fragment for the release routes + the changelog routes, the response DTO shapes, and the `severity`/`audience`/`publishStatus` enums | `docs/implementation/TASK-648-…/contracts/service-release.api.yaml` | U5, U6, U7, U8, U10, U11 |
| Conventional-Commit parse result shape (`{ type, scope, ticket, subject, sha, breaking }`) | same folder, `changelog-entry.schema.json` | U1, U4, U7, U10 |

| Unit | Tier | Effort | Rationale |
|---|---|---|---|
| **U0 — Contract freeze** | **opus-5** | low | Ambiguous, wide-blast-radius interface design; a mistake here is paid for by nine agents. Cheap to run at low effort because §3 already fixed the shape. |

**Gate:** the user (or the integrating agent) reviews U0's three artifacts before Wave 1
launches. Nothing else starts until they are merged.

### 7b.3 Wave 1 — full fan-out (11 units, all concurrent)

| Unit | Scope (§5 refs) | Owns (exclusive write set) | Tier | Effort |
|---|---|---|---|---|
| **U1 — CI stamping, tag validation, digest capture, changelog generation** | W1 + W2 + W12 | `.gitlab/ci/**`, `scripts/changelog-from-commits.ts` | **sonnet-5** | max |
| **U2 — Dockerfile bake-in ×11** | W3 | `apps/*/Dockerfile`, `apps/stt/docker/Dockerfile`, `packages/database/Dockerfile`, `infrastructure/docker/**/Dockerfile` | **sonnet-5** | medium |
| **U3 — Build-info readers (TS + Python)** | W4 | `packages/applications/src/common/build-info/**`, `packages/py-env/src/hope_env/build_info.py` | **sonnet-5** | medium |
| **U4 — Database + domain layer (all 4 models)** | W5 + W6 | `packages/database/**`, `packages/domains/**` | **sonnet-5** | max |
| **U5 — Application service** | W7 | `packages/applications/src/services/serviceRelease/**` | **opus-4-8** | low |
| **U6 — API controllers + health fix** | W8 | `apps/api/src/modules/service-release/**`, `apps/api/src/modules/health/health.controller.ts` | **sonnet-5** | max |
| **U7 — Admin console screen** | W10 | `apps/admin-console/src/app/(console)/(global)/releases/**`, `apps/admin-console/src/features/releases/**` | **sonnet-5** | max |
| **U8 — Self-registration clients** | W9 | `apps/api/src/main.ts`, `apps/{smr,stt,nlp,guardrail,tts,harness}/src/**/main.py` + worker entrypoints, `apps/admin-console/instrumentation.ts` | **sonnet-5** | medium |
| **U9 — Docs + rules** | W11 | `docs/operations/versioning.md`, `.claude/rules/09-infrastructure-devops.md`, this README | **sonnet-5** | medium |
| **U10 — Changelog service + API** | W13 | `packages/applications/src/services/changelog/**`, `apps/api/src/modules/changelog/**` | **opus-4-8** | low |
| **U11 — Changelog console surfaces** | W14 | `apps/admin-console/src/features/changelog/**`, `src/app/(console)/(shared)/changelog/**`, **`src/app/(console)/layout.tsx`** | **sonnet-5** | max |

**Tier reasoning against the tier table:**

- **opus-5 / low** for U0 only — the one genuinely ambiguous, architecture-shaped unit.
- **opus-4-8 / low** for U5 and U10 — the two correctness cruxes. U5 owns the sys-event
  suppression rule (§3.4), the kind of "looks harmless, floods the audit log" trap a mid-tier
  agent implements naively, plus idempotency and the release-vs-instance split. U10 owns
  seen-state semantics — the auto-ack for new users, the impersonation exclusion, and
  idempotent acknowledgement — where every bug is silent and only discovered as "the admin
  never saw the breaking-change notice".
- **sonnet-5 / max** for U1, U4, U6, U7, U11 — multi-file changes over surfaces with known
  landmines (digest promotion semantics; the `ResourceType` dual-enum + destructive
  `gen:mapper`; the auth posture on `/health`; a full console screen with a11y gates).
- **sonnet-5 / medium** for U2, U3, U8, U9 — repetitive-but-careful pattern application
  across many files, with an exemplar to copy in every case.
- **No haiku-4-5 unit exists.** Every remaining unit either edits production infrastructure
  or a PHI-serving service's startup path; none is pure classification/formatting. The only
  haiku-shaped work here (regenerating barrels, running `env:sync`) is folded into its owning
  unit rather than split out, because splitting it would create a file-ownership collision.

### 7b.4 Handling the one hard serial chain

`U4 (DB) → domain layer (W6) → U5 (service)` cannot truly parallelise. Two mitigations:

1. **W6 (domain trio ×2) is folded into U4**, not given its own unit. Splitting it would put
   two agents in `packages/domains` and `packages/database` at once, and the domain layer's
   landmines (`gen:mapper` is destructive; `ResourceType` must land in **both** enum homes)
   are exactly the kind that a hand-off boundary loses. U4 therefore runs
   `gen:model` → hand-author entity/factory/mapper/repository ×2 → `gen:entity` + `gen:factory`
   to reconcile → register in `CoreDatabaseModule`.
2. **U5 starts immediately against the U0 API contract with a hand-written repository
   interface**, and swaps to U4's real repository at integration. This costs U5 one small
   adapter and buys a full wave of parallelism.

Every other unit is genuinely independent: U6, U7, U10 and U11 build against the U0 OpenAPI
fragment (console units with MSW fixtures, controllers with a mocked service token), and U8
builds against the U0 JSON schema with the endpoint stubbed. U10 uses the same
hand-written-repository-then-swap trick as U5.

**One shared-file hazard:** `apps/admin-console/src/app/(console)/layout.tsx` is where the
What's New dialog mounts. It is assigned exclusively to **U11**; U7 must not touch it, and
neither may add a second scroll container or break the pinned-chrome contract of
`11-ux-ui-principles.md` §1 (BUG-004). This is the single most likely collision in the wave
and is called out here so the integrator watches for it.

### 7b.5 Integration

| Step | Owner | Tier | Effort |
|---|---|---|---|
| Merge order: **U0 → U4 → U3 → U5 → U10 → U6 → U1/U2 → U8 → U7 → U11 → U9** | integrator | — | — |
| **Integration + cross-unit review** — resolve the U5 repository swap, verify no unit widened a contract, run `pnpm verify` + the e2e spec end to end | **opus-5** | low | |

Merge order follows the runtime dependency, not the wave order: the DB/domain/service/API
chain lands first so U8's registration calls have somewhere real to go.

### 7b.6 Per-unit definition of done (every agent, non-negotiable)

- Failing test written and **observed failing** before implementation (`01-development-workflow.md`).
- Its package's build + test + lint green, with output pasted into the unit's report — including
  `only-warn` warnings in `packages/*`, which are treated as errors.
- **Touched no file outside its ownership row.** A unit that believes it needs to is blocked,
  not permitted to reach across — it reports the collision to the integrator.
- Appended its own entry to §9 Change History.

## 8. Implementation Summary

### U0 — Contract freeze ✅ COMPLETE

Worktree `.claude/worktrees/task-648-version-registry`, branch `task-648-version-release-registry`
(based on `dev-2.1`, **not** `origin/dev` — the default `worktree.baseRef: fresh` would have
branched off the wrong line).

| Artifact | Path |
|---|---|
| Version grammar (code + 23 tests) | `packages/utils/src/version-grammar.ts`, `src/__tests__/version-grammar.test.ts`, exported from the barrel |
| Build-info JSON Schema | `contracts/build-info.schema.json` |
| Technical-changelog JSON Schema | `contracts/changelog-entry.schema.json` |
| API contract (8 routes + DTO/enum shapes) | `contracts/service-release.api.yaml` |

Evidence:

```
 Test Files  6 passed (6)          # whole @arcaai/utils suite
      Tests  168 passed (168)      # 23 of them new
```

RED observed first (import failure on the not-yet-written module). `tsc --noEmit` reports
only pre-existing errors in `model-registry.ts` / `ModelLoader.ts` (unbuilt `@arcaai/types` in
a fresh worktree); none in the new files. `packages/utils` has no eslint config or `lint`
script, so there is no lint gate for this unit.

Decisions made while freezing, that Wave 1 must honour:

- **Build metadata (`+...`) is rejected** in the tag grammar. An image is identified by its
  digest; a `+build` suffix would be a second, weaker identity competing with it.
- **`parseReleaseTag` returns null rather than throwing.** Most pipeline runs are untagged —
  "not a release" is an ordinary outcome, not an error.
- **`formatUntaggedVersion` never throws**, degrading to `0.0.0-unknown.unknown`. It runs on
  the boot path of PHI-serving services (§3.7).
- **Branch slug corrected** to the `[^a-zA-Z0-9]` → `-` rule already used by
  `.build-template`, so `dev-2.1` yields `0.0.0-dev-2-1.<sha8>` and the version string agrees
  with the image tag. The original §3.1 example was inconsistent with CI and has been fixed.

### Wave 1 — not started

Awaiting review of the four U0 artifacts before fan-out.

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-09 | Ticket created; plan drafted (Pending approval). |
| 2026-08-09 | Changelog added to scope: two-audience model (generated technical changelog on the release row + curated `ChangelogEntry` release notes), server-side per-user acknowledgement, one-time What's New dialog, and a `(shared)/changelog` screen. Adds W12–W14 and units U10/U11; model count 2 → 4. |
| 2026-08-09 | Prod-is-promotion-only confirmed by the user → §7 open question resolved into a design constraint (one release row, three environments). Added §7b parallel execution plan: 11 workstreams re-cut into a blocking contract-freeze unit + 9 concurrent units + integration, with disjoint file ownership and a model tier per unit. |
