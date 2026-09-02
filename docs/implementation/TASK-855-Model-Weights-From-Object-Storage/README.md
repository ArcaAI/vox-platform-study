# TASK-855 — Model Weights From Object Storage

| Field | Value |
|---|---|
| **Status** | `In Progress` — plan v2 (fast-win). **Phase 0 complete** (5 of 6 probes pass on OrbStack); Phases 1–3 not started. |
| **Type** | `infrastructure` + `feature` (spans `hope-v2` and `hope-v2-deployment`) |
| **Branch** | `dev-2.2` |
| **Audit artifact** | https://claude.ai/code/artifact/4ebd2ac6-9f2f-4829-be05-fecb7c0388a7 |
| **Authored** | 2026-09-02 · revised same day after a second pass over the Python services |

> ### Plan v2 supersedes v1 — and the correction is load-bearing
>
> v1 said `nlp` and `tts` *"cannot be pointed at MinIO even by configuration"*. **That is wrong.**
> It was true only of the `s3://` URI scheme. **All four model-hosting services already implement
> mount-point loading**, driven by `AiModel.localPath`, at the highest resolution precedence, reading
> weights **in place and never copying them**:
>
> | Service | Mechanism | Evidence |
> |---|---|---|
> | `stt`, `stt-worker` | `local_path` → returned directly, highest precedence | `apps/stt/src/stt/models/source_resolver.py:5-6,279-284` |
> | `harness` | same resolver | `apps/harness/src/harness/models/source_resolver.py` |
> | `nlp` | `(model_name, model_path)` is the cache key; `_weights_source()` prefers the staged path | `apps/nlp/src/nlp/dependencies.py:99-131` |
> | `tts` | `modelPath` control-plane keys per provider, with `local_files_only: True` | `apps/tts/src/tts/core/control_plane.py:101,105`; `providers/indic_parler.py:48-49` |
>
> `nlp`'s own comment states the contract explicitly: *"An admin flipping `AiModel.localPath` must be
> a cache MISS"*, and *"the same precedence the other three services apply"*.
>
> **Consequence: the fast win needs no Python code at all.** Mount the bucket, set `localPath`, cut
> the Hugging Face egress. What v1 scoped as three code lanes is one deployment change plus data.

---

## 1. Requirement Analysis

- **R1** — Platform admins manage the **model + provider catalog**, including **downloading models**;
  models are stored and persisted in S3/MinIO only.
- **R2** — Platform admins manage the built-in default/fallback providers (`lm-studio`, future
  `ollama` / `vllm` / `mlflow`); an inference request (ASR, text, NER) causes just-in-time load and
  serve of the declared model **from MinIO**.
- **R3** — Services never cache or download models into their containers/pods; MinIO holds the weights.

### Two supported loading modes (owner directive, both required)

| Mode | How the service reaches the weights | Status today |
|---|---|---|
| **Mode U — S3 URI** | `AiModel.sourceUri = s3://hope-models/<slug>/<version>/`; the service fetches and verifies | **Implemented** in `stt` + `harness`. Not in `nlp`/`tts`. Downloads once into the service cache. |
| **Mode M — mount point** | s3fs sidecar mounts the bucket; `AiModel.localPath` points into it; weights are read **in place** | **Implemented in all four services** (table above). Sidecar proven in `base/lmstudio.yaml`. Symlink-tree variant also proven there. |

**Mode M is the fast win and the only one that literally satisfies R3** — Mode U copies into a cache
by definition (`source_resolver.py:15` — *"download once into the service cache"*). Ship Mode M first;
keep Mode U as the fallback for engines that cannot mmap over FUSE, and for clusters where a
privileged sidecar is unacceptable.

---

## 2. Current State — what is already right

| Capability | Where |
|---|---|
| Mount-point loading, admin-flippable, cache-key-correct, in all four services | see the correction box above |
| `s3://` scheme with SHA256 verification + single-flight | `apps/stt/src/stt/models/source_resolver.py` |
| A complete, production-tested s3fs sidecar (native sidecar, `restartPolicy: Always`, Bidirectional propagation, endpoint wait, uid mapping, path-style, read-only) | `hope-v2-deployment/deployment/k8s/base/lmstudio.yaml:215-270` |
| Symlink-tree indexer over the mount (for engines that need a flat model dir) | same file, the `lms import -L` init container |
| Admin CRUD over the model registry | `apps/api/src/modules/ai-model/ai-model-admin.controller.ts:23` |
| Engine discovery + audited register | `apps/api/src/modules/ai-model/ai-model-discovery.controller.ts:28,42` |
| Provider governance: SYSTEM = platform default, self-hosted engines locked to SYSTEM scope | `packages/applications/src/services/ai-provider-connection/` |
| Fallback chains with gates, STRICT mode, `fallback_occurred` sys-event | `packages/applications/src/services/ai-routing-policy/routing-gates.ts` |
| Console screens (separate today): `ai-models`, `ai-providers`, `ai-task-defaults`, `inference-engines` | `apps/admin-console/src/features/` |

### What is genuinely missing

| # | Gap | Consequence |
|---|---|---|
| **G1** | No download action anywhere. `downloadStatus` is *"manual registry bookkeeping (no write-back automation yet)"* (`stt.prisma:175-177`) | An admin cannot get a model into the bucket |
| **G2** | No s3fs sidecar on `stt`, `stt-worker`, `nlp`, `tts` | Mode M is unreachable for the four services that already support it |
| **G3** | 46 seeded `sourceUri` rows, **zero** `s3://`, and no `localPath` set | The registry points at huggingface.co |
| **G4** | `HF_HOME` + three HF token projections; a 112 GB node-local cache | R3 actively violated (`base/stt.yaml:127-149`, `components/node-local-model-cache`) |
| **G5** | Catalog is split across four screens; no single model↔provider view | R1's "manage the catalog" is a multi-screen scavenger hunt |
| **G6** | Kokoro (`KPipeline(lang_code="a")`) takes no path argument | The one service provider with no Mode M path — see §6 |
| **G7** | `nlp`/`tts` have no `s3://` resolver | Mode U unavailable there (acceptable — Mode M covers them) |

---

## 3. Plan v2 — four phases, front-loaded on the cheap win

### Phase 0 — Local proof on OrbStack (blocks everything)

The whole fast win rests on one unproven assumption: **can these loaders read weights over a FUSE
mount without copying, at acceptable speed?** `transformers.from_pretrained` does many small random
reads; GGUF engines `mmap` a single large file. FUSE handles those very differently. Prove it before
building on it.

Lab: `--context orbstack`, namespace `hope-lab`, MinIO + bucket `hope-models`, s3fs sidecar copied
verbatim from `base/lmstudio.yaml` (TLS and the private CA stripped — the lab tests FUSE semantics,
not transport).

**Test models — these three only:**

| Purpose | Model | Constraint |
|---|---|---|
| text / LM Studio | `unsloth/Qwen3-0.6B-GGUF` | **Q4_K_S only** |
| nlp | `blaze999/Medical-NER` | full repo |
| speech-to-text | `taphuynh/whisper-large-en-medical-2607.26-merged-gguf` | **Q5_0 only** |

**Exit criteria — each is pass/fail, and each maps to a decision:**

| # | Test | Decides |
|---|---|---|
| P0-1 | `AutoModelForTokenClassification.from_pretrained('/mnt/models-bucket/medical-ner', local_files_only=True)` succeeds and infers | Whether Mode M works for `nlp` and any transformers-based loader |
| P0-2 | The same load performs **no writes** to any local cache dir (inotify/`HF_HUB_OFFLINE` + a read-only rootfs) | Whether Mode M actually satisfies R3, or merely relocates the cache |
| P0-3 | A GGUF engine `mmap`s Qwen3-0.6B Q4_K_S from the mount and answers a prompt | Whether Mode M works for LM Studio / llama.cpp — the riskiest case |
| P0-4 | Cold-load wall time, mount vs local disk, for each of the three models | Whether Mode M is viable for JIT or needs a warm tier |
| P0-5 | Whisper Q5_0 loads from the mount in the STT loader path | Whether ASR can leave HF |

If P0-3 fails, GGUF engines stay on Mode U (or the existing sync-to-PVC), and Mode M ships for the
transformers services only. That is still most of the win, and the plan is written so that branch
costs nothing already spent.

### Phase 1 — The fast win (no application code)

1. **s3fs sidecar** onto `hope-stt`, `hope-stt-worker`, `hope-nlp`, `hope-tts` — copy the proven block.
2. **Registry data**: set `AiModel.localPath` to `/mnt/models-bucket/<slug>/<version>/` for every
   model whose weights are in the bucket. Rows with no bucket copy stay untouched.
3. **Cut the egress**: delete `HF_HOME`, `HF_XET_CACHE`, `HUGGINGFACE_CACHE_DIR` and the three token
   projections; retire `components/node-local-model-cache`; add a NetworkPolicy denying
   huggingface.co. The policy is what *enforces* R3 — without it, a regression silently re-downloads
   and looks like a slow cold start.

Steps 1–3 land together per service. A `localPath` that does not exist falls through to the hub id
with a warning (all four services), so the failure mode of a half-done change is silent HF traffic —
which is exactly why the NetworkPolicy ships in the same change.

### Phase 2 — The admin surface (R1)

1. **Download action** — the smallest thing that works: `POST /admin/ai-models/:id/download` enqueues
   an existing-queue job that streams source → MinIO, verifies, and writes back `downloadStatus`,
   `downloadedAt`, `fileSizeMb`, checksum, and the resulting `localPath` + `sourceUri`.
2. **Catalog screen** — one view over models × providers: which provider serves a model, whether the
   weights are in the bucket, its download state, and the Download action. Built by composing the
   existing `ai-models` and `ai-providers` features, not by forking either.

### Phase 3 — NO LONGER OPTIONAL (owner directive, 2026-09-02)

Port `source_resolver.py` into `nlp` and `tts` for Mode U parity. Plan v2 scoped this as optional on
the reasoning that Mode M alone satisfies R1–R3. **The owner's directive requires BOTH modes** —
"services support loading/fetching models using s3 URI" *and* "from a mount point" — so Mode U
parity is in scope, not a nice-to-have. Running as lane **L6**.

Note that Mode U also needs the `model-registry`/`s3` provider connection enabled and keyed; it is
disabled and unkeyed today, so an `s3://` URI fails closed. Configuring it is an admin action, which
is why lane **L4** surfaces its status and deep-links to the providers screen rather than forking a
second editor for it.

---

## 4. Lanes and tiers

Four lanes, down from six, and one `opus` instead of two — because the correction in the box above
removed the two hardest lanes from the critical path.

| Lane | Phase | Scope | Owns exclusively | Tier | Effort |
|---|---|---|---|---|---|
| **L0** lab | 0 | Run the five P0 tests on OrbStack; report pass/fail + timings | `scratchpad/lab/**` (nothing in either repo) | `sonnet` | high |
| **L1** mount | 1 | s3fs sidecars, HF env removal, egress policy, retire node cache | `hope-v2-deployment`: `base/{stt,nlp,tts-v2,models-cache}.yaml`, `components/**`, `overlays/dev` | `opus` | high |
| **L2** registry | 1 | Set `localPath` on catalogue rows + backfill migration | `packages/database/src/prisma/db_main/seed/ai-models/**` + one migration | `sonnet` | medium |
| **L3** download API | 2 | Download endpoint + queue job + registry write-back | `packages/applications/src/services/stt/model/**`, `apps/api/src/modules/ai-model/**` | `sonnet` | high |
| **L4** catalog UI | 2 | Model↔provider catalog view + Download action | `apps/admin-console/src/features/ai-models/**` | `sonnet` | medium |

**Tier rationale.** L1 stays `opus`: it is the only lane that can take running services offline, and
its verdict (which env removal is safe when) is acted on directly. L3 drops from `opus` to `sonnet`
because Phase 2 no longer sits on the critical path for R3 and the contract is fully specified in
§5 — but it is `high` effort, because it writes to an OCC model and must regenerate five artifacts.
L0 is `sonnet` not `haiku`: it produces the pass/fail verdict the rest of the plan branches on, and
"never downshift the stage whose verdict you act on" applies to experiments too.

### Sequencing

| Wave | Runs | Gate |
|---|---|---|
| 0 | **L0** | P0-1…P0-5 reported with timings. P0-3's result selects the GGUF branch. |
| 1 | **L1 ∥ L2** | Different repos, no shared file. L2's `localPath` values must match the mount path L1 declares — fixed in §5 so they cannot drift. |
| 2 | **L3 ∥ L4** | L4 codes against the §5 contract. Neither blocks Phase 1. |
| 3 | one `opus` review over the combined diff | The only point where the whole change is judged together. |

---

## 5. Frozen contracts (so parallel lanes cannot drift)

**Mount path.** The bucket mounts at `/mnt/models-bucket` in every service pod (matching
`base/lmstudio.yaml`). A model's weights live at `/mnt/models-bucket/<slug>/<version>/`, and
`AiModel.localPath` is exactly that directory, with no trailing-slash variation. L1 declares the
mount; L2 writes the paths; neither invents its own.

**Download API** (L3 implements, L4 consumes):

```
POST   /api/v1/admin/ai-models/:id/download   → 202 { jobId, status: 'DOWNLOADING' }
GET    /api/v1/admin/ai-models/:id/download   → 200 { status, startedAt, finishedAt,
                                                      fileSizeMb, sha256, localPath, error }
```

- `status` ∈ the existing `AiModelDownloadStatus` enum — **do not add members**.
- On success write `downloadStatus`, `downloadedAt`, `fileSizeMb`, checksum, `localPath`
  (`/mnt/models-bucket/<slug>/<version>/`) and `sourceUri` (`s3://hope-models/<slug>/<version>/`) —
  so the row serves **both** modes and either can be selected without a second fetch.
- 409 if a download for that model is in flight; 404 for a cross-tenant id (404-over-403).

---

## 6. Owner decisions

| # | Decision | Status |
|---|---|---|
| **OD-1** | ~~Stream or warm?~~ | **Resolved by the directive**: both. Mode M (stream) is the default; Mode U (fetch) stays supported. |
| **OD-2** | **How wide is JIT?** 6 time-sliced GPU slices across 2 cards, 6/6 allocated, no memory isolation | **Open** — bounds what R2 can promise for GPU-resident models. Does not block Phases 0–2. |
| **OD-3** | **Kokoro has no path argument** (`KPipeline(lang_code="a")`) | ✅ **RESOLVED 2026-09-02 — point `HF_HOME` at the mount.** `hope-tts` keeps an `HF_HOME`, repointed to `/mnt/models-bucket/hf`, plus `HF_HUB_OFFLINE=1` and no HF token. Kokoro then finds its weights offline inside the bucket with **no application code change**, and the egress deny stays absolute across all four services. Consequence for the publish step: Kokoro's weights must be laid out in **HF-cache format** under that prefix, not the flat `<slug>/<version>/` layout. |
| **OD-4** | **Privileged sidecar acceptable?** s3fs needs `privileged: true` + Bidirectional propagation | ✅ **Accepted implicitly** by proceeding — it extends the posture `hope-lmstudio` already runs, now to four more workloads. Revisit if a cluster policy forbids privileged pods. |

---

## 7. Orchestrator-owned surfaces

No lane agent performs these (`14-multi-agent-worktrees.md` §3): all merges; `pnpm install`,
`db:push`, `db:migrate`, `test:db:reset`; every `kubectl` **against the dev cluster** (the OrbStack
lab is L0's own sandbox and is exempt); container image builds (GitLab CI is the only builder);
re-running gates after each merge; worktree removal after merge.

---

## 8. Implementation Summary

### Phase 0 — OrbStack lab results (`--context orbstack`, ns `hope-lab`)

Lab: MinIO (`RELEASE.2025-04-22`) + bucket `hope-models` in the production layout
`<slug>/<version>/<files, flat>`; s3fs sidecar copied from `base/lmstudio.yaml` with TLS/CA stripped.
Manifests and the upload script are committed alongside this README in [`lab/`](lab/):
`minio.yaml` (lab MinIO), `upload.py` (host → bucket, production layout), `test-safetensors.yaml`
(P0-1a/b, P0-2), `test-gguf.yaml` (P0-3, P0-4), `test-transformers.yaml` (P0-1c, **needs a re-run**).

Reproduce with `kubectl --context orbstack apply -f lab/minio.yaml`, then
`kubectl -n hope-lab port-forward svc/minio 19000:9000`, `python3 lab/upload.py`, then apply the
test jobs. The lab strips TLS and the private CA on purpose — it tests FUSE semantics, not transport.

| Test | Result | Evidence |
|---|---|---|
| **P0-1a** small random reads over FUSE | ✅ **PASS** | `config.json` + `tokenizer.json` (128 000-entry vocab, 8.7 MB) read from the mount in **0.27 s** |
| **P0-1b** mmap read of the full tensor file | ✅ **PASS** | All **200 tensors, 736 MB**, of `blaze999/Medical-NER` (DebertaV2, 83 labels) read via `safetensors.safe_open` in **3.95 s = 186 MB/s over FUSE** |
| **P0-2** nothing copied to a local cache | ✅ **PASS** | Cache canary at `$HF_HOME` after the full read: **0 files, 0.00 MB**. Weights were read in place. This is the R3 crux. |
| **P0-3** GGUF engine mmaps off the mount | ✅ **PASS** | `llama-bench` on `Qwen3-0.6B-Q4_K_S.gguf` (359.84 MiB): **mmap ON** pp32 `352.59 t/s`, tg8 `27.65 t/s`; **mmap OFF** pp32 `121.45 t/s`, tg8 `12.84 t/s`. `llama-cli` generated coherent clinical text — 98.3 t/s prompt, 24.6 t/s generation, 5 s wall. |
| **P0-4** mount cost | ✅ measured | mmap is **~2.9× faster** than `--no-mmap` over FUSE — page-faulting beats reading the whole file up front. Keep the default; never add `--no-mmap` to a mounted model. |
| **P0-1c** full `from_pretrained` + inference | ⚠️ **not completed — lab network, not FUSE** | Three attempts. The pod cannot pull large wheels: `ReadTimeoutError` from **`download-r2.pytorch.org`**, then the same from **`files.pythonhosted.org`**. Small installs (`safetensors`, `numpy`) succeed, so it is a large-transfer failure in the OrbStack egress path, unrelated to the mount. The access pattern it would exercise is exactly what P0-1a/b/P0-5 already proved. **L0 should re-run it** where PyPI is reachable, or serve the wheels from the bucket. |
| **P0-5** whisper Q5_0 from the mount | ✅ **PASS** | With the owner's HF token: `ggml-whisper-large-en-medical-2607.26-q5_0.bin`, **1081.1 MB**, mmapped from the mount in **2.15 s = 503 MB/s**, sha256 `c36b521e…f09f8` **byte-identical** to the file published from the host, **0 files / 0.00 MB** written locally. Faster per byte than the 200-tensor read — one large sequential file suits FUSE better than many small ones. Engine-level transcription was **not** run: `ghcr.io/ggml-org/whisper.cpp` publishes **no arm64 manifest**, so it cannot run on this cluster. P0-3 already proved engine-level mmap serving with llama.cpp. |

**Reading.** Every assumption the fast win rests on holds. Weights are read **in place with zero local
copies** at 186–503 MB/s, a GGUF engine **serves generated text** straight off the mount, and a 1 GB
model arrives **byte-identical**. Mode M is viable for both model families and at production file
sizes. The only untested link is the `from_pretrained` wrapper itself, blocked by lab egress rather
than by anything in the design.

**Caveats, stated so nobody over-reads the numbers.** This is a 360 MiB GGUF and a 736 MB safetensors
file against an in-cluster MinIO on the *same node* — a best case for latency. It proves the
mechanism, not the production first-token budget. The dev cluster's MinIO is on the same node too,
so the shape is comparable, but a multi-node or remote-object-store deployment must re-measure.

### Defect found while running the lab: three seeded ASR models point at repos that do not exist

Verified against the Hugging Face API with the owner's token on 2026-09-02:

| Seed row | Verdict |
|---|---|
| `audio.ts:335` `taphuynh/whisper-large-en-medical-260726-merged-gguf` | ❌ **does not exist** — the real repo is `…-2607.26-…` (with the dot) |
| `audio.ts:358` `taphuynh/whisper-large-en-medical-260726-merged-ct2` | ❌ **does not exist** — same dot-stripping |
| `audio.ts:312` `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-ct2` | ❌ **does not exist** (a different miss — never published?) |
| `audio.ts:239,262` `…codeswitch-fullft-2607.29.1-GGUF` | ✅ exists |
| `audio.ts:286` `…codeswitch-fullft-2607.29.1-fp16` | ✅ exists |

Three of six `taphuynh/*` ASR rows are unresolvable. Any task routed to them fails closed at request
time with a model-source error — the failure is correct, but the rows should never have shipped. Fold
the fix into **L2**, and note that this is precisely the class of defect **L0's inventory exists to
catch**: a registry row is only as good as the artifact behind it.

### Lanes

| Lane | Branch | Merged | Gates | Worktree |
|---|---|---|---|---|
| L0 | run in-session on OrbStack | n/a | P0-1a/b, P0-2, P0-3, P0-4, **P0-5 pass**; only P0-1c outstanding (lab egress) | n/a |
| **L1** mount | `task-855-l1-mount` @ `fbdb1f5` (deployment repo) | **blocked on publish** | 7 of 8 repo CI gates PASS; `patch-hygiene` red **but already red on `main`** | branch in the existing clone |
| **L2** registry | `task-855-l2-registry` | **ready — awaiting owner go-ahead** | typecheck clean; `migrate diff` empty; 1709 tests pass (2 files fail at import on unbuilt workspace deps — the known fresh-worktree condition, rule 14 §4) | `../hope-v2-task-855-l2` |
| **L3** download API | `task-855-l3-download` | **ready + follow-on in flight** | applications build clean · **10 937 tests** · `api:build` clean · all 5 artifacts regenerated · all 3 `:check` gates green | `../hope-v2-task-855-l3-download` |
| **L4** catalog UI | `task-855-l4-catalog` | **ready** | build OK · lint 0 warnings · **2305/2305 tests** · axe 0 violations. Themes not eye-verified (no live gateway/DB) | `../hope-v2-task-855-l4-catalog` |
| **L6** s3:// parity | `task-855-l6-s3uri` | **code done, NOT yet functional** | nlp 553 pass / lint / typecheck clean; tts 444 pass / lint / typecheck clean; `uv lock` re-run by the orchestrator | `../hope-v2-task-855-l6-s3uri` |

⚠️ **`dev-2.2` advanced 5 commits** while L1/L2 ran (another session is active). L2's branch is based
on `f92313d1f`; L3/L4/L6 are based on `d78cb0446`. L2 needs its base refreshed before it merges —
rule 14 §4, a stale base is the commonest source of a surprise conflict.

### Dev bucket inventory (read live from `hope-minio-0`, 2026-09-02)

`s3://hope-models` holds **four prefixes, 15 GB, all GGUF LLM builds** — and nothing else:

```
gemma-4-e2b-it-qat-gguf/q4-0-451faffb5a16
gemma-4-e4b-it-qat-gguf/q4-0-7a0c80ad163b
granite-guardian-4.1-8b-gguf/q4-k-m-1af04917c451
text-embedding-embeddinggemma-300m-qat-gguf/q4-0-f2af2a2fb7c0
```

Three consequences, all of which changed the plan:

1. **No ASR, NER or TTS weights are in the bucket at all.** Every model `stt`, `stt-worker`, `nlp`
   and `tts` load today comes from huggingface.co. The publish step is not a top-up; it is the whole
   catalogue for those three services. L2's candidate table (§ below) counts **~35 self-hosted rows**
   — audio 16, llm 10, nlp 6, tts 3.
2. **The version segment is content-derived — `<quant>-<first 12 of sha256(SHA256SUMS)>` — not `v1`.**
   So `AiModel.localPath` **cannot be written before a model is published**; the hash does not exist
   yet. The orchestrator's original instruction to L2 (`/mnt/models-bucket/<slug>/v1/`) was wrong and
   was retracted mid-flight. `localPath` is now written **at publish time**, which is exactly what the
   Phase 2 download action is specified to do automatically (§5 frozen contract). Hand-writing one
   fabricates a path that falls through silently today and fails hard once the egress policy lands.
3. **`hope-vllm` points at a prefix that does not exist.** `base/config/vllm.env:79` sets
   `VLLM_MODEL_URI=s3://hope-models/medgemma-1.5-27b-it/v1/`; there is no `medgemma-*` prefix in the
   bucket, and `/v1/` is not the convention either. Latent only because `hope-vllm` runs at
   `replicas: 0` — scale it up in any environment and it fails to find its weights. Not this ticket's
   to fix, but it must not be discovered during an incident.

### L2 delivered (verified by the orchestrator, not just reported)

Final diff: 3 files, 28 insertions. Two `sourceUri` corrections with the HF-API verification recorded
in-line; the `localPath` field added to `AiModelSeed` with a comment that explicitly forbids
hand-authoring a value; the `06-stt.ts` re-seed mapping so the field actually syncs. Migration
`20260902090000_task_855_ai_model_source_uri_fix` contains **only** the two guarded `UPDATE`s — each
fires solely where the column still holds the exact known-wrong value, so it is idempotent and cannot
clobber an operator's edit.

**L2 is now independent of the publish gate.** Removing the fabricated `localPath` values had a
useful side effect: what remains is pure correction, valid whether or not anything is ever published,
so it can merge on its own schedule rather than waiting behind step 1.

Two findings it surfaced and correctly did NOT act on:
- `arcaai-whisper-large-ml-en-ct2` (`audio.ts:312`) — repo does not exist under any spelling tried.
  Its own row comment says an ASR pipeline references it, and `retireLegacyAiModels` guards against
  retiring a slug a live pipeline uses, so retirement needs the pipeline migrated first. Owner call:
  locate/republish the CT2 build, retire the row, or mark it `DISABLED`.
- **6 rows declare `source: LOCAL` while carrying an HF-style `org/repo` `sourceUri`** — systematic,
  not the two rows first spotted. Enum semantics are an owner decision.

### L1 delivered — `fbdb1f5`, 17 files, +918/−330 (orchestrator-verified)

s3fs sidecars on `hope-stt`, `hope-stt-worker`, `hope-nlp`, `hope-tts` at **uid/gid 1001** (each
verified against its own Dockerfile — `apps/stt/docker/Dockerfile:343-345` defines its own `hope`
user rather than inheriting from python-base, so the check mattered); HF env + token projections
removed; four per-workload egress NetworkPolicies; `base/models-cache.yaml` and
`components/node-local-model-cache` **deleted**; `hope-vllm`'s dead `/models` mount removed.

**Gates:** 7 of 8 repo CI jobs pass. `patch-hygiene` fails — and the orchestrator verified it is
**already red on `main`**: the three MLflow `args/8` index patches came in with TASK-854
(`8c0e878`). Either this repo's CI has not run since TASK-854 landed, or it is red and unnoticed.
L1's branch removes one index patch (the vLLM `volumes/4`) and adds none. **Not a TASK-855 regression
— but somebody owns fixing it.**

### Provider rows read live from the dev DB (resolves L1's open BYOK question)

All **18** `core."AiProviderConnection"` rows are SYSTEM-tenant; **no customer tenant has a row at
all**. Every cloud STT provider is disabled and unkeyed:

| service | provider | enabled | keyed |
|---|---|---|---|
| stt | azure-speech / openai / sarvam | **f** | **f** |
| tts | azure / sarvam | **f** | **f** |
| llm | lm-studio / ollama / vllm / llama-cpp / built-in | t | t (except built-in) |
| model-registry | **s3** | **f** | **f** |
| model-registry | huggingface | f | f |

Three consequences:

1. **L1's closed egress policy for `hope-stt` / `hope-stt-worker` is safe today.** Its stated worry —
   "if any tenant has keyed a cloud ASR provider, this breaks it" — is answered: none has.
2. **`hope-tts`'s public-443 allowance is not currently needed.** L1 opened it for Azure Speech
   (`TTS_AZURE_ENABLED: "true"` in the Deployment), but the `tts/azure` row is disabled and unkeyed,
   and a disabled row is a veto in both tiers. Closing 443 would make the egress deny absolute for
   TTS too — at the cost that a future admin enabling Azure TTS in the console would then fail with a
   confusing network error rather than working. **Owner decision.**
3. **Mode U is not configured** — `model-registry/s3` is disabled and unkeyed, so an `s3://`
   `sourceUri` would fail closed today. This does **not** affect Phase 1: the s3fs sidecar
   authenticates with the `hope-models-reader` Kubernetes Secret, not that DB row. Worth knowing that
   Mode M works with zero provider configuration, which is one more reason it is the fast win.

### The one thing no manifest can fix

L1 found that **the HF token still reaches those pods after its change**: all four workloads carry
`envFrom: secretRef: hope-secrets`, and `hope-secrets` itself holds `HUGGINGFACE_TOKEN` / `HF_TOKEN`.
Deleting the explicit `secretKeyRef` projections is necessary but not sufficient. Argo cannot manage
Secrets, so this needs a **hand edit on the live Secret plus a rollout restart** — the procedure is
now written into `secrets.dev.yaml.example`. Baseline showed exactly 5 `HUGGINGFACE_TOKEN`
`secretKeyRef`s, all on stt/stt-worker, so removing the keys breaks no other workload's explicit
reference.

### L6 delivered — and correctly reported that it is not enough on its own

Mirrored `source_resolver.py` into `apps/nlp` and `apps/tts` (scheme dispatch, `local_path`
precedence, single-flight, SHA256, atomic replace, lazy `minio` import) and — the part that matters —
**wired it into real call sites**, not left as dead code: `nlp/dependencies.py::_weights_source()`
now dispatches `s3://` and `file://` before handing the value to `from_pretrained`, and the TTS
providers resolve an `s3://` override in the coroutine *before* the blocking load thread starts.
Gates green on both services. `uv lock` re-run by the orchestrator (489 packages).

**But Mode U still cannot resolve in production, and L6 said so rather than hiding it.**

`apps/stt` gets its S3 credentials from `GET /internal/stt/model-registry-credential?provider=&tenantId=`
(`apps/api/src/modules/internal/stt-internal.controller.ts:329`), guarded by the internal gateway
secret and resolving tenant → SYSTEM through `IProviderConnectionService`. **There is no nlp or tts
equivalent**, so `config_from_settings()` in the new modules supplies cache-dir and TLS only, and an
`s3://` resolve raises `_make_s3_client`'s "not configured" `ModelSourceError`. L6 refused to invent
env-var credentials for it — correct, since TASK-799 explicitly closed that door and the brief bans
new `*_API_KEY` vars.

**The fix is one route, not three.** That endpoint is generic in everything but its path: it takes
`provider` and `tenantId` and delegates to the provider-connection service. A shared
`GET /internal/model-registry-credential` serves all three services. Assigned as a follow-on to **L3**,
which already owns `apps/api` this round — a second writer there would collide on the five generated
artifacts (`route-manifest.json`, `openapi.json`, the portal, the vox-node admin SDK), which must be
regenerated exactly once.

Two further findings from L6, neither actioned:
- **`apps/harness` has the same defect today** — its resolver's real caller builds a
  `ModelSourceConfig` with no credentials either. Same shared route would fix it.
- **`nlp/core/guard_model_reference.py`** (GLiNER2 guard, MiniCheck entailment) keeps its own
  deliberately fail-closed, synchronous local-path resolution and still cannot load `s3://`. It is a
  clinical safety gate with 12 existing sync assertions; L6 judged an async signature change
  out of scope. Owner call whether it needs Mode U at all.
- Historical note L6 dug up: `nlp` **used to have** this exact resolver (`core/model_source.py`),
  deleted in TASK-799 as dead code because its only caller was its own test. This lane is that work
  redone *and connected*.

### L4 delivered — and corrected the brief

**The brief was stale: `sourceUri` was already in the model form.** The real gaps were `localPath`,
the download affordance, and any catalog-level view of weight source and download state. L4 also
found that `/ai-platform` (TASK-845, shipped by another lane) already has a read-only "Catalogue" tab
linking to `/ai-models`, and followed that established pattern in reverse rather than inventing one.

Shipped: `localPath` in the form (disabled with a stated reason in register mode, since the create DTO
does not accept it; `toUpdateRequest()` always sends it — including `""` — so clearing actually
clears rather than being silently dropped); help text distinguishing Mode U from Mode M and warning
that `<version>` is content-derived; two read-only grid columns (`WeightSourceBadge`: Mounted / S3
URI / Hub ID / No source, with `localPath` winning — and `DownloadStatusBadge`), both using the
codebase's `StatusBadge` + `StatusDot` + distinct-label pattern so state is never colour alone; the
download panel in the `DetailDrawer` with 2s polling, one toast per transition, 409 → "already in
progress", and a disabled button with a visible adjacent reason when a model has no source.

The `model-registry`/`s3` connection is surfaced read-only with a plain link to
`/ai-platform?tab=providers&psvc=model-registry` — no cross-feature import, per rule 13. Orchestrator
verified the endpoint it reads is real: `GET admin/providers/:service/:provider`
(`ai-provider-connection.controller.ts:80`).

**A real bug caught in passing:** L4's first draft used `text-primary` for the link, which a repo-wide
emphasis-canon guard bans because `--primary` ≈ `--foreground`. It found this via the failing test and
fixed it to the established `text-foreground … hover:underline` convention.

**Stated limitation, not glossed:** both themes were verified by grep (no hardcoded colours; every new
element uses already dual-theme-verified semantic tokens) but **not confirmed by eye** — `/ai-models`
is SUPER_ADMIN-only behind BFF session auth and no gateway/DB was running. Worth one manual pass
before release.

Open questions from L4: download lives in the drawer rather than the grid row (a 48px fixed-height row
cannot carry an accessible disabled-reason without breaking the no-wrap grid contract); "Hub ID" is a
catch-all for any non-`s3://` source; and the grid does not poll while a download runs elsewhere.

### L3 delivered — the download action exists

Both routes ship on the existing `AiModelAdminController`, inheriting its `@ForbidApiKey()` /
`@RequiredSvcScopes('svc:admin:ai-model:manage')` / `@Authorize(['manage','all'])`, verified in the
regenerated manifest. 404-over-403 falls out of the repository + tenant-scope extension. 409 covers
both the already-`DOWNLOADING` case **and** the CAS race — an `OptimisticConcurrencyException` on the
`updateWithVersion` write is remapped to `Conflict`, deliberately not left as a 412, since 412 is
reserved for a client-supplied stale `If-Match` and this action never uses one. No enum members added.

**Version derivation is real, not stubbed:** the processor computes SHA256 per file, builds a
`SHA256SUMS` body matching `shasum -a 256` output, hashes that, and takes 12 hex chars — validated end
to end against both live bucket examples (`q4-0-…`, `q4-k-m-…`). Quant token comes from `computeType`
when present, else regex from the source, else the bare hash.

Credentials route entirely through the existing `IS3Service` (`S3_ENDPOINT` from `AppSettingsService`
db-config, keys from `SecretsService` vault-kv). **No new env var anywhere** — the constraint held.

`startedAt`/`finishedAt`/`error` have no `AiModel` columns and no migration was available to this lane,
so they ride in the existing `_metadata` JSONB under `metaData.download`, following the entity's own
documented precedent (TTS `metaData.voices`).

**Boundary excursion, reviewed and accepted:** L3 touched `JobQueue.enum.ts` and `worker-session.ts`
outside its stated ownership. A background job needs a queue, no other lane touches either file, and
the orchestrator confirmed no collision.

**Owner questions raised and deliberately NOT resolved by the lane:**
1. `computeType` (documented as float32/float16/int8) is **reused as the GGUF quant selector** and
   version label. Works for both examples, but it repurposes a field's stated meaning.
2. `HOPE_MODELS_BUCKET = 'hope-models'` is a literal. Defensible — `apps/stt`'s `path_resolver.py`
   defaults the same literal, and only endpoint/credentials vary per environment — but it sits against
   the letter of "never hardcode configuration".
3. **The HF fetch allowlist is GGUF-focused.** A plain safetensors repo would fetch nothing. That
   directly affects `blaze999/Medical-NER` and the TTS models, which are **not** GGUF — so the download
   action cannot yet publish them. Real limitation, must be closed before the publish step runs.
4. `attempts: 1` on the queue (no silent retry after a row is already `DOWNLOAD_FAILED`) — accepted.

### Follow-on now in flight: making Mode U actually work

Both halves of the credential path, dispatched in parallel to the lanes that own each side:
- **L3** — one shared `GET /internal/model-registry-credential`, mirroring the stt route's guard and
  tenant → SYSTEM resolution, with the stt-specific path left working and marked superseded.
- **L6** — the Python client in `nlp`/`tts` that calls it, mirroring `stt/core/model_credentials.py`,
  failing closed on absence, with `X-Tenant-Id` mandatory.

### Phase 1 merge gate (orchestrator-owned)

Neither lane may merge until **the weights are actually in the dev `hope-models` bucket**. Order:

1. Publish the self-hosted models into `s3://hope-models/<slug>/v1/` (flat), **plus Kokoro in HF-cache
   layout under `hf/`** per OD-3. Operator step — the orchestrator's, not a lane's.
2. Merge **L2** (registry rows carry `localPath`, pointing at what now exists).
3. Merge **L1** (sidecars + egress deny) and re-run the affected gates on the merge result.

Inverting 2 and 3 takes services offline: a `localPath` that does not exist falls through to the hub
id with a warning today, but once the egress policy lands that fall-through has nowhere to go. L1's
report must name every service that would lose its weight source if merged early — that list is the
gate.

---

## 9. Change History

| Date | Change |
|---|---|
| 2026-09-02 | Ticket opened. R1–R3 audited against both repos and the live cluster; six-lane plan v1 authored. |
| 2026-09-02 | **Plan v2.** Second pass found mount-point loading already implemented in all four model-hosting services via `AiModel.localPath` — correcting v1's claim that `nlp`/`tts` could not be pointed at MinIO. Restructured around two named modes (M = mount, U = URI), cut the critical path to one no-code deployment change, added the OrbStack Phase 0 proof with the three owner-named test models, folded the catalog UI in as Phase 2, and reduced six lanes to four (one `opus`, down from two). OD-1 resolved by the directive; OD-3 (Kokoro) and OD-4 (privileged sidecar) added. |
| 2026-09-02 | **Phase 0 executed.** Lab stood up on OrbStack; all three owner-named models published to `hope-models`. P0-1a/b, P0-2, P0-3, P0-4 and P0-5 pass — weights load in place at 186–503 MB/s with zero local writes, and llama.cpp generates text straight off the mount. P0-1c blocked by lab egress (large-wheel timeouts from two CDNs), not by the design. Found and recorded a live registry defect: three seeded `taphuynh/*` ASR rows point at non-existent HF repos. |
