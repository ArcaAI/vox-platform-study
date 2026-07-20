# TASK-416 — K3s Image Pipeline Fixes (Overlay Tags, Guardrail, NLP Registration)

- **Ticket:** TASK-416
- **Created:** 2026-07-04
- **Updated:** 2026-07-04
- **Status:** Pending
- **Type:** infrastructure / bugfix

## Requirement Analysis

Follow-up to TASK-414. While fixing the overlay kustomizations, the deployment review found three pre-existing gaps in the k3s image pipeline (all confirmed via `kubectl kustomize` renders, kustomize v5.6.0; recorded in `docs/implementation/TASK-414-Known-Issues-Remediation/README.md`, "Newly Discovered Issues"). They were not fixed in TASK-414 because each changes rendered manifests, and the dev ArgoCD Application auto-syncs from `main` (prune + self-heal) — fixes must be deliberately reviewed and rolled out.

### The three gaps

1. **Overlay `newTag` pins never take effect.** Kustomize applies the `registry` component's `newName` rewrite (`hope-v2/*` → `registry.taphuynh.dev/arca/hope-v2/*`) before the overlay `images:` blocks, whose entries still match the original `hope-v2/*` names. Result: every service in both dev and prod renders as `registry.taphuynh.dev/arca/hope-v2/*:latest` — and `latest` is a tag CI never pushes (verified "NO latest tag" policy in `.gitlab-ci.yml`), so pods cannot pull. Caveat comments were left in both overlays and a "Known gap" note in `deployment/README.md` (see the comments marked TASK-414).
2. **`guardrail` image is unmanaged everywhere** — not rewritten by the registry component, not pinned by either overlay, not tracked by Image Updater; renders as an unqualified docker.io name (`hope-v2/guardrail:latest`) that can never be pulled from the private registry.
3. **`nlp.yaml` exists in `k3s/base/` but is not registered in `k3s/base/kustomization.yaml`** — no NLP workload renders at all; the overlays' `hope-v2/nlp` image entries and the prod bootstrap example's `nlp` Image Updater alias (added in TASK-414) are inert until it is registered.

## Acceptance Criteria

1. `kubectl kustomize deployment/k3s/overlays/dev` and `.../prod` render every service image as `registry.taphuynh.dev/arca/hope-v2/<svc>:<pinned-tag>` where `<pinned-tag>` is a tag format CI actually pushes (`dev-<sha8>` / `staging-<sha8>` / semver / `sha-<sha8>`) — zero `:latest` anywhere in either render.
2. `guardrail` is registry-rewritten, tag-pinned in both overlays, and (prod) covered by the Image Updater alias set.
3. NLP renders in both overlays with correct registry name and pinned tag.
4. Strict duplicate-key YAML validation still passes on all files under `deployment/`; before/after renders are diffed and every change is intentional and reviewed.
5. Rollout plan agreed before merge (dev auto-syncs from `main` — merging IS deploying to dev).

## Current State Evaluation

- Both overlays carry explanatory caveat comments (TASK-414) at their `images:` blocks.
- The registry component: `deployment/k3s/components/registry/` (image `newName` rewrites + `imagePullSecrets` injection). Its rewrite list omits `guardrail`.
- Real CI tag streams (verified in TASK-414 from `.gitlab-ci.yml` + `.gitlab/ci/*`): `dev-<sha8>`, `staging-<sha8>`, `cicd-<sha8>`, `<branch>-<sha8>`, immutable `sha-<sha8>`; semver `X.Y.Z`/`X.Y`/`X` on `v*` tags. Never `latest`. `deploy-staging` writes Helm values to the separate `hope-deployments` repo; the in-repo overlays are the ArgoCD kustomize flow.
- Related but out of scope here: Harness + Temporal have no k3s manifests at all; Postgres/MinIO are external by design (documented in `deployment/README.md`, "Database provisioning").

## Implementation Plan (proposal — requires approval before any manifest change)

1. **Fix the ordering bug** (pick one, decide in review):
   - (a) Change both overlays' `images:` entries to match the post-rewrite names (`registry.taphuynh.dev/arca/hope-v2/<svc>`), keeping the registry component as-is; or
   - (b) Drop the separate registry component's image rewrite and do `newName` + `newTag` together in each overlay's `images:` block (component keeps only the `imagePullSecrets` patch).
   Option (b) keeps name+tag in one place and removes the ordering trap permanently; option (a) is the smaller diff. Recommendation: (b).
2. **Add `guardrail`** to the chosen image-management path (rewrite + pin in both overlays; add prod Image Updater alias).
3. **Register `nlp.yaml`** in `k3s/base/kustomization.yaml`; verify its ConfigMap/Secret/resource requirements render sanely in both overlays.
4. **Choose initial pinned tags** for every service from tags that actually exist in the registry (coordinate with whoever owns the registry; `sha-<sha8>` of the current deployed builds is the safest starting pin).
5. **Verification:** strict YAML parse of all `deployment/` files; `kubectl kustomize` diff pre/post for dev and prod with every hunk reviewed; grep renders for `:latest` (must be zero); dry-run `kubectl apply --dry-run=server` against a non-prod cluster if available.
6. **Rollout:** merge to a branch, review rendered diffs, then merge to `main` (auto-deploys dev) with a monitoring window; prod follows via the `prod` branch (manual sync).

## Implementation Summary

_(pending)_

## Change History

| Date | Description | Files |
|---|---|---|
| 2026-07-04 | Ticket created from TASK-414 "Newly Discovered Issues"; plan proposed, awaiting approval. | — |
