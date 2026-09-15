# API Gateway Docs — narrative documentation for apps/api

Five long-form documents supplementing `apps/api/README.md`. They predate several current
platform decisions (see Gotchas) — treat them as background reading, not as the authoritative
description of how the gateway is built, authorized, or deployed today.

## Layout

| Document | Covers |
|---|---|
| `01-implementation-status.md` | Feature-completion tracker |
| `02-development-guide.md` | Local dev setup, feature-creation walkthrough |
| `03-usage-guide.md` | Client-facing endpoint/auth usage examples |
| `04-deployment-guide.md` | Deployment options and environment configuration |
| `05-api-reference.md` | Guards, decorators, interceptors, controllers reference |

## How it works

These are hand-maintained narrative docs, not generated artifacts — nothing regenerates them from
the code the way `route-manifest.json`/`openapi.json` are regenerated (see
`docs/operations/api-documentation.md`). For anything that must be exactly right, prefer:

- **What routes exist, their auth requirements, and their shapes**: `apps/api/route-manifest.json`
  and `apps/api/openapi.json` (generated, drift-gated), or the interactive Swagger UI at
  `/api/v1/docs` in a running dev instance.
- **The guard pipeline, authorization decorators, and OCC contract**: `apps/api/README.md` and
  `.claude/rules/05-nestjs-api.md`, verified directly against `src/app.module.ts`.
- **Deployment**: the separate `arca/hope-v2-deployment` repository is the sole owner of cluster
  manifests (Kustomize overlays, not Helm); see `.claude/rules/09-infrastructure-devops.md`.

## Gotchas

- `04-deployment-guide.md` describes a systemd single-server path and a Helm-based Kubernetes
  path. Neither matches the current deployment: cluster manifests live entirely in the separate
  `hope-v2-deployment` repository and are rendered with Kustomize, and
  `infrastructure/single-deployment/` in this repo is a retired design record, not a runnable
  target. Read `.claude/rules/09-infrastructure-devops.md` for the live deployment path before
  acting on that guide.
- These documents carry their own "Last Updated" dates in their headers — check the date before
  trusting a specific claim, and prefer the generated artifacts or the rule files when they
  disagree.

## Related

- `../README.md` — this app's own README (layout, commands, guard pipeline, OCC, doc-artifact pipeline)
- `../../../docs/operations/api-documentation.md` — the generated-documentation pipeline
- `../../../.claude/rules/05-nestjs-api.md` — the authoritative gateway contract
- `../../../.claude/rules/09-infrastructure-devops.md` — the authoritative deployment path
