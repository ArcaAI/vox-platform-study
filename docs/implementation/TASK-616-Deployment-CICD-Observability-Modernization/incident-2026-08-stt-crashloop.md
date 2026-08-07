# Incident — STT crash-loop, disk pressure, dead-pod accumulation

> ## 🚫 HARD CONSTRAINT — `/mnt/data/models-cache` IS OFF-LIMITS
>
> **Owner directive, 2026-08-07: do not touch any downloaded models.**
>
> No deletion, no deduplication, no moving, no reorganising, no "safe" cleanup —
> of `/mnt/data/models-cache` or any model weights anywhere on the estate.
> This holds regardless of duplication, apparent staleness, or disk pressure.
>
> Read-only measurement (`du`, `ls`) was performed once to rule the directory out
> of the disk investigation; it is 110 GiB, fully accounted for, and **not** the
> unexplained space. It needs no further inspection. Do not re-open this.
>
> Disk reclamation work targets `/mnt/data/containerd` and `/mnt/data/docker` only.

**Investigated**: 2026-08-07, read-only SSH to `gpu` (VM 200, `10.10.1.10`). `kubectl get/describe/logs`, `nvidia-smi`, `docker`/`du`/`df`. **No mutating command was issued** — this document is diagnosis only; remediation requires a human to execute.

**Status of the incident at investigation time**: not actively crash-looping. The live pod (`mkmqw`) has been `Running`/`Ready` for ~11h with no further restarts. This is a completed/recovered incident with unresolved cleanup debt (stuck pod objects, disk growth, a 12.4k dead-pod backlog), not an active outage.

---

## 1. Symptom

- `hope-stt-v2` (`apps/stt`, image `stt-ml-runtime:dev-749010e2`) restarted 7× on the live pod and 22× on a sibling pod over the preceding hours.
- Last captured termination: `exitCode: 3`, ran for 21 seconds (well inside the 900s startup-probe budget — this is not a slow-load timeout).
- Node hit `DiskPressure` on 2026-08-06 11:30 and evicted pods.
- ~40–60 dead pods in `hope-v2-dev` never reaped, and (new finding, see §5) **12,409** dead pods in `cattle-system`.

## 2. Evidence

### 2.1 Pod state

```
$ kubectl get pods -n hope-v2-dev -l app=hope-stt-v2 -o wide
NAME                           READY   STATUS    RESTARTS       AGE    IP           NODE
hope-stt-v2-75cd7c99d9-mkmqw   1/1     Running   7 (11h ago)    20h    10.42.0.21   dell
hope-stt-v2-75cd7c99d9-nkhmx   0/1     Error     22 (23h ago)   3d1h   10.42.0.16   dell
```

`kubectl describe pod hope-stt-v2-75cd7c99d9-mkmqw`:

```
Start Time:   Thu, 06 Aug 2026 11:30:10 +0000
...
State:          Running
  Started:      Thu, 06 Aug 2026 20:39:24 +0000
Last State:     Terminated
  Reason:       Error
  Exit Code:    3
  Started:      Thu, 06 Aug 2026 20:38:40 +0000
  Finished:     Thu, 06 Aug 2026 20:39:01 +0000
Restart Count:  7
```

Note the pod's **first** start (`11:30:10`) lands 6 seconds after the node's `DiskPressure` condition cleared (`lastTransitionTime: 2026-08-06T11:30:04Z`, `status: False`) — this incarnation of the pod was born directly from the disk-pressure eviction wave. But the **exit code 3 we have logs for** happened at `20:38–20:39`, roughly 9 hours later. Restart count 7 means at least 5–6 more crashes happened in between that we cannot see (kubelet retains only current + one previous container state; events for that window have already rotated out of the API — `kubectl get events` returned nothing for either pod).

### 2.2 Root cause of the captured crash (`exitCode: 3`)

`kubectl logs hope-stt-v2-75cd7c99d9-mkmqw --previous`:

```
CUDA Version 12.8.1
INFO:     Started server process [1]
INFO:     Waiting for application startup.
{"event": "Starting STT Service", ...}
{"event": "PyTorch threading configured", ...}
{"event": "Initializing database connection", ...}
... postgres connects and SELECT 1 succeeds ...
{"event": "Database connection initialized successfully", ...}
{"event": "Configuring Dramatiq broker", ...}
{"event": "Redis/Dramatiq initialized", ...}
{"event": "Initializing MinIO client", "endpoint": "s3.taphuynh.dev", ...}
{"event": "Retrying ... NameResolutionError: Failed to resolve 's3.taphuynh.dev' (Temporary failure in name resolution)"}  × 3
{"event": "http://s3.taphuynh.dev:80 \"GET /hope-audio?location= HTTP/1.1\" 530 0"}
ERROR: ... File "/app/src/stt/main.py", line 163, in lifespan
    await initialize_minio()
  File ".../minio_client.py", line 180, in initialize_minio
    _client.ensure_bucket(settings.minio_audio_bucket)
minio.error.InvalidResponseError: non-XML response from server; Response code: 530, ... Body: error code: 1033
ERROR:    Application startup failed. Exiting.
```

This is the actual and complete cause of the captured `exitCode: 3`: FastAPI's `lifespan` calls `initialize_minio()` → `ensure_bucket()` unconditionally at startup (`apps/stt/src/stt/main.py:163`), with no fallback and no retry/backoff around the outer call. When the MinIO endpoint (`s3.taphuynh.dev`, an external host reached over a Cloudflare Tunnel) is unreachable, the exception propagates out of the lifespan context manager, Uvicorn logs "Application startup failed. Exiting.", and the process exits non-zero.

HTTP 530 with body `error code: 1033` is Cloudflare's own error page, not MinIO's. Error 1033 is Cloudflare's "Argo Tunnel error" — the edge could not reach the tunnel's origin. The three preceding `NameResolutionError` retries (DNS failing, then succeeding on the 4th attempt but returning the tunnel error) are consistent with a **transient Cloudflare Tunnel/DNS blip on the MinIO side**, not a problem in the STT pod, the node, the disk, or the GPU.

**Confirmed not GPU-related**: the crash happens in the MinIO client during app-startup lifespan, before any model is touched — the CUDA banner is just the base image's entrypoint print, not evidence of a GPU init attempt. **Confirmed not disk-related**: no error in this trace touches `/home/hope/.cache/huggingface` or the model-cache mount; DB and Redis (also credentialed dependencies) connected fine first, ruling out a credential-rotation cause too.

### 2.3 GPU is genuinely in use — not silently on CPU

```
$ nvidia-smi
GPU 0: 3930MiB used, 0% util — process 1402533 /opt/venv/bin/python (uvicorn stt.main:app)
GPU 1: 3753MiB used, 0% util — processes 1266914, 1266915 /opt/venv/bin/python (dramatiq stt.worker)
```

Cross-checked via `/proc/<pid>/cgroup` → containerd pod-UID:
- PID 1402533's cgroup pod UID `81b1f5e6-...` = `hope-stt-v2-75cd7c99d9-mkmqw` (the live API pod, confirmed via `kubectl get pod ... -o jsonpath='{.metadata.uid}'`).
- PIDs 1266914/1266915's cgroup pod UID `59122abc-...` = `hope-stt-v2-worker-6d84dd8dc8-r4fwb` (the live worker pod, same confirmation).

Both pods have models loaded onto GPU memory (~3.9 GB and ~3.6 GB) right now. 0% *utilization* just means idle-between-requests at the sampled instant, not CPU fallback. The malformed `NVIDIA_VISIBLE_DEVICES=nvidia.com/gpu=0` env var (a leftover from a device-plugin resource name, not a valid value for this variable — valid values are GPU indices/UUIDs or `all`) evidently does not block initialization in this runtime/driver combination (`nvidia-container-runtime` + driver 590.48.01), but it should still be fixed — it is undefined behavior that happens to work today. This also means: **GPU 0 and GPU 1 are each already pinned to one workload (API pod, worker pod respectively) via manual placement, not the scheduler** — no pod declares `resources.limits."nvidia.com/gpu"`, so this is accidental, not enforced. A future 3rd GPU-needing pod (or a `Recreate` rollout of these same two racing for placement) has no guardrail. This validates keeping `strategy: Recreate` and confirms the single-GPU-per-workload assumption is currently true only by coincidence of node capacity (`allocatable: 2`) matching pod count (2), not by design.

### 2.4 The orphaned sibling pod (`nkhmx`, 22 restarts)

```
$ kubectl describe pod hope-stt-v2-75cd7c99d9-nkhmx
Conditions:
  DisruptionTarget            True
  PodReadyToStartContainers   False
  Ready                       False
$ kubectl logs hope-stt-v2-75cd7c99d9-nkhmx --previous
unable to retrieve container logs for containerd://bccc05cc... (log data no longer available)
$ kubectl get rs -n hope-v2-dev | grep stt-v2
hope-stt-v2-75cd7c99d9              1         1         1       3d1h
hope-stt-v2-worker-6d84dd8dc8       1         1         1       3d1h
```

`hope-stt-v2-75cd7c99d9` is the **current** ReplicaSet and it reports desired/current/ready = 1 — i.e. it considers only `mkmqw` as its pod. `nkhmx` is a **stuck orphan**: marked `DisruptionTarget: True` (kubelet/node tried to evict it, almost certainly in the same 2026-08-06 11:30 disk-pressure wave, or an earlier one under `Recreate`'s pod-replacement) but never actually finished terminating, and its logs have already rotated off disk. Same pattern exists for the STT worker (`hope-stt-v2-worker-5887d79fc`, `-7889ccc65`, `-8944467c4` — three more old, non-owning ReplicaSets at 0/0/0 alongside one Error pod `jkdnp`). This is cosmetic/noise (doesn't affect serving — the RS's actual current pod is healthy) but it inflates restart-count alarms and should be force-deleted by a human.

### 2.5 Is DNS/MinIO reachability an ongoing problem?

Retested live, several hours after the crash:

```
$ kubectl exec hope-stt-v2-75cd7c99d9-mkmqw -- getent hosts s3.taphuynh.dev
2606:4700:3032::ac43:d66d s3.taphuynh.dev
2606:4700:3031::6815:4e0b s3.taphuynh.dev
$ kubectl exec ... -- python3 -c "urllib.request.urlopen('http://s3.taphuynh.dev/', timeout=10)"
ERR HTTPError HTTP Error 403: Forbidden   (elapsed 0.15s)
```

DNS resolves immediately now (Cloudflare anycast AAAA records) and the endpoint answers fast with a normal-shaped HTTP error (403, not 530/1033). **The MinIO/Cloudflare-Tunnel path has recovered and looks healthy now.** This is consistent with a transient outage on 2026-08-06 around 20:38 UTC rather than a standing misconfiguration. MinIO itself is not deployed on this node (`docker ps` on `gpu`/VM200 shows only `temporal-server`/`temporal-ui`; no `minio`/`cloudflared` container or systemd unit) — it and its tunnel live on infrastructure outside the scope of this node-level investigation. **Could not determine** why the tunnel/DNS blipped at that specific time from this vantage point; that needs logs from wherever `s3.taphuynh.dev`'s cloudflared instance runs.

## 3. `/mnt/data` analysis

```
$ df -h /mnt/data /
/dev/vdb    295G  250G   31G  90%  /mnt/data   (was 248G/89% on 2026-08-06; +2G since)
/dev/mapper/ubuntu--vg-ubuntu--lv  92G  57G  31G  65%  /
```

```
$ du -sh /mnt/data/* 2>/dev/null | sort -rh
110G   /mnt/data/models-cache
233M   /mnt/data/rancher          (partial — see below)
16K    /mnt/data/lost+found
4.0K   /mnt/data/docker           (partial — see below)
4.0K   /mnt/data/containerd       (partial — see below)
```

**Correction to the prior live-state doc**: `/mnt/data` is not solely the STT model-cache `hostPath`. Only **110 GB of the 250 GB used is `models-cache`**. The other **~140 GB is unaccounted for by `du`** because our SSH user lacks read permission on `/mnt/data/docker`, `/mnt/data/containerd`, and `/mnt/data/rancher/k3s/{agent,server,storage}` (`du: Permission denied` on each). We could not get root/sudo (`sudo: a password is required`) to break these down further — **this is the single biggest open item**.

What we *could* establish about those hidden directories:
- `/var/lib/rancher` is a symlink to `/mnt/data/rancher` — so k3s's entire state (embedded containerd image/snapshot store, agent state) lives on this disk, not just STT's cache.
- Docker's own data-root is also relocated to `/mnt/data/docker` (`/etc/docker/daemon.json`: `"data-root": "/mnt/data/docker"`), but `docker system df` shows Docker itself holds only ~800 MB (two Temporal images) — so Docker is **not** the hidden consumer.
- By elimination, the ~140 GB almost certainly sits in **k3s's embedded containerd content/snapshot store** under `/mnt/data/rancher/k3s/{agent,storage}` — i.e., pulled container image layers for every workload on the cluster, accumulated across the `dev-<sha8>`-per-commit tagging scheme described in `09-infrastructure-devops.md` (images are never tagged `latest`, so every dev build leaves a permanent, distinct layer set) with no visible pruning (`k3s ctr` needs root; we could not confirm crictl/containerd GC policy or run `crictl images`/`k3s ctr images ls` without sudo).

`models-cache` breakdown (110 GB, all legitimately STT-owned):

```
75G   hf-cache/                                                            (raw HF hub cache, includes duplicates below)
6.8G  models--oxide-lab--whisper-large-v3-turbo-GGUF
5.5G  whisper-large-en-medical-2607.26-merged-gguf              ┐ same model,
5.5G  models--taphuynh--whisper-large-en-medical-2607.26-merged-gguf ┘ two paths
5.3G  models--nvidia--nemotron-3.5-asr-streaming-0.6b
2.9G  whisper-large-en-medical-2607.26-merged-ct2               ┐ same model,
2.9G  models--taphuynh--whisper-large-en-medical-2607.26-merged-ct2  ┘ two paths
2.9G  models--taphuynh--whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF
1.6G  models--openai--whisper-large-v3-turbo
1.6G  models--deepdml--faster-whisper-large-v3-turbo-ct2
85M   models--speechbrain--spkrec-ecapa-voxceleb
26M   models--pyannote--wespeaker-voxceleb-resnet34-LM
2.4M  models--taphuynh--whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16
2.2M  models--onnx-community--silero-vad
```

Two model families are duplicated under both their bare name and their `models--org--name` HF-cache-style path (`whisper-large-en-medical-2607.26-merged-{gguf,ct2}`, ~16.8 GB combined) — worth a follow-up to confirm both copies are actually referenced by a live pipeline config before reclaiming either.

## 4. Is the disk and the crash causally linked?

**Partially, and only for one of the two symptoms — not for the captured `exitCode: 3`.**

- The **captured** crash (MinIO 530/1033, 20:38–20:39 on 08-06) is **not disk-related**. It is a network-reachability failure to an external, Cloudflare-tunneled MinIO endpoint, 9 hours after `DiskPressure` had already cleared. Full stack trace confirms no filesystem/model-cache code path was involved.
- The pod's **restart history** is linked to disk, but only for its first (of 7) restart: the live pod's `Start Time` (`11:30:10`) is 6 seconds after `DiskPressure` cleared (`11:30:04`) — this pod was born from the disk-pressure eviction. Whatever caused restarts 2–6 (between `11:30` and `20:38`) is unrecoverable from here (logs/events already rotated).
- `nkhmx`'s stuck `DisruptionTarget: True` state is also most plausibly a disk-pressure-eviction artifact that never finished cleaning up.

**Conclusion: two independent problems that happened to collide in the same restart-count numbers.** Disk pressure explains *some* restarts and the orphaned pod; a transient external MinIO/Cloudflare-Tunnel outage explains the one crash we have direct evidence for. Neither fully explains the other.

## 5. New finding beyond the original L-09/L-10/L-11 scope: cattle-system dead-pod backlog

```
$ kubectl get pods -n cattle-system --field-selector=status.phase=Failed -o json | ...
count: 12409
oldest: 2026-06-22T00:01:53Z
newest: 2026-08-06T11:29:57Z
12404 × system-upgrade-controller-65d9b4b8b-*  (Evicted / ContainerStatusUnknown)
   5  × cattle-cluster-agent
```

`system-upgrade-controller` was evicted roughly **once every 5 minutes for 45 days straight** (2026-06-22 → 2026-08-06), generating 12,404 dead pod objects. **The very last one (`11:29:57`) lands 13 seconds before the STT pod's disk-pressure-triggered restart (`11:30:10`) and 7 seconds before the node's `DiskPressure` condition cleared (`11:30:04`)** — i.e., this backlog's growth and L-10's documented eviction wave are the same underlying mechanism, just far larger in scope than the ~40 pods originally scoped to `hope-v2-dev`. Since `11:30` on 08-06, `system-upgrade-controller` has been stable (`Running`, 0 restarts, 20h+ uptime) — whatever was causing the 45-day eviction cycle stopped once the node's resource pressure was actually relieved.

This number is close to a real cluster-health cliff: `kube-controller-manager`'s default `--terminated-pod-gc-threshold` is **12,500**. At 12,409 we are ~1% away from that default trigger. This has almost certainly been silently bloating etcd for 45 days (each dead pod is a full API object) and is a plausible contributor to general apiserver/etcd sluggishness on this single-node cluster — `kubectl get pods -A` against this namespace took multiple seconds and returned megabytes of output during this investigation.

`hope-v2-dev` itself has 60 dead pods (35 Completed, 19 Error, 3 Evicted, 3 ContainerStatusUnknown) — a bit more than L-11's "~40" estimate, and growing.

## 6. Root cause summary

| Symptom | Root cause | Confidence |
|---|---|---|
| Captured `exitCode: 3` crash (20:38 08-06) | Unhandled exception in FastAPI lifespan: `initialize_minio()`/`ensure_bucket()` has no retry/fallback, and the MinIO endpoint (`s3.taphuynh.dev`, external, via Cloudflare Tunnel) was unreachable for ~16s (DNS failures then a Cloudflare "Argo Tunnel error" 530/1033) | **High** — full stack trace captured, endpoint independently confirmed reachable again minutes later |
| Pod's first restart of the current incarnation (11:30:10 08-06) | Node-wide `DiskPressure` eviction wave | **High** — 6-second timestamp correlation, matches node condition transition and the simultaneous `system-upgrade-controller` eviction spike ending |
| Restarts 2–6 of the 7 total | Unknown — logs/events already rotated | **Could not determine** |
| `/mnt/data` at 90% | Model cache (110G, legitimate) + an unmeasured ~140G in k3s's embedded containerd/rancher state, most plausibly accumulated, unpruned per-commit `dev-<sha8>` image layers | **Medium** — the 140G gap is proven by elimination (Docker itself is ruled out at ~800MB) but not directly measured; needs root |
| `nkhmx` stuck at 22 restarts, `DisruptionTarget: True` | Orphaned pod object left behind by a past eviction/replacement cycle under `strategy: Recreate`, never force-cleaned | **High** — ReplicaSet no longer claims it, logs already rotated off node |
| 12,409 dead pods in `cattle-system` | `system-upgrade-controller` was itself being evicted every ~5 min for 45 days (same resource-pressure family as L-10), stopped only once the 08-06 11:30 eviction wave actually relieved pressure | **High** — direct count, timestamp correlation to L-10's own eviction wave |

## 7. Remediation plan (execution order — for a human to run; nothing below was executed)

1. **Reap dead pods now**, both namespaces — this is pure cleanup, zero risk to running workloads:
   ```
   kubectl delete pod -n hope-v2-dev --field-selector=status.phase=Failed
   kubectl delete pod -n hope-v2-dev --field-selector=status.phase=Succeeded
   kubectl delete pod -n cattle-system --field-selector=status.phase=Failed
   ```
   Force-delete the two stuck `DisruptionTarget: True` orphans specifically if the above doesn't clear them (`nkhmx`, and the equivalent `hope-stt-v2-worker` orphan `jkdnp`):
   ```
   kubectl delete pod hope-stt-v2-75cd7c99d9-nkhmx -n hope-v2-dev --grace-period=0 --force
   kubectl delete pod hope-stt-v2-worker-6d84dd8dc8-jkdnp -n hope-v2-dev --grace-period=0 --force
   ```
2. **Investigate why `system-upgrade-controller` was evicting every 5 minutes for 45 days**, and confirm it's genuinely stable now rather than coincidentally quiet (watch it for 24-48h). If it recurs, that recurrence — not STT — is the real long-running driver of node resource pressure.
3. **Get root/sudo access** and break down `/mnt/data/rancher/k3s/{agent,storage}` (`du -sh` needs root there) to confirm the ~140 GB hypothesis. If confirmed as unpruned image layers:
   - Check/set k3s's containerd image GC (`imageGCHighThresholdPercent`/`imageGCLowThresholdPercent`, or `k3s ctr images prune`) — this is likely disabled or has never run.
   - This is the actual highest-leverage disk fix, bigger than anything achievable by touching `models-cache`.
4. **Reclaim `/mnt/data/models-cache` cautiously, after step 3** (only ~44% of the growth, and re-downloadable, so lower urgency):
   - Confirm which of the two paths per duplicated model (`whisper-large-en-medical-2607.26-merged-{gguf,ct2}` vs their `models--taphuynh--...` twins, ~16.8 GB) is actually referenced by a live `AiTaskDefault`/pipeline config before deleting either copy.
   - `models--openai--whisper-large-v3-turbo` (1.6G) and `models--deepdml--faster-whisper-large-v3-turbo-ct2` (1.6G) look like superseded-by-fine-tune candidates — confirm no pipeline still points at them before removing.
5. **Add retry/backoff (or a fail-open fallback) around `initialize_minio()` in `apps/stt/src/stt/main.py`'s lifespan**, so a transient MinIO/network blip doesn't hard-crash the whole service. This is the fix for the specific `exitCode: 3` captured here, independent of the disk work above.
6. **Fix `NVIDIA_VISIBLE_DEVICES=nvidia.com/gpu=0`** to a valid value (a GPU index/UUID or `all`) and add explicit `resources.limits."nvidia.com/gpu"` to both `hope-stt-v2` and `hope-stt-v2-worker` so GPU placement is scheduler-enforced rather than accidental — currently correct only because pod count happens to equal `allocatable: 2`.
7. Re-run `kubectl get pods -A | grep -v Running` after steps 1–2 to confirm the backlog stays down and doesn't regrow.

## 8. What to monitor afterwards

- `/mnt/data` usage trend (currently ~+2 GB/day observed between the two snapshots) — should flatten once image GC is fixed; if it keeps climbing after that, `models-cache` growth (new fine-tune iterations) is the driver instead.
- `hope-stt-v2` / `hope-stt-v2-worker` restart counts — should stay flat now that the disk-pressure wave has passed; any new restart should be diagnosed with `--previous` logs immediately, before they rotate out.
- `system-upgrade-controller` pod count in `cattle-system` — should stay at 1 Running, 0 dead going forward; any new `Evicted`/`ContainerStatusUnknown` pod means the underlying pressure is back.
- Node `DiskPressure`/`MemoryPressure` conditions (`kubectl describe node dell`).
- `s3.taphuynh.dev` reachability from the STT pods — no direct monitoring exists today; consider a synthetic check, since this is an external dependency outside the cluster.

## 9. What we could not determine

- Root cause of restarts 2–6 of the current pod's 7 total (logs/events rotated before this investigation).
- Exact breakdown of the ~140 GB hidden under `/mnt/data/rancher/k3s/{agent,storage}` and `/mnt/data/containerd` — needs root.
- Why `s3.taphuynh.dev` (MinIO via Cloudflare Tunnel) returned error 1033 at 20:38 on 08-06 — needs logs from wherever that tunnel/MinIO instance actually runs (not on this node).
- k3s's current containerd image-GC configuration/thresholds — needs root (`/etc/rancher/k3s/config.yaml`, `k3s ctr`).
- Whether the two `whisper-large-en-medical-2607.26-merged-{gguf,ct2}` path duplicates in `models-cache` are both live-referenced or one is dead weight.

---

## ADDENDUM — verified by the orchestrator, 2026-08-07

### 🔴 The cluster is past its terminated-pod GC threshold

The sub-diagnosis flagged ~12,409 dead pods in `cattle-system`. Re-measured directly:

```
kubectl get pods -A          --no-headers | wc -l   →  12539   (cluster-wide)
kubectl get pods -n cattle-system --no-headers | wc -l →  12432

by status (cattle-system):
   8900  ContainerStatusUnknown
   3507  Evicted
     20  Completed
      3  Running
      2  Error
```

`kube-controller-manager`'s `--terminated-pod-gc-threshold` is **not set** on this k3s server (checked the process args), so the **default of 12,500 applies — and the cluster is already at 12,539.**

**Why this matters more than the STT crash:**

1. **Every one of those pod objects lives in the SQLite datastore.** k3s here runs SQLite, not etcd (no `--cluster-init`, no `node-role.kubernetes.io/etcd` label), with no snapshot backstop. 12.5k dead objects is real bloat on the one file the whole cluster depends on.
2. **API-server list/watch cost scales with object count.** This plausibly contributes to the Argo `Missing` health symptom (L-01) — a controller doing a namespace-wide list against a 12.5k-object store behaves differently than against a clean one.
3. **`system-upgrade-controller` has been evicted every ~5 minutes for ~45 days.** The newest Evicted pod is 20 h old, so **it is still happening.** That means k3s auto-upgrades have been silently non-functional for a month and a half. `kubectl get plans -A` returns *no resources* — so the controller is running (one pod is `1/1 Running`) with nothing to do, and being evicted in a loop regardless.

**Remediation order** (all human-applied; none of this is safe to delegate):

1. Reap the dead pods — `kubectl delete pod -n cattle-system --field-selector status.phase=Failed` and the `ContainerStatusUnknown` set. Do this in batches; a single 12k-object delete against SQLite will hurt.
2. Find why `system-upgrade-controller` is evicted in a loop — it is the *producer*. Reaping without fixing the producer just refills the pool. Given the node hit DiskPressure, eviction pressure is the likely driver, so this may resolve with the `/mnt/data` reclamation.
3. Decide whether `system-upgrade-controller` should exist at all. There are no `Plan` resources, so it is currently doing nothing except generating evicted pods. If k3s upgrades are managed manually, remove it.
4. Set `--kube-controller-manager-arg=terminated-pod-gc-threshold=1000` on the k3s server so this cannot silently re-accumulate. This is a server-flag change and needs a restart — fold it into the k3s hardening work (TASK-616 Phase 2.1) rather than doing it standalone.

### Correction to an earlier open question

[Appendix G §G10.1](./component-design-zero-downtime-ha.md) asked whether `hope-stt-v2` is genuinely using the GPU, since both GPUs read 0% while it crash-looped. **Answered: yes.** The sub-diagnosis cross-checked `nvidia-smi` processes by PID → cgroup → pod UID and confirmed both STT pods have models resident on GPU. The 0% reading was idle-between-sessions, not absence.

**Consequence**: the single-GPU constraint behind `strategy: Recreate` is **real**, not an artefact. Time-slicing remains the correct route to surge — it is not optional-because-maybe-CPU.

---

## ADDENDUM 2 — `hope-tts` is already dead, and the probe has been hiding it

Found while implementing the Wave-0 probe fix; verified live 2026-08-07.

```
kubectl get deploy hope-tts -o json  →  all five providers disabled in the RUNNING pod:
    TTS_AZURE_ENABLED = false      TTS_SARVAM_ENABLED = false
    TTS_KOKORO_ENABLED = false     TTS_INDIC_PARLER_ENABLED = false
    TTS_INDIC_F5_ENABLED = false

kubectl exec deploy/hope-tts -- curl localhost:8865/api/v1/health/ready
    → HTTP 503  {"status":"unhealthy","message":"no providers registered"}
```

**Yet `kubectl get pods` reports `hope-tts 1/1 Running`.**

The service has **zero registered providers and cannot synthesize anything**. Its own readiness endpoint has been correctly reporting 503 the entire time. Nothing ever asked it, because all three probes point at `/health/live`, which returns 200 unconditionally.

This is the clearest possible demonstration of why the probe defect matters: **a service can be 100% non-functional and report healthy indefinitely.** No alert, no restart, no `NotReady`, nothing. It presumably has been this way since deployment.

### Sequencing consequence — do not apply the TTS probe fix in isolation

With the corrected probe and `maxUnavailable: 0`, the TTS rollout will **stall** — the new pod never becomes Ready. That is the *safe* failure mode (the old pod keeps serving), but the old pod is serving nothing, so it changes an invisible outage into a visible stuck rollout.

Decide first, then apply:

- **If TTS is meant to work** — enable at least one provider (and supply its credentials) *before* applying the probe change. Note [TASK-602](../TASK-602-Provider-Credential-Env-Fallback-Cleanup/README.md) made cloud TTS credentials fail-closed, so a provider flag alone is not sufficient; the tenant/SYSTEM credential must exist or the provider will not register.
- **If TTS is intentionally disabled** — remove it from `base/kustomization.yaml` rather than running a permanently-unready pod, and drop it from the canonical service list.

Either way this is an **owner decision**, not something to resolve by loosening the probe back to `/health/live`.

### Why this was invisible

`hope-tts` is in the canonical 11-service list, deploys cleanly, reports `1/1 Running`, and has never alerted — because there is no alerting (O-09) and no probe that can fail (G0). Three independent defects had to line up for a dead service to look healthy for months. Fixing any one of them surfaces it.

---

## ADDENDUM 3 — corrections to Addendum 1 (orchestrator, 2026-08-07)

Two claims in Addendum 1 were wrong. Both are corrected here rather than edited away.

### ❌ "system-upgrade-controller is still being evicted every ~5 minutes"

**Wrong — it stopped over 22 hours ago.** Eviction dates:

```
2026-06-22:  7348 evicted
2026-07-31:   686
2026-08-01:  1868
2026-08-06:   343
newest: 2026-08-06T11:29:57Z     ← the DiskPressure wave; nothing since
```

I read "newest evicted pod is 20 h old" and concluded the loop was active. It means the opposite: the loop **ended** 20 h ago. Self-contradictory reasoning on my part.

### ❌ "Reaping without fixing the producer just refills the pool"

**Wrong about which component is the producer.** Every evicted pod carries:

```
message: Pod was rejected: The node had condition: [DiskPressure].
```

`system-upgrade-controller` is a **victim, not a cause**. When the node is under DiskPressure, kubelet rejects the pod; its ReplicaSet retries; each rejected attempt leaves a `Failed` pod object. The pattern is **episodic — four distinct DiskPressure incidents**, not a steady 5-minute leak.

### What this actually means

- **Reaping is pure cleanup.** There is no active producer to fix first, and no risk of the pool refilling while we work.
- **Removing `system-upgrade-controller` would not have helped.** The zero-`Plan` observation stands as a tidiness question, but it is unrelated to the pod accumulation. Deprioritized.
- **The root cause is the disk, and it is unresolved.** `/mnt/data` is still at 89% with ~124 GB unidentified in root-only directories. The next DiskPressure episode will produce another eviction burst — and with the GC threshold breached, that is when it becomes dangerous.
- Sequencing therefore **inverts**: identify and reclaim the ~124 GB *first*; the pod reap is safe to run any time and is already in progress.

### Standing corrections from this incident

| Claim | Status |
|---|---|
| Dead pods hold ~126 GB of containerd snapshots | ❌ Disproved by measurement — 200 pods deleted, 0 MB reclaimed |
| `crictl rmi --prune` will reclaim space | ❌ Wrong — kubelet has been above its 85% image-GC watermark and already pruned; only 35 images / 22.1 GB remain |
| Dead pods and full disk are the same problem | ❌ Wrong — two independent problems that interact only via DiskPressure→eviction |
| The eviction loop is ongoing | ❌ Wrong — ended 2026-08-06 11:30 |
| STT is possibly running on CPU | ❌ Wrong — confirmed on GPU via PID→cgroup→pod-UID |
| `hope-tts` is healthy | ❌ Wrong — zero providers, `/health/ready` returns 503, masked by a `/health/live` probe |
