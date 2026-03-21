# Deploy GitLab Runner — VM 411 (10.10.1.111)

**Date**: 2026-03-17
**VM**: 411 | **IP**: 10.10.1.111 | **Bridge**: vmbr1 | **Specs**: 8c / 16 GB / 64 GB disk
**Architecture**: 4 specialized runners (fast / build / test / deploy) — 8 concurrent job slots
**Config files**: [`configs/gitlab-runner/`](./configs/gitlab-runner/) — `config.toml`
**Related**: [Infrastructure Overview](./proxmox-infrastructure-gitlab-rancher-plan.md) | [GitLab Deployment](./deploy-vm410-gitlab.md) | [MinIO Deployment](./deploy-vm402-minio.md) | [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md)

---

## Prerequisites

- VM 411 running Ubuntu 24.04 Server
- SSH access: `ssh hope@10.10.1.111`
- **GitLab on VM 410 is deployed and accessible** at `http://10.10.1.110`
- Cloudflare Tunnel (CT 101) configured with `ssh-git-runner.taphuynh.dev → ssh://10.10.1.111:22`

---

## 1. Expand Disk (Proxmox Host)

The runner builds Docker images and caches layers. Each concurrent build consumes 2-5 GB in layers. With 4 concurrent jobs, 64 GB fills fast.

```bash
# On the Proxmox host (SSH or web shell)
qm resize 411 virtio0 +86G
```

## 2. Extend Filesystem (Inside VM 411)

```bash
ssh hope@10.10.1.111
```

```bash
lsblk
df -h /

# Grow GPT partition
sudo growpart /dev/vda 3

# Resize LVM physical volume
sudo pvresize /dev/vda3

# Extend logical volume
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv

# Resize filesystem
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv

# Verify — should show ~145 GB
df -h /
```

> **Non-LVM?** Use `sudo growpart /dev/vda 2` then `sudo resize2fs /dev/vda2`.

## 3. Install Docker

Docker is required for the Docker executor (the runner uses Docker-in-Docker for CI builds).

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Log out and back in
exit
```

```bash
ssh hope@10.10.1.111
docker --version
docker compose version
```

### 3.1 — DNS Override: Bypass Cloudflare for Internal Traffic

**Critical**: Cloudflare Free tier has a **100 MB HTTP upload limit**. CI jobs that push Docker images or large artifacts to `registry.taphuynh.dev` or `git.taphuynh.dev` will fail if any single HTTP request body exceeds 100 MB.

The fix: resolve these hostnames to internal IPs on the runner VM so traffic stays on `vmbr1` and never touches Cloudflare.

```bash
# Add internal DNS overrides
sudo tee -a /etc/hosts <<'EOF'

# GitLab internal — bypass Cloudflare 100 MB limit
10.10.1.110  git.taphuynh.dev
10.10.1.110  registry.taphuynh.dev
10.10.1.110  pages.taphuynh.dev
EOF
```

Verify:

```bash
# Should resolve to internal IP, not Cloudflare
ping -c 1 git.taphuynh.dev
# → PING git.taphuynh.dev (10.10.1.110)

ping -c 1 registry.taphuynh.dev
# → PING registry.taphuynh.dev (10.10.1.110)
```

### 3.2 — Docker Daemon Configuration

Configure Docker for optimal build caching, log management, and allow the internal insecure registry:

```bash
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "insecure-registries": [
    "10.10.1.110:5050",
    "registry.taphuynh.dev",
    "registry.taphuynh.dev:5050",
    "registry.taphuynh.dev:80"
  ],
  "builder": {
    "gc": {
      "defaultKeepStorage": "50GB",
      "enabled": true
    }
  },
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "3"
  },
  "storage-driver": "overlay2"
}
EOF

sudo systemctl restart docker
```

> **Why so many `insecure-registries` entries?** The internal registry serves plain HTTP. Docker defaults to HTTPS for any registry that isn't `localhost`. We need entries for every form of the address that Docker might encounter:
> - `10.10.1.110:5050` — direct IP push/pull
> - `registry.taphuynh.dev` — hostname without port (Docker defaults to :443)
> - `registry.taphuynh.dev:5050` — hostname with explicit registry port
> - `registry.taphuynh.dev:80` — hostname with HTTP port

## 4. Prepare Directories

```bash
# Cache directory for CI jobs
sudo mkdir -p /cache
sudo chmod 777 /cache
```

## 5. Install GitLab Runner

```bash
# Add the official GitLab Runner repository
curl -L "https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh" | sudo bash

# Install the runner
sudo apt install -y gitlab-runner

# Verify
gitlab-runner --version
```

## 6. Create Runner S3 Cache Bucket (MinIO on VM 402)

All 4 runners share a single S3-backed cache bucket on MinIO. This is **much faster** than local-disk caching because cache is shared across runners and survives container cleanup.

```bash
ssh hope@10.10.1.102
```

```bash
# If mc is not installed yet
curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
chmod +x /usr/local/bin/mc
mc alias set homelab http://10.10.1.102:9000 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
```

```bash
# Create the runner cache bucket
mc mb homelab/gitlab-runner-cache
```

### 6.1 — Create the `runner-svc` user and policy

```bash
# Create a dedicated MinIO user for the runner
# Choose a strong password (16+ chars, mixed case, numbers, symbols)
mc admin user add homelab runner-svc '<STRONG_PASSWORD_HERE>'
```

Create the IAM policy that restricts this user to the cache bucket only:

```bash
cat > /tmp/runner-cache-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload"
      ],
      "Resource": [
        "arn:aws:s3:::gitlab-runner-cache",
        "arn:aws:s3:::gitlab-runner-cache/*"
      ]
    }
  ]
}
EOF

mc admin policy create homelab runner-cache-policy /tmp/runner-cache-policy.json
mc admin policy attach homelab runner-cache-policy --user runner-svc
```

### 6.2 — Generate S3 Access Key and Secret Key

The `runner-svc` username/password is for MinIO admin operations. GitLab Runner needs **S3-compatible access keys** (access key + secret key pair). Generate them from the `runner-svc` user:

**Option A — MinIO Console (recommended):**

1. Open MinIO Console at `https://s3-console.taphuynh.dev` or `http://10.10.1.102:9001`
2. Login with root credentials
3. Navigate: **Identity** → **Users** → click `runner-svc`
4. Go to the **Service Accounts** tab → **Create Service Account**
5. (Optional) Set a custom access key, or let MinIO generate one
6. Click **Create**
7. **Copy and save both the Access Key and Secret Key** — the secret is shown only once

**Option B — CLI (`mc admin user svcacct`):**

```bash
mc admin user svcacct add homelab runner-svc

# Output:
# Access Key: <GENERATED_ACCESS_KEY>
# Secret Key: <GENERATED_SECRET_KEY>
# Expiration: no-expiry
```

> **Save both values immediately** — the secret key is only displayed once. If lost, you must create a new service account.

### 6.3 — Verify S3 Access

Test that the generated access key can read/write to the cache bucket:

```bash
# Use the ACCESS KEY and SECRET KEY from step 6.2 (NOT the runner-svc password)
mc alias set runner-test http://10.10.1.102:9000 <ACCESS_KEY> <SECRET_KEY>

# Write a test object
echo "cache-test" | mc pipe runner-test/gitlab-runner-cache/test.txt

# Read it back
mc cat runner-test/gitlab-runner-cache/test.txt
# → cache-test

# Clean up
mc rm runner-test/gitlab-runner-cache/test.txt
mc alias rm runner-test
```

> **These are the credentials for `config.toml`** — you'll use the Access Key as `AccessKey` and Secret Key as `SecretKey` in the `[runners.cache.s3]` sections in step 9.

## 7. Create 4 Runner Tokens in GitLab UI

We use a **multi-runner architecture** — 4 specialized runners on the same VM, each handling different job types. Fast jobs (lint, typecheck) never queue behind slow builds.

GitLab 17+ uses the new runner creation workflow. The old registration token is deprecated.

1. Open GitLab at `https://git.taphuynh.dev` or `http://10.10.1.110`
2. Login as admin
3. For **each** of the 4 runners below, navigate to **Admin** → **CI/CD** → **Runners** → **New instance runner** and create it:

| # | Description | Tags | Run untagged? | Platform |
|---|-------------|------|---------------|----------|
| 1 | `fast-runner-01` | `fast,lint,typecheck,unit` | No | Linux |
| 2 | `build-runner-01` | `build,docker` | No | Linux |
| 3 | `test-runner-01` | `test,e2e,playwright,integration` | No | Linux |
| 4 | `deploy-runner-01` | `deploy` | No | Linux |

4. After creating each runner, **copy the authentication token** (starts with `glrt-`)
5. Save all 4 tokens — you'll use them in step 8

> **Why no "Run untagged jobs"?** — untagged jobs would match ALL runners and defeat the purpose of specialization. Your `.gitlab-ci.yml` must use `tags:` to route jobs to the correct runner.

### Runner Architecture Overview

```
┌─────────────── VM 411 (10.10.1.111) ───────────────┐
│                                                      │
│  concurrent = 8 (total across all runners)           │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ FAST (3) │ │ BUILD(2) │ │ TEST (2) │ │DEPLOY  │ │
│  │ lint     │ │ docker   │ │ e2e      │ │  (1)   │ │
│  │ type-chk │ │ compose  │ │ playwrght│ │ serial │ │
│  │ unit     │ │ registry │ │ integ.   │ │        │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │
│       │             │            │            │       │
│       └─────────────┴────────────┴────────────┘      │
│                         │                            │
│              ┌──────────┴──────────┐                 │
│              │ Shared S3 Cache     │                 │
│              │ MinIO (VM 402)      │                 │
│              │ gitlab-runner-cache │                 │
│              └─────────────────────┘                 │
└──────────────────────────────────────────────────────┘
```

## 8. Register All 4 Runners

Register each runner using its token from step 7. Run these on **VM 411**:

```bash
ssh hope@10.10.1.111
```

### 8.1 — Register fast-runner-01

```bash
sudo gitlab-runner register \
  --non-interactive \
  --url "http://10.10.1.110" \
  --token "glrt-FAST_TOKEN_HERE" \
  --executor "docker" \
  --docker-image "node:22-alpine" \
  --description "fast-runner-01" \
  --tag-list "fast,lint,typecheck,unit"
```

### 8.2 — Register build-runner-01

```bash
sudo gitlab-runner register \
  --non-interactive \
  --url "http://10.10.1.110" \
  --token "glrt-BUILD_TOKEN_HERE" \
  --executor "docker" \
  --docker-image "docker:27-dind" \
  --docker-privileged \
  --docker-volumes "/var/run/docker.sock:/var/run/docker.sock" \
  --docker-volumes "/cache:/cache" \
  --description "build-runner-01" \
  --tag-list "build,docker"
```

### 8.3 — Register test-runner-01

```bash
sudo gitlab-runner register \
  --non-interactive \
  --url "http://10.10.1.110" \
  --token "glrt-TEST_TOKEN_HERE" \
  --executor "docker" \
  --docker-image "mcr.microsoft.com/playwright:v1.52.0-noble" \
  --description "test-runner-01" \
  --tag-list "test,e2e,playwright,integration"
```

### 8.4 — Register deploy-runner-01

```bash
sudo gitlab-runner register \
  --non-interactive \
  --url "http://10.10.1.110" \
  --token "glrt-DEPLOY_TOKEN_HERE" \
  --executor "docker" \
  --docker-image "docker:27" \
  --docker-privileged \
  --docker-volumes "/var/run/docker.sock:/var/run/docker.sock" \
  --docker-volumes "/cache:/cache" \
  --description "deploy-runner-01" \
  --tag-list "deploy"
```

> **Internal URL**: `http://10.10.1.110` — all runners communicate with GitLab directly over vmbr1. No tunnel, no TLS overhead.

### 8.5 — Verify All Runners Registered

```bash
sudo gitlab-runner list
# Should show 4 runners

sudo gitlab-runner verify
# → Verifying runner... is alive (×4)
```

Also check the GitLab UI: **Admin** → **CI/CD** → **Runners** → all 4 should show **online** (green indicator).

## 9. Production Configuration

After registration, GitLab Runner creates a basic `config.toml` with all 4 runners. Replace it with the production config from [`configs/gitlab-runner/config.toml`](./configs/gitlab-runner/config.toml):

```bash
# Option A: SCP from your dev machine
scp docs/research/configs/gitlab-runner/config.toml hope@10.10.1.111:/tmp/
ssh hope@10.10.1.111 'sudo mv /tmp/config.toml /etc/gitlab-runner/config.toml'

# Option B: Edit directly on VM 411
sudo nano /etc/gitlab-runner/config.toml
# Paste contents from configs/gitlab-runner/config.toml
```

### 9.1 — Update Tokens and IDs

Edit the file and replace placeholder values with your actual tokens:

```bash
sudo nano /etc/gitlab-runner/config.toml
```

Replace these placeholders:

| Placeholder | Replace with | Source |
|-------------|-------------|--------|
| `glrt-FAST_TOKEN_HERE` | Actual token | Step 7, runner #1 |
| `glrt-BUILD_TOKEN_HERE` | Actual token | Step 7, runner #2 |
| `glrt-TEST_TOKEN_HERE` | Actual token | Step 7, runner #3 |
| `glrt-DEPLOY_TOKEN_HERE` | Actual token | Step 7, runner #4 |
| `id = 1` through `id = 4` | Actual runner IDs | GitLab Admin → Runners |
| `RUNNER_ACCESS_KEY` (×4) | MinIO S3 access key | Step 6.2 (service account access key) |
| `RUNNER_SECRET_KEY` (×4) | MinIO S3 secret key | Step 6.2 (service account secret key) |

> **Tip**: The runner ID is visible in the GitLab Admin UI under each runner's detail page, or in the URL: `https://git.taphuynh.dev/admin/runners/<ID>`.

### 9.2 — Key Settings Explained

| Setting | Value | Why |
|---------|-------|-----|
| `concurrent = 8` | 8 total job slots | fast(3) + build(2) + test(2) + deploy(1) = 8 max |
| `clone_url = "http://10.10.1.110"` | Internal GitLab URL | **Bypasses Cloudflare** — clones over vmbr1 directly |
| `extra_hosts` | Internal IP mappings | Injects `/etc/hosts` into every CI container, **bypassing 100 MB Cloudflare limit** |
| `limit = 3` (fast) | 3 concurrent fast jobs | Quick jobs never queue behind slow builds |
| `limit = 2` (build) | 2 concurrent builds | Heavy CPU/disk I/O per build |
| `limit = 2` (test) | 2 concurrent test suites | Browser-based tests use significant memory |
| `limit = 1` (deploy) | 1 deployment at a time | Serialized to prevent conflicting deployments |
| `privileged = true` (build/deploy) | Docker-in-Docker | Required for `docker build` and `docker compose` |
| `shm_size = 536870912` (test) | 512 MB shared memory | Prevents Chrome/Playwright OOM |
| `pull_policy = ["if-not-present"]` | Cache images locally | Faster builds, less bandwidth |
| `GIT_STRATEGY=fetch` | Incremental git updates | Faster than full clone each time |
| `cache.Type = "s3"` | MinIO-backed cache | Shared across all 4 runners, survives cleanup |

### 9.3 — Why `clone_url` and `extra_hosts` matter

Without these settings, CI jobs may resolve `git.taphuynh.dev` and `registry.taphuynh.dev` to Cloudflare's edge IPs. This routes traffic through Cloudflare where the **free-tier 100 MB HTTP upload limit** will reject large Git pushes and Docker image layer pushes.

- **`clone_url`** — overrides the URL the runner uses to clone repos. Set to `http://10.10.1.110` so Git operations stay internal.
- **`extra_hosts`** — adds `/etc/hosts` entries to every CI container. When a CI script runs `docker push registry.taphuynh.dev/...`, the Docker client inside the container resolves to `10.10.1.110` instead of Cloudflare.
- **`/etc/hosts` on VM 411** (step 3.1) — ensures the Docker daemon on the host also resolves internally. When CI uses `DOCKER_HOST: unix:///var/run/docker.sock`, the daemon does the DNS resolution on the host, not in the container.

## 10. Restart and Verify

```bash
sudo gitlab-runner restart
sudo gitlab-runner verify
# → Verifying runner... is alive (×4)
```

Check in GitLab UI: **Admin** → **CI/CD** → **Runners** → all 4 runners show **online** (green indicator).

Verify S3 cache connectivity:

```bash
# Quick test: run a job that writes to cache, then another that reads it
# (see test pipeline in step 12)
```

## 11. Configure Runners for Container Registry

The build and deploy runners need to pull/push images from GitLab's Container Registry. Thanks to the `/etc/hosts` override (step 3.1) and `extra_hosts` (step 9), `registry.taphuynh.dev` resolves to `10.10.1.110` internally — all traffic stays on vmbr1.

```bash
# Login to the registry on the runner machine (uses /etc/hosts → 10.10.1.110)
docker login registry.taphuynh.dev -u <gitlab-username> -p <personal-access-token>
# → Login Succeeded (via internal network, no Cloudflare)
```

For CI pipelines, use GitLab's built-in `CI_REGISTRY` variables. The `extra_hosts` in `config.toml` ensures the CI container resolves `registry.taphuynh.dev` to the internal IP:

```yaml
build-image:
  stage: build
  tags: [build]
  image: docker:27
  variables:
    DOCKER_HOST: unix:///var/run/docker.sock
  before_script:
    - echo "Registry resolves to $(getent hosts registry.taphuynh.dev)"
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
```

> The `getent hosts` line is a debug check — it should print `10.10.1.110` confirming internal routing. Remove it after verification.

## 12. Test the Runners

### 12.1 — Create Test Pipeline

In GitLab, create a test project or use an existing one. Add `.gitlab-ci.yml`:

```yaml
stages:
  - fast
  - build
  - test
  - deploy

# ── FAST RUNNER TESTS ─────────────────────────────────────────
fast-lint-check:
  stage: fast
  tags: [fast]
  image: node:22-alpine
  script:
    - echo "✓ Fast runner operational"
    - node --version
    - cat /etc/hosts | grep taphuynh || echo "No host override (expected in non-privileged)"
  cache:
    key: test-cache
    paths:
      - .cache-test/
    policy: push
  before_script:
    - mkdir -p .cache-test && echo "cached-data" > .cache-test/test.txt

fast-cache-verify:
  stage: fast
  tags: [fast]
  image: node:22-alpine
  needs: [fast-lint-check]
  script:
    - echo "Checking S3 cache..."
    - cat .cache-test/test.txt
    - echo "✓ S3 cache working"
  cache:
    key: test-cache
    paths:
      - .cache-test/
    policy: pull

# ── BUILD RUNNER TESTS ────────────────────────────────────────
build-docker-check:
  stage: build
  tags: [build]
  image: docker:27
  variables:
    DOCKER_HOST: unix:///var/run/docker.sock
  script:
    - docker info
    - docker images | head -10
    - echo "✓ Docker build capability confirmed"

build-network-check:
  stage: build
  tags: [build]
  image: docker:27
  variables:
    DOCKER_HOST: unix:///var/run/docker.sock
  script:
    - cat /etc/hosts | grep taphuynh
    - echo "✓ extra_hosts DNS override working"

# ── TEST RUNNER TESTS ─────────────────────────────────────────
test-e2e-check:
  stage: test
  tags: [test]
  image: mcr.microsoft.com/playwright:v1.52.0-noble
  script:
    - echo "✓ Test runner operational (Playwright image)"
    - node --version
    - npx playwright --version
    - echo "Shared memory:"
    - df -h /dev/shm

# ── DEPLOY RUNNER TESTS ──────────────────────────────────────
deploy-check:
  stage: deploy
  tags: [deploy]
  image: docker:27
  variables:
    DOCKER_HOST: unix:///var/run/docker.sock
  script:
    - docker info
    - echo "✓ Deploy runner operational"
  when: manual
```

### 12.2 — Run and Verify

1. Commit the `.gitlab-ci.yml` file
2. Go to **CI/CD** → **Pipelines** → verify all jobs pass (manually trigger `deploy-check`)
3. Confirm each job was picked up by the correct runner:
   - Click each job → look for `Running on <runner-name>...` in the log header
   - `fast-lint-check` → should say `Running on fast-runner-01`
   - `build-docker-check` → should say `Running on build-runner-01`
   - `test-e2e-check` → should say `Running on test-runner-01`
   - `deploy-check` → should say `Running on deploy-runner-01`
4. Verify S3 cache works: `fast-cache-verify` should successfully read the file written by `fast-lint-check`

### 12.3 — Example `.gitlab-ci.yml` for HOPE Monorepo

Here's how the HOPE project `.gitlab-ci.yml` would route jobs to the specialized runners:

```yaml
stages:
  - fast
  - build
  - test
  - deploy

variables:
  DOCKER_HOST: unix:///var/run/docker.sock

# ── FAST STAGE ────────────────────────────────────────────────
lint:
  stage: fast
  tags: [fast]
  image: node:22-alpine
  script:
    - corepack enable
    - pnpm install --frozen-lockfile
    - pnpm lint
  cache:
    key: pnpm-${CI_COMMIT_REF_SLUG}
    paths: [node_modules/, .pnpm-store/]

typecheck:
  stage: fast
  tags: [fast]
  image: node:22-alpine
  script:
    - corepack enable
    - pnpm install --frozen-lockfile
    - pnpm typecheck
  cache:
    key: pnpm-${CI_COMMIT_REF_SLUG}
    paths: [node_modules/, .pnpm-store/]

unit-tests:
  stage: fast
  tags: [fast]
  image: node:22-alpine
  script:
    - corepack enable
    - pnpm install --frozen-lockfile
    - pnpm test:unit
  cache:
    key: pnpm-${CI_COMMIT_REF_SLUG}
    paths: [node_modules/, .pnpm-store/]

# ── BUILD STAGE ───────────────────────────────────────────────
build-api:
  stage: build
  tags: [build]
  image: docker:27
  script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
    - docker build -t $CI_REGISTRY_IMAGE/api:$CI_COMMIT_SHORT_SHA -f apps/api/Dockerfile .
    - docker push $CI_REGISTRY_IMAGE/api:$CI_COMMIT_SHORT_SHA
  only: [main, develop]

# ── TEST STAGE ────────────────────────────────────────────────
e2e-tests:
  stage: test
  tags: [test]
  image: mcr.microsoft.com/playwright:v1.52.0-noble
  script:
    - corepack enable
    - pnpm install --frozen-lockfile
    - pnpm test:e2e
  cache:
    key: pnpm-${CI_COMMIT_REF_SLUG}
    paths: [node_modules/, .pnpm-store/]
  only: [main, develop]

# ── DEPLOY STAGE ──────────────────────────────────────────────
deploy-staging:
  stage: deploy
  tags: [deploy]
  image: docker:27
  script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
    - docker compose -f infrastructure/docker/docker-compose.staging.yml pull
    - docker compose -f infrastructure/docker/docker-compose.staging.yml up -d
  only: [develop]
  when: manual
```

## 13. Periodic Cleanup

Docker builds accumulate layers over time. Schedule automatic cleanup:

```bash
sudo tee /usr/local/bin/runner-cleanup.sh <<'SCRIPT'
#!/bin/bash
set -euo pipefail

LOG_TAG="runner-cleanup"
logger -t "$LOG_TAG" "Starting Docker cleanup..."

# Remove unused images, containers, and build cache older than 7 days
docker system prune -af --filter "until=168h" 2>&1 | logger -t "$LOG_TAG"

# Clean CI cache older than 14 days
find /cache -type f -mtime +14 -delete 2>/dev/null || true
find /cache -type d -empty -delete 2>/dev/null || true

DISK_FREE=$(df -h / | tail -1 | awk '{print $4}')
logger -t "$LOG_TAG" "Cleanup complete. Disk free: $DISK_FREE"
SCRIPT

sudo chmod +x /usr/local/bin/runner-cleanup.sh

# Run weekly Sunday at 04:00
(sudo crontab -l 2>/dev/null; echo '0 4 * * 0 /usr/local/bin/runner-cleanup.sh') | sudo crontab -
```

## 14. Add Kubernetes Executor (After K3s on VM 200)

Once K3s is running on VM 200 with GPU support, add a 5th runner for GPU workloads. A commented-out template is already in `config.toml` — see the `k8s-runner-01` section.

**Steps:**

1. Create a new runner in GitLab Admin:
   - **Admin** → **CI/CD** → **Runners** → **New instance runner**
   - Tags: `kubernetes,gpu`
   - Run untagged jobs: **No**
   - Description: `k8s-runner-01`
2. Copy the `glrt-` token
3. Register on VM 411:

```bash
sudo gitlab-runner register \
  --non-interactive \
  --url "http://10.10.1.110" \
  --token "glrt-K8S_TOKEN_HERE" \
  --executor "kubernetes" \
  --kubernetes-host "https://10.10.1.10:6443" \
  --kubernetes-namespace "gitlab-ci" \
  --kubernetes-service-account "gitlab-runner" \
  --description "k8s-runner-01" \
  --tag-list "kubernetes,gpu"
```

4. Uncomment the `k8s-runner-01` section in `config.toml` and replace the token
5. Update `concurrent` from `8` to `10` (adding 2 k8s slots)
6. Restart: `sudo gitlab-runner restart && sudo gitlab-runner verify`

## 15. Monitoring

```bash
# List all registered runners and their status
sudo gitlab-runner list

# Verify all runners can reach GitLab
sudo gitlab-runner verify

# Runner service status
sudo gitlab-runner status

# Docker resource usage
docker system df
docker system df -v | head -20

# Disk usage
df -h /

# Running CI containers (shows which runner started each)
docker ps --filter "label=com.gitlab.gitlab-runner.type" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

# Runner logs (all runners share one service)
sudo journalctl -u gitlab-runner --no-pager -n 50

# Filter logs by runner name
sudo journalctl -u gitlab-runner --no-pager -n 50 | grep "fast-runner"
sudo journalctl -u gitlab-runner --no-pager -n 50 | grep "build-runner"

# S3 cache usage on MinIO
mc ls homelab/gitlab-runner-cache --recursive --summarize
```

## 16. Upgrading GitLab Runner

Keep the runner version close to the GitLab server version (same minor version recommended):

```bash
# Check current version
gitlab-runner --version

# Update
sudo apt update
sudo apt install -y gitlab-runner

# Verify
gitlab-runner --version
sudo gitlab-runner verify
```

## 17. Verification Checklist

```bash
# All 4 runners are alive
sudo gitlab-runner verify
# → Verifying runner... is alive  (fast-runner-01)
# → Verifying runner... is alive  (build-runner-01)
# → Verifying runner... is alive  (test-runner-01)
# → Verifying runner... is alive  (deploy-runner-01)

# All 4 runners appear online in GitLab UI
# Admin → CI/CD → Runners → 4 green indicators

# Docker is functional
docker info | grep "Server Version"

# S3 cache reachable from host
curl -s http://10.10.1.102:9000/minio/health/live
# → HTTP 200

# Test pipeline passes (see step 12) — all 4 runner types tested

# Disk space
df -h /
# → ~145 GB total, reasonable usage

# Cleanup cron installed
sudo crontab -l | grep runner-cleanup
# → 0 4 * * 0 /usr/local/bin/runner-cleanup.sh

# DNS overrides working
ping -c 1 git.taphuynh.dev | head -1
# → PING git.taphuynh.dev (10.10.1.110)
```

---

## Quick Reference

```
VM 411 — GitLab Runner (Multi-Runner Architecture)
  IP:          10.10.1.111
  SSH:         ssh hope@10.10.1.111  (ssh-git-runner.taphuynh.dev via tunnel)
  GitLab:      http://10.10.1.110    (internal, no tunnel needed)
  Config:      /etc/gitlab-runner/config.toml
  Managed:     configs/gitlab-runner/config.toml
  Concurrent:  8 total (across 4 runners)
  Cache:       S3 → MinIO (10.10.1.102) → gitlab-runner-cache bucket
  Cleanup:     weekly Sun 04:00

  Runners:
  ┌─────────────────┬─────────────────────────────────┬───────┬──────────────────────┐
  │ Name            │ Tags                            │ Limit │ Default Image        │
  ├─────────────────┼─────────────────────────────────┼───────┼──────────────────────┤
  │ fast-runner-01  │ fast,lint,typecheck,unit         │ 3     │ node:22-alpine       │
  │ build-runner-01 │ build,docker                     │ 2     │ docker:27-dind       │
  │ test-runner-01  │ test,e2e,playwright,integration  │ 2     │ playwright:v1.52.0   │
  │ deploy-runner-01│ deploy                           │ 1     │ docker:27            │
  └─────────────────┴─────────────────────────────────┴───────┴──────────────────────┘

  Logs:    sudo journalctl -u gitlab-runner -f
  Status:  sudo gitlab-runner verify
  List:    sudo gitlab-runner list
```

---

## Troubleshooting

### Runner shows "offline" in GitLab

```bash
# Check runner service
sudo systemctl status gitlab-runner

# Check connectivity to GitLab
curl -s http://10.10.1.110/-/readiness
# If fails → network issue, check vmbr1 connectivity

# Check runner logs
sudo journalctl -u gitlab-runner --no-pager -n 100 | grep -i error

# Re-verify registration
sudo gitlab-runner verify
```

### Jobs stuck in "pending"

- **Tag mismatch** — all jobs MUST have `tags:` in `.gitlab-ci.yml` (none of our runners accept untagged jobs). Common tags:
  - `tags: [fast]` — lint, typecheck, unit tests
  - `tags: [build]` — Docker image builds
  - `tags: [test]` — E2E, Playwright, integration tests
  - `tags: [deploy]` — deployments
- Check `concurrent` limit isn't reached: `docker ps | wc -l`
- Check disk space: `df -h /`
- Check per-runner limit: each runner has its own `limit` — if all 3 fast slots are busy, fast jobs queue
- Verify all 4 runners are online: `sudo gitlab-runner verify`

### Docker-in-Docker not working

```bash
# Verify Docker socket is mounted
docker exec <ci-container-id> ls -la /var/run/docker.sock

# Verify privileged mode
grep privileged /etc/gitlab-runner/config.toml
# → privileged = true
```

### Out of disk space

```bash
# Emergency cleanup
docker system prune -af

# Check what's consuming space
sudo du -sh /var/lib/docker/*
sudo du -sh /cache/*

# Run scheduled cleanup early
sudo /usr/local/bin/runner-cleanup.sh
```
