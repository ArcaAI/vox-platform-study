# Additional Table of Contents — `codewalk/`, `deploy/`, `observability/`, `cloudflared/`

**Location:** `/Users/apple/repos/VOX/vox-platform-study/code_review/additional_toc.md`
**Companion document:** [`Table_of_Contents.md`](./Table_of_Contents.md) covers the five other research waves in this folder (`ALaaSv3/`, `api_explore/`, `api_explore_2/`, `api_explore_3/`, `Test_Results/`). This file covers the four remaining folders.
**Audience:** A developer taking over service-code understanding, local or cluster deployment, public ingress/Tunnel setup, or monitoring of the HOPE / VOX platform.
**Last inventoried:** 2026-11-23 from the files present in these folders. No source repositories were modified.

> **Read this first.** These are not four versions of the same document. They are four different layers of the same investigation:
>
> - `codewalk/` — **what the code does** (services, endpoints, handlers, flows, sequence diagrams).
> - `deploy/` — **how to build and deploy it**, mostly from the earlier k3s / `taphuynh.dev` reference estate.
> - `cloudflared/` — **how traffic reaches the services** through Cloudflare Tunnel and Traefik in the newer kubeadm lab estate.
> - `observability/` — **how the running platform is measured and troubleshot** (Prometheus, Grafana, Loki/Promtail) in that same lab estate.
>
> A large part of reading these folders correctly is knowing **which estate a document describes**; see §3.

---

## 1. How to use this handover

| If you need to… | Start here | Then go to |
|---|---|---|
| Understand the platform and its services in 15 minutes | [`codewalk/vox.md`](./codewalk/vox.md) | [`codewalk/BREN_CONSULTATION_E2E.md`](./codewalk/BREN_CONSULTATION_E2E.md) → individual service docs |
| Trace one endpoint from route to implementation | The relevant `codewalk/<service>.md` | `codewalk/diagrams/<prefix>-*.html` for that service |
| Build and validate the stack on a laptop | [`deploy/01-tools-explained.md`](./deploy/01-tools-explained.md) → [`deploy/02-service-dependency-map.md`](./deploy/02-service-dependency-map.md) | [`deploy/09-execute-plan.md`](./deploy/09-execute-plan.md) → [`deploy/10-docker-commands.md`](./deploy/10-docker-commands.md) |
| Prepare secrets and manifests for a cluster deployment | [`deploy/05-vault-secrets-setup.md`](./deploy/05-vault-secrets-setup.md) | [`deploy/06-manifest-validation.md`](./deploy/06-manifest-validation.md) → [`deploy/08-deployment-checklist.md`](./deploy/08-deployment-checklist.md) |
| Debug a deployment failure | [`deploy/07-known-deployment-errors.md`](./deploy/07-known-deployment-errors.md) | [`deploy/06-manifest-validation.md`](./deploy/06-manifest-validation.md) → [`deploy/08-deployment-checklist.md`](./deploy/08-deployment-checklist.md) |
| Understand / reproduce public ingress (`vox2.arcaai.com`) | [`cloudflared/README.md`](./cloudflared/README.md) | [`cloudflared/current-setup.md`](./cloudflared/current-setup.md) → [`cloudflared/steps_to_follow.md`](./cloudflared/steps_to_follow.md) → [`cloudflared/manifests/`](./cloudflared/manifests/) |
| Debug `gateway-test.arcaai.com` returning Traefik 404 | [`cloudflared/rca_gateway_test.md`](./cloudflared/rca_gateway_test.md) | [`cloudflared/nitik/gateway-test-ingress.yaml`](./cloudflared/nitik/gateway-test-ingress.yaml) |
| Stand up or understand monitoring | [`observability/README.md`](./observability/README.md) | [`observability/LOGGING.md`](./observability/LOGGING.md) → [`observability/docs/README.md`](./observability/docs/README.md) → [`observability/docs/01-prerequisites.md`](./observability/docs/01-prerequisites.md) |
| Change a Grafana dashboard | [`observability/docs/11-dashboard-management.md`](./observability/docs/11-dashboard-management.md) | [`observability/dashboards/generate.py`](./observability/dashboards/generate.py) → [`observability/docs/12-dashboard-update-procedure.md`](./observability/docs/12-dashboard-update-procedure.md) |
| See where a document's old path points | §8.1 Path drift | Do **not** assume `/Users/apple/repos/VOX/review/...` is the live tree; use relative links here |

---

## 2. Folder map

| Folder | Inventory | What it is | Primary forward use | Start file |
|---|---|---|---|---|
| [`codewalk/`](./codewalk/) | 12 Markdown files; `diagrams/` with 50 standalone HTML sequence diagrams and 250 JSON sidecars/specs (5 per diagram) | Source-code walkthroughs for each HOPE microservice plus an end-to-end BREN consultation trace; generated diagrams show request sequences | Understand what a service does, which handler owns a route, which config keys and downstream calls are involved, and how a consultation flows end-to-end | [`vox.md`](./codewalk/vox.md) |
| [`deploy/`](./deploy/) | 11 numbered Markdown guides (`01`–`11`) | Deployment engineering: tool explanations, dependency order, image builds, laptop validation, Vault secrets, manifest validation, deployment checklist, known errors, Docker command reference, Traefik ingress plan | Build images, bring services up locally, and prepare/validate a cluster deployment; use `07` as an error dictionary | [`01-tools-explained.md`](./deploy/01-tools-explained.md) |
| [`cloudflared/`](./cloudflared/) | 10 Markdown/text docs, 4 rollout manifests, 2 historical/reference snapshots, 2 operator/scratch logs | How HOPE is exposed on `vox2.arcaai.com` via a dedicated Cloudflare Tunnel (`hope-vox2`) and the in-cluster Helm Traefik; includes the gateway-test 404 RCA | Reconstruct or audit public routing, TLS/edge decisions, CORS, STT external endpoints, and ingress troubleshooting | [`README.md`](./cloudflared/README.md) |
| [`observability/`](./observability/) | 2 top-level docs, 16 `docs/` Markdown files, 15 numbered manifests + 1 example secret, 12 dashboard sources + 2 generators, 21 individual dashboard JSONs, 4 GPU-box files | Core monitoring stack (Prometheus, Alertmanager, Grafana), logging design (Loki/Promtail), dashboards, GPU-host telemetry, and day-2 runbooks | Deploy/verify the monitoring plane, manage dashboards, and understand which metrics/logs exist | [`README.md`](./observability/README.md) |
| `.DS_Store` files | macOS Finder metadata | None | Ignore | — |

---

## 3. Cross-folder relationships and the two estates

### 3.1 Dependency flow

```
codewalk/  ──(service ports, endpoints, health probes, GPU topology)──►  deploy/
    │                                                                     │
    │                                                                     ▼
    └──(services being exposed)──►  cloudflared/  ◄──(corrects deploy/11 ingress assumptions)
                                          │
                                          │ (hope-vox2 tunnel + Traefik hosts)
                                          ▼
                                     observability/  (Grafana/Prometheus/Alertmanager hosts and dashboards)
```

- `codewalk/` supplies the **code-level truth** for what the deployment and ingress docs refer to. `codewalk/STT_TEXT_GPU_DEPLOY.md` in particular explains why STT is off-cluster and how gateway callbacks/NodePorts are wired.
- `deploy/` supplies the **build/validation baseline**. `deploy/11-traefik-ingress-setup.md` was later reviewed and partly corrected by `cloudflared/traefik-k3s-findings.md`; do not use `11` as the final ingress design.
- `cloudflared/` supplies the **current edge/routing design** for the lab estate. `observability/README.md` §3d depends on its `hope-vox2` tunnel and Traefik service.
- `observability/` is the **measurement plane** for the lab estate; it reads service metrics defined by `codewalk/` and uses hostnames routed by `cloudflared/`.

### 3.2 Two estates — do not mix their facts

| Dimension | Earlier reference estate | Newer lab estate |
|---|---|---|
| Cluster | single-node k3s (server `dell`), k3s-bundled Traefik `3.6.9` in `kube-system` | kubeadm v1.29.15, 6 nodes `192.168.112.6`–`.11`, Helm Traefik `v3.7.14` in `project-hope-vox` |
| Namespace | `hope-v2-dev` / `hope-v2-staging` / `hope-v2-prod` | `project-hope-vox` (apps + Traefik + cloudflared), `project-hope-vox-infra` (DB, Vault, Temporal, observability) |
| Domain / tunnel | `*.taphuynh.dev`, tunnels `hope-v2-dev` + `arca-dev` | `*.arcaai.com` with `vox2` names, dedicated tunnel `hope-vox2` |
| Typical ports | API NodePort `30088`, admin `30081`, registry `registry.taphuynh.dev` | gateway NodePort `32458`, admin `32540`, Traefik `32067`/`31815`, STT at `192.168.112.2:8862` |
| Where documented | most of `deploy/`, `cloudflared/reference/`, `cloudflared/traefik-k3s-findings.md`, `cloudflared/cloudflare-tunnel-reference.md` | `cloudflared/README.md`, `current-setup.md`, `steps_to_follow.md`, `manifests/`, `vox2-arcaai-com-routing.md`, all of `observability/` |

`codewalk/` is mostly code-level and spans both; its two deployment runbooks lean toward the reference estate.

---

## 4. `codewalk/` — service and flow map

### 4.1 Markdown files

| File | What it contains | When to read it |
|---|---|---|
| [`vox.md`](./codewalk/vox.md) | Platform overview: 9 services under `apps/`, key shared packages, data-flow sketch, communication conventions (`/api/v1/`, `/internal/`, `X-Service-Token`, Redis Streams), and a complete index of all 50 sequence diagrams with a Quick Access list | **First.** Use it as the folder's index. Note: it still lists a missing `smr.md`. |
| [`api.md`](./codewalk/api.md) | API Gateway service overview (NestJS), sample of 200+ public routes, detailed handler chains, guard/interceptor chain, key `@arcaai/applications` services, control-plane config, and 6 gateway diagrams | When tracing gateway routing, auth, streaming, or agent resolution |
| [`admin-console.md`](./codewalk/admin-console.md) | Admin console endpoints, handlers, implementation chains, config, and 4 login/logout/proxy/impersonation diagrams | When working on console auth, proxying, or impersonation |
| [`stt.md`](./codewalk/stt.md) | STT endpoints (streaming sessions, batch transcription, voice profiles, engine switch), data flow through Redis/VAD/inference, config keys, implementation files, and 6 diagrams | For STT request handling and streaming internals |
| [`tts.md`](./codewalk/tts.md) | TTS endpoints (`/api/v1/audio/speech`, `/api/v1/audio/stream`), batch/SSE/raw synthesis, routing and failover logic, config, and 5 diagrams | For TTS synthesis, streaming, and failover |
| [`text.md`](./codewalk/text.md) | Text generation endpoints, providers, guardrail gates, streaming/SSE, task cancellation, health probes, config, and 6 diagrams | For LLM text proxy/provider behavior |
| [`nlp.md`](./codewalk/nlp.md) | NLP classification/NER/guard/diagnosis endpoints, model cache architecture, concurrency control, config keys, and 8 diagrams | For medical NER, PII/entailment guards, and model caching |
| [`guardrail.md`](./codewalk/guardrail.md) | Guardrail endpoints (analyze, screen, redact, medical validation, groundedness, jobs, realtime), implementation chains, config, and 8 diagrams | For content-safety and compliance paths |
| [`harness.md`](./codewalk/harness.md) | Harness endpoints (admin list, doc start, signal approve/context-added, knowledge ingest, eval gate, health), implementation chains, config, and 7 diagrams | For evaluation/quality-gate flows |
| [`BREN_CONSULTATION_E2E.md`](./codewalk/BREN_CONSULTATION_E2E.md) | End-to-end Breast & Endocrine consultation walkthrough: system map, config locations, workflow definition, step-by-step sequence, full API call matrix, data contracts, Substrate A/B decision logic, failure modes, and appendices | Read after `vox.md` and `api.md`; it is the best cross-service narrative and a consistency check for route names |
| [`STT_TEXT_GPU_DEPLOY.md`](./codewalk/STT_TEXT_GPU_DEPLOY.md) | Confirmed GPU-server + k3s topology for STT and TEXT: component inventory, NodePort vs Traefik decision, build/registry, STT env and model-cache wiring, TEXT deployment, gateway wiring, smoke test | Read with `deploy/` and `cloudflared/current-setup.md`; explains why STT is off-cluster |
| [`LOCAL_BUILD_DEPLOY_RUNBOOK.md`](./codewalk/LOCAL_BUILD_DEPLOY_RUNBOOK.md) | Long step-by-step build/deploy runbook (private registry, Docker trust, base image, Node/Python/STT images, registry push, and later deployment/smoke-test steps) | Use as a deeper alternative to `deploy/03`–`deploy/09`; it is broader and older than `deploy/` |

### 4.2 `codewalk/diagrams/` — generated sequence diagrams

There are **50** standalone `.html` files. Each has five sidecars named `<base>.sequence.json`, `<base>.finalize.json`, `<base>.finalize-summary.json`, `<base>.delivery.json`, and `<base>.browser-check.json`.

| Artifact type | What it is |
|---|---|
| `*.html` | Self-contained Archify 3.0.1 viewer with inline SVG, themes, toolbar, and export controls. Open in a browser; no network access required. |
| `*.sequence.json` | Authoring spec: participants, messages, labels, layout hints, quality profile. It does **not** embed source-file lineage. |
| `*.finalize.json` | Build receipt: exact Archify commands, exit codes, timings. |
| `*.finalize-summary.json` | Gate results for validate/deliver/check/browser-check plus diagnostics. |
| `*.delivery.json` | Delivery receipt: status, input/output paths, spec/artifact hashes. |
| `*.browser-check.json` | Rendering/theme/readability checks at multiple viewports and light/dark themes. |

All 50 sets report passing finalize/browser-check gates and `status: current`, but these are **tool receipts**, not proof that the architecture narrative is still correct.

| Diagram prefix | Count | Belongs with | Example flows |
|---|---:|---|---|
| `api-` | 6 | `api.md` | agent resolve, health probes, speech synthesize, STT streaming, text proxy, TTS job lifecycle |
| `stt-` | 6 | `stt.md` | session create, streaming transcription, batch transcribe, engine switch, voice profile, health |
| `tts-` | 5 | `tts.md` | batch speech, streaming WS, routing failover, model resolvability, health |
| `text-` | 6 | `text.md` | generate, streaming, providers probe, guardrail gate, task cancel, health |
| `nlp-` | 8 | `nlp.md` | token/text classification, topic-intent delegation, PII/entailment, diagnosis, model cache, health |
| `guardrail-` | 8 | `guardrail.md` | analyze, screen, redact, medical validate, groundedness, realtime, jobs, health |
| `harness-` | 7 | `harness.md` | admin list, doc start, signals, knowledge ingest, eval gate, health |
| `admin-console-` | 4 | `admin-console.md` | login, logout, proxy, impersonation |

### 4.3 Recommended reading order in `codewalk/`

1. `vox.md` — index and platform model.
2. `api.md` + the 6 `api-*` diagrams — central entry point.
3. `BREN_CONSULTATION_E2E.md` — cross-service narrative.
4. `stt.md`, `tts.md`, `text.md`, `nlp.md`, `guardrail.md`, `harness.md`, `admin-console.md`, each with its diagram prefix.
5. `STT_TEXT_GPU_DEPLOY.md` and `LOCAL_BUILD_DEPLOY_RUNBOOK.md` — only when moving from code understanding to deployment.

---

## 5. `deploy/` — build, validate, deploy

### 5.1 Files

| File | Mode | What it contains |
|---|---|---|
| [`01-tools-explained.md`](./deploy/01-tools-explained.md) | Explainer | Plain-language tour of Docker, Kubernetes, k3s, Karpenter, Kustomize, ArgoCD, Vault, MinIO, Temporal; namespaces, registry, buckets, and a full-stack summary |
| [`02-service-dependency-map.md`](./deploy/02-service-dependency-map.md) | Reference + ordered phases | Service dependency table, why startup order matters, NodePort/health tables, and 30-step bring-up across phases 0–6. Master dependency reference. |
| [`03-build-images-from-source.md`](./deploy/03-build-images-from-source.md) | Runbook | Build every HOPE image from `project-hope`, with Dockerfile locations, base image, Prisma build args, registry push, and troubleshooting |
| [`04-laptop-validation-guide.md`](./deploy/04-laptop-validation-guide.md) | Runbook | Run services one-by-one with Docker Compose, migrate the DB, check health, and understand what local validation does *not* prove |
| [`05-vault-secrets-setup.md`](./deploy/05-vault-secrets-setup.md) | Runbook/reference | Full secret inventory, `secrets.dev.yaml` setup, Vault kv-v2/transit/AppRole, unseal, and local `SECRETS_PROVIDER=env` bypass |
| [`06-manifest-validation.md`](./deploy/06-manifest-validation.md) | Runbook | Offline validation with `kustomize`, `kubeconform`, config-ref checks, `:latest` scan, dry-run apply, and gitleaks; lists what static checks cannot catch |
| [`07-known-deployment-errors.md`](./deploy/07-known-deployment-errors.md) | Error dictionary | 15 classes of real errors with exact messages and fixes (Vault sealed, missing harness token, immutable Job, Prisma P3005, image pulls, ArgoCD access, Loki buckets, Qdrant snapshots, Karpenter, etc.) |
| [`08-deployment-checklist.md`](./deploy/08-deployment-checklist.md) | Gate checklist | Pre-deployment checks in phases 0–5, the 31-key `hope-secrets` verification, GPU time-slicing, Argo/CDI/GitLab requirements, and known degraded states |
| [`09-execute-plan.md`](./deploy/09-execute-plan.md) | Condensed execution plan | Apple Silicon runbook: env setup, base image, Node/Python image builds, run containers, batch health loop. Shorter and more executable than `03`+`04`. |
| [`10-docker-commands.md`](./deploy/10-docker-commands.md) | Cheat sheet | Commands for the already-running `test-hope-*` stack: Postgres/MinIO/Redis/Ollama, per-service containers, health endpoints, gateway fan-out, seeded dev users |
| [`11-traefik-ingress-setup.md`](./deploy/11-traefik-ingress-setup.md) | Design plan / partly superseded | Plan for fronting console + API with Traefik: Ingress, `hope-no-buffer` middleware, `ServersTransport`, TLS options, build-time `NEXT_PUBLIC_API_HOST`, origin allow-list, ETag/compression rules. Superseded in part by `cloudflared/`. |

### 5.2 Recommended reading order in `deploy/`

1. `01` — vocabulary.
2. `02` — dependencies and bring-up order; keep it open as a reference.
3. Local track: `03` → `04`, or `09` for the condensed Apple Silicon path; then `10` once containers are running.
4. `06` — validate manifests offline.
5. `05` — secrets/Vault before any cluster sync.
6. `08` — run the checklist gate.
7. `07` — consult only when something fails.
8. `11` — ingress design background only; read `cloudflared/` for the lab-estate decision.

---

## 6. `cloudflared/` — public exposure and ingress

### 6.1 Files

| File | Category | What it contains |
|---|---|---|
| [`README.md`](./cloudflared/README.md) | **Start here / provenance** | Splits the folder into current (`steps_to_follow.md`, `manifests/`, `vox2-arcaai-com-routing.md`), live snapshot (`current-setup.md`), and background/reference (`traefik-k3s-findings.md`, `cloudflare-tunnel-reference.md`, `reference/`). Condenses the main findings. |
| [`current-setup.md`](./cloudflared/current-setup.md) | Point-in-time live state (2026-10-13) | Full `kubectl` inventory of `project-hope-vox` / `project-hope-vox-infra`: Deployments, Services/NodePorts, Traefik args, ConfigMaps, env vars, absent Ingress/tunnel, off-cluster STT, and the unrelated `arcafabric` tunnel. A **pre-change snapshot**, not today's state. |
| [`steps_to_follow.md`](./cloudflared/steps_to_follow.md) | Primary runbook | Ordered rollout: Cloudflare dashboard (new `hope-vox2` tunnel, public hostnames, proxied CNAMEs, Access apps, compression off for `/api/hope/*`), Kubernetes (token Secret, hardened connector, STT Service/Endpoints, Ingresses, CORS), GPU server, verification, rollback |
| [`vox2-arcaai-com-routing.md`](./cloudflared/vox2-arcaai-com-routing.md) | Confirmed decisions | Hostname → backend mapping, selector-less STT Service rationale, rejection of reusing `arcafabric`, cross-namespace Ingresses, typo fix `vault.vo2` → `vault.vox2`, no in-cluster TLS |
| [`manifests/README.md`](./cloudflared/manifests/README.md) | Manifest index | Apply order and decisions for the `hope-vox2` rollout; states durable copies belong in the `arca/hope-v2-deployment` GitOps repo |
| [`manifests/cloudflared-hope-vox2.yaml`](./cloudflared/manifests/cloudflared-hope-vox2.yaml) | Manifest | Hardened token-only `cloudflared` Deployment (2 replicas, digest-pinned image, probes, metrics Service); token comes from a Secret created out of band |
| [`manifests/stt-external-service.yaml`](./cloudflared/manifests/stt-external-service.yaml) | Manifest | Selector-less `Service/hope-stt` plus hand-written Endpoints for off-cluster STT at `192.168.112.2:8862`; apply before its Ingress |
| [`manifests/ingress-vox2-apps.yaml`](./cloudflared/manifests/ingress-vox2-apps.yaml) | Manifest | App-plane Traefik objects: `hope-no-buffer` middleware, optional long-stream `ServersTransport`, and Ingresses for console, API, text, TTS, guardrail, NLP, harness, STT. Uses single-label `-vox2` hostnames. |
| [`manifests/ingress-vox2-infra.yaml`](./cloudflared/manifests/ingress-vox2-infra.yaml) | Manifest | Cross-namespace Ingresses for Vault and Temporal in `project-hope-vox-infra`; uses `vault-vox2` / `temporal-vox2` |
| [`rca_gateway_test.md`](./cloudflared/rca_gateway_test.md) | RCA (2026-11-04) | Root cause and fix for `gateway-test.arcaai.com` returning Traefik 404: Ingress pointed at container `targetPort 8868` instead of Service port `80`; verification, prevention checklist, and comparison one-liner |
| [`nitik/gateway-test-ingress.yaml`](./cloudflared/nitik/gateway-test-ingress.yaml) | Corrected manifest | Source of the fixed Ingress in `project-hope-vox` using `gateway-test-svc` port `80` |
| [`nitik/for_gatway-test.txt`](./cloudflared/nitik/for_gatway-test.txt) | Scratch/evidence | Raw `kubectl` dumps from the failed first attempt, including the misspelled `gatway-test-svc`, wrong port, old `nitik` namespace, and plaintext credentials. Read only to understand the RCA. |
| [`session_log.txt`](./cloudflared/session_log.txt) | Operator transcript | Shell log showing the actual 2026-10-13 rollout: Secret creation, manifest applies, connector pods, STT Service/Endpoints, and Ingresses. Also contains a plaintext tunnel token; treat as sensitive. |
| [`cloudflare-tunnel-reference.md`](./cloudflared/cloudflare-tunnel-reference.md) | Background bridge | Points to the canonical `arca-deployment-template@main:docs/cloudflare-tunnel.md` and relates the reference estate to the `vox2` plan |
| [`reference/cloudflare-tunnel.md`](./cloudflared/reference/cloudflare-tunnel.md) | Verbatim snapshot | Canonical reference-estate tunnel doc: hostnames, HTTP/TCP rules, TCP access for Postgres, connector operations, `httpHostHeader` rule, security gaps |
| [`reference/cloudflared.yaml`](./cloudflared/reference/cloudflared.yaml) | Verbatim snapshot | Canonical reference-estate connector manifest: ConfigMap with TCP rules + HTTP catch-all to k3s Traefik, digest-pinned Deployment, metrics Service |
| [`traefik-k3s-findings.md`](./cloudflared/traefik-k3s-findings.md) | Initial investigation (reference estate) | Traefik version/deployment findings and an important correction: middleware references must use `<namespace>-<name>@kubernetescrd` (dash), not a slash |
| [`custom_cert/`](./cloudflared/custom_cert/) | Superseded/fallback | `custom_cert/README.md` explains that two-level `*.vox2.arcaai.com` names fail free Universal SSL, so the chosen fix is single-label `*-vox2.arcaai.com` names. `custom_cert/token_gen.md` is the fallback scoped-token + Let's Encrypt wildcard procedure if two-level names must remain. |

### 6.2 Recommended reading order in `cloudflared/`

**Current track (read in this order):**

1. `README.md` — provenance and current-vs-background split.
2. `current-setup.md` — cluster baseline as it was before the rollout.
3. `vox2-arcaai-com-routing.md` — confirmed hostname/backend decisions.
4. `steps_to_follow.md` — full runbook.
5. `manifests/README.md` → the four YAML manifests — the objects intended for GitOps/`kubectl`.
6. `rca_gateway_test.md` → `nitik/gateway-test-ingress.yaml` — the post-rollout incident and correct Ingress pattern.
7. `../observability/README.md` §3d and `../observability/manifests/10-ingress.yaml` — the downstream consumer of the tunnel.

**Background only (do not follow blindly):**

8. `custom_cert/README.md` → `custom_cert/token_gen.md` — superseded TLS fallback.
9. `cloudflare-tunnel-reference.md` → `reference/cloudflare-tunnel.md` → `reference/cloudflared.yaml` — reference-estate design rationale.
10. `traefik-k3s-findings.md` — keep for the middleware-format correction only.
11. `session_log.txt` and `nitik/for_gatway-test.txt` — evidence and cautionary examples, not instructions.

---

## 7. `observability/` — monitoring, logging, dashboards

### 7.1 Top-level documents

| File | What it contains |
|---|---|
| [`README.md`](./observability/README.md) | Core-3 stack overview (Prometheus, Alertmanager, Grafana), file/apply order, namespace and cluster prerequisites, conflict audit against the live cluster, Cloudflare dashboard steps, verification/rollback, and known caveats. Explicitly says **"Not applied yet"** — this folder is a review artifact. |
| [`LOGGING.md`](./observability/LOGGING.md) | Separate follow-on design for Loki + Promtail: current state, architecture, component roles, namespace scoping, storage/retention, security, rollout, verification, rollback, decisions, and GPU-box shipping. Describes logging as implemented/applied; use it for logging status. |

### 7.2 `observability/docs/` — numbered runbook

| File | What it contains |
|---|---|
| [`README.md`](./observability/docs/README.md) | Runbook index, what the stack builds, conventions, assumed existing setup, environment variables, golden rules, and file map |
| [`01-prerequisites.md`](./observability/docs/01-prerequisites.md) | Tools, cluster access, StorageClass `nfs-client`, IngressClass `traefik`, namespaces, Traefik/connector checks, Grafana admin Secret, network and firewall prerequisites |
| [`02-core-stack.md`](./observability/docs/02-core-stack.md) | Apply order and details for RBAC, Prometheus config, Prometheus, Alertmanager, Grafana provisioning, permissions Job, and Grafana |
| [`03-logging.md`](./observability/docs/03-logging.md) | Loki config/StatefulSet, Promtail DaemonSet, Loki NodePort `31100`, namespace scoping option, verification, and LogQL label reference |
| [`04-metrics-scraping.md`](./observability/docs/04-metrics-scraping.md) | Scrape jobs, node-exporter, kube-state-metrics, cAdvisor, `hope-apps` application metrics, GPU target wiring, alert rules, and coverage checks |
| [`05-dashboards.md`](./observability/docs/05-dashboards.md) | Dashboard management rule: edit `generate.py`, regenerate the ConfigMap, apply, **restart Grafana**, then verify; includes a description of each dashboard |
| [`06-ingress-dns-cloudflare.md`](./observability/docs/06-ingress-dns-cloudflare.md) | Apply Ingresses, request flow, Cloudflare public hostnames, DNS confirmation, security note, and end-to-end verification |
| [`07-gpu-server.md`](./observability/docs/07-gpu-server.md) | GPU host `192.168.112.2` telemetry: SSH bounce, copy/start bundle, verify from cluster and Grafana, `promtail-gpu.yml` behavior, optional DCGM, gotchas |
| [`08-verification.md`](./observability/docs/08-verification.md) | End-to-end checklist: workloads, Prometheus targets, metric coverage, GPU host, Loki ingestion, Grafana datasources/dashboards, alerting, public hostnames, NodePort, cleanup |
| [`09-troubleshooting.md`](./observability/docs/09-troubleshooting.md) | Fast triage and fixes for pods, NFS permissions, down targets, missing app metrics or logs, missing dashboards, credentials, ingress/DNS, alerting, GPU, cardinality, plus destructive reset |
| [`10-day2-operations.md`](./observability/docs/10-day2-operations.md) | Change management, alerts, retention, adding apps, Grafana admin, image upgrades, backup/restore, scaling, secret rotation, GPU maintenance, periodic health and security checks |
| [`11-dashboard-management.md`](./observability/docs/11-dashboard-management.md) | Two workflows: regenerate the managed ConfigMap from `generate.py`, or edit/import individual JSON files via UI, API, or ConfigMap |
| [`12-dashboard-update-procedure.md`](./observability/docs/12-dashboard-update-procedure.md) | Concrete end-to-end dashboard update procedure: generate individual JSONs, regenerate ConfigMap, apply, restart, verify counts, optional imports, troubleshooting |
| [`13-dashboard-import-and-prometheus-update.md`](./observability/docs/13-dashboard-import-and-prometheus-update.md) | Record of importing 7 dashboards and proposed Prometheus/datasource changes for the rest (Postgres, Redis, PgBouncer, Temporal). Several counts and claims here are stale; verify against the JSON. |
| [`appendix-file-map.md`](./observability/docs/appendix-file-map.md) | Directory tree, manifest map, apply order, variables, and doc cross-links. Known to be stale in places; do not treat its counts as authoritative. |
| [`migrate_dashboard.md`](./observability/docs/migrate_dashboard.md) | Datasource/UID migration notes (`hope-prometheus` → `prometheus`, `hope-postgres`, `unknown` datasource, templating). Read with `13`; it also contains outdated claims. |

### 7.3 `observability/manifests/` — Kubernetes objects

Apply in numeric order.

| Files | Purpose |
|---|---|
| `01-rbac.yaml` | ServiceAccount/ClusterRole/Binding, de-collided as `project-hope-vox-prometheus` |
| `02-prometheus-config.yaml` | Prometheus template ConfigMap and alert-rules ConfigMap (10 scrape jobs, 6 alert rules) |
| `03-prometheus.yaml`, `04-alertmanager-config.yaml`, `05-alertmanager.yaml` | Prometheus StatefulSet/Service/PVC; Alertmanager config, StatefulSet/Service/PVC |
| `06-grafana-provisioning.yaml` | Prometheus + Loki datasources and dashboard provider |
| `07-grafana-dashboards.yaml` | Generated ConfigMap with 13 managed dashboards; generated from `dashboards/generate.py` — do not hand-edit |
| `08-grafana-permissions.yaml`, `09-grafana.yaml` | Grafana PVC and chown Job; Grafana Deployment/Service |
| `10-ingress.yaml` | Traefik Ingresses for `grafana-vox2` / `prometheus-vox2` / `alertmanager-vox2.arcaai.com` |
| `11-loki-config.yaml`, `12-loki.yaml`, `13-promtail.yaml`, `14-loki-nodeport.yaml` | Loki config/StatefulSet, Promtail DaemonSet, and LAN-only NodePort 31100 for the GPU shipper |
| `15-node-exporter.yaml` | Node-exporter DaemonSet across the 6 lab nodes |
| `grafana-secret.yaml.example` | Placeholder only; the real `grafana-admin` Secret is created out of band |
| `manifests/dashboards/*.json` | 21 individual dashboard JSONs kept for study/import: 12 from `project-hope`, 4 older `smr-*` forks, 5 from archived TASK-251 |

### 7.4 `observability/dashboards/` and `gpu-box/`

| Path | Purpose |
|---|---|
| [`dashboards/generate.py`](./observability/dashboards/generate.py) | **Source of truth** for the 13 dashboards embedded in `manifests/07-grafana-dashboards.yaml`; regeneration matches the committed ConfigMap |
| [`dashboards/generate_individual.py`](./observability/dashboards/generate_individual.py) | Provenance script for the 21 individual JSONs; still writes to the stale `review/observability/...` path |
| [`dashboards/*.json`](./observability/dashboards/) | 12 working dashboard JSONs, structurally the same as their `manifests/dashboards/` counterparts |
| [`gpu-box/`](./observability/gpu-box/) | Off-cluster GPU host telemetry: `docker-compose.yml`, `dcgm-exporter.compose.yml`, `promtail-gpu.yml`, and `README.md` for host `192.168.112.2` |

### 7.5 Recommended reading order in `observability/`

1. `README.md` — intended stack, apply order, conflict audit.
2. `LOGGING.md` — correct the status assumption for logging.
3. `docs/README.md` → `docs/01`–`docs/08` — deployment/verification narrative in order.
4. `manifests/01`–`15` in numeric order, paying most attention to `02`, `06`, `07`, `08`, `10`.
5. `dashboards/generate.py` — learn the dashboard source of truth.
6. `docs/09` — troubleshooting when something fails.
7. `docs/10` — day-2 operations once it is running.
8. `docs/11`–`13`, `migrate_dashboard.md`, `appendix-file-map.md` — read last and verify claims against the actual JSON/YAML.
9. `gpu-box/` and `docs/07` — only when working on the GPU host.

---

## 8. Caveats, conflicts, and sensitive material

### 8.1 Path drift

Many documents still use the original research path `/Users/apple/repos/VOX/review/...`. The actual files here are under `/Users/apple/repos/VOX/vox-platform-study/code_review/...`. Notable examples: `codewalk/vox.md` diagram index, `codewalk/LOCAL_BUILD_DEPLOY_RUNBOOK.md` §A1, `observability/docs/11`–`12`, `observability/dashboards/generate_individual.py`, `cloudflared/rca_gateway_test.md`, `cloudflared/session_log.txt`, and sibling references to `review/deploy/11-traefik-ingress-setup.md` and `review/cloudflared/current-setup.md`. Use the relative links in this document rather than the old absolute paths.

### 8.2 Conflicting facts to verify

- **Estate mixing:** most of `deploy/` describes k3s / `hope-v2-dev` / `taphuynh.dev`; `cloudflared/` and `observability/` describe kubeadm / `project-hope-vox*` / `hope-vox2` / `arcaai.com`.
- **Hostname drift:** `steps_to_follow.md`, `manifests/README.md`, `vox2-arcaai-com-routing.md`, and `observability/README.md` §3d mostly use two-level names such as `grafana.vox2.arcaai.com`, while the committed Ingress YAML in both `cloudflared/manifests/` and `observability/manifests/10-ingress.yaml` uses single-label names such as `grafana-vox2.arcaai.com`. Two-level names do not work with free Universal SSL; reconcile before applying.
- **`current-setup.md` is a snapshot:** it says no HOPE tunnel/Ingress existed on 2026-10-13, but `session_log.txt` shows those objects being created the same day and the RCA confirms `hope-vox2` running later.
- **Ingress middleware format:** `deploy/11` uses `project-hope-vox/hope-no-buffer@kubernetescrd`; `cloudflared/traefik-k3s-findings.md` and the lab manifests use `project-hope-vox-hope-no-buffer@kubernetescrd`.
- **Ingress backend port:** always use the **Service port**, not the container `targetPort`; see `rca_gateway_test.md`.
- **Service ports:** the service codewalk docs and deployment docs disagree on several ports (e.g. `tts`, `text`, `nlp`, `guardrail`). Verify against live manifests/source before relying on a number.
- **Route names:** `api.md` uses `/api/v1/streaming/ws` while BREN/GPU docs use `/ws/stt/stream`; guardrail and TTS routes also differ between docs. Treat the BREN doc as a trace, not the route registry.
- **Counts:** `codewalk/vox.md` says 9 apps / 36 packages; `deploy/01` says 11 apps / 27 packages. `observability/docs/13` says 7 imports / 20 total, `migrate_dashboard.md` says 12 dev / 25 total; actual committed sets are 13 embedded dashboards and 21 individual JSONs. `docs/04` says 4 alert rules while `02-prometheus-config.yaml` defines 6.
- **Dashboard staleness:** the 4 `smr-*` dashboards are metric-renamed forks of `text-*` dashboards, but there is no `smr_*` scrape job, so they will be empty. Some JSONs still reference `hope-prometheus`, `hope-postgres`, `${DS_PROMETHEUS}`, DCGM, Redis, or PgBouncer datasources/jobs that are not provisioned.
- **Missing files:** `codewalk/vox.md` lists `smr.md`, which does not exist. `docs/appendix-file-map.md` omits newer docs and generators.

### 8.3 Sensitive material — exclude or redact for external handover

| File | Issue |
|---|---|
| [`cloudflared/session_log.txt`](./cloudflared/session_log.txt) | Contains a full plaintext Cloudflare tunnel token in the `kubectl create secret ...` command. Rotate/revoke if it was ever real; do not copy the value. |
| [`cloudflared/nitik/for_gatway-test.txt`](./cloudflared/nitik/for_gatway-test.txt) | Plaintext Redis, Vault AppRole, and PostgreSQL credentials in env dumps. Redact/exclude. |
| [`cloudflared/current-setup.md`](./cloudflared/current-setup.md) | Documents that plaintext secrets exist in workload env vars; values shown masked. Treat as a security finding. |
| [`observability/docs/10-day2-operations.md`](./observability/docs/10-day2-operations.md) | Reports a leaked Cloudflare API token in an external `cf/cf-le/cf.ini` file. Treat any copied token as compromised. |
| `deploy/05`, `deploy/08`, `codewalk/LOCAL_BUILD_DEPLOY_RUNBOOK.md`, `codewalk/STT_TEXT_GPU_DEPLOY.md` | Mostly placeholders and dev-only values, but they describe Vault root/AppRole/unseal handling. Keep real values out of these docs. |

No secret values are reproduced in this index.

---

## 9. Handover checklist

- [ ] Decide which estate you are working on before applying any command: reference k3s (`deploy/`, `cloudflared/reference/`) or lab kubeadm (`cloudflared/` current track, `observability/`).
- [ ] Replace old `review/...` paths with this folder's relative paths when re-running commands.
- [ ] For code questions, start with `codewalk/vox.md` and the relevant service doc + diagram prefix.
- [ ] For local builds, prefer `deploy/09` + `deploy/10` as the fastest executable path; keep `deploy/02` open for dependencies.
- [ ] For cluster deployment, do `deploy/05` → `deploy/06` → `deploy/08` before any sync; keep `deploy/07` handy.
- [ ] For public access, follow `cloudflared/README.md` current track only; treat `custom_cert/` and `reference/` as background.
- [ ] Reconcile two-level vs single-label hostnames before touching DNS/Ingress; verify Ingress `service.port.number` against the Service port.
- [ ] For monitoring, treat `observability/dashboards/generate.py` as the dashboard source of truth and restart Grafana after ConfigMap changes.
- [ ] Redact or exclude the sensitive files in §8.3 before sharing this bundle externally.
- [ ] Re-verify versions, ports, hostnames, and secret inventory against the live cluster/source; these documents are point-in-time research artifacts, not an executable source of truth.
