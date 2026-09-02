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

| Lane | Branch | Merged into `dev-2.2` | Gates |
|---|---|---|---|
| L0 lab | n/a (OrbStack) | n/a | P0-1a/b, P0-2, P0-3, P0-4, P0-5 **pass**; P0-1c blocked by lab egress |
| **L2** registry | `task-855-l2-registry` | ✅ `0334a5408` | typecheck clean · `migrate diff` empty · 1709 tests |
| **L6** s3:// parity | `task-855-l6-s3uri` | ✅ `1fe661cb4` | nlp 553 · tts 444 · lint + typecheck clean |
| **L4** catalog UI | `task-855-l4-catalog` | ✅ `72239b601` | build · lint 0 warnings · 2305 tests · axe 0 violations |
| **L3** download API | `task-855-l3-download` | ✅ `5b476bc43` | applications 10 937 tests · api 4161 tests · 5 artifacts · 3 `:check` green |
| **L1** mount | `task-855-l1-mount` @ `fbdb1f5` | ❌ **deliberately NOT merged** | 7/8 repo CI gates; `patch-hygiene` red on `main` already |
| **L7** fetch fix | merged `9bd68b614` | ✅ | 7 files / 57 tests, against real HF repo listings |

**Merged by a different session, not this one**, while lanes were still running. Verified afterwards:
L1 — the only branch whose merge is an outage — correctly stayed unmerged, and **both credential
follow-ons landed** (`model-registry-internal.controller.ts`, `nlp/core/model_credentials.py`,
`tts/core/model_credentials.py`).

**Post-merge gates re-run by the orchestrator on the merged HEAD** (rule 14 §5 — a clean merge is not
a passing build). L3 and L4 both touched generated API-docs files, so drift was the live risk:

```
[openapi-coverage]     OK — every served route documented or deliberately excluded
[gen-api-portal]       no drift (admin 633 ops, business 188 ops)
[vox-node-codegen]     no drift (52 areas, 411 routes, 376 schemas)
```

**L6 reconciled — nothing stranded.** It was still running when its branch was merged, but the
coordinator's tooling had squashed both its rounds into `9fa4274c9`; that commit is contained in
`dev-2.2`, its worktree is clean, and the follow-on's own regression test is present in HEAD. The
race resolved without loss.

### The security deviation, verified and accepted

L3 was instructed to make the new internal route come out `isPublic: false` like the stt one. **It
refused, and it was right.** Both reasons verified in source by the orchestrator:

- `RESERVED_INTERNAL_SCOPE_CONTROLLERS` is frozen at `{'SttInternalController'}`
  (`api-key-scope-audit.ts:181`), with a doc comment saying widening it must *"force the discussion
  into review rather than letting it happen by accident."*
- `InternalServiceTokenGuard.SERVICE_SECRETS` (`internal-service-token.guard.ts:34-41`) already
  carries `text`, `nlp`, `guardrail`, `harness`, `tts` and `stt` — every caller already holds a
  working credential for the `@Public()` + `InternalServiceTokenGuard` pattern it used instead
  (`EffectiveConfigController`'s existing pattern).

`isPublic: true` in that manifest means "carries `@Public()`" — off the JWT/API-key path — **not**
"unauthenticated". The route is still gated. Extending the frozen exemption would have been a
deliberate security-posture change, and doing it silently inside a background lane was correctly
refused.

### L6 follow-on — the credential path, and a bug it found on the way

Credential clients for `nlp` and `tts` mirroring `stt.core.model_credentials` (per-tenant-and-provider
cache that never caches a fault, single-flight per key), calling the **generic**
`GET /internal/model-registry-credential` — not the STT-worker-reserved path. Auth uses
`API_GATEWAY_KEY`, which is **not a new secret**: already in `turbo.json#globalEnv` and the root
`.env.sample`, and `apps/stt` reads it the same bare-name way. `X-Tenant-Id` is sent on every request
— which `stt`'s own client does not do today (query param only), so this is stricter than the
incumbent, per the mandatory-header rule.

**A real bug caught in passing.** `nlp`'s `_weights_source` dispatches `s3://` and `file://` through
the same branch. Routing `file://` through the credentialed builder would have made a purely local,
gateway-independent resolve — an on-prem pre-staged path — start requiring a live gateway call, and
fail when it is down. Fixed so only `s3://` takes the credential path, pinned by
`apps/nlp/tests/test_task855_weights_source.py` so it cannot regress silently.

**Limitation stated, not hidden:** `nlp` receives only `model_name`/`model_path` per request, never the
model row's `tenant_id`, so it resolves credentials against SYSTEM always. That is *safe* — it can
never spend one tenant's credential on a model it did not select — but it means **a tenant's own BYO
`s3://` bucket will not authenticate**. Closing that needs a gateway-side DTO addition to thread true
ownership through. `tts` has no tenant dimension for its operator-set local-engine overrides, so
SYSTEM there is exactly right rather than an approximation.

**Harness answered: not a one-line fix.** It needs a new `model_credentials.py` (~300 lines), a new
`api_gateway_key` settings field (it has no `X-Internal-Service-Key` equivalent at all today), and a
change to `resolve_atomic_fact_model_path` (`temporal/activities.py:2131`), which builds a
`ModelSourceConfig` inline with no credential half. Its `_make_s3_client` boto3 adapter transfers
unchanged. Same shape, genuine multi-file lift — deliberately not attempted.

Gates after the follow-on: **nlp 582 passed, tts 466 passed**, lint and typecheck clean on both.

### L6b — the same `source_resolver.py` bug in the two copies `2502ac387` did not reach

`2502ac387` fixed the `HF_HUB_OFFLINE` pre-emption in **two of the four** copies of
`models/source_resolver.py`. `tts` and `harness` still carried it. Fixed here.

**The bug.** `_resolve_hf` raised as soon as `HF_HUB_OFFLINE` was set, *before* calling
`snapshot_download` — while its own message advised the operator to "pre-populate the hub cache".
`huggingface_hub` honours that variable by SERVING the local cache and never touching the network,
so the guard pre-empted exactly the behaviour it recommended. The offline case is still reported
distinctly, but now only after a real cache MISS, which is when the message is true.

**Live in tts, latent in harness.** `deployment/k8s/base/tts-v2.yaml:220` sets `HF_HUB_OFFLINE=1`
alongside the read-only `s3://hope-models` mount, so every hub-sourced resolve on that pod raised
with the weights present. Harness's one production entry (`resolve_atomic_fact_model_path`) passes
`allow_network=False`, which refuses `hf:` one branch earlier — but `resolve_model_dir` is public,
and the copy nobody notices is the copy that bites when it becomes the live one.

**Divergence after the change**, measured by normalising the service token and diffing `_resolve_hf`:

| pair | result |
|---|---|
| nlp vs stt | identical |
| nlp vs harness | identical |
| nlp vs tts | 3 lines — all the **pre-existing, deliberate** "tts has no `AiModel.localPath`" wording (`Stage the weights locally`, `set a local mirror path`), documented in tts's own module docstring |

**Third defect, fixed with it.** `harness._make_s3_client` still told operators to *"Set the
`*_MODEL_S3_ENDPOINT` / `_ACCESS_KEY` / `_SECRET_KEY` environment variables."* Two lies in one
breath: TASK-799 removed the env-credential model platform-wide (`apps/stt` renamed its aliases to
`..._ENV_REMOVED_TASK_799` so the old names can never bind), and **`HARNESS_MODEL_S3_*` never
existed in this repo at all** — the only occurrence anywhere was the error string itself. A
rule-09 config-tier violation on top of an operator-facing lie: an S3 credential is
`vault-kv`/`db-secret` behind an `AiProviderConnection`, never `env`. The message now names that
tier and states plainly that harness cannot yet READ it (it ships no `core/model_credentials.py`,
which the L6 follow-on already recorded as a genuine multi-file lift). The dead names are
deliberately NOT repeated in the new text — a string an operator can still grep for reads as live
advice however it is framed — and a test pins that.

**boto3 in harness: deliberate, kept.** `boto3` is a pre-existing harness dependency with two other
production consumers (`temporal/claim_check.py`'s `S3BlobStore`, `eval/judge/providers.py`'s Bedrock
judge) and harness ships **no `minio`**, which the other three do. Swapping to `minio` would add a
dependency to the harness image for a client it already has. `_Boto3MinioAdapter` confines the
divergence to `_make_s3_client` so the resolver body stays identical, and `list_objects_v2` without
a `Delimiter` matches minio's `recursive=True`. One cosmetic nit, not worth a change: the adapter
accepts a `recursive` argument it never reads (it is always recursive; every call site passes
`True`).

**Consolidation: recommended, but as its own ticket.** ~55% of each copy (≈283 of 490–541 lines) is
the identical dispatch core; the divergent ~45% is real and per-service. See §10.

### L7 — the fetch allowlist could not reach two of the three test models

Found while scoping L3's flagged limitation, and **worse than L3 reported.**
`isRelevantModelSourceFile` accepted only `*.gguf` plus seven companion basenames. Measured against
the three models nominated for validation:

| Repo | Weight file | Fetched before |
|---|---|---|
| `unsloth/Qwen3-0.6B-GGUF` | `Qwen3-0.6B-Q4_K_S.gguf` | ✅ |
| `blaze999/Medical-NER` | `model.safetensors` | ❌ config only, **no weights** |
| `taphuynh/whisper-…-gguf` | `ggml-…-q5_0.bin` | ❌ **nothing at all** |

L3 flagged safetensors but missed the whisper case, which is the instructive one: the repo is *named*
`-gguf` but ships whisper.cpp `ggml-*.bin`, so an extension check on `.gguf` found nothing. And the
failure was **silent** — a repo with no match returned companions and the publish "succeeded".

Fixed by widening to the weight formats the platform actually serves
(`gguf/safetensors/bin/onnx/nemo/pt/pth/.model`) behind a denylist for trainer bookkeeping, which
shares `.bin`/`.pt` with real weights (`training_args.bin` et al).

**A second bug the widening would have created:** `matchesQuantOrIsCompanion` exempted everything not
`.gguf` — correct while GGUF was the only quantised format, but with `.bin` accepted a `Q5_0` request
against the whisper repo would have published f16, q5_0 **and** q8_0: 3× the bytes and an ambiguous
prefix with no way for a consumer to know which file to serve. `.safetensors` stays exempt
deliberately — a repo ships one unquantised set, so filtering it would exclude the only weights.

Tests use the **real repo listings** read from the HuggingFace API, not invented fixtures.
Merged as `9bd68b614`. Suite: **7 files, 57 tests, all passing** (after generating the Prisma client
and building `@arcaai/domains`/`@arcaai/exceptions` — the fresh-worktree condition of rule 14 §4,
diagnosed from the actual resolver error rather than assumed).

⚠️ **All TASK-855 worktrees were removed by another session**, including this one while its fix was
still uncommitted. It survived only because that session committed before removing. Rule 14 §5 exists
for exactly this: *never destroy a worktree with unmerged commits, and never prune worktrees to tidy
up.* No loss this time; it was luck, not process.

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

---

## 10. Assessment — should the four `source_resolver.py` copies become one shared module?

**Owner decision, not executed here.** The audit that called the mirroring *"a real, realised risk,
and the ticket that touched two of four copies is the proof"* is correct, and L6b is the second
proof: a fix landed in two copies and the other two kept the bug for a day.

### What is actually shared

Measured by function, not by eye:

| service | total | shared dispatch core | share | service-specific |
|---|---|---|---|---|
| stt | 541 | 283 | 52% | `config_from_settings`, `config_for_model`, `identity_from_model_config`, `resolve_for_model_config`, `resolve_weights_or_hf_id`, `_make_s3_client` |
| nlp | 490 | 283 | 57% | `config_from_settings`, `config_for_model`, `_make_s3_client` |
| tts | 504 | 282 | 55% | `config_from_settings`, `config_for_model`, `resolve_local_override`, `_make_s3_client` |
| harness | 528 | 294 | 55% | `_make_s3_client`, `_Boto3MinioAdapter`, `resolve_atomic_fact_model_path` |

The shared core is `resolve_model_dir` + `_looks_like_hf_id` / `_resolve_file` / `_resolve_hf` /
`_resolve_s3` / `_download_s3_prefix` / `_sha256` / `_verify_checksum_sync` / `_verify_dir_checksum`
/ `_hf_snapshot_download`, plus the three types. That is the **highest-risk** half — checksum
verification, atomic download-then-rename, and the offline handling that just drifted twice.

The divergent half is genuinely divergent, and consolidation must not flatten it: stt has an
`AiModelConfig` type and five entry points; tts has `resolve_local_override` and zero-arg config
builders; harness has `resolve_atomic_fact_model_path` and no config builders at all.

### Recommendation

**Extract the core into `packages/py-model-source` (`hope_model_source`); keep a thin per-service
`models/source_resolver.py` holding only that service's seams and entry points, re-exporting the
shared names so no call site changes.** Precedent is established and proven: `packages/py-env`
(985 LOC) and `packages/py-runtime-models` (991 LOC) are already consumed by **all four** of these
services, so the packaging, `uv` workspace wiring and pytest `pythonpath` pattern are known-good.

**Cost: one focused ticket, one agent, roughly a day.** ~350 LOC moved, ~400 LOC of tests, plus 4
service `pyproject.toml` edits (dependency + `{ workspace = true }` + `pythonpath`) and a root
`uv lock`. The four near-duplicate conformance suites collapse into one parameterised suite, which
is where most of the day goes.

### What would break — read this before scheduling it

1. **The monkeypatch seams, silently.** Every suite stubs at
   `monkeypatch.setattr("<svc>.models.source_resolver._hf_snapshot_download", ...)` and
   `..._make_s3_client`. If the body moves and the service module merely re-exports those names,
   patching the service name rebinds the *shim's* attribute while the shared body still resolves
   its own module global — the stub is bypassed and the hermetic suites reach the real network.
   That fails as a hang or a surprise 200, not as a red test. **Mitigation must be designed up
   front**: pass the client factory and the snapshot function as explicit injected seams rather
   than module globals. This is what makes the job a design change, not a mechanical extraction.
2. **Worktree provenance (rule 14 §4).** Each service's `pytest` `pythonpath` needs the new
   package, *and* the new package name must be added to every
   `assert_source_tree([...], __file__)` call in the four `conftest.py` files — otherwise a
   worktree run silently imports the PRIMARY checkout's resolver, which is precisely the failure
   mode that guard exists to catch.
3. **The harness hermetic constraint (rule 06).** harness ships no `minio`. The shared package must
   never import it at module scope, so the S3 client factory has to stay a per-service injection —
   it cannot be absorbed into the shared body.
4. **mypy.** Three services carry a `module = ["minio", "minio.*"]` override; the shared package
   needs its own config, and harness must keep resolving `boto3-stubs`.
5. **`ModelSourceError` becomes one class.** Re-export keeps `except` clauses working, but anything
   comparing `type(...).__module__` changes. Grep before moving.
6. **`uv.lock`** regenerates for the whole workspace (one root lock).

### Cheaper interim guard, available now without an owner decision

Nothing in CI compares the four copies today — which is *why* this drifted twice. A single
conformance test that normalises the service token and asserts the shared region is byte-identical
across all four files would have caught both drifts at the commit that introduced them. It costs
about an hour, needs no owner decision, and stays useful whether or not the consolidation is ever
approved. Reproduce the check with:

```
diff <(sed 's/nlp/SVC/g' apps/nlp/src/nlp/models/source_resolver.py) \
     <(sed 's/tts/SVC/g' apps/tts/src/tts/models/source_resolver.py)
```

## 9. Change History

| Date | Change |
|---|---|
| 2026-09-02 | Ticket opened. R1–R3 audited against both repos and the live cluster; six-lane plan v1 authored. |
| 2026-09-02 | **Plan v2.** Second pass found mount-point loading already implemented in all four model-hosting services via `AiModel.localPath` — correcting v1's claim that `nlp`/`tts` could not be pointed at MinIO. Restructured around two named modes (M = mount, U = URI), cut the critical path to one no-code deployment change, added the OrbStack Phase 0 proof with the three owner-named test models, folded the catalog UI in as Phase 2, and reduced six lanes to four (one `opus`, down from two). OD-1 resolved by the directive; OD-3 (Kokoro) and OD-4 (privileged sidecar) added. |
| 2026-09-02 | **Phase 0 executed.** Lab stood up on OrbStack; all three owner-named models published to `hope-models`. P0-1a/b, P0-2, P0-3, P0-4 and P0-5 pass — weights load in place at 186–503 MB/s with zero local writes, and llama.cpp generates text straight off the mount. P0-1c blocked by lab egress (large-wheel timeouts from two CDNs), not by the design. Found and recorded a live registry defect: three seeded `taphuynh/*` ASR rows point at non-existent HF repos. |
| 2026-09-02 | **L6b PLAN (written before any code, per the standing rule).** `2502ac387` fixed the `HF_HUB_OFFLINE` pre-emption in **two of the four** `models/source_resolver.py` copies (stt, nlp). `tts` and `harness` still carry the pre-emptive raise. Plan: (1) TDD — add `test_hf_offline_cached_is_served_from_cache` to `apps/tts/src/tts/tests/unit/test_model_source_resolver.py` and `apps/harness/src/harness/tests/unit/test_model_source_resolver.py`, watch both RED; (2) port the `2502ac387` fix verbatim into both resolvers (drop the pre-emptive raise, keep `offline`, emit the offline-specific message from the `except` handler after a REAL cache miss) and repair the now-false `# pragma: no cover - offline guard fires first` stub comment in the sibling `..._offline_uncached_raises_cleanly` test; (3) fix `harness._make_s3_client`'s credential error, which still instructs operators to set `*_MODEL_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY` — env vars TASK-799 removed and which **never existed for harness at all** (rule-09 config-tier violation + an operator-facing lie), TDD'd by an assertion that the message names no env var; (4) ASSESS ONLY (no execution) whether the four copies should collapse into one shared package. Gates: `pnpm {tts,harness}:{test,lint,typecheck}` plus a `stt`/`nlp` regression re-run. Boto3 in harness is to be judged, not ripped out. |
| 2026-09-02 | **L6b DONE.** `HF_HUB_OFFLINE` pre-emption removed from the `tts` and `harness` resolvers (TDD: both new `test_hf_offline_cached_is_served_from_cache` cases shown RED against the pre-emptive raise first), the now-false `# pragma: no cover - offline guard fires first` stub comments corrected in both sibling tests, and harness's credential error re-pointed from three env vars that do not exist to the `model-registry`/`s3` provider connection. `_resolve_hf` is now byte-identical across stt/nlp/harness; tts keeps only its documented "no `AiModel.localPath`" wording. boto3 in harness assessed and KEPT (pre-existing dep, two other production consumers, no `minio` in that image). Gates: **tts 467 passed, harness 1976 passed, nlp 583 passed, stt 3079 passed** (e2e excluded — needs a live gateway), lint + typecheck clean on tts and harness. Shared-module consolidation assessed and written up in §10 — **not executed**, it is an owner decision. |
