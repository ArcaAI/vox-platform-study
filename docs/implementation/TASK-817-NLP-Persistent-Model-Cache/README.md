# TASK-817 — Persistent Model Cache for `hope-nlp`

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `infrastructure` |
| **Branch** | `dev-2.2` |
| **Follows** | [TASK-808](../TASK-808-Unblock-TEXT-Generation/README.md) §6.3 |
| **Depends on** | TASK-808's `apps/nlp/Dockerfile` fix being deployed (this ticket is the durability half) |
| **Blocks** | nothing |
| **Primary repo** | `arca/hope-v2-deployment` (manifests) — plus two small in-repo cleanups |

> **This is NOT a design task.** `hope-stt` and `hope-tts` already run the exact pattern in
> `hope-v2-dev` today. `hope-nlp` is the only weight-loading service that does not. The work is to
> apply the established pattern, not to invent one.

## 1. Requirement Analysis & Scope

### In scope
- Give `hope-nlp` a persistent HuggingFace cache, using the same `models-cache` volume +
  `init-hf-cache` initContainer that `hope-stt` and `hope-tts` already use.
- Remove the vestigial `HF_HOME` and its stale "mount a persistent volume" comment from
  `apps/guardrail/Dockerfile` (guardrail has held zero model weights since TASK-735 Phase 3).
- Reconcile `apps/stt/docker/Dockerfile`'s `HF_HOME` with the value the manifest actually applies —
  they currently disagree.

### Out of scope
- Migrating `models-cache` off `hostPath` to a real PV/PVC (see §5, OD-1 — needs an owner decision).
- Baking weights into images at build time (`snapshot_download` + `HF_HUB_OFFLINE=1`) — a separate
  trade-off, already noted as open in `apps/tts/Dockerfile`.
- Any change to `apps/nlp` model SELECTION. Which model loads is `AiTaskDefault` config
  (`09-infrastructure-devops.md` §No hardcoded configuration); this ticket only changes WHERE its
  bytes are cached.

## 2. Current State Evaluation

TASK-808 fixed the *correctness* half: `apps/nlp/Dockerfile` now sets
`HF_HOME=/app/.cache/huggingface` with a `mkdir -p` + `chown`, because `hope-python-base` creates the
`hope` user with `--no-create-home` and huggingface_hub's default `~/.cache/huggingface` was
therefore an uncreatable path (`PermissionError at /home/hope`).

That directory lives in the container's **writable layer**, so it dies with the pod. Every restart,
rollout, eviction and node reboot re-downloads `blaze999/Medical-NER` and every other NLP model from
huggingface.co. Consequences: slow and failure-prone cold starts on the FIRST `/classify/tokens`
after any restart, and a hard runtime dependency on an external host being reachable.

### The pattern already in production (verified against `hope-v2-dev`, 2026-08-26)

Both siblings mount the SAME host directory and both run the same idempotent chown initContainer:

| Service | Volume | Mount path | Cache env var | initContainer |
|---|---|---|---|---|
| `hope-stt` | `hostPath: /mnt/data/models-cache` | `/home/hope/.cache/huggingface/hub` | `HF_HOME` + `HUGGINGFACE_CACHE_DIR` (+ `HOME=/home/hope`) | `init-hf-cache` |
| `hope-tts` | `hostPath: /mnt/data/models-cache` | `/mnt/models-cache` | `HF_HUB_CACHE` | `init-hf-cache` |
| **`hope-nlp`** | **none** | — | image-only `HF_HOME` | **none** |
| `hope-guardrail` | n/a | — | `HF_HOME` in the image, **unused** | n/a |

The shared initContainer, verbatim from both manifests — note it is idempotent, so it costs nothing
on the common path:

```yaml
initContainers:
  - name: init-hf-cache
    image: busybox:1.36.1
    command: ['/bin/sh', '-c']
    args:
      - |
        [ "`stat -c %u /hf-cache`" = 1001 ] || chown -R 1001:1001 /hf-cache
    securityContext: { runAsUser: 0, runAsGroup: 0 }
    volumeMounts:
      - { name: models-cache, mountPath: /hf-cache }
volumes:
  - name: models-cache
    hostPath: { path: /mnt/data/models-cache, type: DirectoryOrCreate }
```

It exists because the volume is owned by root on first creation while the containers run as uid
1001 — the same `--no-create-home` / non-root constraint that caused the TASK-808 defect.

## 2a. Findings this ticket closes

| # | Finding | Evidence |
|---|---|---|
| F-1 | `hope-nlp` re-downloads every model on every pod restart | live Deployment `hope-nlp` has **no `volumes:` and no `volumeMounts:`**; `HF_HOME` comes only from the image, pointing into the writable layer |
| F-2 | `apps/guardrail`'s `HF_HOME` is dead configuration | `grep -rn 'from_pretrained\|snapshot_download\|hf_hub_download' apps/guardrail/src` → **zero hits**. TASK-735 Phase 3 moved GLiNER and MiniCheck to `apps/nlp`; `Dockerfile:74` and the `Dockerfile:19` comment ("Mount a persistent volume at /app/.hf-cache") both survived the move and now describe a service that loads nothing |
| F-3 | STT's image and manifest disagree on the cache location | `apps/stt/docker/Dockerfile:390` sets `HF_HOME=/models/hf-cache`; the live manifest overrides it to `/home/hope/.cache/huggingface`. Host env wins (`00-project-context.md` §Precedence), so the image value is inert and misleading — a reader debugging a cache miss is sent to the wrong path |
| F-4 | Three services, three different env vars and three mount paths for ONE shared directory | `HF_HOME` (stt) vs `HF_HUB_CACHE` (tts) vs `HF_HOME` (nlp, image-only); `/home/hope/.cache/huggingface/hub` vs `/mnt/models-cache`. All resolve to `hostPath: /mnt/data/models-cache`, so they already share a cache — but nothing states that, and the next service to be added has three precedents to copy |

## 3. Implementation Plan

| # | Task | Where | Verification |
|---|---|---|---|
| 1 | Add the `models-cache` volume + `init-hf-cache` initContainer to `hope-nlp`, mounting at the path `HF_HOME` already names | `arca/hope-v2-deployment` overlay | pod starts; `/app/.cache/huggingface` is the mount and is writable by uid 1001 |
| 2 | Decide nlp's mount path and state it — either mount at the image's `/app/.cache/huggingface`, or override the env in the manifest as stt/tts do. **Pick one and write down why**; do not leave a third undocumented convention (F-4) | manifest (+ Dockerfile comment) | the image value and the effective value agree, or the divergence is commented |
| 3 | Prove persistence: call `/classify/tokens`, restart the pod, call again — the second cold start must not re-download | live `hope-v2-dev` | no download in logs on the second start; second cold start measurably faster |
| 4 | Delete `HF_HOME` and the stale volume comment from `apps/guardrail/Dockerfile` (F-2) | this repo | `pnpm guardrail:test` green; guardrail still starts and serves |
| 5 | Reconcile `apps/stt/docker/Dockerfile:390` with the manifest value, or comment it as deliberately overridden (F-3) | this repo | stated in one place, agreeing with the manifest |
| 6 | Extend `apps/nlp/tests/test_hf_cache_writable_task808.py` (or add a sibling) so the guard also covers the persistence contract, not just writability | this repo | RED before, GREEN after |

### TDD note

Tasks 4–6 are code and carry the normal gate: failing test first, and you must SEE it fail
(`01-development-workflow.md` §Phase 4). Tasks 1–3 are manifest changes in another repo and are
verified against the running cluster instead — capture actual pod logs, not assertions.

## 4. Verification

```bash
# in-repo (tasks 4-6)
pnpm nlp:test
pnpm guardrail:test
pnpm lint
```

On `hope-v2-dev`, the load-bearing evidence for task 3:

1. `POST /api/v1/classify/tokens` → 200, and the logs show the model downloading.
2. `kubectl rollout restart deployment/hope-nlp` (orchestrator-owned).
3. `POST /api/v1/classify/tokens` again → 200, and the logs show **no download**.

Paste both log windows into §6. A restart that still downloads means the mount path and the
effective cache env var disagree — the single most likely way to get this wrong (F-4).

## 5. Open Decisions

- **OD-1 — `hostPath` is a single-node bet.** `/mnt/data/models-cache` works on the current
  one-node k3s and survives pod restarts, but not node replacement, and it silently breaks if a
  second node is ever added (a pod scheduled elsewhere gets an empty cache and re-downloads, with
  no error). Following stt/tts keeps `hope-nlp` consistent with its siblings *today*; converting all
  three to a PVC is the durable answer and is a separate, owner-level call. **Recommendation:**
  match the siblings now (consistency, ~zero risk), and open the PVC migration as its own ticket
  covering all three at once — a partial migration is strictly worse than either end state.
- **OD-2 — one shared cache directory across services.** stt, tts and (after this) nlp all write to
  the same host directory. The HF cache layout is content-addressed per repo id and huggingface_hub
  takes file locks, so concurrent use is safe and sharing saves disk on overlapping models. This is
  worth stating explicitly in the manifests, because it is currently true by accident rather than by
  declaration.

## 6. Implementation Summary
_Not started._

## 7. Change History
| Date | Change |
|---|---|
| 2026-08-26 | Opened from TASK-808 §6.3. Scope narrowed after verifying against `hope-v2-dev`: `hope-stt` and `hope-tts` already run the target pattern, so this is an application of it to `hope-nlp` rather than a new design. Added F-2 (guardrail's `HF_HOME` is dead since TASK-735 P3), F-3 (stt image/manifest disagree) and F-4 (three conventions for one directory), all found while confirming the pattern. |
