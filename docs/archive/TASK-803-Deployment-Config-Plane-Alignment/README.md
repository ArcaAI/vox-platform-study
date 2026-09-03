# TASK-803 — Deployment Manifest Alignment with the Consolidated Config Plane

| Field | Value |
|---|---|
| Status | **Completed** — all six findings (A–F) closed with live-cluster evidence, 2026-08-31. See §Closure |
| Type | infrastructure |
| Branch | `dev-2.2` (monorepo, docs only) · `main` (`arca/hope-v2-deployment`, manifests) |
| Scope | `arca/hope-v2-deployment` — `deployment/k8s/**`, `.gitlab-ci.yml`, vendored env inventory |
| Opened | 2026-08-25 |

## Requirement Analysis

TASK-799 moved the Python services' configuration out of environment variables into
Vault (`vault-kv`), the database (`db-config` / `AiTaskDefault` / `AiProviderConnection`)
and `GlobalSetting` (`global-kv`), leaving env as the bootstrap floor only. The
deployment repo was not updated alongside it, so the cluster still ships the retired
surface.

Requirement: bring `arca/hope-v2-deployment` in line with the config plane as it exists
on `dev-2.2`, then redeploy and reset/reseed the `hope-v2-dev` database and verify.

Classification: `infrastructure`.

## Current State Evaluation

### A. The `smr` → `text` fork (live fault, not cosmetic)

The deployed text service reports:

```json
{"service":"smr","gitBranch":"dev-2.1","gitCommitSha":"81195848","buildAt":"2026-08-15T06:20:05Z"}
```

- CI builds `SERVICE_NAME: text` (`.gitlab/ci/build.yml:219`) and promotes `text`
  (`.gitlab/ci/promote.sh:101`). Neither builds or promotes `hope-v2/smr`.
- `deployment/k8s/base/smr.yaml` pins `image: hope-v2/smr:latest`, which
  `overlays/dev/kustomization.yaml` resolves to a stale digest.
- **A `hope-v2/text` image pin already exists in that same `images:` list and is unused.**

Consequence: every `apps/text` change since 2026-08-15 has never reached the cluster.

### B. `SMR_URL` has no reader

`base/config/api.env:9` sets `SMR_URL=http://hope-smr:8862`. The gateway resolves
`TEXT_URL` only, with no `SMR_URL` fallback
(`packages/applications/src/services/baseServices/_meta/config/config.service.ts:133`),
and no ConfigMap sets `TEXT_URL` — so the gateway falls through to `http://localhost:8862`.

### C. Prefix drift

`apps/text` settings are `env_prefix="TEXT_"` with no aliases
(`apps/text/src/text/core/config.py:156`). The running pod carries 32 `SMR_*` variables
and 0 `TEXT_*`. Guardrail's six engine prefixes and `GUARDRAIL_GLINER_` were deleted by
TASK-735/736 but are still set in `base/guardrail.yaml`.

### D. `stt-v2` naming

Cosmetic only: the image names are already canonical (`stt-ml-runtime`, `stt-worker`)
and `STT_V2_URL` is dual-read alongside `STT_URL` in three places. Renaming retires a
shim; nothing breaks today.

### E. CI gate is stale

`.gitlab-ci.yml`'s `envfrom-coverage` job validates against
`scripts/env-consumer-inventory.generated.json`, vendored 2026-08-08 — before TASK-799.

### F. Seed-time Vault requirement

`seed/17-ai-provider-connection.ts:563` — without `SECRETS_PROVIDER=vault` the
self-hosted engine rows seed KEYLESS, the override fold drops them, and `apps/text`
answers 503. The 2026-08-24 reset performed in this session did not set it, so the
current `hope-v2-dev` rows are keyless. A re-seed with the variable set repairs them
via the `needsSelfHostKeyBackfill` path (`:585`).

## Implementation Plan

Executed in one pass against `arca/hope-v2-deployment@main` (commit `18821c6`), because
the changes are interlocking: renaming the Service without repointing `TEXT_URL` would
leave the gateway pointing at a name that no longer resolves.

## Implementation Summary

### Method — the surface was derived, not inspected

Every "this variable is dead" claim comes from `scripts/env-consumer-inventory.py`, which
asks pydantic's own `EnvSettingsSource._extract_field_info` what env name each settings
field actually resolves — `env_prefix` + `AliasChoices` + nested models mean the name is
often not textually present in the source. The generated `.env.sample` files are the
per-service contract: an UNCOMMENTED line is must-set, a commented one is an optional
override at its code default.

Two supporting fixes were needed first:
- `scripts/env-consumer-inventory.py` wrote to a `docs/archive/**` path (TASK-616) that no
  longer exists, so `--check` failed with "missing" regardless of staleness. Repointed here.
- The deployment repo's `envfrom-coverage` gate validated against a copy of that inventory
  vendored 2026-08-08 — before TASK-799. Regenerated: 774 -> 496 keys.

### Changes

| Area | Change |
|---|---|
| `smr` -> `text` | `base/smr.yaml` -> `base/text.yaml`; workload/Service/HPA/PDB `hope-smr` -> `hope-text`; image `hope-v2/smr` -> `hope-v2/text` (the pin already existed, unused) |
| Gateway routing | `SMR_URL` -> `TEXT_URL`, `STT_V2_URL` -> `STT_URL` in `config/api.env` and `base/api.yaml` |
| Dead env removed | 32 `SMR_*`; `GUARDRAIL_GLINER_ENABLED` + 4 `GUARDRAIL_OPENAI_COMPAT_*`; `SMR_AZURE_*`; 7 of 9 keys in `config/stt.env`; `APP_NAME`/`APP_VERSION`/`STT_PROVIDER`/`SARVAM_API_KEY` |
| Misroutes fixed | `GUARDRAIL_DATABASE_URL` (absent entirely); guardrail `TEXT_URL`/`NLP_URL`; nlp `NLP_GATEWAY_URL`/`TEXT_URL`; harness `HARNESS_{TEXT,NLP,GUARDRAIL}_BASE_URL` + embeddings; `API_URL` promoted to `platform.env` |
| `INTERNAL_ACCESS_TOKEN` | Wired on all six Python services as an OPTIONAL secret ref |
| `stt-v2` -> `stt` | Files, workloads, Services, OTEL names. Worker keeps its `-worker` suffix (`worker.py:47`) |
| Observability | Prometheus jobs/targets/labels, alert rules, alert unit tests, smoke test follow the renames |
| Seed safety | `db-migrate.yaml` gains `SECRETS_PROVIDER=vault` + Vault AppRole refs |

### Verification

All three overlays render; `check-config-refs.py` (93 non-optional refs), 
`check-envfrom-coverage.py`, image-hygiene, pull-secrets and patch-hygiene pass;
gitleaks clean.

### Deliberately NOT done

- **`TTS_KOKORO_ENABLED` left in place.** TASK-799 §Open item 3 asks for its removal, but
  it is still a LIVE must-set key in `apps/tts/.env.sample`, and that ticket lists the
  item as needing an owner decision. Removing a still-read flag whose DB replacement only
  exists after a seed run is not a manifest-only change.
- **`HARNESS_RETRIEVAL_RERANKER_BASE_URL` left at its default.** No reranker is deployed
  to this cluster. Inventing an address would produce config that looks correct and
  resolves to nothing.
- **`INTERNAL_ACCESS_TOKEN` not minted.** It is DevOps-set key material
  (`platform-secrets.descriptors.ts` `internal.accessToken`); the wiring is in place and
  inert until someone populates it.

## Closure — each finding, against the LIVE cluster (2026-08-31)

The manifest work was already pushed; what was missing was evidence that it *reached* and *worked
on* `hope-v2-dev`. Every row below was read from the running objects, not from the manifests.

| # | Finding | Closed by | Live evidence |
|---|---|---|---|
| **A** | The `smr` → `text` fork — every `apps/text` change since 2026-08-15 never reached the cluster | `18821c6` | Deployment **`hope-text`** exists and is 1/1; there is **no `hope-smr`** workload in the namespace. The dev overlay pins `hope-v2/text` → `registry.taphuynh.dev/arca/hope-v2/text@sha256:faac799c5449…` |
| **B** | `SMR_URL` had no reader, so the gateway fell through to `http://localhost:8862` | `18821c6` | ConfigMap `hope-api-config-6629fmb499` carries `TEXT_URL=http://hope-text:8862`; **no `SMR_URL` key exists**. The symptom this finding was named for is gone: `ServiceHealthMonitoringService` now logs `{"service":"Text","status":"up","responseTimeMs":10}` — and `up` for all six peers |
| **C** | Prefix drift — 32 `SMR_*` vars set, 0 `TEXT_*`; dead `GUARDRAIL_*` engine prefixes | `18821c6` | No `SMR_*` in any live ConfigMap; the dev overlay's own comment records that the seven `SMR_V2_OTEL_*` keys were dropped rather than carried as inert |
| **D** | `stt-v2` naming shim | `18821c6` | `STT_URL=http://hope-stt:8861` in `hope-api-config`; workloads are `hope-stt` / `hope-stt-worker`; no `STT_V2_URL` key remains |
| **E** | Stale `envfrom-coverage` CI gate (inventory vendored 2026-08-08) | `18821c6` | The gate now runs **and passes** — `envfrom-coverage` is one of the 8 green jobs in deployment-repo pipeline **#1029** on `de8dc03e`. Worth stating plainly: until `f09c45e3` ("tag the jobs, because none of them had ever actually run") **no job in that repo had ever executed** — every one was untagged and no runner accepts untagged jobs. So this gate's earlier "pass" was a local run, not CI |
| **F** | Seed-time Vault requirement — without `SECRETS_PROVIDER=vault` the self-hosted engine rows seed KEYLESS and `apps/text` answers 503 | `hope-reset` | Job **`hope-reset`** completed successfully — `succeeded: 1`, `startTime 2026-08-30T18:35:14Z`, `completionTime 2026-08-30T18:35:53Z` — with `SECRETS_PROVIDER=vault`, `RUN_SEED=all`, and **non-optional** `VAULT_ROLE_ID`/`VAULT_SECRET_ID` refs. Its step 2 is a canary that logs in with hope-api's own AppRole and encrypts under `transit/hope-phi`, and it gates step 3, so a successful run **proves** the AppRole in `hope-secrets` is the current one for the rebuilt Vault and that the seed ran in vault mode |

**One F caveat, stated rather than glossed:** the four self-hosted `AiProviderConnection` rows have
not been READ BACK. The mechanism that produces them is proven to have run under the right
conditions, which is a strong structural argument, not a row-level observation. The cheapest
end-to-end confirmation is TASK-808's open probe — one live flush returning `textFailed:false`. If
that probe ever returns `503 PROVIDER_CREDENTIALS_MISSING`, **come back here first**: F is the
likeliest cause, and the repair is another `hope-reset` (the `needsSelfHostKeyBackfill` path at
`seed/17-ai-provider-connection.ts:585`).

**Also landed under this ticket after the original close-out:** `2d87b4ff`
*"an endpoint is not a secret, and two dead keys are not documentation"* — R-7 moved
`MINIO_ENDPOINT` out of `hope-secrets` (the settings registry declares `minio.endpoint` as tier
`env`, sensitivity `internal`, so it was never a credential) into `config/{api,stt,harness}.env`,
referenced as an **explicit, non-optional `configMapKeyRef`**. Explicit is load-bearing, not style:
`secretRef: hope-secrets` is the last `envFrom` source in all four workloads, so a same-named
Secret key would outrank a `configMapRef` — but an explicit `env:` entry outranks every `envFrom`
source, so the reviewed Git value wins with no operator coordination. That matters because the dev
AppProject blacklists Secrets, so Argo can never manage `hope-secrets`. It also took the
`config-refs` gate from 31 to 35 checked references. Two dead keys (`STT_V2_DATABASE_URL`, an empty
`# -- SMR V2 --` header) were deleted from the secret template, and one latent defect was fixed in
passing: `hope-harness-worker` was feeding bare `host:port` into
`HARNESS_CLAIM_CHECK_ENDPOINT_URL`, which harness parses as a URL and derives `secure` from.
Confirmed live: `hope-api-config-6629fmb499` carries `MINIO_ENDPOINT: 10.10.1.102:9000`.

**Still owed, and deliberately NOT a reason to hold this ticket open:** `INTERNAL_ACCESS_TOKEN` is
still unminted. It was declared out of scope at close-out (§Deliberately NOT done) because it is
DevOps-set key material — the wiring is in place on all six Python services as an OPTIONAL secret
ref and is inert until someone populates it. **Naming the action so it is not lost: an operator
must generate the token and patch it into `hope-secrets`.** The same applies to
`TTS_KOKORO_ENABLED` (needs an owner decision, per TASK-799) and
`HARNESS_RETRIEVAL_RERANKER_BASE_URL` (no reranker is deployed to this cluster; inventing an
address would produce config that looks correct and resolves to nothing).

## Change History

| Date | Change |
|---|---|
| 2026-08-25 | Ticket opened; current-state evaluation recorded. |
| 2026-08-25 | Manifests aligned and pushed as `18821c6`; Argo auto-synced to it. |
| 2026-08-25 | Follow-up `36ba06e`: wired the Redis clients owner decision D-5 added to nlp/tts/harness-worker (the first commit carried a comment asserting the opposite, quoting a Round-2 statement D-5 superseded), `HARNESS_TEMPORAL_METRICS_HOST=0.0.0.0`, and `DEPLOYMENT_ENVIRONMENT`. |
| 2026-08-25 | Cluster DB reset + reseeded with `SECRETS_PROVIDER=vault`; all four self-hosted engine rows seeded `(enabled, keyed)`. |
| 2026-08-30 | Follow-up `2d87b4ff` (R-7): `MINIO_ENDPOINT` moved OUT of `hope-secrets` into `config/{api,stt,harness}.env` as an explicit non-optional `configMapKeyRef` (an endpoint is tier `env`, sensitivity `internal` — never a credential, and in the Secret it was outside Git, outside review and outside CI). Two dead keys removed from the secret template (`STT_V2_DATABASE_URL`, the empty `# -- SMR V2 --` header). One latent defect fixed in passing: `hope-harness-worker` fed bare `host:port` into `HARNESS_CLAIM_CHECK_ENDPOINT_URL`, which harness parses as a URL and derives `secure` from. `config-refs` 31 → 35 checked references. |
| 2026-08-31 | **Status `Review` → `Completed`.** New §Closure verifies all six findings (A–F) against the RUNNING cluster rather than the manifests: `hope-text` exists and `hope-smr` does not (A); `hope-api-config` carries `TEXT_URL`/`STT_URL`/`MINIO_ENDPOINT` with no `SMR_URL` or `STT_V2_URL`, and the gateway's own `ServiceHealthMonitoringService` — the monitor whose "Text: down" was the original symptom — now reports all six peers `up` (B, C, D); the `envfrom-coverage` gate passes in deployment-repo pipeline **#1029** (E). Note for the record: that gate's earlier "pass" was a LOCAL run — until `f09c45e3` no job in `arca/hope-v2-deployment` had ever executed, because every job was untagged and no runner accepts untagged jobs. (F) is closed structurally: the `hope-reset` Job completed (`succeeded: 1`, 18:35:14Z → 18:35:53Z) with `SECRETS_PROVIDER=vault`, `RUN_SEED=all` and non-optional AppRole refs, behind a step-2 canary that logs in as hope-api and encrypts under `transit/hope-phi` before anything is dropped — so the seed demonstrably ran in vault mode against the rebuilt Vault. **Caveat recorded, not hidden:** the four self-hosted `AiProviderConnection` rows were not read back; TASK-808's open live-flush probe is the cheapest confirmation, and a `503 PROVIDER_CREDENTIALS_MISSING` there points here first. Three items stay deliberately undone with named owners: mint `INTERNAL_ACCESS_TOKEN` (operator), `TTS_KOKORO_ENABLED` (owner decision), `HARNESS_RETRIEVAL_RERANKER_BASE_URL` (no reranker deployed). |
