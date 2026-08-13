# TASK-616 Appendix E — Configuration Plane Design

**Date**: 2026-08-07 · **Status**: Draft for owner decision — nothing applied.
Covers the ConfigMap architecture, the 7 drifted keys, CI guardrails, and a safe `selfHeal` enablement order.

---

## E1. Why the drift happened — the root cause, not just the symptom

The seven untracked keys are not random hand-edits. **Two of them are the fix someone applied to stop harness crash-looping**, and the crash is still latent in Git today.

Verified 2026-08-07:

```
deployment/k8s/base/harness.yaml:42-43   →  - name: HARNESS_ENVIRONMENT
                                              value: production
grep -rn HARNESS_ENVIRONMENT overlays/   →  NONE — base applies to all three environments
```

So `hope-v2-dev` runs harness as a **deployed** environment. In `apps/harness/src/harness/core/config.py`, `_DEPLOYED_ENVIRONMENTS = {"production","prod","staging"}` and the `_reject_memory_claim_check_outside_dev` model validator **raises `ValueError` at `Settings()` construction** — which happens at FastAPI boot (`main.py:67`) and again in `run_worker()` — if `HARNESS_CLAIM_CHECK_STORE` resolves to its code default `"memory"` while `HARNESS_CLAIM_CHECK_ENABLED` is true (default `True`).

**That is a crash-loop, not a soft degrade.** Someone hit it, hand-patched `HARNESS_CLAIM_CHECK_STORE=s3` into the live ConfigMap, and never committed it. The drift is a scar from an incident.

Consequence for sequencing: `HARNESS_CLAIM_CHECK_STORE` is the one key whose absence does **not** fail safe. It must be in Git *before* `selfHeal` is flipped, or the flip itself recreates the original outage.

### A further latent defect this exposes

`HARNESS_CLAIM_CHECK_STORE = s3` is set live — but the credentials it needs are **not**. Verified against the live `hope-secrets`:

```
present:  MINIO_ACCESS_KEY, MINIO_ENDPOINT, MINIO_SECRET_KEY
absent:   HARNESS_CLAIM_CHECK_ACCESS_KEY, HARNESS_CLAIM_CHECK_SECRET_KEY, HARNESS_CLAIM_CHECK_ENDPOINT_URL
```

`ClaimCheckConfig` reads the `HARNESS_CLAIM_CHECK_` prefix, and `envFrom` injects the MinIO keys under their own names, so they do not satisfy it. The S3 claim-check store is therefore **configured but uncredentialed**.

This has not surfaced because claim-check only engages on payloads ≥ 64 KiB, and **the worker has never run** — so no activity has ever produced one. It would surface on the *first real transcript* the worker processes. Fold the credential mapping into the harness-worker work (Phase 7.7); do not treat `STORE=s3` as evidence the path works.

---

## E2. Consumption reality — `envFrom` is not universal

The "every workload uses `envFrom`" framing in earlier sections is wrong at the platform level. It holds for the 8 backend services only:

| Pattern | Workloads |
|---|---|
| `envFrom` both maps + some explicit refs | api, smr, guardrail, stt-v2, stt-v2-worker, tts, nlp, harness |
| **Explicit refs only, no `envFrom`** | `hope-admin-console` — proof the strict pattern is viable at scale |
| **No ConfigMap input at all** | `hope-compat-playground`, `hope-db-migrate` |

Notable per-service facts that shape the design:

- **`hope-harness`** carries the only non-optional `configMapKeyRef`s in the repo (the three `TEMPORAL_*`), *and* depends on `HARNESS_API_BASE_URL` + `HARNESS_CLAIM_CHECK_*` invisibly through `envFrom`. Its most dangerous dependencies are its least visible ones.
- **`hope-api`** declares `STT_V2_URL`/`SMR_URL`/`NLP_URL` as explicit refs *and* receives them via `envFrom` — redundant, harmless, but it muddies which pattern is intended. It also maps `DATABASE_URL` twice under two env names.
- **`hope-smr`** gets `SMR_GATEWAY_URL` only via `envFrom`; its code default is `http://localhost:8868/api/v1`, which in-cluster means *SMR calls itself*. Absence is a silent misroute, not an error.
- **`hope-stt-v2`** aliases one HF token secret to three env names (`HF_TOKEN`, `HUGGINGFACE_TOKEN`, `HUGGING_FACE_HUB_TOKEN`).

---

## E3. Per-key verdict on the 7 drifted keys

Tier verdicts against the project's own model in `09-infrastructure-devops.md` §Configuration Tiers, whose bootstrap-floor rule is: *a variable stays in `env` only if it is required to reach the database or authenticate to Vault.*

| Key | Tier verdict | Failure mode if absent | Remediation |
|---|---|---|---|
| `TEMPORAL_ADDRESS` | **Correctly `env`** — connection topology, same class as `DATABASE_URL`/`VAULT_ADDR` | **Loud** — non-optional ref → `CreateContainerConfigError` | Add `hope-temporal:7233` to Git. Note the Dockerfile bakes an already-wrong default (`temporal:7233`); the real Service is `hope-temporal` |
| `TEMPORAL_NAMESPACE` | Correctly `env` | Loud | Add `default` |
| `TEMPORAL_TASK_QUEUE` | Correctly `env` | Loud | Add `harness-task-queue`. Currently gates nothing live — no worker exists |
| `HARNESS_API_BASE_URL` | Correctly `env` — bootstrap transport | **Silent** — code default `localhost:8868` makes harness call *itself* | Add `http://hope-api:8868` **and promote to an explicit non-optional ref** so it fails loud |
| `SMR_GATEWAY_URL` | Correctly `env` — the codebase's own comment calls this "BOOTSTRAP TRANSPORT… NOT config authority" | **Silent** misroute, same shape | Add `http://hope-api:8868/api/v1` and promote to explicit non-optional ref |
| `HARNESS_CLAIM_CHECK_ENABLED` | Operational flag — belongs in `global-kv` long-term, but is read through the same synchronous `Settings()` path, so it cannot move independently yet | **Safe** — code default `True` equals the desired value | Add `"true"`. No promotion needed |
| `HARNESS_CLAIM_CHECK_STORE` | Same tier note, **but the highest-severity key here** | **Crash-loop** — see §E1 | Git-track the live value **first**, with its paired credentials (§E1) |

**All seven are legitimately `env`-tier.** This is a Git-hygiene failure, not a tier misclassification — which is good news: the remediation is "commit them," not "re-architect the config plane."

---

## E4. Recommended architecture

### E4.1 Shared map → platform map + per-service maps

| Option | Blast radius | Drift risk | Verdict |
|---|---|---|---|
| One shared `hope-config` (today) | Every service restarts on any edit | High — no ownership boundary | Reject as end-state |
| Fully per-service | Minimal | Duplicates ~15 cross-cutting keys N times | Reject — recreates "forgot to update 6 copies" |
| **`hope-platform-config` + `hope-<svc>-config`** | Cross-cutting edits restart everything (rare, intentional); service edits restart one Deployment | Low — each file is owned by whoever owns the service | **Recommended** |

Platform map holds: `NODE_ENV`, `LOG_LEVEL`, `DEBUG`, `CORS_ALLOWED_ORIGINS`, all `*_PORT`, all internal `*_URL`, MinIO bucket names, `OTEL_*_ENABLED`. Everything else moves to its owning service.

### E4.2 `envFrom` vs explicit refs — a decision rule, not a ban

- **Explicit, non-optional** when the key is a hard boot dependency with no safe cluster fallback: `TEMPORAL_*`, `HARNESS_API_BASE_URL`, `SMR_GATEWAY_URL`, and api's `*_URL` set. Missing → fails fast and loudly.
- **`envFrom` retained** only where every key in the generated map has a code default that already equals the intended cluster value — i.e. where "silently absent" and "silently correct" coincide *by construction*.
- **Never both for the same key on the same container** (api's redundant `*_URL` refs).

### E4.3 `configMapGenerator` with hash suffixes — the central mechanism

This closes two problems at once:

1. **Drift becomes structurally impossible.** A generator is rebuilt wholesale from Git on every render; there is no "add a key to the live object" path once `selfHeal` is on. `immutable: true` additionally blocks `kubectl edit` on any generation.
2. **Config changes actually roll pods.** A changed ConfigMap does *not* restart Deployments by itself — a real gap today. Changing content changes the generated name, which changes the pod template, which triggers a rollout.

```yaml
configMapGenerator:
  - name: hope-harness-config
    literals:
      - TEMPORAL_ADDRESS=hope-temporal:7233
      - TEMPORAL_NAMESPACE=default
      - TEMPORAL_TASK_QUEUE=harness-task-queue
      - HARNESS_API_BASE_URL=http://hope-api:8868
      - HARNESS_CLAIM_CHECK_ENABLED=true
      - HARNESS_CLAIM_CHECK_STORE=s3      # confirmed live 2026-08-07
    options:
      immutable: true
      disableNameSuffixHash: false
```

Kustomize's `nameReference` transformer rewrites every matching `configMapRef`/`configMapKeyRef` to the hashed name automatically. With Argo `prune: true`, superseded generations disappear on the next sync.

**Tradeoff worth stating:** the hash mechanism is orthogonal to blast radius. A single shared map still restarts every consumer on any edit — the per-service split in E4.1 is what bounds that.

### E4.4 Kill the index-based patches

Today: `overlays/dev/kustomization.yaml` does `op: replace, path: /spec/template/spec/containers/0/env/5/value` — which silently patches the wrong variable if the env list is ever reordered.

Replace with `configMapGenerator` + `behavior: merge` per overlay, and move `SMR_V2_OTEL_ENABLED` out of the Deployment's literal `env:` array into the generated map so it is addressable **by name, not position**. Apply this to all three overlays — staging and prod use the same fragile pattern, so a dev-only fix just relocates the inconsistency.

---

## E5. CI guardrails — all net-new

The deployment repo has **no CI at all** today (root is `README.md`, `deployment/`, `docs/`). Three checks, in priority order:

1. **Non-optional ref resolution** — render each overlay, assert every non-`optional` `configMapKeyRef`/`secretKeyRef` resolves to a key that exists. *This check fails on `main` today* against harness's `TEMPORAL_*` refs — which is exactly the bug that started this. Highest value, ~80 lines of Python.
2. **Required-key parity with the app's own settings** — the gateway's `bootstrap-env.descriptors.ts` is NestJS-only (zero `HARNESS_`/`TEMPORAL_`/`SMR_` entries), so it cannot be the single source of truth. Add a `--dump-required-env` mode per Python service that emits `{env_var: has_default}` from `model_fields` metadata (no real secrets needed), and cross-check both directions: missing keys *and* declared-but-never-provided dead config.
3. **Scheduled drift detection** — `argocd app diff --local`, plus a direct key-set comparison as a belt-and-braces check for exactly the 55-vs-48 class.

---

## E6. Enabling `selfHeal` / `prune` — ordered, non-negotiable

Each step gates the next.

1. **Read the live cluster** — capture the real values of all 7 keys. ✅ *Done 2026-08-07; `HARNESS_CLAIM_CHECK_STORE=s3` confirmed.*
2. **Land the 7 keys in Git** with those confirmed values, in a PR that passes guardrail #1.
3. **Promote `HARNESS_API_BASE_URL` and `SMR_GATEWAY_URL` to explicit non-optional refs** — convert their silent-misroute failure mode into a loud one.
4. **Resolve `hope-ui`** — it runs live but `ui.yaml` is commented out of `base/kustomization.yaml:27`. Either formally retire it (consistent with `apps/ui-playground` being deprecated) or re-add it. **`prune: true` will otherwise delete it as a side effect.**
5. **Audit for other hand-applied drift** — check `last-applied-configuration` across the namespace, or `kubectl diff -k`. Anything carrying it was last written outside Argo and will fight `selfHeal`.
6. **Land the Argo `Application` object in Git** — it exists only as an out-of-band `kubectl`/`argocd` write today, so `syncPolicy` itself is unreviewable.
7. **Land the CI guardrails** — *before* step 8, not after. Once `selfHeal` is on, Git is the enforced truth, and the guardrail is what stops Git drifting the same way.
8. **Flip `selfHeal: true` alone**, in a low-traffic window, and watch one full sync.
9. **Only then flip `prune: true`**, after step 4 has made a deliberate call on every live-but-untracked object.

---

## E7. Multi-environment and EKS

- `configMapGenerator`, hash suffixes, and `immutable` are core Kustomize, bundled in `kubectl` since 1.14 — **identical behavior on EKS**, nothing k3s-specific.
- Convert all three overlays to the generator pattern together.
- **Vault Agent Injector composes cleanly with zero Python changes.** `packages/py-env/src/hope_env/settings_sources.py` already implements `host env > /vault/secrets > dotenv > default` and no-ops when the mount is absent. Only k8s annotations change. Vault owns the `vault-kv`/`db-secret` tiers; generated ConfigMaps own the `env` tier; no overlap.
- Not portable and in the same files being touched: `runtimeClassName: nvidia` and the `hostPath` model cache. Orthogonal to config, but flagged because the same manifests are in scope.

---

## E8. Open questions

| # | Question | Status |
|---|---|---|
| 1 | Live value of `HARNESS_CLAIM_CHECK_STORE` + paired credentials | ✅ **Answered** — `s3`; credentials **absent** (§E1). Fold into Phase 7.7 |
| 2 | Is the harness Temporal worker running anywhere? | ✅ **Answered** — no. `TEMPORAL_TASK_QUEUE`/`NAMESPACE` gate nothing today |
| 3 | Should `HARNESS_ENVIRONMENT` be overlay-patched per namespace, or should every environment be treated as deployed? | **Open — owner decision.** Recommend the latter for a PHI platform: any namespace may run >1 replica, and the in-memory claim-check store is a per-process singleton. Also check what *else* is gated on `_DEPLOYED_ENVIRONMENTS` |
| 4 | `hope-ui` — retire or re-add? | **Open — blocks `prune`** |
| 5 | Where does the Argo `Application` live in Git, and who owns `syncPolicy` changes? | **Open** — neither repo declares it |
