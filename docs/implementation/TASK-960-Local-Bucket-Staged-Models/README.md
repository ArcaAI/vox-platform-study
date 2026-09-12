# TASK-960 — LOCAL (bucket-staged) models are a first-class registry source

| Field | Value |
|---|---|
| Status | **Completed** |
| Type | bugfix + feature |
| Branch | `dev-2.2` |
| Owner decision | OD-1 (2026-09-12): LOCAL rows are verified **by object listing**, not by `manifest.json` |
| Related | TASK-860 (model registry + `hope-models` publish), TASK-890 §3.11 (`localPath` as a derivation) |

---

## 1. Requirement Analysis

A platform admin configures a model from exactly **two** source kinds:

| Source kind | Contract |
|---|---|
| **HuggingFace registry** | Admin supplies a repo id + an HF access token on the SYSTEM `model-registry/huggingface` connection. The platform **downloads** the weights into `hope-models` and publishes them under `<slug>/<version>/` with `manifest.json` + `SHA256SUMS`. *(Already works.)* |
| **Local path** | Admin uploads the weights to the `hope-models` bucket, which is mounted into every serving pod at `/mnt/models-bucket`. The registry and the inference service **read them from the mount**. Nothing is downloaded, and no credential is required. |

`LOCAL` therefore means *"already staged in the bucket, never fetched"*. This ticket makes the
registry honour that; the serving side already does.

### Vocabulary clarification (resolves the `LOCAL` / `S3` overlap)

`AiModelSource` carries both `LOCAL` and `S3` and nothing distinguished them. Under this contract
they are different things and both are kept:

| Value | Meaning |
|---|---|
| `LOCAL` | Already inside `hope-models`, reachable at the mount. **Never copied.** |
| `S3` | A prefix in some *other* bucket. The publish job **copies** it into `hope-models`, exactly as it does for a Hub repo. |

## 2. Current State Evaluation

### What already satisfies the contract — do not touch

- `/mnt/models-bucket` is the `hope-models` root; verified present in `hope-stt-9655558ff-hlcmh`.
- `derivedLocalPath()` (`packages/applications/src/services/ai-model/constants.ts:197`) →
  `/mnt/models-bucket/<bucketPrefix>/<primaryObject>` for a `SINGLE_FILE_LIBRARIES` loader.
- `apps/stt/src/stt/models/source_resolver.py:152` honours `local_path` **before any credential
  resolution**, naming this exact case ("a bucket mount, an admin-staged directory"), and
  `resolve_weights_or_hf_id` returns it without touching the network.
- `agent.service.ts:2115` already treats `availability === AVAILABLE` as sufficient for a
  self-hosted row, so no change is needed there once §4 stamps it.
- The admin console form already exposes `bucketPrefix` + `primaryObject` with a live derived-path
  preview (`model-form-sheet.tsx:750`).

### Five defects (evidence: the live `arcaai-whisper-2609` row, SYSTEM tenant)

| # | Defect | Evidence |
|---|---|---|
| **D1** | `ModelSourceFetcherService.fetch` dispatches on the **shape** of `sourceUri` and never reads `source`. A LOCAL row whose URI looks like `a/b` matches `HF_REPO_RE` and is sent to huggingface.co. | `model-source-fetcher.service.ts:43`. Live row: `source=LOCAL`, `sourceUri=hope-models/arcaai-whisper-en-2609` → `HTTP 401` with a hint to configure an HF token that can never help. |
| **D2** | Nothing rejects a **bucket-qualified** `bucketPrefix`. The mount *is* the bucket, so `hope-models/x` derives `/mnt/models-bucket/hope-models/x` — a path that does not exist. | Live row: `bucketPrefix=hope-models/arcaai-whisper-en-2609`. |
| **D3** | The console cannot offer `S3` at all — its union is `HUGGINGFACE \| GITHUB \| MLFLOW \| LOCAL`, while the DB enum and the fetcher both carry `S3`, and `s3://` is the only bucket scheme the fetcher supports. | `apps/admin-console/src/features/ai-models/api/types.ts:5`, `components/model-meta.ts:21`. |
| **D4** | `ModelInventoryService.measure()` stamps `MISSING` without a `manifest.json`, and `findUnregisteredPrefixes` only lists prefixes that **already carry** a manifest and match `<seg>/<seg>/`. The "In bucket, not registered → Register" drawer therefore only ever discovers models the publisher itself wrote. An admin upload is invisible to it and reads `MISSING` forever once registered. | `model-inventory.service.ts:186-213`, `:220-240`. |
| **D5** | A LOCAL row is `POST /download`-able, which is how D1 gets reached at all. There is nothing to download. | `ai-model-download.service.ts:56`. |

D4 is the structural one: it is why a correct upload still reads as missing.

## 3. Implementation Plan

TDD throughout — every step writes the failing test first and is seen RED before the fix.

### Lane A — the registry refuses to fetch a LOCAL row (D1, D5)

1. **RED** `publish/__tests__/model-source-fetcher.service.test.ts`: a `LOCAL` source throws a named
   error and the HF client is **never called**, even when `sourceUri` is `org/repo`-shaped.
2. **GREEN** `ModelSourceFetcherService.fetch(source, sourceUri, quantFilter)` — take the enum, and
   guard `LOCAL` *before* the regex chain. Update the single call site in
   `ai-model-download.processor.ts` (`this.modelSourceFetcher.fetch(model.source, model.sourceUri, quantHint)`).
3. **RED** `publish/__tests__/ai-model-download.service.test.ts`: `triggerDownload` on a `LOCAL` row
   throws `ConflictException` and **enqueues no job** and **writes no bookkeeping**.
4. **GREEN** `AiModelDownloadService.triggerDownload` — refuse a `LOCAL` row up front, before the
   in-flight check, with a message naming the mount rather than a credential.

> **Open question OQ-1** — 409 vs 400 for step 3. 409 matches the existing in-flight refusal on the
> same route; 400 argues this is a malformed request against a permanently-unfetchable row. Plan
> assumes **409**; one line to change.

### Lane B — `bucketPrefix` is bucket-relative, enforced (D2)

5. **RED** a DTO validation test: `hope-models/x` and `s3://hope-models/x` are rejected with a
   message naming `/mnt/models-bucket`; `x/` and `x/y/` are accepted; a missing trailing slash is
   normalised.
6. **GREEN** one exported validator beside the constants, applied to `bucketPrefix` on **both**
   `create-model.request.ts:203` and `update-model.request.ts:195`.

> Validation binds **new writes only**. Existing malformed rows are a data fix (§5), not a migration —
> there is exactly one, and it is the row that prompted this ticket.

### Lane C — inventory verifies a LOCAL row by listing (D4, OD-1)

7. **RED** `inventory/__tests__/model-inventory.service.test.ts`:
   - LOCAL row + `primaryObject` present under the prefix → `AVAILABLE`, detail `verifiedBy: 'listing'`.
   - LOCAL row + `primaryObject` **absent** → `MISSING`, detail naming the missing object.
   - LOCAL row, no `primaryObject`, ≥1 object under the prefix → `AVAILABLE`.
   - LOCAL row, prefix empty → `MISSING`.
   - A LOCAL row must **never** be stamped `PARTIAL` for a manifest-digest mismatch it cannot have.
   - Non-LOCAL rows keep the manifest requirement **unchanged**.
8. **GREEN** a `source === LOCAL` branch in `measure()`, ahead of the `manifest.json` lookup.
9. **RED** discovery: a manifest-less prefix holding a weight-extension object appears in
   `unregistered` with `layout: 'staged'`; the `hf/` cache tree is **excluded**; a one-segment
   prefix (`arcaai-whisper-en-2609/`) is accepted, since `FLAT_PREFIX_RE` requires two.
10. **GREEN** extend `findUnregisteredPrefixes`: group manifest-less weight objects by directory.
    Reuse the weight-extension test from `model-version.util.ts` (export it) rather than a second copy.
11. Widen `UnregisteredBucketPrefix.layout` to `'flat' | 'hf-cache' | 'staged'`
    (`inventory/dto/model-inventory.response.ts:16`).

### Lane D — console (D3)

12. Add `S3` to the union (`api/types.ts:5`), `SOURCE_LABELS` and `SOURCE_OPTIONS`
    (`components/model-meta.ts:16,21`).
13. Widen `layout` in `api/types.ts:246` and render the `staged` case in
    `unregistered-prefixes-drawer.tsx`.
14. In `model-form-sheet.tsx`, when `source === 'LOCAL'`: make `bucketPrefix` the primary input, and
    derive `sourceUri` as `s3://hope-models/<bucketPrefix>` so the two cannot disagree (the Python
    resolver falls back to `sourceUri` scheme dispatch when `local_path` is absent, so this keeps the
    fallback honest). Help text states that no download occurs.

### Lane E — verification artifacts

15. `pnpm --filter @arcaai/applications build test`, `pnpm --filter @arcaai/admin-console build lint test`.
16. Regenerate the five API artifacts **together** (`05-nestjs-api.md` DoD) — the DTO change in Lane B
    touches the OpenAPI surface:
    `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`,
    then the three `:check` gates.
17. Runtime proof on the dev cluster: register the fixed row, `POST admin/ai-models/inventory`,
    assert `AVAILABLE`; then open an STT session against the agent and capture the log line showing
    the model loaded from `/mnt/models-bucket/...` with no Hub call.

## 4. Verification Criteria

- [ ] A `LOCAL` row can never reach huggingface.co — proven by a test asserting the client is not called.
- [ ] `POST /download` on a `LOCAL` row is refused, with no job enqueued and no bookkeeping written.
- [ ] `bucketPrefix` containing the bucket name is rejected at the DTO with an actionable message.
- [ ] An admin-uploaded, manifest-less prefix is **discovered** by inventory and stamps `AVAILABLE` once registered.
- [ ] Non-LOCAL rows keep manifest-based verification byte-for-byte.
- [ ] The console can select `S3`, and a `LOCAL` row's `sourceUri` cannot disagree with its `bucketPrefix`.
- [ ] Five API artifacts regenerated and their `:check` gates green.
- [ ] STT loads the staged model from the mount with no network call.

## 5. Data fix — the row that prompted this (separate from the code change)

`AiModel 01a090d5-6532-754a-a212-5184c7361d66` (`arcaai-whisper-2609`, SYSTEM tenant) is currently
unusable. **Do not fix it by re-triggering the download**: the publish processor buffers every file
whole (`FetchedModelFile.data: Buffer`, all files held in one array) and `hope-api` is capped at
`limits.memory: 2Gi` — a 1.62 GB object will OOMKill the gateway.

Restage inside MinIO instead (server-side, no bytes through the API pod):

1. `sha256sum` the object; `version = sha256(SHA256SUMS)[0:12]` (no quant prefix — `QUANT_TOKEN_RE`
   matches only `Q<digit>`, and this is `f16`).
2. Server-side copy to `arcaai-whisper-en-2609/<version>/ggml-arcaai-whisper-en-2609-f16.bin`.
3. `PATCH /api/v1/admin/ai-models/{id}` (requires `If-Match`):
   `bucketPrefix: "arcaai-whisper-en-2609/<version>/"`,
   `primaryObject: "ggml-arcaai-whisper-en-2609-f16.bin"`, `checksum: <sha256>`,
   `sourceUri: "s3://hope-models/arcaai-whisper-en-2609/<version>"`.
4. `POST /api/v1/admin/ai-models/inventory` to stamp availability.

After Lane C, step 1–2 become optional: the flat upload verifies by listing on its own.

## 6. Out of Scope — flagged, not fixed

- **`source_resolver.py` exists in four copies** (stt, nlp, tts, harness), guarded only by
  `tests/contracts/source-resolver-parity.contract.test.ts`, which deliberately does not demand
  byte-identity. That file records `tts` as having **no `AiModel.localPath`** — so a bucket-staged
  TTS model would not get the `local_path`-first treatment this ticket relies on. Consolidation is
  its own ticket; this one changes no resolver.
- No in-console **upload** endpoint. OD-1 chose listing-based verification precisely so admins can
  keep uploading through the MinIO browser. A platform-owned streaming upload remains a follow-up.
- The `GITHUB` and `MLFLOW` enum members stay unimplemented in the fetcher; this ticket does not
  widen their surface.

## 7. Implementation Summary

Delivered on `dev-2.2` in three file-disjoint worktree lanes, merged by the orchestrator.

| Lane | Branch | Merge | Model tier |
|---|---|---|---|
| W1 guards (plan lanes A+B) | `task-960/guards` | `c8990685d` | `sonnet` |
| W2 inventory (lane C) | `task-960/inventory` | `9bf0c6d13` | `opus` |
| W3 console (lane D) | `task-960/console` | `faf95813c` | `sonnet` |
| API artifacts (orchestrator) | — | `051985241` | — |

W2 took the higher tier because it carried the only subtle work (directory grouping, `hf/`
exclusion, suppressing a `PARTIAL` a manifest-less row cannot have, and keeping non-LOCAL
verification byte-for-byte). W1/W3 were mechanical against an exact spec.

### What changed

- **D1/D5** — `ModelSourceFetcherService.fetch(source, sourceUri, quantFilter)` refuses
  `AiModelSource.LOCAL` **before** any scheme dispatch, so the HF branch is now structurally
  unreachable for a bucket-staged row. `AiModelDownloadService.triggerDownload` refuses a LOCAL
  row with `ConflictException` (409) after the `findById` existence check but before the
  in-flight check and before any write — so an unknown id still answers 404 and the refusal
  never becomes an existence oracle.
- **D2** — `BucketRelativePrefixConstraint` (exported from `constants.ts`) rejects a
  bucket-qualified or `s3://`-schemed `bucketPrefix` on both the create and update DTOs.
- **D4** — `ModelInventoryService.measure()` gained a `source === LOCAL` branch ahead of the
  manifest lookup (verify by object listing, per OD-1), placed *after* the `isCloud` and
  weightless-library early returns so those keep precedence. `findUnregisteredPrefixes` gained a
  second pass reporting manifest-less weight-bearing prefixes as `layout: 'staged'`, grouped by
  directory, with the `hf/` cache tree excluded. `isModelWeightFile` was added to
  `model-version.util.ts` as a pure addition (0 removed lines).
- **D3** — the console gained `S3` in its source vocabulary, renders the `staged` layout
  distinctly, and derives a LOCAL row's `sourceUri` as `s3://hope-models/<bucketPrefix>` so the
  two can never disagree.

### Evidence

| Gate | Result |
|---|---|
| `tests/contracts` | 25 files, 354 tests passed |
| `pnpm --filter @arcaai/applications test` | 812 passed \| 1 skipped (813 files); 13343 passed \| 4 skipped |
| `pnpm --filter @arcaai/applications build` | exit 0 |
| `pnpm --filter @arcaai/admin-console build lint test` | build + lint clean; 2959 tests / 324 files passed (lane run) |
| Five API artifacts | regenerated; `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check` all green |

`route-manifest.json` is unchanged — no route changed, only DTO shape and documentation.

### Live verification (dev cluster, 2026-09-12)

The `arcaai-whisper-2609` row (`01a090d5-…`) was repaired and the model **proven to load**:

```
whisper_model_load: type = 5 (large v3)
whisper_model_load: CUDA0 total size = 1623.92 MB
whisper_backend_init_gpu: using CUDA0 backend
LOADED OK
TRANSCRIBE_OK segments= 1
```

and through STT's own resolver rather than a direct loader call:

```
stt.model_source.local_path_hit path=/mnt/models-bucket/arcaai-whisper-en-2609/ggml-…-f16.bin
RESOLVER_OK -> /mnt/models-bucket/arcaai-whisper-en-2609/ggml-arcaai-whisper-en-2609-f16.bin
```

No network call, no credential resolved, checksum verified.

### Known residual

- **Themes were never verified in a running browser.** W3 substituted axe tests (0 violations)
  and a "no new hardcoded colours" argument. That is a reasonable proxy, not the check
  `13-nextjs-apps.md` asks for.
- **`audit-correlation.test.ts` is load-flaky**, not broken: it timed out for both W1 and W2
  while the host sat at load 140–170 under three concurrent ticket waves, and passed in the
  clean post-merge run above. Pre-existing on `dev-2.2`; W2 disproved ownership by reverting all
  five of its files and reproducing on a pristine tree.

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Ticket opened. Diagnosis of the live `arcaai-whisper-2609` failure; five defects recorded; OD-1 taken (verify LOCAL by object listing). Plan pending approval. |
| 2026-09-12 | All three lanes merged (`c8990685d`, `9bf0c6d13`, `faf95813c`) and the five API artifacts regenerated (`051985241`). Post-merge gates green. Live row `arcaai-whisper-2609` repaired and proven to load on CUDA0 through STT's own resolver. A `manifest.json` + `SHA256SUMS` were staged into the prefix as a BRIDGE so the currently-deployed (pre-TASK-960) hourly inventory verifies it too; redundant once the new image ships. |
