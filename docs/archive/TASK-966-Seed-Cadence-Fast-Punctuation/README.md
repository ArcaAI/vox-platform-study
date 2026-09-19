# TASK-966 — Seed the STT punctuation row as `cadence-fast` and bind the seeded ASR agents to it

| Field | Value |
|---|---|
| Status | **Completed** (not pushed; local verification on the dev stack) |
| Type | bugfix (seed) |
| Branch | `dev-2.2` |
| Reported | Owner, 2026-09-13, after the TASK-960/961 playground e2e: "fix the seed so realtime-transcription binds cadence-fast" |
| Packages | `packages/database` (seed + seed tests) |

---

## 1. Requirement Analysis

The seeded `realtime-transcription` agents (SYSTEM, Global and ArcaAI rows, `seed/25-agents.ts`)
bind `postProcessing.punctuation.modelSlug: 'cadence-punctuation'`. In `apps/stt` the punctuation
service (`stt/punctuation/service.py::_load_model`) routes a model name to the direct transformers
loader ONLY on the exact name `cadence-fast` (`stt/punctuation/cadence_fast.py::MODEL_NAME`); every
other name reaches the legacy `cadence-punctuation` wrapper, which cannot load under the pinned
transformers 5.x, and the service then latches punctuation OFF for the process. So every seeded ASR
agent ran unpunctuated, with one warning per worker process:

> The session spec requests punctuation but no model is available: the agent bound no
> `models.punctuation` row, or the bound model failed to load (… bind `cadence-fast`).

Requirement: the seed must bind the name the loader actually selects, and the registry row that
carries that slug must name the repo and revision the loader reads, so the publish job stages the
right weights for the offline cluster cache.

## 2. Current State Evaluation

Verified 2026-09-13 on the local dev stack (console 5176, gateway 8868):

- Registering a `cadence-fast` row by hand (platform admin) and binding it on a v2 of a tenant ASR
  agent made the STT worker load `ai4bharat/Cadence-Fast` at the pinned revision
  (`stt.punctuation.cadence_fast: "Cadence-Fast punctuation model loaded and warmed up"`) and
  punctuate the batch result (periods 153 → 180, commas 247 → 273, questions 39 → 43 on the same
  13-minute consultation recording).
- The resolver (`AgentResolverService`, `ASR_AUX_MODEL_PATHS`) only requires the aux slug to be a
  registry row visible to the tenant (409 otherwise); publish does not gate auxiliary rows on bucket
  availability (`availabilityFindings` covers the primary model and its fallbacks only).
- On the cluster (`arca/hope-v2-deployment`, `base/stt.yaml` + `base/stt-worker.yaml`) both STT pods
  run with `HF_HUB_OFFLINE=1`, `HF_HOME=/mnt/models-bucket/hf`, `HF_HUB_CACHE=/mnt/models-bucket/hf/hub`
  over the s3fs sidecar mount of `hope-models`. The direct loader calls `from_pretrained` on the hub
  cache, so the row must be published (`POST admin/ai-models/:id/download`, HF-cache layout —
  `cadence-punctuation` is in `HF_CACHE_LIBRARIES`) before it can serve there.
- `ai4bharat/Cadence-Fast` on the Hub: not gated, MIT, `model.safetensors` 1.07 GB, sha
  `8971c5011e4fba5dcfbcac52744587d7da605534` (= the loader's pinned `REVISION`). The seeded row
  pointed at `ai4bharat/Cadence` (1B, gated) — the wrong repo for the loader that works.

## 3. Implementation Plan

1. `seed/ai-models/audio.ts` — replace the `cadence-punctuation` row with `cadence-fast`
   (new id `80000000-0000-0000-0004-000000000002`, `ai4bharat/Cadence-Fast`, `sourceRevision` pinned,
   `libraryName: 'cadence-punctuation'` kept — that vocabulary entry documents "the punctuation
   service loads its own model" in `stt/models/cache.py` and selects the HF-cache publish layout).
2. `seed/ai-models/retired.ts` — add `cadence-punctuation` to `RETIRED_AI_MODEL_SLUGS` (soft-retire
   sweep across every tenant; a new id is used because the model seed upserts by `(tenantId, slug)`
   and the old row must survive as DELETED, never be re-pointed).
3. `seed/25-agents.ts` — `ASR_PARAMETERS.postProcessing.punctuation.modelSlug = 'cadence-fast'`.
4. `seed/__tests__/ai-model-registry-seed.test.ts` — rename the D-4 assertion, add a TASK-966
   assertion that pins id / repo / revision / not gated, that `ASR_PARAMETERS` binds the seeded slug,
   and that `cadence-punctuation` is retired; ledger length 67 → 68.

Out of scope: an alias in `apps/stt` that would let `cadence-punctuation` select the direct loader
(the owner asked for the seed fix; the loader's exact-name contract is pinned by
`apps/stt/tests/unit/punctuation/test_cadence_fast.py`).

## 4. Implementation Summary

### Files changed (`packages/database`)

| File | Change |
|---|---|
| `src/prisma/db_main/seed/ai-models/audio.ts` | `cadence-punctuation` row replaced by `cadence-fast` — id `80000000-0000-0000-0004-000000000002`, `ai4bharat/Cadence-Fast`, `sourceRevision` pinned to the loader's `REVISION`, MIT / not gated, `libraryName: 'cadence-punctuation'` kept (HF-cache publish layout + the `stt/models/cache.py` vocabulary entry) |
| `src/prisma/db_main/seed/ai-models/retired.ts` | `cadence-punctuation` added to `RETIRED_AI_MODEL_SLUGS` (ledger 67 → 68) |
| `src/prisma/db_main/seed/25-agents.ts` | `ASR_PARAMETERS.postProcessing.punctuation.modelSlug` → `cadence-fast` (SYSTEM, Global and ArcaAI `realtime-transcription` rows, and the ArcaAI department agents phase 29 builds from it) |
| `src/prisma/db_main/seed/06-ai-models.ts` | `retireLegacyAiModels` guard extended: a ledger slug still bound by any non-deleted `Agent.parameters` / `compiledConfig` is SKIPPED with the existing loud warning (published versions are immutable, so the seed cannot migrate them, and a retired aux slug is a resolver 409) |
| `src/prisma/db_main/seed/__tests__/ai-model-registry-seed.test.ts` | D-4 assertion renamed; TASK-966 assertions (id / repo / revision / not gated / `ASR_PARAMETERS` binds the seeded slug / old slug retired); sweep test for the agent-reference guard; ledger count 68 |

### Evidence

- `pnpm --filter @arcaai/database test` — **91 files, 1813 tests passed** (was 1812; the new sweep test).
- **Fresh database** (`hope_seedcheck`, `db push` + `RUN_SEED=all seed`): every `realtime-transcription` row —
  SYSTEM v1, Global v1, ArcaAI v1 (DEPRECATED) and v2 (PUBLISHED) — carries
  `{"enabled": true, "modelSlug": "cadence-fast"}` in BOTH `parameters` and
  `compiledConfig.parameters.postProcessing.punctuation`; the only cadence row is
  `80000000-…-0004-000000000002 | cadence-fast | ENABLED | ai4bharat/Cadence-Fast | 8971c501…`.
- **Existing database** (the local dev DB, seeded before this ticket, published agents still bound to
  `cadence-punctuation`): `RUN_SEED=all pnpm db:seed` creates `cadence-fast` and logs
  `RETIREMENT SKIPPED: AiModel "cadence-punctuation" is still referenced by … a non-deleted Agent
  version — leaving it active` (`Retired 0 legacy AI model rows … 1 slugs skipped`). Before the guard
  extension the same run retired the row, which would have made every seeded ASR agent resolve to a
  409; the row was restored by hand.
- **Publish path proven locally** (the step the cluster needs): `POST admin/ai-models/…0002/download`
  → `DOWNLOADED` in 96 s, 1056 MB, sha256 `b60302bc…`; the row is now `AVAILABLE` with
  `bucketPrefix hf/hub/models--ai4bharat--Cadence-Fast/snapshots/8971c501…/` and the bucket holds
  `refs/main`, `model.safetensors` (1023 MiB), tokenizer + config files, `manifest.json`, `SHA256SUMS` —
  the verbatim HF-cache layout `from_pretrained(MODEL_ID, revision=REVISION)` resolves under
  `HF_HUB_OFFLINE=1` on the s3fs mount.
- **Runtime** (2026-09-13, before the seed change, on a hand-registered `cadence-fast` row bound to a
  tenant agent v2): the STT worker logged `Cadence-Fast punctuation model loaded and warmed up` and
  punctuated the batch result (periods 153 → 180, commas 247 → 273, questions 39 → 43).

### Rolling this out to an environment seeded before TASK-966

1. Re-seed (`RUN_SEED=all`, or `safe` where the model catalogue is in scope) — creates `cadence-fast`;
   `cadence-punctuation` stays active while published agents bind it (guard above).
2. Platform admin publishes the row (`/ai-models` → row → Download, or `POST admin/ai-models/80000000-0000-0000-0004-000000000002/download`) so the HF cache lands in `hope-models`.
3. Each tenant that wants punctuation publishes a new version of its ASR agent bound to `cadence-fast`
   (Configuration → New version → Edit draft → Post processing → punctuation model slug). The dev cluster
   does NOT re-seed on deploy (`hope-db-migrate` runs with `RUN_SEED=none`), so steps 1–3 are operator
   actions there; a `hope-reset` re-seed gets the new binding for free.
4. Once no non-deleted agent version binds `cadence-punctuation`, the next seed retires it.

### Not changed

- `apps/stt` — the exact-name contract of the direct loader is deliberate and pinned by
  `tests/unit/punctuation/test_cadence_fast.py`; no alias was added.
- `AI_MODEL_LIBRARIES` / OpenAPI / `@arcaai/vox-node` schemas — the library vocabulary is untouched, so
  no generated artifact regenerates.
- The pre-existing Prettier drift in `audio.ts` / `25-agents.ts` (both were non-conformant at HEAD) —
  the edits are surgical; the files were not reformatted.

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Ticket opened; seed edits applied; `pnpm --filter @arcaai/database test` 91 files / 1812 tests green. |
| 2026-09-13 | Retirement guard extended to agent configurations after the dev-DB re-seed retired the slug the published seeded agents still bind; sweep test added (1813); fresh-DB and existing-DB seeds proven; row published locally in the HF-cache layout. Status → Completed. |
