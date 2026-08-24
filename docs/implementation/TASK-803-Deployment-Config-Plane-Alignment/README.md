# TASK-803 — Deployment Manifest Alignment with the Consolidated Config Plane

| Field | Value |
|---|---|
| Status | Review |
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

## Change History

| Date | Change |
|---|---|
| 2026-08-25 | Ticket opened; current-state evaluation recorded. |
| 2026-08-25 | Manifests aligned and pushed as `18821c6`; Argo auto-synced to it. |
| 2026-08-25 | Follow-up `36ba06e`: wired the Redis clients owner decision D-5 added to nlp/tts/harness-worker (the first commit carried a comment asserting the opposite, quoting a Round-2 statement D-5 superseded), `HARNESS_TEMPORAL_METRICS_HOST=0.0.0.0`, and `DEPLOYMENT_ENVIRONMENT`. |
| 2026-08-25 | Cluster DB reset + reseeded with `SECRETS_PROVIDER=vault`; all four self-hosted engine rows seeded `(enabled, keyed)`. |
