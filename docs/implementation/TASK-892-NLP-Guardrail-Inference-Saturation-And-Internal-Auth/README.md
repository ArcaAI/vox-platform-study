# TASK-892 — NLP inference saturation, probe-induced endpoint flap, and missing internal service auth

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `bugfix` + `infrastructure` + `enhancement` |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-07 |
| **Environment observed** | `hope-v2-dev` (k3s, VM 200 `dell`), Argo-synced `overlays/dev` |
| **Evidence window** | 2026-09-07 09:15:00Z – 09:23:00Z, live cluster (read-only) |
| **Affected surfaces** | `apps/nlp`, `apps/guardrail`, `apps/stt` (latent), `arca/hope-v2-deployment` (`overlays/dev`, `hope-secrets`) |

---

## 1. Requirement Analysis

The owner ran a batch of NER and Guardrail requests against the dev cluster and reported that
(a) NER is **very slow** and (b) **many requests threw errors**.

This ticket must:

1. Explain the latency with measured evidence, not inference.
2. Enumerate every distinct error class in the window and attribute each to a root cause.
3. Separate *defects* (things that are wrong) from *enhancements* (things that could be better),
   and fix the defects.
4. Close the systemic gaps that let these land silently — a missing Secret key that fails open,
   and a container-unaware thread default that no gate catches.

**Non-goals.** Model quality/accuracy tuning, guardrail toxicity thresholds (tracked separately in
the TASK-890 owner notes), and GPU capacity expansion (the cluster is at 6/6 allocatable
`nvidia.com/gpu`; see §6 E-2).

---

## 2. Current State Evaluation

### 2.1 Measured latency (from the pod's own `/metrics`, 09:23Z)

| Endpoint / metric | Count | Sum (s) | Mean |
|---|---:|---:|---:|
| `model_inference_latency_seconds{model="Medical-NER"}` | 19 | 386.30 | **20.3 s** |
| `http_request_duration_seconds{handler="/api/v1/classify/tokens"}` | 21 | 389.80 | **18.6 s** |
| `http_request_duration_seconds{handler="/api/v1/guard/pii"}` | 7 | 92.59 | **13.2 s** |
| `http_request_duration_seconds{handler="/api/v1/guard/classify"}` | 4 | 33.82 | **8.5 s** |
| `nlp_inference_queue_wait_seconds{batcher="nlp_guard_classify_bulk"}` | 4 | 24.19 | **6.0 s (queue only)** |
| `http_request_duration_seconds{handler="/api/v1/internal/models/resolvable"}` | 155 | 7.49 | 48 ms |

Inference accounts for **386.3 s of the 389.8 s** of NER endpoint time — **99.1 %**. Neither the
network, the gateway, nor request parsing is material. An earlier sample in the same window put
the slowest NER bucket at **60–120 s**.

`/api/v1/internal/models/resolvable` at 48 ms proves the process, the event loop and the network
path are all healthy when no model is running. The cost is entirely the forward pass.

### 2.2 Root cause of the latency — PyTorch sizes its thread pool from the node, not the cgroup

Measured inside `hope-nlp-6845fc5d4b-tv765`:

```
/sys/fs/cgroup/cpu.max   = 200000 100000     → 2 CPUs
nproc (node `dell`)      = 48
torch.get_num_threads()  = 48                ← sized from the node
OMP_NUM_THREADS          = (unset)
MKL_NUM_THREADS          = (unset)
torch.cuda.is_available()= False
```

The container gets 2 cores; PyTorch launched a **48-thread** intra-op pool. The cgroup records the
damage:

```
nr_periods     22172
nr_throttled    2714          (12.2 % of periods)
throttled_usec  7291815148    → 7,292 s frozen on the quota
usage_usec       573328295    →   573 s actually executing
```

**The container spends 12.7× more wall time frozen by the CFS quota than it spends running.**
48 runnable threads exhaust a 200 ms quota in a few ms, then the entire pool stalls for the
remainder of every 100 ms period; on top of that, OpenMP barrier cost across 48 threads dominates
the actual GEMM for the small batches NER submits.

Benchmarked in-pod on BERT-base FFN shapes (seq 256, 768→3072→768, 30 iters):

| `torch.set_num_threads(n)` | ms / layer |
|---:|---:|
| **48 (current default)** | **583.3** |
| 16 | 93.5 |
| **8 (optimum)** | **50.0** |
| 4 | 96.5 |
| 2 | 116.7 |
| 1 | 139.5 |

**11.7× slower at the running configuration than at 8 threads.** Over 12 encoder layers this is
~7.0 s vs ~0.6 s of FFN alone, which is the correct order of magnitude to explain the observed
10–120 s responses.

`apps/stt` already solves exactly this problem — `_configure_torch_threading()` in
[`apps/stt/src/stt/main.py:35`](../../../apps/stt/src/stt/main.py) sets `OMP_NUM_THREADS` /
`MKL_NUM_THREADS` before importing torch and calls `torch.set_num_threads()` /
`set_num_interop_threads()`, driven by `STT_TORCH_NUM_THREADS`. **`apps/nlp` has no equivalent** —
`apps/nlp/src/nlp/main.py` contains no torch setup at all, and no thread env var is set on the
`hope-nlp` container.

> **Note for the fix:** STT's own fallback is `os.cpu_count() or 4`, which is *also* cgroup-blind
> and would return 48 on this node. STT escapes the symptom today only because it holds a GPU
> slice. The shared helper must read `/sys/fs/cgroup/cpu.max`, not `os.cpu_count()` — see E-1.

### 2.3 Root cause of the errors — saturation starves the probes, which unpublishes the Service

Pod events on `hope-nlp-6845fc5d4b-tv765`:

```
Warning  Unhealthy  ×72  Readiness probe failed: Get "http://10.42.0.194:8864/api/v1/health/ready": context deadline exceeded
Warning  Unhealthy  ×9   Liveness probe failed:  Get "http://10.42.0.194:8864/api/v1/health/live":  context deadline exceeded
```

Both probes are configured `timeoutSeconds: 1` (readiness `periodSeconds: 5`,
`failureThreshold: 2`; liveness `periodSeconds: 30`, `failureThreshold: 3`). While the 48-thread
pool holds the quota, the uvicorn event loop cannot be scheduled within 1 s, so the probe times
out. Two consecutive readiness failures remove the pod from the `hope-nlp` Endpoints object:

```
Endpoints/hope-nlp  annotations:
  endpoints.kubernetes.io/last-change-trigger-time: "2026-09-07T09:22:57Z"
```

— i.e. the endpoint list was still being rewritten at the end of the window. The Deployment's
`Available` condition also re-transitioned at `09:15:42Z`.

**The complete causal chain:**

```
NER request
  → 48 threads contend for a 2-core quota
    → CFS throttles the process (7,292 s frozen)
      → readiness probe exceeds its 1 s timeout  (×72)
        → pod removed from hope-nlp Endpoints
          → guardrail's delegated POST http://hope-nlp:8864/... → ConnectError
            → POST /api/guardrail/analyze → 503 Service Unavailable
```

Confirmed in the guardrail log at 09:18:54Z / 09:18:56Z:

```
{"event": "guardrail.nlp_delegation.failed what=classify error=ConnectError",
 "logger": "guardrail.services.external_nlp_client", "level": "error"}
INFO: 10.42.0.207:37584 - "POST /api/guardrail/analyze HTTP/1.1" 503 Service Unavailable
```

`ConnectError` (not a timeout) is the tell: the TCP connect itself failed because the Service had
no ready backend. Guardrail's fail-closed 503 is **correct behaviour** — it is a faithful report
of an unavailable dependency, not a guardrail defect.

The **liveness** failures (×9, `failureThreshold: 3`) are the latent hazard: `restartCount` is
still 0, so three *consecutive* failures have not yet coincided, but sustained NER load will
restart the pod mid-inference and turn a slow service into a crash-looping one.

### 2.4 Error inventory for the window

| # | Error | Count | Source | Root cause |
|---|---|---:|---|---|
| E1 | `POST /api/guardrail/analyze` → **503** | 2 | guardrail | §2.3 chain — NLP unpublished from Endpoints |
| E2 | `guardrail.nlp_delegation.failed … error=ConnectError` | 2 | guardrail | same |
| E3 | `POST /api/v1/classify/tokens` → **503** | 2 | nlp | fail-closed shed under saturation (`core/batching.py:24`) |
| E4 | Readiness probe failed (`context deadline exceeded`) | 72 | kubelet | §2.2 CPU starvation |
| E5 | Liveness probe failed (`context deadline exceeded`) | 9 | kubelet | §2.2 CPU starvation |
| E6 | `GET /internal/effective-config?service=nlp` → **401** | ~1/req | nlp → gateway | D-3 missing token |
| E7 | `GET /internal/effective-config?service=guardrail` → **401** | ~1/req | guardrail → gateway | D-3 |
| E8 | `POST /internal/service-releases` → **401** + `service_registration.rejected` | ~6 | nlp + guardrail | D-3 |
| E9 | `transformers`: *"model of type `extractor` to instantiate a model of type ``"* | 2 | nlp | D-5 checkpoint/architecture mismatch |

### 2.5 Root cause of the 401s — `INTERNAL_ACCESS_TOKEN` is absent from `hope-secrets`

Read from inside the NLP pod:

```
INTERNAL_ACCESS_TOKEN = <empty/unset>
```

The `hope-nlp` container declares it as:

```yaml
- name: INTERNAL_ACCESS_TOKEN
  valueFrom:
    secretKeyRef: { key: INTERNAL_ACCESS_TOKEN, name: hope-secrets, optional: true }
```

`hope-secrets` in `hope-v2-dev` carries 43 keys — including `HARNESS_SERVICE_TOKEN`,
`SMR_SERVICE_TOKEN`, `SMR_V2_SERVICE_TOKEN` and `API_GATEWAY_KEY` — but **no
`INTERNAL_ACCESS_TOKEN`**. Because the binding is `optional: true`, both containers start
happily with the variable unset and every gateway-bound internal call is unauthenticated.

The control experiment is in the gateway's own log for the same window:

```
GET /api/v1/internal/effective-config?service=harness  → 200  (durationMs 4)   ← has HARNESS_SERVICE_TOKEN
GET /api/v1/internal/effective-config?service=nlp      → 401                   ← no token
GET /api/v1/internal/effective-config?service=guardrail→ 401                   ← no token
```

Harness succeeds; nlp and guardrail fail. This is a missing Secret key, not a guard defect.

**Impact.** Both services fall back to compiled defaults instead of their resolved tenant → SYSTEM
configuration, and neither can register a service release. Per
`09-infrastructure-devops.md` §Tenant-first resolution, silently serving compiled defaults where
tenant configuration was intended is a correctness fault, not merely noise. It costs one wasted
round-trip per request but is **not** a material contributor to the latency in §2.1.

CLAUDE.md already records why nothing caught this: *"No CI gate validates a `secretKeyRef` against
the live Secret — Argo cannot manage Secrets, so check by hand when you add a key."*

### 2.6 Incidental findings

- **`SMR_V2_SERVICE_TOKEN` is an empty string** in `hope-secrets`. Per
  `06-python-services.md`, an EMPTY service token is the **dev-mode auth bypass** sentinel. An
  empty value is materially different from an absent key and should not sit in a Secret.
- **`hope-secrets` carries a `kubectl.kubernetes.io/last-applied-configuration` annotation
  containing every value in plaintext base64.** It is a hand-applied (non-Argo) Secret, so
  `kubectl apply` recorded the full manifest. This defeats the Rancher/MCP `showSensitiveData:
  false` masking and propagates the values into every `get -o yaml`, etcd backup and audit log.
  No values are reproduced in this document.
- **NLP holds no GPU.** `torch.cuda.is_available() == False` and the Deployment requests no
  `nvidia.com/gpu`. The cluster is at **6/6 allocatable** GPU units (LM Studio 4, STT 1, STT
  worker 1), so a GPU for NLP requires an existing workload to release a slice — an owner
  decision, tracked as E-2, **not** in scope for the fix.
- **Memory headroom is thin:** 945.98 MiB against a `1Gi` request (`4Gi` limit).

### 2.7 Prior art — D-2 is already written, unmerged, and undeployed (discovered 2026-09-07, pre-execution)

Before allocating work, a scan of both checkouts found that **`arca/hope-v2-deployment` is not on
`main`**. It sits on `task-891/dev-fixes` with one unmerged commit:

```
c78cb89  fix(dev): unblock the realtime scribe — nlp probes, live-doc timeout, LM Studio context
         (TASK-891 lane F, writer W5 — authored 2026-09-07 16:28 +0700)
```

That commit already implements **all of Lane B** as `overlays/dev` patches: readiness and liveness
`timeoutSeconds` 1 → 5, readiness `failureThreshold` 2 → 3, and NLP CPU limit 2 → 4. Its own
message records *"44 readiness and 4 liveness probe timeouts in one 10-minute consultation
window"* — the same incident measured here at **72 and 9**.

**The counters kept climbing because the fix was never deployed.** Argo syncs `main`, which is one
commit behind at `ec641e6`. The remedy is a merge, not new work.

Two consequences that survive the merge:

1. **c78cb89 does NOT fix D-1.** Raising the CPU limit 2 → 4 leaves the 48-thread pool intact —
   `nproc` still reports 48 whatever the quota is, and the §2.2 benchmark puts 48 threads at
   583 ms/layer against 96 ms at 4. It buys probe headroom and masks the symptom; the 11.7×
   threading penalty is untouched. **Lane A remains the actual fix.**
2. **The `OMP_NUM_THREADS=8` figure in A5 was measured under a 2-core quota.** Once the 4-core
   limit lands, the optimum must be re-benchmarked before the value is fixed in the overlay.

Also noted: `ec641e6 feat(argocd): prune on for the dev Application` **is** merged to `main`, so
Argo's `prune` is now ON for `hope-v2-dev` — contrary to the "prune defaults OFF" note in
`09-infrastructure-devops.md`, which is now stale. Out-of-band resources are consequently at risk
of pruning; out of scope here, but it should be raised on the TASK-616 E6 thread.

### 2.8 Cross-ticket contention

`hope-v2-task-891-stt` holds **8 uncommitted files** under `apps/stt/` (`pipeline/`, `streaming/`,
and tests). None is `apps/stt/src/stt/main.py`, so lane A4 does not collide file-for-file — but
A4 is deferred anyway (§4 Lane A) to remove the last cross-ticket contention. All four TASK-891
worktrees are dirty (7/2/10/8 files) though their commits are merged into `dev-2.2`; **none may be
pruned or touched by this ticket.**

---

## 3. Defect & Enhancement Register

| ID | Kind | Pri | Title | Surface |
|---|---|---|---|---|
| **D-1** | defect | **P0** | NLP PyTorch pool sized from node (48) not cgroup (2) — 11.7× slowdown | `apps/nlp` |
| **D-2** | defect | **P0** | Probes starve under inference load → Endpoints flap → guardrail 503 — **ALREADY FIXED in unmerged `c78cb89`; needs merging, not rewriting (§2.7)** | deployment repo |
| **D-3** | defect | **P1** | `INTERNAL_ACCESS_TOKEN` missing from `hope-secrets` → nlp+guardrail unauthenticated | `hope-secrets` |
| **D-4** | defect | **P1** | `optional: true` makes the missing token fail **open** and silent | deployment repo |
| **D-5** | defect | P2 | `transformers` checkpoint/architecture mismatch (`extractor` → ``) | `apps/nlp` |
| **D-6** | defect | P2 | `SMR_V2_SERVICE_TOKEN` empty string = dev-mode bypass sentinel | `hope-secrets` |
| **D-7** | hygiene | P2 | `last-applied-configuration` exposes `hope-secrets` values in plaintext | `hope-secrets` |
| **E-1** | enhancement | P1 | Shared **cgroup-aware** thread sizing helper; retire `os.cpu_count()` in STT | `packages/py-env` |
| **E-2** | enhancement | P2 | NLP capacity: right-size CPU/memory, or an owner decision on a GPU slice | deployment repo |
| **E-3** | enhancement | P2 | Saturation SLO alerts + `nlp_inference_rejections_total` dashboard | deployment repo |

---

## 4. Implementation Plan

Ordered so the **P0 latency fix lands first** — D-2, D-3 and E-3 are all easier to verify once the
service is not saturated.

### Lane A — D-1 + E-1: cgroup-aware CPU threading (P0)

**A1.** Add `hope_env.cpu.effective_cpu_quota()` to `packages/py-env`, resolving in order:
1. `OMP_NUM_THREADS` if already set (operator override wins),
2. the service's own `*_TORCH_NUM_THREADS` setting,
3. **cgroup v2** `/sys/fs/cgroup/cpu.max` (`quota / period`, `"max"` → unlimited),
4. **cgroup v1** `cpu.cfs_quota_us / cpu.cfs_period_us`,
5. `len(os.sched_getaffinity(0))`,
6. `os.cpu_count()`.

Clamp to `>= 1`. **RED first**: a test that fakes `cpu.max = "200000 100000"` and asserts `2`,
plus a `"max 100000"` case asserting the affinity fallback.

**A2.** Add `_configure_torch_threading()` to `apps/nlp/src/nlp/main.py`, modelled on
[`apps/stt/src/stt/main.py:35`](../../../apps/stt/src/stt/main.py) but driven by A1. Set the
OMP/MKL env vars **before** the first torch import, then `torch.set_num_threads()` and
`torch.set_num_interop_threads(1)`. Log the resolved values at startup.

**A3.** Add `NLP_TORCH_NUM_THREADS` / `NLP_TORCH_NUM_INTEROP_THREADS` to the NLP `Settings`
(`env_prefix = "NLP_"`), default `0` = auto. Register in `turbo.json#globalEnv` and
`apps/nlp/.env.sample`.

> **Config-tier check.** These are process-bootstrap knobs that must be read *before* torch
> imports and cannot change without a restart — env tier is correct per
> `09-infrastructure-devops.md` §Configuration Tiers L1. They are **not** a model/provider
> selection, so the "no hardcoded configuration" rule is not engaged.

**A4.** ~~Point STT's fallback at the same helper, removing `os.cpu_count() or 4`.~~
**DEFERRED** — `apps/stt` carries 8 uncommitted files in the `task-891/stt` worktree (§2.8).
No file-level collision, but deferring a P1 tidy-up removes the last cross-ticket contention.
Re-open once TASK-891's STT lane commits.

**A5.** Interim mitigation, **no image rebuild** — set on the `hope-nlp` container in
`overlays/dev`:

```yaml
- name: OMP_NUM_THREADS
  value: "8"
- name: MKL_NUM_THREADS
  value: "8"
```

Ship A5 first; A1–A4 make it correct by default and portable across node sizes.

### Lane B — D-2: probe hardening (P0) — **SUPERSEDED by `c78cb89`, merge only**

B1–B2 are **already implemented** in the unmerged commit `c78cb89` (§2.7): readiness/liveness
`timeoutSeconds` 1 → 5, readiness `failureThreshold` 2 → 3, CPU limit 2 → 4, as `overlays/dev`
patches. **Do not re-derive them.** The remaining work is a merge:

**B0.** `A-deploy` branches from `task-891/dev-fixes` (at `c78cb89`), stacks the TASK-892
deployment changes on top, and the whole set merges to **`main`** — the branch Argo actually
syncs. This deploys the probe fix as a side effect. *(Owner-confirmed 2026-09-07.)*

**B3.** Still open — confirm `/api/v1/health/live` performs no model work and shares no lock with
the inference path. If it does, split it onto a path that only asserts the event loop is alive.

**B4.** Still open — apply the same probe review to `hope-guardrail`, `hope-text` and `hope-stt`;
the 1 s timeout is copy-pasted across all four.

**B5.** After the 4-core limit lands, **re-benchmark** the thread optimum before fixing A5's value
(the `8` was measured under a 2-core quota).

### Lane C — D-3 + D-4 + D-6 + D-7: internal service auth (P1)

**C1.** **OWNER-EXECUTED — no agent and no Claude session writes to the live Secret**
*(owner-confirmed 2026-09-07).* Generate an `INTERNAL_ACCESS_TOKEN` and add it to `hope-secrets`
in `hope-v2-dev`. Per the *one shared internal service token* decision, the same value serves every
internal call; `X-Tenant-Id` stays mandatory alongside it. This ticket prepares everything around
it (C2–C6) and hands over the exact command.

**C2.** Flip `optional: true` → `optional: false` on **every** `INTERNAL_ACCESS_TOKEN`
`secretKeyRef`. A service that cannot authenticate to the gateway must fail to start, loudly,
rather than serve compiled defaults in silence. Audit the other `optional: true` bindings in the
same pass.

**C3.** Add a startup assertion in `apps/nlp` and `apps/guardrail`: if `INTERNAL_ACCESS_TOKEN` is
absent **or empty**, refuse to start (`NODE_ENV=production` / in-cluster) or emit one `error`-level
log naming the variable (local dev). Empty must not silently mean *bypass*.

**C4.** Set or remove `SMR_V2_SERVICE_TOKEN` (D-6). An empty string in a Secret is never correct.

**C5.** Re-apply `hope-secrets` with `kubectl replace` (or `apply --server-side`) so the
`last-applied-configuration` annotation is not repopulated with plaintext (D-7); strip the
existing annotation. **Requires owner approval — it touches a live Secret.**

**C6.** Add a `secret-keys` job to the deployment repo's CI: assert every `secretKeyRef` in the
rendered overlay names a key present in a declared key **inventory** file (names only, never
values). Closes the gap CLAUDE.md flags as unguarded.

### Lane D — D-5: checkpoint/architecture mismatch (P2)

**D1.** Reproduce the `transformers` warning and identify which `model_cache_loads_total` entry
emits it (`nlp_token_classifier` or `nlp_gliner2_guard`).
**D2.** Determine whether the checkpoint's `config.json` `model_type: "extractor"` is intended
(GLiNER2-style custom head) or a mis-published artifact in `s3://hope-models`.
**D3.** If intended, register the architecture explicitly so the warning is suppressed rather than
tolerated; if mis-published, correct the artifact and re-run the model publish chain.
An unresolved architecture warning on a *medical* NER path must not stay a permanent log fixture.

### Lane E — E-2 + E-3: capacity & observability (P2)

**E2a.** Re-measure NER latency after Lane A. Right-size `requests.cpu` from the measured steady
state (currently `500m` request vs `789m` observed) and raise `requests.memory` above the observed
946 MiB.
**E2b.** Prepare — do not action — an owner decision on a GPU slice for NLP, stating which of
LM Studio (4), STT (1) or STT-worker (1) would surrender one.
**E3a.** Alert on `nlp_inference_queue_wait_seconds` p95 and on probe-failure rate.
**E3b.** Add `nlp_inference_rejections_total{reason}` and Endpoints churn to the NLP dashboard, so
a repeat of §2.3 is visible as saturation rather than as a mystery 503.

---

## 5. Verification Criteria

| # | Criterion | Evidence required |
|---|---|---|
| V1 | NLP thread pool matches the cgroup quota | `torch.get_num_threads()` in-pod = configured value, not 48 |
| V2 | Throttling substantially reduced | `nr_throttled / nr_periods` well below the 12.2 % baseline; `throttled_usec` no longer exceeds `usage_usec` |
| V3 | **NER latency improved ≥ 5×** | `model_inference_latency_seconds` mean ≪ 20.3 s baseline |
| V4 | Probes stop failing | Zero `Unhealthy` events on the NLP pod over a comparable load run |
| V5 | Endpoints stable | `endpoints.kubernetes.io/last-change-trigger-time` unchanged across the run |
| V6 | Guardrail delegation succeeds | Zero `nlp_delegation.failed` / `503` on `/api/guardrail/analyze` |
| V7 | Internal auth works | `effective-config?service=nlp` and `…=guardrail` both **200**; no `service_registration.rejected` |
| V8 | Missing token fails closed | A pod with the key removed refuses to start (D-4 regression test) |
| V9 | Gates green | `pnpm nlp:test`, `nlp:lint`, `nlp:typecheck`, `stt:test`, `guardrail:test` |
| V10 | Overlay renders | `kustomize build deployment/k8s/overlays/dev` clean; all 8 deployment-repo CI jobs green |

Load profile for V3–V6: replay the same NER + Guardrail batch that produced this evidence, and
capture `/metrics` before and after.

---

## 6. Owner Decisions Required

| ID | Question | Blocking |
|---|---|---|
| **OD-1** | Approve rotating/adding `INTERNAL_ACCESS_TOKEN` in the live `hope-v2-dev` `hope-secrets` (C1) and re-applying it to strip the plaintext annotation (C5). Both touch a live Secret. | Lane C |
| **OD-2** | Confirm `optional: false` is the wanted posture — a service with no internal token must **fail to start** rather than serve compiled defaults (C2). | C2 |
| **OD-3** | NLP GPU: is surrendering a slice from LM Studio (4 units) acceptable, or does NLP stay CPU-only? Cluster is 6/6 allocated. | E-2 only |
| **OD-4** | Is `model_type: "extractor"` intended for the Medical-NER checkpoint, or a mis-published artifact? | Lane D |

---

## 6b. Agent Allocation (rule 14 — one writer per file, tier per stage)

Partitioned by **file ownership**, not by lane: lanes A5/B/C2 all write `base/nlp.yaml`, and
A2/A3/C3/D all write `apps/nlp/**`, so a naive per-lane fan-out would collide. The py-env helper
is folded into the NLP writer — they are a producer/consumer pair, and splitting them buys a
worktree and a merge round-trip to save minutes of sequential work.

| Agent | Exclusive scope (no path is owned twice) | Tier / effort | Worktree · branch |
|---|---|---|---|
| **A-core** | `packages/py-env/**`, `apps/nlp/**`, `turbo.json` — A1, A2, A3, C3(nlp) | **opus / high** | `hope-v2-task-892-core` · `task-892/core` |
| **A-guard** | `apps/guardrail/src/guardrail/main.py` + its tests — C3(guardrail) | **sonnet / medium** | `hope-v2-task-892-guardrail` · `task-892/guardrail` |
| **A-deploy** | deploy repo `base/*.yaml` ×8, `overlays/dev/kustomization.yaml`, `.gitlab/ci/**` — A5, B0, C2, C6 | **opus / medium** | `hope-v2-deployment-task-892` · `task-892/deploy` **off `c78cb89`** |
| **R-model** | read-only — D-5 checkpoint/architecture diagnosis | **sonnet / medium** | none (read-only fan-out is free) |

**Tier rationale.** *A-core* is opus/high because the thread configuration must execute before the
first torch import, and `apps/nlp/src/nlp/main.py` is a 27-line uvicorn launcher whose app lives in
`app.py` — wrong placement yields a silent no-op that still looks green; it is the stage whose
verdict every other lane rests on, so it is not downshifted. *A-deploy* is opus/medium: it must
rebase onto `c78cb89` without reverting it, and `overlays/dev/kustomization.yaml` is rewritten by
`promote-dev` (comments duplicate inside `patch:` literals). *A-guard* and *R-model* are sonnet
with tight briefs — one env assertion and one read-only diagnosis. **Review stays opus:** the
orchestrator reviews every diff before merging, and re-verifies artifacts rather than trusting
reports.

**Shared surfaces retained by the orchestrator:** merges, `pnpm install`, DB/infra commands, and
the live Secret (C1, owner-executed). No agent runs any of these.

**Merge targets (owner-confirmed 2026-09-07):** `hope-v2` → `dev-2.2`; `hope-v2-deployment` →
`main`, carrying `c78cb89` with it.

---

## 7. Implementation Summary

**Status: code merged to `dev-2.2`; deployment merge and C1 pending.** Four agents ran in
parallel per §6b with no file overlap and no merge conflicts.

### 7.1 Merged to `dev-2.2`

| Commit | Lane | Content |
|---|---|---|
| `4ff4fdafb` | A1 / E-1 | `hope_env.cpu` — cgroup-aware CPU allowance (v2 `cpu.max`, v1 `cfs_quota_us`, affinity, `os.cpu_count`), 20 tests |
| `c06ab3d2d` | A2, A3, C3 | NLP sizes torch from the cgroup; `NLP_TORCH_NUM_*` settings; fail-closed token assertion |
| `179f98d93` | review | **Correction:** gate on `DEPLOYMENT_ENVIRONMENT`, not `NODE_ENV` |
| `7819b127e` | C3 | Guardrail fail-closed token assertion |
| `9d3cd1970` | review | **Correction:** same gate fix for guardrail |

**Post-merge gates (re-run on `dev-2.2` after merging, not on the branches):**

```
pnpm py-env:test        → 112 passed
CI=true pnpm nlp:test   → 651 passed, 1 skipped, 3 deselected
pnpm guardrail:test     → 514 passed
pnpm nlp:lint / guardrail:lint / py-env:lint   → All checks passed!
pnpm nlp:typecheck      → Success: no issues found in 64 source files
pnpm guardrail:typecheck→ Success: no issues found in 45 source files
```

**Torch placement (A2), the highest-risk part.** The hook is at module scope in
`apps/nlp/src/nlp/__init__.py`, not `main.py` — the image `ENTRYPOINT` is
`python -m uvicorn --factory nlp.app:get_app`, so **`main.py` is never imported in the
container**, and a worker-count > 1 re-imports the app string per child. `__init__.py` is the one
module Python must execute before any `nlp.*` submodule on both paths. Proven by a subprocess test
that *discriminates*: with the hook neutered the same subprocess reports the host default (12), and
against the container's real entrypoint `torch.get_num_threads()` honours the setting.

### 7.2 The `DEPLOYMENT_ENVIRONMENT` correction (applies to BOTH services)

The original briefs said to gate on `NODE_ENV=production`. **That gate is inert in `hope-v2-dev`:**
`base/config/platform.env` sets `NODE_ENV=production`, but `overlays/dev/kustomization.yaml:429`
patches the generated ConfigMap to `NODE_ENV=development` — the live `hope-platform-config` reads
`NODE_ENV: development`. A pod with no token would have logged one line and served on
unauthenticated: today's behaviour exactly.

`DEPLOYMENT_ENVIRONMENT` is set in every deployed environment (base `production`, dev overlay
`dev`) and unset on a laptop. `CI` was dropped as a trigger — a CI *test* job is not a deployment.
A-core's `NODE_ENV=test` carve-out was kept and checked first (`.gitlab/ci/test.yml` sets
`NODE_ENV=test` **and** `CI=true` on every Python job).

Verified identically for both services:

```
dev cluster (real)     -> refuses to start: True
staging/prod (base)    -> refuses to start: True
GitLab CI test job     -> refuses to start: False
developer laptop       -> refuses to start: False
```

Consequence: A-core's reported risk *"this image will CrashLoop `hope-nlp` if promoted before C1"*
was **false** — it reasoned from `base/` without the dev overlay. There is no crashloop risk in
dev today, and the image is safe to promote before C1.

### 7.3 Ready in `hope-v2-deployment`, branch `task-892/deploy` (NOT merged)

Branched from `c78cb89`, which it preserves (`git merge-base --is-ancestor` passes; the overlay
file is byte-identical, 0 diff lines, so the `promote-dev` comment-duplication trap is sidestepped).

| Commit | Content | Safe to merge now |
|---|---|---|
| `6546081` | `OMP_NUM_THREADS`/`MKL_NUM_THREADS` on `hope-nlp` | ✅ |
| `64a5647` | `startupProbe` `timeoutSeconds: 5` (it had **none** — 1s default on the heaviest handler; `c78cb89` missed it) | ✅ |
| `213af0e` | `secret-keys` CI gate + key inventory | ✅ |
| `b4d20a2` | `optional: false` ×8 | ⛔ **after C1 only** |

Verified with `kubectl kustomize`: tip renders **8×** `optional: false`; `213af0e` renders **0×**
while still carrying the OMP fix — the Secret dependency is genuinely isolated in the tip commit.
`timeoutSeconds: 5` appears 21× (c78cb89 preserved).

**Two ticket errors this lane corrected, both on evidence:**
1. **A5 belongs in `base/`, not the overlay** (§4 said overlay). `base/stt.yaml:287` and
   `base/tts-v2.yaml:237` *already* ship `OMP_NUM_THREADS`/`MKL_NUM_THREADS`; NLP was the only
   PyTorch service without them. A container-unaware library default is wrong in every
   environment, so base is right — and it means every overlay including `eks/*` inherits the fix.
2. **§4 B4's "1s is copy-pasted across all four" was wrong.** `hope-stt` is already 5–10 s,
   `hope-tts` 5 s. Guardrail/text probes were deliberately left alone — guardrail holds zero
   resident model weights and text bans them via an enforced invariant.

**This also corrects §2.2:** STT escapes the 48-thread pathology because it *already ships
`OMP_NUM_THREADS=8` in base*, **not** because it holds a GPU slice. Its cgroup-blind
`os.cpu_count()` fallback is simply never reached. A4 remains worth doing but is not urgent.

### 7.4 OPEN CONFLICT — the auto-derived thread count is not the measured optimum

| Source | Value at a 4-CPU quota |
|---|---|
| `hope_env.cpu` (rounds quota **down**, clamps ≥1) | **4** |
| `base/nlp.yaml` `OMP_NUM_THREADS` (A-deploy) | **8** |
| §2.2 benchmark (measured at a 2-CPU quota) | 8 → 50.0 ms/layer · **4 → 96.5 ms/layer** |

The CFS quota caps CPU-*seconds per period*, not concurrency, and the node has 48 physical cores
for the parallel section to spread across — so the quota-matching value is not the fastest value.
A-core's precedence deliberately lets `OMP_NUM_THREADS` win over the derived value, so **8 wins
today** and the merged state is the fast one.

**Therefore A-core's follow-up #7 — "remove the interim overlay patch so the cgroup decides" — must
NOT be actioned as written**; it would halve throughput. Resolve with B5 (re-benchmark in-pod at
the 4-core limit) before changing either value.

### 7.5 New defects found during execution (not in the original register)

| ID | Pri | Finding |
|---|---|---|
| **D-8** | P1 | `stt`'s `/health/ready` makes a **blocking synchronous MinIO SDK call inside an `async def`** with no executor offload — it stalls the event loop for the full round-trip, on a probe. Same failure family as this ticket's incident. |
| **D-9** | P1 | `text`'s `/health/ready` makes outbound HTTP to the same LLM backends `/generate` uses, at `timeoutSeconds: 1` / `failureThreshold: 2` — two slow vLLM responses unpublish it. |
| **D-10** | P1 | **`apps/nlp` never configures logging on the container path.** `setup_logging()` is called only from `main.py`, which the ENTRYPOINT does not import; uvicorn configures only its own loggers, leaving root at WARNING. **Every `logger.info` from the app is dropped in the cluster** — which is why the pod logs are bare uvicorn access lines. V1 evidence must be an in-pod read, never a log grep. |
| **D-11** | P2 | No post-load assertion anywhere in the gliner2 guard / token-classifier paths — no `id2label`, output-dimension or `labelTaxonomy` check. An incompatible checkpoint would serve degraded medical NER/PII silently. |
| **D-12** | P2 | `hope-stt`'s probe paths are inverted: liveness *and* readiness both hit the heavy `/api/v1/health` (incl. D-8's blocking call) while the trivial `/health/live` is used only for startup. |
| **D-13** | P2 | `GUARDRAIL_SERVICE_TOKEN` and `HARNESS_INTERNAL_SERVICE_TOKEN` still carry the fail-open `optional: true` shape (same as D-3). |
| **D-14** | P3 | `scripts/generated/python-env-surface.json` was already stale on `dev-2.2` (missing `HF_HUB_CACHE` from TASK-890/F6); regenerated here. `overlays/orbstack` is never rendered by CI and can rot. |

### 7.6 D-5 resolved — OD-4 answered

Reproduced end-to-end against the installed packages: `gliner2_guard.py:110` → `gliner2`'s
`Extractor.from_pretrained` → `AutoTokenizer.from_pretrained` → `AutoConfig` raises on the unknown
`extractor` type → falls back to raw `PreTrainedConfig` whose `model_type` is `""` → the warning.

**Intended, not mis-published.** `"extractor"` is `gliner2`'s own `ExtractorConfig.model_type`, and
`checkpoint_family.py:39` already anticipates it. **Cosmetic** — the mismatched config is transient
tokenizer-resolution scaffolding, discarded before model construction; it never reaches the weights
or label map. Fix is one line at startup: `AutoConfig.register("extractor", ExtractorConfig)`. Do
not re-publish the artifact. The durable fix is upstream in `gliner2`.

*(Caveat: reproduced against `transformers==5.5.4` from the conda env; `uv.lock` pins 4.57.6/5.16.1
for the container build, so cited line numbers are unverified against the deployed image. The
fallback mechanism is stable across versions.)*

### 7.7 Remaining work

1. **C1 (owner):** add `INTERNAL_ACCESS_TOKEN` to live `hope-secrets`, then verify non-empty.
2. Merge `task-892/deploy` `213af0e` → `main` (safe now); merge `b4d20a2` only after step 1.
3. **B5:** re-benchmark threads in-pod at the 4-core limit; settle §7.4.
4. **V3–V6:** replay the NER + Guardrail batch, capture `/metrics` before/after.
5. Triage D-8 … D-14; re-open A4.

---

## 8. Change History

| Date | Author | Change |
|---|---|---|
| 2026-09-07 | Tap Huynh / Claude | **Pre-execution scan + agent allocation.** Found D-2 already implemented in the unmerged deployment commit `c78cb89` and never deployed (Argo tracks `main`, one commit behind) — Lane B demoted to a merge (§2.7, B0); confirmed it does NOT fix D-1, since the CPU limit 2→4 leaves the 48-thread pool intact. Deferred A4 (STT) on cross-ticket contention (§2.8). Recorded that Argo `prune` is now ON in `main`, making the CLAUDE.md note stale. Added §6b agent allocation: 3 writers + 1 reader partitioned by file ownership, tiers opus/high · sonnet/medium · opus/medium · sonnet/medium. Owner decisions: deploy branches off `c78cb89` → `main`; C1 Secret write is owner-executed. |
| 2026-09-07 | Tap Huynh / Claude | Ticket opened. Live read-only diagnosis of `hope-v2-dev` over the 09:15–09:23Z window: NER latency root-caused to PyTorch thread oversubscription against the container CPU quota (11.7× measured penalty, benchmark in §2.2); guardrail 503s root-caused to probe starvation unpublishing the NLP Service endpoint (§2.3); nlp+guardrail 401s root-caused to `INTERNAL_ACCESS_TOKEN` being absent from `hope-secrets` while bound `optional: true` (§2.5). Register of 7 defects + 3 enhancements (§3), 5 implementation lanes (§4), 10 verification criteria (§5), 4 owner decisions (§6). No code or cluster state changed. |
