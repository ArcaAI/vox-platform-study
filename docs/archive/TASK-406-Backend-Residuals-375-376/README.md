# TASK-406 — Backend Residuals (P2-6 / TASK-375 + P2-7 / TASK-376)

| | |
|---|---|
| **Ticket** | TASK-406 |
| **Name** | Backend Residuals — TASK-375 (P2-6) + TASK-376 (P2-7) close-out |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed (E2E authored-and-deferred to the post-wave verifier) |
| **Type** | feature (P2-6) + test-infrastructure (P2-7) |
| **Source** | `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` items **P2-6** and **P2-7** |
| **Related** | [TASK-375](../TASK-375-Admin-Backend-Enhancements/README.md), [TASK-376](../TASK-376-Media-Seed-And-Backfill/README.md) |

Closes the deferred backend follow-ups that TASK-375 / TASK-376 flagged in their
own READMEs. Package-level work only — **`pnpm build:api` is NOT run and the
running `:8868` / `:5174` stack is never touched** (owned by a sibling ticket
this wave); E2E specs are authored-and-deferred for the consolidated verifier.

---

## 1. Requirement Analysis

### 1.1 P2-6 (TASK-375 residuals)

Backlog: *"`getContextItemsPaginated` enrichment; enum-member + JSON-path
validation; model-aware coercion for other list resources."* Mapped to the
TASK-375 README's own flagged deferrals:

- **(a) `getContextItemsPaginated` enrichment** (TASK-375 §7): the paginated
  variant of the consultation-context read does not run the `attachMediaUrls`
  media enrichment that `getContextItems` got in TASK-375 item 4. Enrich the
  returned page with the SAME presigned `url` / `mimeType` / `thumbnailUrl`
  resolution.
- **(b) enum-member + JSON-path validation** (TASK-375 §8 follow-up entry):
  - *enum*: the model-aware registry recognizes enum columns but keeps **no
    runtime member allow-list** — an invalid member passes through and Prisma
    rejects it server-side (surfacing as a 500-class error). Implement member
    validation: an invalid enum member in a CSV filter is rejected with a clear
    `BadRequestException` (400); valid members pass through unchanged.
  - *JSON*: JSON columns are recognized but "structured JSON-path filtering is
    a deferred follow-up (FLAGGED)". Implement a validated JSON-path filter
    grammar: `jsonColumn.path.to.key[op]:value` deserializes to Prisma's
    `{ path: [...], [op]: value }` JSON filter, with the operator validated
    against Prisma's JSON path-filter allow-list (400 on anything else).
- **(c) model-aware coercion for other list resources** (TASK-375 §8
  follow-up (2)): adopt the model-name registry for the list resources the
  README names — **tenant, media, role, permission, tag, webhook,
  notification** — so their boolean/number/date columns coerce and their
  enum/JSON columns are recognized/validated, exactly like `User`/`AuditLog`.

### 1.2 P2-7 (TASK-376 residuals)

Backlog: *"Recording-shaped audio fixture; parameterize media-test owner via
env."* Mapped to TASK-376 §8:

- **(a) recording-shaped audio fixture**: the seeded audio is a plain
  `audio/wav` ATTACHMENT. Seed a **recording-shaped** fixture too: an
  `AUDIO_RECORDING` context-item container + an `AudioRecording` row
  (duration/format/sampleRate/channels/sequenceNumber/recordedAt) pointing at
  a real audio `Media` object — the shape `ContextService.addAudioRecording`
  produces and `GET /consultations/:id/recordings` returns.
- **(b) parameterize the media-test owner via env**: the media Playwright
  check logs in as the hardcoded seeded `doctor`/`__GLOBAL__` owner. Allow the
  owner username / password / tenantKey to be overridden via env so
  `E2E_CONSULTATION_ID` can point at a different tenant's consultation.

### 1.3 Acceptance criteria

1. `getContextItemsPaginated` page items carry `url`/`mimeType`/`thumbnailUrl`
   when storage deps are wired; degrades to a no-op identically to
   `getContextItems` (unit-proven).
2. An invalid enum member in a `filters` CSV token → `BadRequestException`
   listing the allowed members; a valid member passes through byte-identical.
   Registry member lists are compile-time-guarded against the generated model
   types (a bogus member fails the `@arcaai/applications` build).
3. `jsonColumn.path[op]:value` produces `{ path: ['path'], [op]: value }` for
   declared JSON columns; unsupported ops → 400; non-JSON dotted keys keep the
   pre-existing byte-identical behavior.
4. Tenant / Media / Role / Tag / Webhook / Notification list+count paths pass
   their model names; e.g. `version[gte]:1` coerces to a number (unit-proven
   per service).
5. The TASK-376 seed additionally upserts (idempotent, additive, storage
   best-effort) the recording fixture with stable ids; the media spec owner is
   env-parameterized with the current defaults.
6. E2E specs for the above are authored (`task-406-*.spec.ts` + the edited
   TASK-375 spec) but **not run live** — deferred to the post-wave verifier.

### 1.4 Constraints

zsh; no `git commit`/`push`; no DELETE/DROP/TRUNCATE; **no schema change**
(confirmed: everything here is code-/fixture-level); no `pnpm build:api`; no
touching the running `dev:api:test` stack or `:5174`; no live E2E runs; no DB
writes (the updated seed is authored + type-checked, not executed here).

---

## 2. Current State Evaluation

| Concern | State (pre-TASK-406) |
|---|---|
| `ContextService.getContextItemsPaginated` | Maps `ContextDtoMapper.toResponse` only — no `attachMediaUrls` call (the non-paginated `getContextItems` has it). No HTTP route uses the paginated method yet (interface + unit tests only), so enrichment is unit-verifiable. |
| Enum filter values | `coerceFilterValue` `case 'enum'` is a documented pass-through; invalid members reach Prisma and fail server-side. Runtime enum objects exist in `@arcaai/domains` (`enums/generated/` — `ResourceStatusType`, `ResourceType`, `AuditAction`, `TenantPlan`, `NotificationType`, generated from the same Prisma schema), so a member allow-list needs **no** runtime import from `@arcaai/database`. |
| JSON filter values | `case 'json'` pass-through; the flat `field[op]:value` grammar cannot express Prisma `path` operators. `Repository.formatFindAllProps` passes `filters` verbatim into the Prisma `where`, so a `{ path, [op] }` object flows through untouched. |
| Registry coverage | `MODEL_FILTER_FIELD_TYPES` = `{ User, AuditLog }` only. Generated model types for Tenant/Media/Role/Tag/Webhook/Notification all exist (`@arcaai/database` type aliases). **`Permission` has NO Prisma model** — `PermissionRepository` points at a nonexistent `prisma.permission` delegate (legacy RBAC superseded by `Policy`/`RolePolicy`), so there is no generated type to drive the registry → skipped with this documented reason. |
| Six adopting services | `tenant` (fetchAll / fetchAllByTenantCodeName / fetchAllCreatedByUser — NOT `fetchTenantConfigs`, which lists GlobalSetting rows owned by the settings module), `media` (fetchAll / fetchAllByTenantId / fetchAllCreatedByUser), `role` (fetchAll / fetchAllCreatedByUser), `tag` (fetchAll / fetchAllByTenantId / fetchAllCreatedByUser), `webhook` (fetchAll / fetchAllByTenantId / fetchAllCreatedByUser), `notification` (fetchAll / fetchAllByTenantId / fetchAllCreatedByUser) — all call `withFormatted{Paginated,Count}Props(props)` with no model name today. |
| TASK-376 seed | `packages/applications/scripts/task-376-media-seed.ts` — additive/idempotent, storage best-effort. Free stable ids: media `96…381`, context item `91…380`, audio recording `93…376` (existing seeds use `93…0001-0004`). |
| Media spec owner | `task-375-admin-features.spec.ts` hardcodes `SEEDED_USERS.doctor` + `DEFAULT_TENANT_KEY`. |

Uncommitted-tree note: `modelFilterTypes.ts` already carries a sibling's
TASK-400 `passwordChangedAt` entry — built upon, not reverted.

---

## 3. Implementation Plan (TDD)

No Domain (`packages/domains`) or Database (`packages/database`) change. All
Application-layer + scripts + specs.

### Item A — enum-member + JSON-path validation (P2-6b) + registry expansion (P2-6c)

- **RED** (`paginatedQueryParamConverters.test.ts`): enum-member validation
  (invalid member throws `BadRequestException`, valid passes, plain-`'enum'`
  explicit maps stay unvalidated pass-throughs); JSON-path grammar (dotted key
  on a JSON column → `{ path, [op] }`, op allow-list, value coercion,
  string_* ops keep raw strings, non-JSON dotted keys unchanged, AND-group
  recursion); new-model coercion (Tenant/Media/Role/Tag/Webhook/Notification
  boolean/number/date/enum columns). Update the TASK-375 tests that pinned the
  old pass-through/`'enum'`-literal contract.
- **GREEN** (`modelFilterTypes.ts`): `EnumFilterFieldSpec` (`{ type: 'enum',
  members }`) + `enumFilterMembers()` helper reading the `@arcaai/domains`
  generated enum objects; `ModelFilterFieldTypes<T>` now REQUIRES the spec
  (with members typed against the generated column union — invalid/extra
  members fail the build) for every enum column; six new
  `*_FILTER_FIELD_TYPES` registries + `MODEL_FILTER_FIELD_TYPES` entries.
  (`paginatedQueryParamConverters.ts`): `coerceFilterValue` validates enum
  members (throws 400); dotted-key JSON-path branch with
  `JSON_PATH_FILTER_OPERATORS` allow-list + conservative value coercion;
  bracket parsing hardened (first-`[` / first-`]:` split so JSON values
  containing `[` or `]:` survive).

### Item B — service adoption (P2-6c)

- **RED**: one focused test per service (existing harnesses) — `fetchAll({
  filters: 'version[gte]:2' })` reaches `repository.findAll` with
  `{ version: { gte: 2 } }` (a number).
- **GREEN**: `const XXX_FILTER_MODEL = '<Model>'` passed on every list/count
  call site listed in §2 (14 call-site pairs across 6 services).

### Item C — `getContextItemsPaginated` enrichment (P2-6a)

- **RED** (`context.service.test.ts`): paginated read with storage deps wired
  presigns and attaches `url`/`mimeType`/`thumbnailUrl` on the PAGE slice
  only; degrades to no-op without deps.
- **GREEN** (`context.service.ts`): map the page slice, `await
  this.attachMediaUrls(responses)`, return.

### Item D — recording-shaped fixture (P2-7a) + owner env (P2-7b)

- Seed: new WAV (2 s, distinct tone) uploaded best-effort; `Media` `96…381` +
  `AUDIO_RECORDING` context item `91…380` (no mediaId — production shape) +
  `AudioRecording` `93…376` (duration 2000 ms / wav / 16 kHz / mono / seq 1 /
  fixed `recordedAt`) — all upsert-by-id. Verified by `tsc --noEmit` on the
  scripts (pure-file check; live run deferred).
- Spec: `E2E_CONSULTATION_OWNER_USERNAME` / `..._PASSWORD` /
  `..._TENANT_KEY` env overrides defaulting to the current
  `doctor`/`__GLOBAL__` values.

### Item E — E2E specs (authored-and-deferred)

`apps/api/tests/e2e/task-406-backend-residuals.spec.ts`: enum-member 400/200
on `/admin/users`; JSON-path 200 + unsupported-op 400; other-resource coercion
on `/admin/tenants` (`version[gte]:1` → 200; bogus `plan` member → 400);
recording fixture via `/consultations/:id/recordings` as the (env-param'd)
owner. NOT run in this ticket.

### Migration decision

**No Prisma migration.** Additive code + fixtures only. No destructive SQL.

---

## 4. Implementation Summary

### P2-6b — enum-member validation + JSON-path filtering

- **Registry** (`modelFilterTypes.ts`): new `EnumFilterFieldSpec<TMember>`
  (`{ type: 'enum', members }`) + `enumFilterSpec()` helper building the member
  list from the `@arcaai/domains` GENERATED enum objects (same Prisma schema,
  same generator run → members can't drift; no runtime `@arcaai/database`
  import). `ModelFilterFieldTypes<T>` now REQUIRES the member-carrying spec for
  every enum column, with `members` typed against the column's generated
  literal union — a wrong/unknown member in the registry fails the
  `@arcaai/applications` build. `USER_/AUDIT_LOG_FILTER_FIELD_TYPES` upgraded
  (`ResourceStatusType` / `ResourceType` / `AuditAction`).
- **Converter** (`paginatedQueryParamConverters.ts`):
  - `coerceFilterValue` validates a member-carrying enum spec and throws
    `BadRequestException` (400) naming the field, the bad value and the allowed
    members; a valid member passes through byte-identical. A plain `'enum'` tag
    in an EXPLICIT caller map keeps the TASK-375 unvalidated pass-through
    (documented escape hatch), as do enum/JSON whole-column values.
  - JSON-path grammar: a dotted key whose ROOT is a declared `'json'` column
    (`metaData.a.b[equals]:1`) deserializes to Prisma's
    `{ path: ['a','b'], equals: 1 }` with (i) the operator validated against
    the Prisma JSON path-filter allow-list (`equals/not/lt/lte/gt/gte/
    string_contains/string_starts_with/string_ends_with/array_contains/
    array_starts_with/array_ends_with`) → 400 otherwise; (ii) empty path
    segments → 400; (iii) conservative value coercion (JSON literal parse for
    value ops — `5`→number, `true`→boolean, `null`, arrays; raw-string
    fallback; string_* ops NEVER parse); (iv) same-path ops merge (gte+lte
    range), a second path on the same column in one group → 400 pointing at
    `AND[…]` groups (which recurse with the same rules); (v) any dotted key
    whose root is NOT a declared JSON column keeps the literal-key legacy
    behaviour byte-for-byte.
  - Token parsing hardened: split on FIRST `[` / FIRST `]:` so JSON values
    containing `[` or `]:` survive (byte-identical for all previously-valid
    tokens, which silently dropped the extra pieces).

### P2-6c — model-aware coercion for the other list resources

Six new registry entries (Tenant / Media / Role / Tag / Webhook /
Notification), each `satisfies ModelFilterFieldTypes<Model>` for completeness +
drift-guarding, and each service now passes its model name on every
`withFormatted{Paginated,Count}Props` list/count call site:

| Service | Call sites (pairs) | Coercions unlocked |
|---|---|---|
| `tenant.service.ts` | fetchAll, fetchAllByTenantCodeName, fetchAllCreatedByUser | version→number, trialEndsAt/dates→Date, plan+resourceStatus→validated enums, metaData→JSON-path |
| `media.service.ts` | fetchAll, fetchAllByTenantId, fetchAllCreatedByUser | size/version→number, dates, resourceStatus, metaData |
| `role.service.ts` | fetchAll, fetchAllCreatedByUser | isSystemRole→boolean, version, dates, resourceStatus, metaData |
| `tag.service.ts` | fetchAll, fetchAllByTenantId, fetchAllCreatedByUser | version, dates, resourceStatus, metaData (tagValue etc. stay strings) |
| `webhook.service.ts` | fetchAll, fetchAllByTenantId, fetchAllCreatedByUser | version, dates, resourceStatus, metaData+subscriptionMetadata→JSON-path |
| `notification.service.ts` | fetchAll, fetchAllByTenantId, fetchAllCreatedByUser | read→boolean, version/keyVersion→number, dates, type+resourceStatus→validated enums, metaData |

Deliberately NOT changed: `tenant.service.fetchTenantConfigs` (lists
GlobalSetting rows — settings-module surface, out of TASK-406's lane) and
**Permission** (named by TASK-375 but has NO Prisma model — the legacy
`PermissionRepository` targets a nonexistent `prisma.permission` delegate, so
there is no generated type to drive an entry; skipped with this rationale).

### P2-6a — `getContextItemsPaginated` enrichment

`context.service.ts`: the paginated read now maps the PAGE slice to responses
and awaits the existing `attachMediaUrls` on it — same presigned
`url`/`mimeType`/`thumbnailUrl` resolution as `getContextItems`, applied only
to returned items (no presigning for off-page rows), degrading to a no-op when
the optional storage deps aren't wired. (Still no HTTP route uses the paginated
method — unit-tested; unchanged surface otherwise.)

### P2-7a — recording-shaped audio fixture

`scripts/task-376-media-seed.ts` (additive/idempotent/storage-best-effort, as
before) now also upserts the production shape `ContextService.addAudioRecording`
writes: an `AUDIO_RECORDING` container context item
(`91000000-0000-0000-0000-000000000380`, SYSTEM-sourced, no mediaId) + an
`AudioRecording` row (`93000000-0000-0000-0000-000000000376`; duration 2000 ms,
wav, 16 kHz, mono, seq 1, fixed `recordedAt`, language en) + a real 2-second
330 Hz WAV `Media` (`96000000-0000-0000-0000-000000000381`, uploaded
best-effort to `hope-audio-global/task-376/sample-recording.wav`, nominal size
64044 when storage is absent). `GET /consultations/:id/recordings` returns it.
Ids verified collision-free against all existing seeds.

### P2-7b — media-test owner via env

`task-375-admin-features.spec.ts`: the media test's tenant-bound owner login is
now `E2E_MEDIA_OWNER_USERNAME` / `E2E_MEDIA_OWNER_PASSWORD` /
`E2E_MEDIA_OWNER_TENANT_KEY`, defaulting to the previous hardcoded values
(seeded `doctor` / `__GLOBAL__`) — so `E2E_CONSULTATION_ID` can point at
another tenant's consultation with a matching owner.

### E2E (authored-and-deferred)

`apps/api/tests/e2e/task-406-backend-residuals.spec.ts` — 7 tests: enum member
valid→200 / invalid→400 (+allowed members listed) on `/admin/users`; JSON-path
accepted→200 / unsupported op→400; Tenant `version[gte]:1`→200 + bogus
`plan`→400 on `/admin/tenants`; the recording fixture via
`/consultations/:id/recordings` as the env-param'd owner. **NOT run in this
ticket** (stack owned by a sibling); the consolidated post-wave verifier runs
it together with the edited `task-375-admin-features.spec.ts`.

---

## 5. Files Changed

| File | Change |
|---|---|
| `packages/applications/src/common/modelFilterTypes.ts` | `EnumFilterFieldSpec` + `enumFilterSpec()`; enum entries now member-carrying; 6 new model registries (Tenant/Media/Role/Tag/Webhook/Notification) registered in `MODEL_FILTER_FIELD_TYPES` |
| `packages/applications/src/common/paginatedQueryParamConverters.ts` | enum member validation (400); JSON-path grammar + operator allow-list + value coercion; hardened first-`[`/first-`]:` token parsing |
| `packages/applications/src/common/paginatedQueryParamConverters.test.ts` | 3 TASK-375 pins updated to the new contract; +21 tests (enum validation ×4, JSON-path ×10, six-model registry ×7) |
| `packages/applications/src/services/consultation/context/context.service.ts` | `getContextItemsPaginated` enriches the page slice via `attachMediaUrls` |
| `packages/applications/src/services/consultation/context/__tests__/context.service.test.ts` | +3 tests (paginated enrichment, page-slice-only scoping, no-deps degrade) |
| `packages/applications/src/services/tenant/tenant.service.ts` | `TENANT_FILTER_MODEL` on 3 list/count pairs (`fetchTenantConfigs` untouched) |
| `packages/applications/src/services/tenant/__tests__/tenant.service.test.ts` | +2 tests (coercion reaches repo; invalid plan → 400) |
| `packages/applications/src/services/media/media/media.service.ts` | `MEDIA_FILTER_MODEL` on 3 pairs |
| `packages/applications/src/services/media/media/__tests__/media.service.test.ts` | +1 test |
| `packages/applications/src/services/security/role/role.service.ts` | `ROLE_FILTER_MODEL` on 2 pairs |
| `packages/applications/src/services/security/role/__tests__/role.service.test.ts` | +1 test |
| `packages/applications/src/services/tag/tag.service.ts` | `TAG_FILTER_MODEL` on 3 pairs |
| `packages/applications/src/services/tag/__tests__/tag.service.test.ts` | +1 test |
| `packages/applications/src/services/webhook/webhook.service.ts` | `WEBHOOK_FILTER_MODEL` on 3 pairs |
| `packages/applications/src/services/webhook/__tests__/webhook.service.test.ts` | +1 test (incl. subscriptionMetadata JSON-path) |
| `packages/applications/src/services/notification/notification.service.ts` | `NOTIFICATION_FILTER_MODEL` on 3 pairs |
| `packages/applications/src/services/notification/__tests__/notification.service.test.ts` | +1 test |
| `packages/applications/scripts/task-376-media-seed.ts` | recording fixture: WAV build/upload + Media + AUDIO_RECORDING container + AudioRecording upserts, result JSON |
| `apps/api/tests/e2e/task-375-admin-features.spec.ts` | media-owner login env-parameterized (`E2E_MEDIA_OWNER_*`, defaults unchanged) |
| `apps/api/tests/e2e/task-406-backend-residuals.spec.ts` | **NEW** — 7 deferred E2E tests (see §4) |
| `docs/implementation/TASK-406-Backend-Residuals-375-376/README.md` | this ticket document |

No Prisma schema change, no migration, no domain-layer change, all additive.

---

## 6. Verification Evidence

TDD RED→GREEN (vitest, `packages/applications`):

| Step | RED | GREEN |
|---|---|---|
| P2-6b converter (`paginatedQueryParamConverters.test.ts`) | `21 failed \| 31 passed (52)` | both converter test files: `68 passed (68)` |
| P2-6c six service suites | `7 failed \| 305 passed (312)` across 6 files | `312 passed (312)` |
| P2-6a context suite (`-t "TASK-406"` then full file) | `2 failed \| 1 passed` (new tests) | full file `164 passed (164)` |

Full package suite + build + lint (after all changes):

```
pnpm vitest run  (packages/applications)   → Test Files 265 passed | 1 skipped (266)
                                             Tests 5748 passed | 4 skipped (5752)   exit 0
pnpm build --filter @arcaai/applications   → Tasks: 7 successful, 7 total          exit 0
pnpm --filter @arcaai/applications lint    → 0 errors (104 pre-existing prettier
                                             warnings, none in TASK-406 files)
ReadLints (all touched files)              → No linter errors found
```

Pure-file checks (scripts are build-excluded; type-checked directly, same
method as TASK-376 §7):

```
tsc --noEmit task-376-media-seed.ts task-376-storage.ts
  (--target es2022 --module commonjs --moduleResolution node
   --esModuleInterop --skipLibCheck)                        → exit 0
tsc --noEmit task-406-backend-residuals.spec.ts task-375-admin-features.spec.ts
  → 0 errors in the two specs; 5 pre-existing errors in shared tests/helpers/*
    (identical output for an untouched sibling spec, task-401 — environmental)
```

Constraint compliance: `pnpm build:api` NOT run; the `dev:api:test` server /
`:8868` / `:5174` never stopped/started/touched; NO live E2E executed; NO DB
reads/writes performed (the updated seed was type-checked only — its live run
is deferred with the E2E); no `git commit`/`push`; no DELETE/DROP/TRUNCATE; no
schema change; forbidden modules (users/password/impersonation/entitlements/
settings, `apps/admin`, SDK, `docs/qa/**`, infrastructure) untouched.

Deferred to the post-wave consolidated verifier:
1. `pnpm test:db:seed:media` (or `test:db:seed`) — creates the recording
   fixture (idempotent).
2. `npx playwright test task-406-backend-residuals task-375-admin-features`
   against the running test stack.

---

## 7. Change History

- 2026-07-02 — Ticket created; requirement analysis, current-state evaluation
  and TDD plan recorded (next-free ticket number confirmed: 386–405 exist or
  are owned by wave siblings 403/404/405).
- 2026-07-02 — Implemented all five residuals TDD RED→GREEN (31 new + 3
  updated unit tests); authored the deferred `task-406` E2E spec; extended the
  TASK-376 seed + owner env parameterization; full suite/build/lint green.
  Status → Completed.
