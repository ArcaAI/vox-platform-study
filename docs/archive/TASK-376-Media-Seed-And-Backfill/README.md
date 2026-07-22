# TASK-376 — Media Seed & Thumbnail Backfill (verify consultation media end-to-end)

| | |
|---|---|
| **Ticket** | TASK-376 |
| **Title** | Make consultation media verifiable end-to-end (seed + backfill) |
| **Type** | infrastructure / test-fixture |
| **Status** | Completed |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-27 |
| **Resolves** | DEFECT-M1 |
| **Related** | [TASK-374 — Admin App Integration](../TASK-374-Admin-App-Integration/README.md), [TASK-375 — Admin Backend Enhancements](../TASK-375-Admin-Backend-Enhancements/README.md) |

---

## 1. Requirement Analysis

The TASK-375 media contract (`Media` → presigned `url` + `mimeType`, image `*.thumb.webp` → presigned `thumbnailUrl`, resolved by `ContextService.resolveMediaUrls`) shipped with a Playwright check that was **permanently skipped**, because the default seed ships **no** image/PDF/attachment context items and one audio `Media` pointed at a non-existent MinIO bucket — there was nothing to verify against.

**DEFECT-M1:** consultation media could not be verified end-to-end (no fixture data; the media E2E never ran).

**Acceptance criteria**

1. An **additive, idempotent** seed creates a consultation with context items covering an **image**, a **PDF**, an **audio** clip, and a **mixed** item (image + file + text), with **real** sample files uploaded into MinIO through the canonical storage convention, including a real `*.thumb.webp` for the image. The consultation id is stable and logged.
2. An **idempotent, best-effort** backfill finds image `Media` lacking a `{key}.thumb.webp` and generates it by **reusing** `ImageThumbnailService` (no reimplementation); logs results; skips failures; only adds derivative objects.
3. The media Playwright check **passes** against the live stack with the seeded id: image exposes a downscaled thumbnail + full-res url; PDF + audio render via presigned urls.

**Constraints:** zsh; no remote push; **no destructive DB ops** — additive/idempotent only.

---

## 2. What was seeded

One **Global-tenant** consultation (status `CLOSED`, owned by the seeded `doctor` in the `__GLOBAL__` tenant), with four `ATTACHMENT` context items, five `Media` rows, and six real MinIO objects.

- **Consultation id (stable):** `90000000-0000-0000-0000-000000000376`
- **Tenant:** `50000000-0000-0000-0000-000000000000` (Global) · **Owner (doctor):** `70000000-0000-0000-0000-000000000010`
- **Buckets (canonical):** `hope-attachments-global`, `hope-audio-global`

| Context item | Context id | Media id | Object (`s3://…`) | `mimeType` | Thumbnail |
|---|---|---|---|---|---|
| image | `91…376` | `96…376` | `hope-attachments-global/task-376/sample-image.png` | `image/png` | `…/sample-image.png.thumb.webp` (seeded inline) |
| pdf | `91…377` | `96…377` | `hope-attachments-global/task-376/sample-document.pdf` | `application/pdf` | — |
| audio | `91…378` | `96…378` | `hope-audio-global/task-376/sample-audio.wav` | `audio/wav` | — |
| mixed (image+file+text) | `91…379` | `96…379` (image) + `96…380` (file) | `hope-attachments-global/task-376/mixed-photo.png` + `…/mixed-note.txt` | `image/png` + `text/plain` | `…/mixed-photo.png.thumb.webp` (**created by the backfill**) |

The sample files are generated in-script (no committed binaries): the images are real ≥1024px PNGs rasterized via `sharp` (so the ≤320px `.thumb.webp` is a genuine downscale); the PDF is a minimal valid single-page `application/pdf`; the audio is a real playable PCM16 mono WAV. The mixed item's narrative text + attached-file pointer live in `ContextItem.metaData` (the encrypted `content` column is owned by the service write-path, not this storage seed).

The **mixed image is uploaded WITHOUT a thumbnail on purpose**, so the backfill has a real image to generate one for — exercising the backfill end-to-end. After both scripts run, every seeded image has a real downscaled thumbnail.

---

## 3. Scripts

All three live under `packages/applications/scripts/` (ESLint-ignored, build-excluded) so they can import the package's own `ImageThumbnailService` source and the `@aws-sdk/client-s3` / `sharp` deps that resolve there. They talk to the **same** physical MinIO + Postgres the API uses (`.env.dev` is loaded as a side effect of importing `@arcaai/database`). They are unscoped admin tooling: with no NestJS `TenantContextProvider` registered, `getExtendedPrismaClient()` runs as the platform-admin (cross-tenant) client.

| File | Purpose |
|---|---|
| `media-storage.ts` | Shared MinIO/S3 helpers (S3 client from `MINIO_*`, `ensureBucket`, `objectExists`, `putObject`, `getObjectBytes`, `parseStorageUri`). |
| `media-seed.ts` | The additive/idempotent seed (Task 1). Upserts the consultation + media + context items by fixed ids (outside every existing seed range) and PUTs the objects by key. Re-running changes nothing. |
| `thumbnail-backfill.ts` | The idempotent, best-effort backfill (Task 2). Reuses `ImageThumbnailService.generateWebpThumbnail`. |

### How to run (from repo root)

```bash
# 1) Seed (additive / idempotent)
NODE_ENV=development node_modules/.bin/tsx \
  packages/applications/scripts/media-seed.ts

# 2) Thumbnail backfill (idempotent / best-effort / non-destructive)
NODE_ENV=development node_modules/.bin/tsx \
  packages/applications/scripts/thumbnail-backfill.ts
```

The seed prints `E2E_CONSULTATION_ID=90000000-0000-0000-0000-000000000376` at the end for the verification step.

The seed is also folded into the **test-DB seed** so the fixture exists after every CI/local test seed — run standalone via `pnpm test:db:seed:media`, or transitively via `pnpm test:db:seed` / `pnpm test:db:reset`. See **§9** for the wiring, the MinIO-absent guard, and the default `E2E_CONSULTATION_ID`.

---

## 4. Verification (real output)

### 4.1 Seed run

```
[task-376] seeding media for consultation 90000000-0000-0000-0000-000000000376
[bucket] hope-attachments-global created
[bucket] hope-audio-global created
[object] hope-attachments-global/task-376/sample-image.png (64917B) + task-376/sample-image.png.thumb.webp (2344B, real downscale)
[object] hope-attachments-global/task-376/sample-document.pdf (784B)
[object] hope-audio-global/task-376/sample-audio.wav (32044B)
[object] hope-attachments-global/task-376/mixed-photo.png (63798B, NO thumb — left for backfill)
[object] hope-attachments-global/task-376/mixed-note.txt (116B)
[consultation] upserted 90000000-0000-0000-0000-000000000376
[media] upserted 96000000-0000-0000-0000-000000000376 (image) → s3://hope-attachments-global/task-376/sample-image.png
[media] upserted 96000000-0000-0000-0000-000000000377 (pdf)   → s3://hope-attachments-global/task-376/sample-document.pdf
[media] upserted 96000000-0000-0000-0000-000000000378 (audio) → s3://hope-audio-global/task-376/sample-audio.wav
[media] upserted 96000000-0000-0000-0000-000000000379 (mixed-image) → s3://hope-attachments-global/task-376/mixed-photo.png
[media] upserted 96000000-0000-0000-0000-000000000380 (mixed-file)  → s3://hope-attachments-global/task-376/mixed-note.txt
[contextItem] upserted 91000000-0000-0000-0000-000000000376 (ATTACHMENT) → media 96…376
[contextItem] upserted 91000000-0000-0000-0000-000000000377 (ATTACHMENT) → media 96…377
[contextItem] upserted 91000000-0000-0000-0000-000000000378 (ATTACHMENT) → media 96…378
[contextItem] upserted 91000000-0000-0000-0000-000000000379 (ATTACHMENT) → media 96…379
E2E_CONSULTATION_ID=90000000-0000-0000-0000-000000000376
```

### 4.2 Backfill run — generates the one missing thumbnail, then is a no-op

```
# First run — generates the mixed image's thumbnail, skips the one that already has it
[task-376 backfill] scanning 2 image Media row(s)…
[ok]   96…376 — thumbnail already present (hope-attachments-global/task-376/sample-image.png.thumb.webp)
[gen]  96…379 — generated hope-attachments-global/task-376/mixed-photo.png.thumb.webp (2232B from 63798B)
===== TASK-376 BACKFILL RESULT =====
{ "scanned": 2, "generated": 1, "alreadyHad": 1, "skipped": 0, "failed": 0 }

# Second run — idempotent: nothing to do
[ok]   96…376 — thumbnail already present (…/sample-image.png.thumb.webp)
[ok]   96…379 — thumbnail already present (…/mixed-photo.png.thumb.webp)
===== TASK-376 BACKFILL RESULT =====
{ "scanned": 2, "generated": 0, "alreadyHad": 2, "skipped": 0, "failed": 0 }
```

### 4.3 Direct API probe (resolved presigned URLs)

`GET /api/v1/consultations/90000000-0000-0000-0000-000000000376/context` as the tenant-bound owner (`doctor` @ `__GLOBAL__`) → **200**, 4 items:

| item | `mimeType` | `url` | `thumbnailUrl` |
|---|---|---|---|
| image | `image/png` | presigned `…/sample-image.png?X-Amz-…` | presigned `…/sample-image.png.thumb.webp?X-Amz-…` |
| pdf | `application/pdf` | presigned `…/sample-document.pdf?X-Amz-…` | `null` |
| audio | `audio/wav` | presigned `…/sample-audio.wav?X-Amz-…` | `null` |
| mixed image | `image/png` | presigned `…/mixed-photo.png?X-Amz-…` | presigned `…/mixed-photo.png.thumb.webp?X-Amz-…` (from the backfill) |

### 4.4 Playwright — the previously-skipped media check now PASSES

```bash
SKIP_DB_PRECHECK=true API_URL=http://localhost:8868 \
  E2E_CONSULTATION_ID=90000000-0000-0000-0000-000000000376 \
  npx playwright test apps/api/tests/e2e/task-375-admin-features.spec.ts --workers=1
```

```
✓  10 [api-tests] › task-375-admin-features.spec.ts › … › Media: context attachments expose presigned url + mimeType (+ thumbnail for images) (123ms)
  10 passed (1.4s)
```

(Run with `SKIP_DB_PRECHECK=true`, which **skips** the destructive `test:db:reset` in the Playwright global-setup — no DB mutation. The global-teardown only stops the separate `*-test` compose project; the dev stack containers were verified `healthy` and the seeded consultation still readable after the run.)

`ReadLints` on the three new scripts + the edited spec: **No linter errors found.**

---

## 5. Root cause of the skipped/failing media check (test-only defects)

The seed + backfill alone left the media test **failing with `404`**. Probing the live API revealed the failure was entirely in the **test**, not the data or the API:

1. **Wrong path (singular vs plural).** The test called `GET /api/v1/consultation/:id/context`; the registered route (confirmed via the live Swagger spec) is the **plural** `GET /api/v1/consultations/:id/context`. The singular path hit no route → Express `"Cannot GET …"` 404.
2. **Wrong auth scope.** The route is **tenant-scoped**: the cross-tenant `super_admin` (no tenant binding) is rejected `400 "Tenant ID is required"`. The other 9 checks in the file legitimately use `super_admin` (admin/users, settings), but the media flow must read as the consultation's **tenant-bound owner**.

**Fix** (`apps/api/tests/e2e/task-375-admin-features.spec.ts`, media test only): use the plural path and log in as the consultation owner (`SEEDED_USERS.doctor` + `DEFAULT_TENANT_KEY`) for that one check; the shared `super_admin` token is unchanged for the other checks. The skip message now points at this TASK-376 seed.

---

## 6. DEFECT-M1 — Resolved

Consultation media is now verifiable end-to-end: a stable, additive seed provides image/PDF/audio/mixed attachments backed by real MinIO objects; the backfill guarantees every image has a real `.thumb.webp`; and the media Playwright check is un-skipped, corrected, and **passing** against the live stack — confirming presigned `url` + `mimeType` for all media and a real downscaled `thumbnailUrl` for images. This closes the TASK-375 gap where the media contract shipped unverifiable.

---

## 7. Files changed

| File | Change |
|---|---|
| `packages/applications/scripts/media-storage.ts` | **New** — shared MinIO/S3 helpers. *(§9)* `makeS3Client` takes an optional `{ maxAttempts }` so the seed's reachability probe can fail fast. |
| `packages/applications/scripts/media-seed.ts` | **New** — additive/idempotent media seed (Task 1). *(§9)* Object storage is now best-effort/guarded (fast-fail probe + 5s timeout); DB rows always upsert with nominal sizes when MinIO is absent; result reports `storageAvailable`/`objectsUploaded`. |
| `packages/applications/scripts/thumbnail-backfill.ts` | **New** — idempotent thumbnail backfill reusing `ImageThumbnailService` (Task 2). |
| `apps/api/tests/e2e/task-375-admin-features.spec.ts` | **Edit (media test only)** — plural `consultations` path + tenant-bound owner login; updated doc comments + skip message. *(§9)* `E2E_CONSULTATION_ID` now defaults to the seeded id via `??` (empty-string opt-out). The D8/Users checks are untouched. |
| `package.json` (root) | **Edit (§9)** — `test:db:seed` chains the new `test:db:seed:media` script after the `@arcaai/database` seed; `test:db:reset` inherits it transitively. |
| `.gitlab/ci/prepare.yml` | **Edit (§9)** — `prepare-test-db` runs the media seed (`pnpm exec tsx …/media-seed.ts`) after the core seed. |
| `docs/implementation/TASK-376-Media-Seed-And-Backfill/README.md` | **New** — this document. |

---

## 8. Follow-ups (non-blocking)

- **Audio fixture vs `audioSegment`-shaped media.** The seeded audio is a plain `audio/wav` attachment (sufficient for the presigned-url contract). If the timeline later needs full recording/transcription playback, seed a recording-shaped fixture too.
- **Generalize the media test's owner.** It currently logs in as the seeded `doctor`/`__GLOBAL__` owner (matches this fixture). If `E2E_CONSULTATION_ID` is ever pointed at a different tenant's consultation, parameterize the owner username/tenantKey via env.
- ~~**Optional CI fixture.** If a permanent media fixture is wanted in CI, fold this seed into the test-DB seed (it is already upsert-safe), gated to dev/test.~~ **Done — see §9.** The upsert-safe seed is now part of the test-DB seed (local `test:db:seed`/`test:db:reset` + the CI `prepare-test-db` job), storage-best-effort so it never fails CI.

---

## 9. CI integration — folded into the test-DB seed

The media fixture is now seeded automatically by the test-DB seed, so the media E2E runs with no manual env. It stays additive/idempotent and **storage-best-effort**, so it never fails a CI seed when MinIO is absent.

### 9.1 How it's wired

Orchestrated at the **pnpm-script level**, *after* the core `@arcaai/database` seed — **not** imported into `@arcaai/database`. `@arcaai/applications` depends on `@arcaai/database` (for the S3/`sharp`/`ImageThumbnailService` deps), so importing the seed back into the database package would be a circular dependency. Running it as a following step keeps the dependency direction clean, and the media seed FK-references core rows (Global tenant, `doctor`, `GEN` dept, the canonical buckets) that the core seed creates first.

**Local (`package.json`):**

```jsonc
"test:db:seed":       "dotenv -e .env.test -- pnpm --filter @arcaai/database seed && pnpm test:db:seed:media",
"test:db:seed:media": "dotenv -e .env.test -- tsx packages/applications/scripts/media-seed.ts",
"test:db:reset":      "pnpm test:db:push && pnpm test:db:seed",
```

The Playwright global-setup runs `test:db:reset` (→ `test:db:seed` → `test:db:seed:media`), so the fixture is present for `pnpm test:e2e` automatically.

**CI (`.gitlab/ci/prepare.yml`, `prepare-test-db`):** after `pnpm --filter @arcaai/database seed`, a new step runs the seed against the already-validated `$CI_DATABASE_URL`:

```yaml
- echo "── Seeding TASK-376 media fixture (DB rows; MinIO objects best-effort)..."
- pnpm exec tsx packages/applications/scripts/media-seed.ts
```

### 9.2 MinIO-absent guard (CI-safe)

CI runs **no** MinIO service, so the object-upload portion is guarded; the DB rows are **always** upserted.

- The S3 client is built with `makeS3Client({ maxAttempts: 1 })` (no retry/backoff) and the **first** `ensureBucket` call — wrapped in `withTimeout(…, 5000ms)` — doubles as a fast **reachability probe**.
- **Reachable** (local dev) → buckets ensured, real sample files built (incl. the native `sharp` dep) + uploaded, the image's real `.thumb.webp` generated; `Media.size` = real byte length; `storageAvailable/objectsUploaded: true`.
- **Unreachable / timeout** (e.g. CI) → the whole storage block is skipped, a clear **warning** is logged, and DB rows are seeded with **nominal** `Media.size` values; `storageAvailable/objectsUploaded: false`. The script **exits 0** — storage absence never fails the seed.
- **Scope of the guard:** only *object storage* is best-effort. The DB upserts are **not** wrapped — a real database error still fails the seed (as it must).
- **E2E fallback when DB-only:** `ContextService` presigns offline (`presignGet` signs a URL without contacting MinIO), so `url` + `mimeType` still resolve; `thumbnailUrl` falls back to the full-size url when the `.thumb.webp` object is absent. The media check can therefore still pass DB-only, or be explicitly skipped (see §9.3).

### 9.3 Default `E2E_CONSULTATION_ID`

The media spec defaults to the seeded fixture, so it runs without manual env once the seed has run, while staying overridable:

```ts
const consultationId = process.env.E2E_CONSULTATION_ID ?? DEFAULT_MEDIA_CONSULTATION_ID; // 90000000-…-376
test.skip(!consultationId, '…');
```

- **unset** → defaults to `90000000-0000-0000-0000-000000000376` (the fixture).
- **set to another id** → targets that consultation (the owner is still `doctor`/`__GLOBAL__`; see §8).
- **set to `""`** (empty) → `??` keeps the empty string, `!consultationId` is true → the check **skips** (opt-out when no media fixture/storage is present).

### 9.4 Verification (real output)

**Idempotency — storage present (dev stack), run twice → identical, 2nd run upserts only:**

```
# Run 1 & Run 2 (identical)
[bucket] hope-attachments-global already exists      # (Run 2: "already exists" — created on a prior run)
[object] hope-attachments-global/task-376/sample-image.png (64917B) + …/sample-image.png.thumb.webp (2344B, real downscale)
…
{ "storageAvailable": true, "objectsUploaded": true, … }
E2E_CONSULTATION_ID=90000000-0000-0000-0000-000000000376
```

**MinIO-absent guard — simulate CI (`CI=true`, dev DB, unreachable `MINIO_ENDPOINT=127.0.0.1:1`):**

```
[task-376] ⚠️  object storage unavailable — seeding DB rows ONLY (no MinIO objects / thumbnail). … Reason: connect ECONNREFUSED 127.0.0.1:1
[consultation] upserted 90000000-0000-0000-0000-000000000376
[media] upserted 96000000-…-376 (image) → s3://hope-attachments-global/task-376/sample-image.png
… (all 5 media + 4 context items upserted)
{ "storageAvailable": false, "objectsUploaded": false, … }
# exit code 0 — the seed does NOT fail CI when storage is absent
```

**npm-script wiring — `pnpm test:db:seed:media` (resolves `dotenv -e .env.test -- tsx …`; test MinIO down → guard) → exit 0.**

**Build / lint / type-check (changed package + scripts):**

```
pnpm build --filter=@arcaai/applications     → Tasks: 7 successful, 7 total   (exit 0)
pnpm --filter @arcaai/applications lint      → 0 errors (86 pre-existing prettier warnings, none in TASK-376 files)
tsc --noEmit  media-seed.ts media-storage.ts  → exit 0   (scripts are build-excluded; type-checked directly)
ReadLints (2 scripts + the edited spec)      → No linter errors found
```

> DB-safety note: idempotency was demonstrated by re-running the **additive** seed only (it upserts). No `test:db:reset` / DELETE / DROP / TRUNCATE was run; the guard demo ran against the dev DB with an unreachable storage endpoint, mutating nothing but the additive fixture rows (and the nominal sizes equal the real sizes, so the dev fixture is unchanged).

---

## Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-27 | Initial implementation: media seed + thumbnail backfill scripts; fixed the media E2E (plural route + tenant-bound owner); verified seed/backfill/Playwright against the live stack; DEFECT-M1 resolved. | see §7 |
| 2026-06-27 | Folded the media seed into the test-DB seed (local `test:db:seed`/`test:db:reset` + CI `prepare-test-db`); made MinIO object-upload best-effort/guarded (`maxAttempts:1` + 5s probe timeout → DB rows seeded with nominal sizes, exit 0 when storage absent); defaulted the spec's `E2E_CONSULTATION_ID` to the seeded id (`??`, empty-string opt-out). Verified idempotency + guard + build/lint/typecheck. | `package.json`, `.gitlab/ci/prepare.yml`, `media-seed.ts`, `media-storage.ts`, `apps/api/tests/e2e/task-375-admin-features.spec.ts` |
