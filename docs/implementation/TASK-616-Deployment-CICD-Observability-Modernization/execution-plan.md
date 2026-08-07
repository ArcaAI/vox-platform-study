# TASK-616 Appendix D — Execution Plan & Agent Allocation

**Date**: 2026-08-07 · **Status**: Awaiting approval (Phase 3 gate — no code written yet)

Companion to [README §4](./README.md). The README says *what* to do; this says *who does it, in what order, and what runs concurrently*.

Config-plane tasks (0.4, 0.13, 1.4) are specified in [Appendix E](./component-design-config-plane.md).

---

## D0. Allocation rules

### Tier mapping

| Complexity       | Tier                | `model` param           | Effort      | Used here for                                                                                         |
| ---------------- | ------------------- | ----------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| Trivial / simple | haiku-4-5           | `haiku-4-5`             | default     | One-line fixes, key extraction, list comparison, dead-code deletion, doc-claim corrections            |
| Moderate         | sonnet-5            | `sonnet-5`              | medium–high | Single-concern manifest authoring, CI job authoring, codebase exploration, standard multi-file edits  |
| Complex          | sonnet-5 / opus-4-8 | `sonnet-5` / `opus-4-8` | high–max    | Multi-file changes with tradeoffs, policy authoring, cross-service code changes, agentic tool use     |
| Very high        | opus-5 / fable-5    | `opus-5` / `fable-5`    | high–max    | Architecture (re)design, PHI-safety-critical design, irreversible migrations, ambiguous open problems |

### Three rules that override the tier table

1. **Agents author; they do not mutate live infrastructure.** Every task below produces a *diff, manifest, script, or analysis* reviewed before it touches a cluster. On a PHI platform an agent must not hold `kubectl apply`, `vault write`, or `git push` to the config repo. Cluster mutations are marked **⚙ human-applied**.
2. **Irreversible or PHI-touching work gets a tier bump**, regardless of mechanical complexity. Secret rotation is a simple script and a very-high-consequence action.
3. **Blocked-on-owner work is never assigned to an agent.** Proxmox VM provisioning, Cloudflare ingress rules, Entra ID app registration, and every ⚠ decision in §7/§9 of the README.

### Verification is not delegated

Each task's gate is checked by whoever reviews the diff — not self-reported by the agent that wrote it. Where a gate needs live evidence (a pod actually starting, a trace actually landing), that evidence is captured **after** human apply.

---

## D1. Wave structure

Waves are dependency-ordered; everything inside a wave runs concurrently.

```
WAVE 0  Diagnosis + authoring, zero cluster risk        ← can start immediately
WAVE 1  Apply Wave-0 output; hope-v2-dev correct        ← needs review + ⚙
WAVE 2  Security baseline + GitOps loop                 ← needs Wave 1
WAVE 3  Observability + supply chain                    ← needs Wave 2
WAVE 4  Staging, production, AWS structure              ← needs Wave 3
────────────────────────────────────────────────────────
TRACK V Vault HA — runs parallel to Waves 0-4           ← starts NOW, longest lead time
```

**Start Track V immediately.** It is gated on VM provisioning only the owner can do, and it blocks nothing else — so its lead time is free if it starts today and expensive if it starts at Wave 3.

---

## D2. Wave 0 — diagnosis and authoring (no cluster risk)

Everything here is read-only or produces a reviewable diff. **16 parallel agents.**

> **Task 0.0 is the new #1 priority.** [Appendix G](./component-design-zero-downtime-ha.md) found that all three `hope-api` probes point at `/api/v1/health`, which returns HTTP 200 unconditionally — so the readiness gate can never close and the entire graceful-drain implementation is unreachable code. It is a three-line YAML fix that unblocks every other zero-downtime measure. It outranks even the Image Updater repair.

| # | Task | Complexity | Tier | Effort | Notes |
| --- | --- | --- | --- | --- | --- |
| **0.0** | **Repoint `hope-api` probes** to `/health/ready`, `/health/live`, `/health/startup`; **remove `process.exit(1)` from `instrumentation.ts`** and route the OTel flush through the existing-but-never-called `registerCleanupCallback` | Moderate — tiny diff, large consequence | `sonnet-5` | medium | Two files. Do not batch with anything else — this wants its own reviewable diff |
| 0.15 | **Author probe/tGPS/preStop changes for the other 9 services** + `maxUnavailable: 1` PDBs | Moderate | `sonnet-5` | high | Per-service table in [Appendix G §G1](./component-design-zero-downtime-ha.md) |
| 0.16 | **Fix `packages/database/migrate.sh`** — always `migrate deploy`, gate the seed behind `RUN_SEED=true` | Moderate — actively destructive today | `sonnet-5` | medium | `db push` drops columns without a migration record; the unconditional seed overwrites admin-edited config every sync |

| #    | Task                                                                                                                                                  | Complexity                     | Tier        | Effort  | Notes                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------- | ------- | ------------------------------------------------------------------------------------------------- |
| 0.1  | **Root-cause `hope-stt-v2` crash loop** (`exitCode: 3`, 22 restarts). Pull container logs, correlate with the DiskPressure window                     | Complex — agentic diagnosis    | `sonnet-5`  | max     | Use the `debugger` agent. Live incident: highest value in this wave                               |
| 0.2  | **Analyse `/mnt/data` at 89%** — what consumes it, what is safe to reclaim, what the steady-state growth is                                           | Moderate                       | `sonnet-5`  | medium  | Read-only. Produces a reclamation plan, does **not** delete                                       |
| 0.3  | **Diagnose the Argo `OutOfSync`/`Missing` health** — test the three hypotheses (token TTL, impersonation RBAC on list/watch, dropped proxied watches) | Complex                        | `sonnet-5`  | high    | Direct-API re-registration is the expected fix                                                    |
| 0.4  | **Config-plane design** — ConfigMap architecture, the 7 drifted keys, CI guardrails, selfHeal enablement order                                        | Complex, high stakes           | `sonnet-5`  | max     | ✅ **Done** → [Appendix E](./component-design-config-plane.md)                                     |
| 0.5  | **Author GPU manifests** — `nvidia.com/gpu` requests on the 3 workloads, time-slicing ConfigMap, `runtimeClassName`                                   | Complex — correctness-critical | `sonnet-5`  | high    | Must note the Operator does *not* watch the ConfigMap; a device-plugin restart is required        |
| 0.6  | **Author probes** for `stt-v2-worker` (has none) and fix Ollama's premature readiness                                                                 | Moderate                       | `sonnet-5`  | medium  | Depends on 0.1's findings for STT                                                                 |
| 0.7  | **Author Ingress** for api / admin-console / compat-playground; delete the 3 dead Ingress patches                                                     | Moderate                       | `sonnet-5`  | medium  | Traefik ingressClass, matching the live cluster                                                   |
| 0.8  | **Author the deployment-repo CI** — `kustomize build` × 3 overlays + `kubeconform` + image-completeness + secret-key parity                           | Complex                        | `sonnet-5`  | high    | This is the guardrail that would have caught D-04 and the ConfigMap drift                         |
| 0.9  | **Repair Argo CD Image Updater** — fix the 2 stale image names, extend 6 → 11 workloads, verify the write-back path                                   | Moderate                       | `sonnet-5`  | high    | **Highest leverage in the whole plan** — it is installed, running, and has never updated anything |
| 0.10 | **Trivial manifest fixes**: guardrail LM Studio URL, `CORS_ALLOWED_ORIGINS`, delete dead `ui-playground` manifest + prod override                     | Trivial                        | `haiku-4-5` | default | Four small, independent edits                                                                     |
| 0.11 | **Correct false claims** in both repos' READMEs (CI updates tags, GPU requests exist, `base/charts/temporal/`, "manual builds", semver derivation)    | Trivial — text                 | `haiku-4-5` | default | Documentation-only                                                                                |
| 0.12 | **Author `harness-worker.yaml` + Dockerfile `worker` target + `build-harness-worker` CI job**                                                         | Complex — new component        | `sonnet-5`  | high    | Design is complete in [Appendix C §C2](./component-designs.md); this is implementation            |

| 0.13 | **Author the config-plane migration** — split `hope-config` into `hope-platform-config` + per-service maps as `configMapGenerator`s with `immutable: true`; convert all three overlays from index-based JSON6902 patches to `behavior: merge` | Complex — touches every workload | `sonnet-5` | max | Per [Appendix E §E4](./component-design-config-plane.md). Includes promoting `HARNESS_API_BASE_URL` + `SMR_GATEWAY_URL` to explicit non-optional refs |
| 0.14 | **Author the non-optional-ref resolution check** (the guardrail that fails on `main` today) | Moderate — ~80 lines | `sonnet-5` | medium | Split out of 0.8 because it is the single highest-value check and should not wait on the rest of the CI work |

**Wave 0 gate**: every diff reviewed by me, then by the owner. Nothing applied.

---

## D3. Wave 1 — make `hope-v2-dev` correct ⚙

Mostly human-applied. Agent work is limited to follow-ups the diagnosis surfaces.

| #   | Task                                                                                                         | Complexity                      | Tier       | Effort |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------- | ------ |
| 1.1 | ⚙ Reclaim `/mnt/data`; confirm DiskPressure clears                                                           | —                               | **human**  | —      |
| 1.2 | ⚙ Apply the STT fix from 0.1                                                                                 | —                               | **human**  | —      |
| 1.3 | ⚙ Reap the ~40 dead pods                                                                                     | Trivial                         | **human**  | —      |
| 1.4 | **Commit the 7 drifted keys to Git** with confirmed live values; verify rendered ≡ live. Follow [Appendix E §E6](./component-design-config-plane.md) steps 1–3 in order | Moderate — sequencing-sensitive | `sonnet-5` | high   |
| 1.4b | ⚠ **Decide `hope-ui`: retire or re-add** — `prune: true` deletes it otherwise | — | **owner** | — |
| 1.4c | ⚠ **Decide `HARNESS_ENVIRONMENT` posture** — overlay-patch per namespace, or treat every environment as deployed (recommended for PHI) | — | **owner** | — |
| 1.4d | **Add the missing claim-check credentials** (`HARNESS_CLAIM_CHECK_ACCESS_KEY`/`_SECRET_KEY`/`_ENDPOINT_URL`) — set to `s3` today with no credentials behind it | Moderate — latent defect | `sonnet-5` | medium |
| 1.5 | ⚙ Apply GPU / probe / Ingress manifests; restart the device-plugin DaemonSet                                 | —                               | **human**  | —      |
| 1.6 | ⚙ Re-register Argo against the direct API (`10.10.1.10:6443`) with an `argocd-manager` SA                    | —                               | **human**  | —      |
| 1.7 | **Replace index-based JSON6902 patches with name-based** across all overlays                                 | Moderate                        | `sonnet-5` | medium |
| 1.8 | **Script `secrets.*.yaml.example` generation from the manifests** so the key set cannot drift                | Moderate                        | `sonnet-5` | medium |

**Wave 1 gate**: all 11 workloads Running and Healthy; zero `Evicted`; rendered overlay ≡ live ConfigMap; Argo reports `Synced`/`Healthy`.

---

## D4. Wave 2 — security baseline + working GitOps loop

| #    | Task                                                                                                                                                                            | Complexity                                              | Tier        | Effort                  | Notes                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | **Author the k3s hardening config** — `config.yaml` with `secrets-encryption`, PSA config file, audit policy, kubelet flags, `system-reserved` + a pre-flight validation script | Complex — cluster-wide blast radius                     | `opus-5`    | high                    | **⚙ applied by owner during a window.** Store the join token in Vault *first* — snapshots become unrecoverable without it |
| 2.2  | **Add `securityContext` to every workload**; fix the two root init containers                                                                                                   | Complex — 15 workloads, per-service breakage risk       | `sonnet-5`  | max                     | Roll out PSA as `warn`+`audit` first, fix what surfaces, then `enforce`                                                   |
| 2.3  | **Derive the service dependency graph and author default-deny + allow NetworkPolicies** (Kyverno-generated, `synchronize: true`)                                                | Very high — getting it wrong breaks everything silently | `opus-5`    | max                     | The graph must be derived from real traffic, not guessed from manifests                                                   |
| 2.4  | **Commit Argo `AppProject` + `ApplicationSet`** — sync waves, PreSync for `db-migrate`, `ignoreDifferences` for HPA + injector annotations, `ServerSideApply`                   | Very high — GitOps architecture                         | `opus-5`    | high                    | Existing hand-made objects get exported, not re-invented                                                                  |
| 2.5  | **Rewrite `deploy-staging`** to target the real repo with digest-pinned `kustomize edit set image`, covering all 11 services                                                    | Complex                                                 | `sonnet-5`  | high                    | Or retire it in favour of 0.9's Image Updater — decide once                                                               |
| 2.6  | **Add `deploy-production`** with `environment: production` + manual gate                                                                                                        | Moderate                                                | `sonnet-5`  | medium                  | CE has no protected environments — a `when: manual` job is the ceiling                                                    |
| 2.7  | **CI hygiene**: `resource_group` + per-pipeline DB naming, `retry`, `COMPAT` tag regex, drop `:latest` from `hope-python-base`, fix false header comments                       | Moderate — many small independent edits                 | `sonnet-5`  | medium                  | Parallelizes well internally                                                                                              |
| 2.8  | **Turbo remote cache** so the 5-package chain builds once per pipeline, not six times                                                                                           | Complex                                                 | `sonnet-5`  | high                    | Measure wall-clock before/after                                                                                           |
| 2.9  | **Rollback runbook**, then ⚙ rehearse it once against dev and time it                                                                                                           | Moderate                                                | `sonnet-5`  | medium                  | Rehearsal is human                                                                                                        |
| 2.10 | **Remove the `dev-2.1` validation carve-out** or time-box it with a documented expiry                                                                                           | Trivial                                                 | `haiku-4-5` | default                 |                                                                                                                           |
| 2.11 | ⚙ Protect `dev` + `staging` branches so the Vault deploy role's `ref` scoping becomes real                                                                                      | —                                                       | **human**   | —                       |
| 2.12 | ⚙ **Decide Fleet vs Argo**; check `helm list -A` for `catalog.cattle.io/*` on `gpu-operator` before adopting it                                                                 | —                                                       | **human**   | Owner decision (N4, N7) |

**Wave 2 gate**: a `git push` deploys with no hand-edited YAML; every pod passes PSA `restricted`; a cross-namespace curl is refused; Argo objects are in Git.

---

## D5. Wave 3 — observability + supply chain

Two independent tracks; run them concurrently.

### Track O — observability (**strict ordering: 3.1 before 3.3**)

| #    | Task                                                                                                                                                                                 | Complexity                                      | Tier        | Effort  | Notes                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ----------- | ------- | ------------------------------------------------------------------ |
| 3.1  | **OTel Collector agent+gateway with redaction and an attribute allowlist**                                                                                                           | Very high — PHI-leak vector                     | `opus-5`    | max     | **Must ship and be verified before 3.3.** Allowlist, not denylist  |
| 3.2  | **Parameterize `deployment.environment.name` / `service.namespace` / `k8s.cluster.name` per overlay**; fix STT's hardcoded `"production"`                                            | Moderate                                        | `sonnet-5`  | medium  |                                                                    |
| 3.3  | **Turn tracing on everywhere** — set the OTLP endpoint in all overlays, set `NLP_OTEL_ENABLED`, **add OTel to guardrail and tts (zero code today)**, add a TracerProvider to harness | Complex — cross-service Python changes          | `sonnet-5`  | max     | Blocked on 3.1                                                     |
| 3.4  | **W3C `traceparent` propagation across Redis Streams, SSE, WebSocket, Temporal**                                                                                                     | Very high — novel integration, async boundaries | `opus-5`    | max     | Where auto-instrumentation silently drops traces                   |
| 3.5  | **Deploy Grafana Alloy** as the log shipper (never Promtail — EOL 2026-03-02)                                                                                                        | Moderate                                        | `sonnet-5`  | medium  |                                                                    |
| 3.6  | **Complete metrics coverage** — scrape all 7 services, add DCGM GPU metrics, move toward ServiceMonitors                                                                             | Moderate                                        | `sonnet-5`  | high    | DCGM exporter already runs — this is a scrape-target change        |
| 3.7  | **Implement log redaction** (`redactFields` is declared and never read); wire NLP's dead redaction hook                                                                              | Complex — PHI                                   | `opus-5`    | high    |                                                                    |
| 3.8  | **Package the 8 existing dashboards** into the deployment repo; fix the Grafana Ingress-host collision and the `optional: true` admin password                                       | Trivial–moderate                                | `haiku-4-5` | default |                                                                    |
| 3.9  | **Cross-environment view** — one Grafana + Mimir/Loki/Tempo with `X-Scope-OrgID` tenancy vs per-env Grafana                                                                          | Very high — architecture                        | `opus-5`    | high    | Decide before staging exists, not after                            |
| 3.10 | **Alertmanager + minimal alert set + one proven route to a human**; then 2–3 real SLIs via Sloth                                                                                     | Complex                                         | `sonnet-5`  | high    | SLI definition is a product decision — surface it, don't invent it |

### Track S — supply chain

| #    | Task                                                                                              | Complexity | Tier        | Effort  | Notes                                                     |
| ---- | ------------------------------------------------------------------------------------------------- | ---------- | ----------- | ------- | --------------------------------------------------------- |
| 3.11 | **Re-enable `scan-gitleaks`**                                                                     | Trivial    | `haiku-4-5` | default | Uncomment. The ruleset is already good                    |
| 3.12 | **Make Trivy blocking** and extend to all 12 images                                               | Moderate   | `sonnet-5`  | medium  | Remove `\|\| echo`, `--exit-code 1`, drop `allow_failure` |
| 3.13 | **Un-`allow_failure` the 4 Python suites** — fix the underlying test-infra gap rather than muting | Complex    | `sonnet-5`  | max     | The real work is provisioning test infra                  |
| 3.14 | **cosign keyless signing** via GitLab OIDC (`aud: sigstore`, cosign ≥2.0)                         | Moderate   | `sonnet-5`  | medium  |                                                           |
| 3.15 | **CycloneDX SBOM** per image as an in-toto attestation                                            | Moderate   | `sonnet-5`  | medium  |                                                           |
| 3.16 | **Kyverno admission policy** rejecting unsigned images outside dev                                | Complex    | `sonnet-5`  | high    | Depends on 3.14                                           |
| 3.17 | **Registry cleanup policy** scoped to `dev-*`/`staging-*`                                         | Trivial    | `haiku-4-5` | default |                                                           |
| 3.18 | **Activate Vault OIDC in CI** (set `VAULT_ADDR`)                                                  | Moderate   | `sonnet-5`  | medium  | Integration is already built and self-revokes             |
| 3.19 | **Register the GPU runner** + a CUDA smoke job for the STT images                                 | Complex    | `sonnet-5`  | high    | GPU images are currently built blind                      |

---

## D6. Wave 4 — staging, production, AWS structure

| #   | Task                                                                                                                                                              | Complexity                            | Tier        | Effort  | Notes                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------- | ------- | ---------------------------------------------------------------------- |
| 4.1 | **Restructure into Kustomize `components/`** — `storage-k3s`/`storage-aws`, `ingress-k3s`/`ingress-aws`, `gpu-passthrough`/`gpu-karpenter`, `secrets-vault-agent` | Very high — re-architecture           | `opus-5`    | max     | The change that makes AWS cheap later                                  |
| 4.2 | **Explicit `storageClassName` on all 7 PVCs**; replace the STT `hostPath` with a PVC                                                                              | Moderate                              | `sonnet-5`  | medium  |                                                                        |
| 4.3 | **Create `hope-v2-staging`** — namespace, overlay, Argo Application, digest-pinned promotion from dev                                                             | Complex                               | `sonnet-5`  | high    |                                                                        |
| 4.4 | **Author the production overlay as a real template** — PDBs, HPAs, `preferred` anti-affinity, resource tiers                                                      | Complex                               | `opus-5`    | high    | `minAvailable` < `HPA.minReplicas`; never `required` anti-affinity     |
| 4.5 | **Hybrid-boundary decision record** — what moves to AWS, what stays on-prem, with the cost basis                                                                  | Very high — ambiguous, tradeoff-heavy | `opus-5`    | max     | Recommendation: control plane portable, GPU stays on-prem (~4–8× cost) |
| 4.6 | **HIPAA-on-AWS baseline** — BAA scope, eligible services, landing zone, Pod Identity, encryption/audit                                                            | Very high                             | `opus-5`    | high    | A gap list, never a compliance claim                                   |
| 4.7 | **Operations docs** — staging runbook, rollback, k3s upgrade (incl. the passthrough-VM downtime caveat), GPU re-tuning, on-call, alert response                   | Moderate                              | `sonnet-5`  | high    |                                                                        |
| 4.8 | **Mark superseded infra research docs**; reconcile `09-infrastructure-devops.md` with reality                                                                     | Trivial                               | `haiku-4-5` | default | It still describes a deleted tree                                      |

---

## D7. Track V — Vault HA (parallel from day 1)

| #   | Task                                                                                                                 | Complexity                                 | Tier       | Effort | Notes                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------ |
| V.1 | ⚠ **Provision VMs 430-432 (+434 seal-Vault)**                                                                        | —                                          | **owner**  | —      | **Blocked — I have no Proxmox access.** Longest lead time                |
| V.2 | **Author the runbook's unwritten sections** (3, 4, 8, 10, 11, 14, 17)                                                | Very high — the source doc is placeholders | `opus-5`   | max    | Can start before V.1                                                     |
| V.3 | ⚠ **Resolve N1–N3**: seal-Vault placement, existing internal CA, version pin                                         | —                                          | **owner**  | —      |                                                                          |
| V.4 | **Author Vault config** — Raft + Transit seal stanza, systemd units, HAProxy                                         | Complex                                    | `opus-5`   | high   |                                                                          |
| V.5 | **Port the existing auth/policy/injector layer** — K8s auth for 6 services, AppRole for the gateway, per-service HCL | Complex — reuse, not invention             | `sonnet-5` | high   | The layer already exists and is tested                                   |
| V.6 | **Author the export/migrate/rotate scripts** (file backend cannot be Raft-snapshotted)                               | Very high — irreversible, PHI              | `opus-5`   | max    | ⚙ execution is human. **Rotation is the security boundary, not cleanup** |
| V.7 | ⚙ **Cutover + rotate every exposed credential**; decommission the dev Vault and both plaintext Secrets               | —                                          | **human**  | —      |                                                                          |
| V.8 | ⚠ **Create a second Entra ID App Registration** for Vault OIDC                                                       | —                                          | **owner**  | —      | Do not reuse GitLab's                                                    |

### Track Q — Qdrant + Temporal (parallel from Wave 2)

| #   | Task                                                                                                | Complexity                         | Tier       | Effort |
| --- | --------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------- | ------ |
| Q.1 | **Deploy Qdrant** — StatefulSet, Service, the missing `qdrant-init` Job, kustomization registration | Moderate                           | `sonnet-5` | high   |
| Q.2 | **Add Qdrant auth** — a *code* change; `KnowledgeQdrantStore.__init__` accepts no `api_key` today   | Complex — code + manifest + config | `sonnet-5` | high   |
| Q.3 | ⚠ **Corpus-size estimate** for PVC sizing and the quantization decision (N6)                        | —                                  | **owner**  | —      |
| Q.4 | **Consolidate Temporal** — retire the host-Docker pair, point everything in-cluster                 | Moderate — zero migration risk     | `sonnet-5` | medium |

---

## D8. Concurrency summary

| Wave | Parallel agents                            | Human/owner items | Blocks              |
| ---- | ------------------------------------------ | ----------------- | ------------------- |
| 0    | **14**                                     | 0                 | Nothing — start now |
| 1    | 3                                          | 5 ⚙               | Wave 0 review       |
| 2    | 8                                          | 2 ⚙ + 2 ⚠         | Wave 1              |
| 3    | **17** (10 observability + 7 supply chain) | 0                 | Wave 2              |
| 4    | 7                                          | 0                 | Wave 3              |
| V    | 4                                          | 4 ⚠⚙              | V.1 owner action    |
| Q    | 3                                          | 1 ⚠               | Wave 2              |

Peak concurrency is Wave 3 at 17. Two ordering constraints are **hard**:

- **3.1 before 3.3** — gateway redaction must be live before tracing turns on across six services handling clinical audio.
- **V.1 before everything else in Track V** — and it is owner-blocked, which is why Track V starts on day 1.

### Tier distribution

| Tier        | Count | Share |
| ----------- | ----- | ----- |
| `haiku-4-5` | 7     | 13%   |
| `sonnet-5`  | 32    | 60%   |
| `opus-5`    | 14    | 26%   |

The `opus-5` allocations cluster where you'd expect on a PHI platform: PHI-safety design (3.1, 3.4, 3.7), architecture (2.4, 4.1, 4.5, 3.9), irreversible migration (V.6), and blast-radius-wide policy (2.1, 2.3).

---

## D9. What must not be delegated

| Item                                                                 | Why                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Proxmox VM creation, Cloudflare ingress rules, Entra ID registration | No capability — see [README §9](./README.md)                                 |
| Every `kubectl apply` / `vault write` / config-repo `git push`       | Agents author; humans apply. Non-negotiable for PHI                          |
| Secret rotation (V.7)                                                | Irreversible, and the actual security boundary of the Vault migration        |
| Enabling Argo `prune` / `selfHeal`                                   | Would delete untracked live state. Only after 1.4 verifies rendered ≡ live   |
| k3s hardening flag application (2.1)                                 | Cluster-wide restart; recoverable only if the join token is in Vault first   |
| SLI/SLO definition (3.10)                                            | A product decision about what "good" means, not an engineering one           |
| The hybrid AWS boundary (4.5)                                        | A business/cost decision; the agent supplies the analysis, the owner decides |
