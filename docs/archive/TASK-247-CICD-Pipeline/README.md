# TASK-247: CI/CD Pipeline Rebuild

| Field | Value |
|-------|-------|
| Ticket | TASK-247 |
| Created | 2026-03-23 |
| Updated | 2026-03-23 |
| Status | **Completed** |

---

## Requirement Analysis

### Description

Rebuild the GitLab CI/CD pipeline with proper branch strategy (`cicd`, `staging`, `release`), image versioning (no `latest` tag), SDK package publishing via GitLab Package Registry, and Argo CD integration for staging deployments.

### Acceptance Criteria

- [x] Pipeline stages: install, validate, test, build, scan, publish, deploy, notify
- [x] `cicd` branch: runs all stages, builds require manual approval
- [x] `staging` branch: runs only changed services, auto-builds, triggers Argo CD
- [x] `release` branch: publishes SDK packages to GitLab Package Registry
- [x] `main` branch: same as staging behavior
- [x] `devops/*` branches: lint + test only (no builds)
- [x] MR pipelines: lint + test + source scan (no builds)
- [x] No `latest` tag — proper semver/sha-based image versioning
- [x] Runner tags: `node`, `python`, `build`, `deploy`
- [x] Trivy pinned to specific version (not `latest`)
- [x] Changesets-based SDK publishing workflow documented

---

## Branch Strategy

| Branch | Pipeline Type | Validate | Test | Build | Scan | Publish | Deploy | Notify |
|--------|-------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `cicd` | cicd | All | All | Manual approval | Source | - | - | - |
| `staging` | staging | Changed | Changed | Auto (changed) | Container + source | - | Argo CD | GitHub backup |
| `release` | release | - | - | - | Source | SDK packages | - | - |
| `main` | main | Changed | Changed | Auto (changed) | Container + source | - | - | GitHub backup |
| `devops/*` | feature | Changed | Changed | - | - | - | - | - |
| MR | merge_request | Changed | Changed | - | Source | - | - | - |
| Tag `v*` | tag_release | All | All | All | Container + source | - | - | GitHub backup |

---

## Image Versioning

**No `latest` tag is ever produced.** Every image tag is traceable to a specific commit.

| Trigger | Tags Produced | Example |
|---------|--------------|---------|
| Tag `v1.2.3` | `1.2.3`, `1.2`, `1`, `sha-a1b2c3d4` | Semver + rolling major/minor |
| `staging` push | `staging-a1b2c3d4`, `sha-a1b2c3d4` | Environment-prefixed |
| `cicd` push | `cicd-a1b2c3d4`, `sha-a1b2c3d4` | Environment-prefixed |
| `main` push | `main-a1b2c3d4`, `sha-a1b2c3d4` | Environment-prefixed |
| `devops/*` push | `devops-foo-a1b2c3d4`, `sha-a1b2c3d4` | Branch-slug-prefixed |

The `sha-<sha8>` tag is always present as an immutable audit trail reference.

---

## Runner Tags

| Tag | Runner Type | Jobs | Resource Notes |
|-----|-----------|------|----------------|
| `node` | Node.js runner | lint-ts, typecheck, install-node, test-api, test-packages, test-sdk, scan-source, publish-sdk | 4GB RAM, 2 CPU |
| `python` | Python runner | lint-python, test-stt, test-smr, test-nlp | 4GB RAM, 2 CPU |
| `build` | Docker builder (Buildx) | All Docker image builds, container scans | 8GB RAM, 4 CPU, `privileged: true` |
| `deploy` | Deploy runner | deploy-staging, sync-argocd, github-backup | 2GB RAM, 1 CPU |

---

## Package Registry Setup (for `release` branch)

### Prerequisites

1. **Enable Package Registry** in GitLab:
   - Settings -> General -> Visibility -> Package registry -> Everyone with access

2. **Create Project Access Token**:
   - Settings -> Access Tokens -> Add new token
   - Name: `npm-publish`
   - Role: Developer
   - Scopes: `api`, `read_package_registry`, `write_package_registry`
   - Save as CI variable: `NPM_PUBLISH_TOKEN`

3. **Install Changesets** in the repo:

```bash
pnpm add -Dw @changesets/cli @changesets/changelog-github
pnpm changeset init
```

4. **Configure `.changeset/config.json`**:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [
    ["@arcaai/vox", "@arcaai/room", "@arcaai/stt",
     "@arcaai/vad", "@arcaai/noise-filter"]
  ],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": [
    "@arcaai/api", "@arcaai/ui-playground", "@arcaai/database",
    "@arcaai/domains", "@arcaai/applications", "@arcaai/exceptions",
    "@arcaai/logger", "@arcaai/tools", "@arcaai/config-eslint",
    "@arcaai/config-rollup", "@arcaai/config-tailwind", "@arcaai/config-ts",
    "@arcaai/ui"
  ]
}
```

5. **Add `publishConfig`** to each publishable package.json:

```json
{
  "publishConfig": {
    "@arcaai:registry": "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/npm/"
  }
}
```

6. **Add root scripts** to `package.json`:

```json
{
  "scripts": {
    "changeset": "changeset",
    "changeset:version": "changeset version",
    "changeset:publish": "changeset publish"
  }
}
```

### Publishable Packages

| Package | Purpose | Status |
|---------|---------|--------|
| `@arcaai/vox` | Consultation SDK | Ready (needs `publishConfig`) |
| `@arcaai/room` | Audio track management | Ready |
| `@arcaai/stt` | Whisper STT WebWorker | Ready (needs `publishConfig`) |
| `@arcaai/vad` | Silero VAD v5 | Ready |
| `@arcaai/noise-filter` | RNNoise WASM | Ready |
| `@arcaai/med-ner` | Medical NER | Ready |
| `@arcaai/pipeline` | Processing pipeline | Ready |
| `@arcaai/utils` | Shared utilities | Needs `publishConfig` + `files` |
| `@arcaai/types` | Shared types | Needs `publishConfig` + `files` |

### Developer Workflow

1. Make changes to SDK packages
2. Run: `pnpm changeset` -> select packages, bump type, write summary
3. Commit the `.changeset/<name>.md` with your code
4. Merge to `release` branch
5. Pipeline: version -> build -> publish to GitLab Package Registry

### Consumer Installation

```ini
# .npmrc
@arcaai:registry=https://<gitlab-host>/api/v4/projects/<PROJECT_ID>/packages/npm/
//<gitlab-host>/api/v4/projects/<PROJECT_ID>/packages/npm/:_authToken=<TOKEN>
```

```bash
pnpm add @arcaai/vox@1.2.3
```

---

## Argo CD Integration (for `staging` branch)

### Setup

1. Create deployment repository `arcaai/hope-deployments`
2. Add CI variables: `DEPLOY_REPO_URL`, `DEPLOY_TOKEN`
3. Configure Argo CD to watch the deployment repo
4. Optionally add `ARGOCD_SERVER` + `ARGOCD_AUTH_TOKEN` for direct sync

### Flow

```
staging push -> lint + test + build -> deploy-staging job
  -> clones hope-deployments repo
  -> updates values-staging.yaml with staging-<sha8> tag
  -> git push to deployment repo
  -> Argo CD detects change and syncs to Kubernetes
```

---

## File Structure

```
.gitlab-ci.yml                   # Main: workflow, stages, defaults, includes
.gitlab/ci/
  templates.yml                  # .node-base, .python-base, .build-template
  rules.yml                      # Change-path rules per service + branch logic
  install.yml                    # install-node (cache warming)
  validate.yml                   # lint-ts, typecheck, lint-python
  test.yml                       # test-api, test-packages, test-sdk, test-stt, test-smr, test-nlp
  build.yml                      # 7 Docker build jobs (manual on cicd, auto on staging)
  scan.yml                       # Trivy container + source scans
  publish.yml                    # SDK package publishing (release branch)
  deploy.yml                     # Argo CD staging deployment
  notify.yml                     # GitHub backup
```

---

## Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-03-23 | Initial pipeline rebuild: 6 stages, modular structure | `.gitlab-ci.yml`, `.gitlab/ci/*.yml` (8 files) |
| 2026-03-23 | Add branch strategy (cicd/staging/release), image versioning (no latest), SDK publishing, Argo CD deploy, runner tags | `.gitlab-ci.yml`, all `.gitlab/ci/*.yml` (10 files), docs |
