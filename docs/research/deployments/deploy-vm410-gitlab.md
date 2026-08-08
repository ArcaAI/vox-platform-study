# Deploy GitLab CE — VM 410 (10.10.1.110)

**Status**: BUILT — GitLab exists and is live on VM 410 per ground-truth VM inventory; the homelab infrastructure includes working GitLab with runner integration.

**Date**: 2026-03-16
**VM**: 410 | **IP**: 10.10.1.110 | **Bridge**: vmbr1 | **Specs**: 8c / 16 GB / 64 GB disk
**Config files**: [`configs/gitlab/`](../configs/gitlab/) — `gitlab.rb` + `docker-compose.yml`
**Related**: [Infrastructure Overview](../infrastructure/proxmox-infrastructure-gitlab-rancher-plan.md) | [MinIO Deployment](./deploy-vm402-minio.md) | [Runner Deployment](./deploy-vm411-gitlab-runner.md) | [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md)

---

## Prerequisites

- VM 410 running Ubuntu 24.04 Server
- SSH access: `ssh hope@10.10.1.110`
- Cloudflare Tunnel (CT 101) configured:
  - `git.taphuynh.dev → http://10.10.1.110:80`
  - `registry.taphuynh.dev → http://10.10.1.110:5050`
  - `ssh-git.taphuynh.dev → ssh://10.10.1.110:2222`
  - `pages.taphuynh.dev → http://10.10.1.110:8090` (GitLab Pages — path-based, no wildcard)
- (Optional) MinIO on VM 402 deployed and running — required for object storage integration

> **Cloudflare Free Tier — 100 MB upload limit**: All HTTP traffic through the tunnel is subject to a 100 MB request body limit. This affects HTTPS Git push and Docker registry push. See the [communication matrix](./deploy-ct101-cloudflare-tunnel.md#cloudflare-free-tier--100-mb-upload-limit) for the full analysis and workarounds. **TL;DR**: Always use SSH for Git, and route Runner/VM traffic through internal IPs.

---

## 1. Expand Disk (Proxmox Host)

GitLab stores git repos, PostgreSQL data, Container Registry layers, CI artifacts, LFS objects, and backups. 64 GB is critically insufficient.

```bash
# On the Proxmox host (SSH or web shell)
qm resize 410 virtio0 +186G
```

## 2. Extend Filesystem (Inside VM 410)

```bash
ssh hope@10.10.1.110
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

# Verify — should show ~245 GB
df -h /
```

> **Non-LVM?** Use `sudo growpart /dev/vda 2` then `sudo resize2fs /dev/vda2`.

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Log out and back in
exit
```

```bash
ssh hope@10.10.1.110
docker --version
docker compose version
```

## 4. Prepare Directories

```bash
# GitLab data directories
sudo mkdir -p /srv/gitlab/{config,logs,data,backups}

# Docker Compose project
mkdir -p ~/gitlab && cd ~/gitlab
```

## 5. Deploy Config Files

### 5.1 — Omnibus Config (`gitlab.rb`)

This is the single source of truth for all GitLab configuration. The managed copy lives at [`configs/gitlab/gitlab.rb`](../configs/gitlab/gitlab.rb) in this repo.

```bash
# Option A: SCP from your dev machine
scp docs/research/configs/gitlab/gitlab.rb hope@10.10.1.110:/tmp/
ssh hope@10.10.1.110 'sudo mv /tmp/gitlab.rb /srv/gitlab/config/gitlab.rb'

# Option B: Create directly on VM 410
sudo nano /srv/gitlab/config/gitlab.rb
# Paste contents from configs/gitlab/gitlab.rb
```

**What's configured out of the box** (14 sections in `gitlab.rb`):

| # | Section | Status |
|---|---------|--------|
| 1 | Core (URL, timezone) | Active |
| 2 | NGINX (Cloudflare proxy, real IP) | Active |
| 3 | SSH — gitlab-sshd on port 2222 (Go-based, replaces OpenSSH) | Active |
| 4 | Container Registry (port 5050) + Metadata Database | Active — see section 9.1 for migration |
| 5 | Performance Tuning (Puma, PG, Gitaly) | Active |
| 6 | Security (signup off, rate limit) | Active |
| 7 | Object Storage (MinIO) | Active — requires MinIO on VM 402 |
| 8 | SSO — Azure AD (Entra ID) via OIDC | Active — requires App Registration in Azure |
| 9 | Email — Office 365 SMTP (delegated SMTP.Send) | Active — requires shared mailbox + App Registration |
| 10 | Backups (7-day retention) | Active |
| 11 | Monitoring (disabled, exporter ready) | Disabled |
| 12 | Pages (static hosting, path-based `pages.taphuynh.dev/<ns>/<project>`) | Active — single CNAME, no wildcard needed |
| 13 | CI/CD Defaults (90-day artifacts) | Active |
| 14 | Advanced (housekeeping) | Active |

### 5.2 — Docker Compose

```bash
# Option A: SCP from dev machine
scp docs/research/configs/gitlab/docker-compose.yml hope@10.10.1.110:~/gitlab/

# Option B: Create directly
cat > docker-compose.yml <<'COMPOSE'
services:
  gitlab:
    image: gitlab/gitlab-ce:18.8.6-ce.0
    container_name: gitlab
    hostname: git.taphuynh.dev
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "2222:2222"
      - "5050:5050"
      - "8090:8090"
    volumes:
      - /srv/gitlab/config:/etc/gitlab
      - /srv/gitlab/logs:/var/log/gitlab
      - /srv/gitlab/data:/var/opt/gitlab
      - /srv/gitlab/backups:/var/opt/gitlab/backups
    shm_size: '256m'
COMPOSE
```

## 6. Start GitLab

```bash
cd ~/gitlab

# Pull the image (~3 GB)
docker compose pull

# Start GitLab
docker compose up -d

# Monitor first-start initialization (3-5 minutes)
docker logs -f gitlab 2>&1 | tail -100
```

Wait for this log line to confirm GitLab is ready:

```
==> /var/log/gitlab/puma/puma_stdout.log <==
- Worker 0 (PID: xxx) booted in ... with 4 threads, processing at ...
```

### Verify Running

```bash
docker compose ps
# → gitlab  running (healthy)

curl -s http://10.10.1.110/-/readiness | python3 -m json.tool
# → {"status":"ok"}

docker exec -it gitlab gitlab-ctl status
# → all services "run"
```

## 7. Initial Setup

### 7.1 — Get Root Password

```bash
docker exec -it gitlab grep 'Password:' /etc/gitlab/initial_root_password
```

**Save this immediately** — the file is auto-deleted after 24 hours.

### 7.2 — First Login

Open GitLab:
- Internal: `http://10.10.1.110`
- External: `https://git.taphuynh.dev` (via Cloudflare Tunnel)

Login as `root` with the password from step 7.1.

### 7.3 — Change Root Password

User avatar → **Edit profile** → **Password** → set a strong password.

### 7.4 — Verify Registration is Disabled

Already configured in `gitlab.rb`, but verify in the UI:

**Admin** → **Settings** → **General** → **Sign-up restrictions** → Confirm "Sign-up enabled" is **unchecked** → **Save changes**

### 7.5 — Create Your Admin User

**Admin** → **Overview** → **Users** → **New user**:
- Set name, username, email
- Access level: **Admin**
- Save, then set a password for the new user

### 7.6 — Create Organization

**Menu** → **Groups** → **New group**:
- Name: `arcaai`
- Visibility: **Private**

### 7.7 — Create Projects

Inside the `arcaai` group → **New project**:
- **Create blank project** for new repos
- **Import project** to migrate from GitHub/other GitLab

## 8. Configure SSH Access

> **Always use SSH for Git operations** — not HTTPS. Cloudflare Free tier limits HTTP uploads to 100 MB. SSH via `cloudflared access ssh` uses a TCP stream that is **not subject to this limit**. This is the only safe way to push large repos, LFS objects, or any packfile > 100 MB from outside the internal network.

### How SSH works in this setup

GitLab uses **`gitlab-sshd`** (a Go-based SSH server) instead of OpenSSH. It listens on **port 2222 inside the container**, and Docker maps `2222:2222` on the host. The Cloudflare Tunnel route `git-remote.taphuynh.dev → ssh://10.10.1.110:2222` proxies external SSH traffic to this port.

```
Mac → cloudflared access ssh → git-remote.taphuynh.dev → CF Tunnel
    → ssh://10.10.1.110:2222 (VM host) → 2222:2222 (Docker) → gitlab-sshd
```

### 8.1 — Add SSH Key in GitLab

User avatar → **Edit profile** → **SSH Keys** → paste your public key (e.g. `~/.ssh/id_ed25519.pub` or `~/gitlab.pub`)

### 8.2 — SSH Config on Your Mac (via Cloudflare Tunnel)

Add to `~/.ssh/config`:

```
Host git.taphuynh.dev
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname git-remote.taphuynh.dev
  User git
  Port 2222
  StrictHostKeyChecking no
  IdentitiesOnly yes
  IdentityFile ~/gitlab
```

> **`IdentitiesOnly yes`** is important if you have multiple keys in your SSH agent. Without it, SSH tries every agent key first and may hit the server's `MaxAuthTries` limit before using the correct key.

Test:

```bash
ssh -T git@git.taphuynh.dev
# → "Welcome to GitLab, @yourusername!"
```

### 8.3 — SSH Config on Internal VMs (Direct)

Add to `~/.ssh/config` on any VM in the `10.10.1.x` network:

```
Host git.internal
  HostName 10.10.1.110
  User git
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
```

### 8.4 — Push Existing Repository

**Always use SSH URLs** (not HTTPS) to avoid the Cloudflare 100 MB limit:

```bash
cd /path/to/HOPE

# SSH remote (correct — no size limit)
git remote add gitlab ssh://git@git.taphuynh.dev/arcaai/hope.git

# NOT this (HTTPS — subject to 100 MB limit):
# git remote add gitlab https://git.taphuynh.dev/arcaai/hope.git

git push gitlab --all
git push gitlab --tags
```

### 8.5 — Git LFS Configuration

If your repo uses Git LFS, configure it to use SSH transport instead of HTTPS:

```bash
cd /path/to/HOPE

# Force LFS to use SSH (bypasses Cloudflare HTTP limit)
git config lfs.url "ssh://git@git.taphuynh.dev/arcaai/hope.git/info/lfs"

# Or set globally for all repos pointing to this GitLab
git config --global "lfs.https://git.taphuynh.dev/.lfsurl" \
  "ssh://git@git.taphuynh.dev"
```

> Without this, Git LFS defaults to HTTPS for transfers. Any LFS object > 100 MB will be rejected by Cloudflare.

## 9. Container Registry

The registry is accessible at:
- **Internal**: `http://10.10.1.110:5050` — no size limit, use from VMs
- **External**: `https://registry.taphuynh.dev` (via Cloudflare Tunnel) — **100 MB layer limit**

### Cloudflare Impact on Registry

Docker pushes image layers as individual HTTP requests. Any single layer > 100 MB will be rejected by Cloudflare's free tier. This means:

| Scenario | Route | Limit? | Recommendation |
|----------|-------|--------|----------------|
| CI pipeline on Runner (VM 411) | Internal (`10.10.1.110:5050` via `/etc/hosts`) | No limit | Preferred — build and push images in CI |
| Dev push from Mac | `registry.taphuynh.dev` via Cloudflare | **100 MB per layer** | Avoid for large images; push via CI instead |
| Dev push from internal VM | `10.10.1.110:5050` directly | No limit | Safe alternative |

**Best practice**: Build and push images in CI pipelines (on the Runner), not from developer machines. The Runner's `/etc/hosts` and `extra_hosts` config route all registry traffic internally.

### Test Registry Access (Internal)

```bash
# From any VM on the internal network:
docker login 10.10.1.110:5050 -u <username> -p <personal-access-token>
# → Login Succeeded

docker pull alpine:3.20
docker tag alpine:3.20 10.10.1.110:5050/arcaai/hope/test:latest
docker push 10.10.1.110:5050/arcaai/hope/test:latest
```

### Test Registry Access (External — for small images only)

```bash
# From your Mac (subject to 100 MB layer limit):
docker login registry.taphuynh.dev -u <username> -p <personal-access-token>
# → Login Succeeded

docker pull alpine:3.20
docker tag alpine:3.20 registry.taphuynh.dev/arcaai/hope/test:latest
docker push registry.taphuynh.dev/arcaai/hope/test:latest
# → Works for small images like alpine (~7 MB)
```

> Create a personal access token in GitLab: User avatar → **Access tokens** → scope: `read_registry, write_registry`

### 9.1 — Enable Registry Metadata Database

The metadata database stores manifest/tag metadata in PostgreSQL instead of parsing S3 on every request. This is required for:

- **OCI manifest support** — Docker BuildKit (used in CI) pushes images with OCI image index format. Without the metadata database, the GitLab UI shows "Invalid tag: missing manifest digest" for all BuildKit-pushed images.
- **Online garbage collection** — automatic cleanup of untagged manifests (replaces the manual `registry-garbage-collect -m` cron job in section 13).
- **Tag listing performance** — metadata queries hit PostgreSQL instead of walking S3 objects.

On GitLab 18.3+ (current: 18.8.6), the database is auto-provisioned as a logical database within the main GitLab PostgreSQL instance. No external database setup required.

> **Important notices before proceeding:**
>
> | Notice | Detail |
> |--------|--------|
> | **One-way migration** | After enabling the database, it becomes the source of truth. Reverting requires restoring from a pre-migration backup |
> | **Timestamp reset** | `createdAt` / `publishedAt` timestamps on existing tags reset to the import date — the legacy registry does not track original tag publish dates |
> | **Backup coverage** | `gitlab-backup` does **not** separately back up the registry database. Since it's a logical database within the main GitLab PostgreSQL instance, it is covered by the main PostgreSQL backup. If using an external database, manual backup management is required |
> | **Read-only during import** | The registry must be in read-only mode during the import (pulls work, pushes blocked). Duration depends on the number of tagged images — typically minutes for small registries |
> | **Post-import GC load** | Expect ~48 hours of elevated database load after import as online GC drains its initial queues. Monitor via `registry_gc_*` Prometheus metrics |

**Step 1 — Add database config (disabled) + enable read-only mode**

Edit `/srv/gitlab/config/gitlab.rb`. Add the `registry['database']` block before `registry['storage']`, and add `maintenance` to storage:

```ruby
registry['database'] = {
  'enabled' => false,
}

registry['storage'] = {
  's3' => {
    'accesskey'      => '...',
    'secretkey'      => '...',
    'region'         => 'us-east-1',
    'regionendpoint' => 'https://10.10.1.102:9000',
    'bucket'         => 'gitlab-registry',
    'pathstyle'      => true
  },
  'delete' => { 'enabled' => true },
  'redirect' => { 'disable' => true },
  'maintenance' => {
    'readonly' => {
      'enabled' => true
    }
  }
}
```

```bash
docker exec -it gitlab gitlab-ctl reconfigure
```

**Step 2 — Run database migrations**

```bash
docker exec -it gitlab sudo -u registry gitlab-ctl registry-database migrate up
```

**Step 3 — Import existing registry metadata**

```bash
docker exec -it gitlab sudo -u registry gitlab-ctl registry-database import --log-to-stdout
```

Watch the output — it logs each repository as it imports. Wait for it to complete successfully.

**Step 4 — Enable database + disable read-only**

Edit `/srv/gitlab/config/gitlab.rb`:

```ruby
registry['database'] = {
  'enabled' => true,
}

registry['storage'] = {
  's3' => {
    'accesskey'      => '...',
    'secretkey'      => '...',
    'region'         => 'us-east-1',
    'regionendpoint' => 'https://10.10.1.102:9000',
    'bucket'         => 'gitlab-registry',
    'pathstyle'      => true
  },
  'delete' => { 'enabled' => true },
  'redirect' => { 'disable' => true }
}
```

Remove the entire `'maintenance'` block and set `'enabled' => true` in the database block.

```bash
docker exec -it gitlab gitlab-ctl reconfigure
```

**Step 5 — Verify**

```bash
# Tags should now show proper digests, sizes, and timestamps in the GitLab UI

# Push a test image to confirm writes work
docker tag alpine:3.20 10.10.1.110:5050/arcaai/hope/test:metadata-db
docker push 10.10.1.110:5050/arcaai/hope/test:metadata-db

# Pull an existing image to confirm reads work
docker pull 10.10.1.110:5050/arcaai/hope/test:metadata-db

# Check online GC health (after ~24 hours)
docker exec -it gitlab sudo -u registry gitlab-ctl registry-database gc-stats
```

> **Reference**: [GitLab Docs — Container registry metadata database](https://docs.gitlab.com/administration/packages/container_registry_metadata_database)

## 10. GitLab Pages Setup (Path-Based Mode)

GitLab Pages serves static sites at `https://pages.taphuynh.dev/<namespace>/<project>/`.

We use **path-based mode** (`namespace_in_path = true`) because Cloudflare's free Universal SSL only covers `*.taphuynh.dev` (one level deep). Wildcard subdomains like `*.pages.taphuynh.dev` would require Advanced Certificate Manager (~$10/month). Path-based mode avoids this by serving all Pages under a single subdomain.

Pages is already enabled in `gitlab.rb` (section 12) and port 8090 is exposed in `docker-compose.yml`. The remaining setup is on the Cloudflare side.

### 10.1 — Cloudflare DNS Record

Add a **standard CNAME** (not wildcard) in the Cloudflare DNS dashboard:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | `pages` | `<tunnel-id>.cfargotunnel.com` | Proxied (orange cloud) |

> **If you previously had a wildcard `*.pages` CNAME**, delete it — it's no longer needed.

### 10.2 — Cloudflare Tunnel Ingress Rule

Route `pages.taphuynh.dev` (exact match, no wildcard) to port 8090 on VM 410.

**Option A: Cloudflare Dashboard**

1. Go to **Zero Trust** → **Networks** → **Tunnels** → select your tunnel (CT 101)
2. **Public Hostname** tab → **Add a public hostname**
3. Configure:
   - **Subdomain**: `pages` | **Domain**: `taphuynh.dev`
   - **Service**: `http://10.10.1.110:8090`
4. Save
5. **If you previously had a `*.pages.taphuynh.dev` wildcard route**, delete it

**Option B: Tunnel config file** (if using `config.yml`)

Add this rule **before** the catch-all:

```yaml
- hostname: pages.taphuynh.dev
  service: http://10.10.1.110:8090
```

> **Note the difference from the old config**: `pages.taphuynh.dev` (exact) instead of `*.pages.taphuynh.dev` (wildcard).

### 10.3 — Reconfigure GitLab

```bash
docker exec -it gitlab gitlab-ctl reconfigure
```

Wait for reconfigure to complete, then verify the Pages daemon picked up the new settings:

```bash
docker exec -it gitlab grep namespace /var/opt/gitlab/gitlab-pages/gitlab-pages-config
# Should show namespace_in_path or similar path-based configuration
```

### 10.4 — Verify Pages is Running

```bash
# Check the Pages daemon is running
docker exec -it gitlab gitlab-ctl status gitlab-pages
# → run: gitlab-pages: (pid ...) ...

# Check Pages NGINX responds on port 8090
curl -sI http://10.10.1.110:8090
# → HTTP/1.1 404 (expected — no pages deployed yet)

# Verify from external (through Cloudflare)
curl -sI https://pages.taphuynh.dev
# → HTTP/2 404 (expected — Cloudflare terminates TLS, routes to Pages)
# → No ERR_SSL_VERSION_OR_CIPHER_MISMATCH!
```

### 10.5 — Deploy a Test Page

1. Create a new project in GitLab (e.g., `arcaai/pages-test`)
2. Add a `.gitlab-ci.yml`:

```yaml
create-pages:
  stage: deploy
  tags: [deploy]
  image: node:22-alpine
  script:
    - mkdir -p public
    - echo "<h1>GitLab Pages works!</h1><p>Path-based mode active.</p>" > public/index.html
  pages: true
```

3. Commit and push — the pipeline deploys to Pages
4. Go to **Deploy** → **Pages** in the project settings to see the URL
5. Open `https://pages.taphuynh.dev/arcaai/pages-test/` (path-based format: `/<namespace>/<project>/`)

> **URL format**: `https://pages.taphuynh.dev/<namespace>/<project>/`
> - NOT `https://<namespace>.pages.taphuynh.dev/<project>/` (old wildcard format)

### 10.6 — Troubleshooting Pages

```bash
# Pages daemon logs
docker exec -it gitlab tail -100 /var/log/gitlab/gitlab-pages/current

# Pages NGINX logs
docker exec -it gitlab tail -50 /var/log/gitlab/nginx/gitlab_pages_access.log
docker exec -it gitlab tail -50 /var/log/gitlab/nginx/gitlab_pages_error.log

# Verify access control (OAuth callback)
# If Pages access control is enabled, the callback URL must be reachable:
# https://git.taphuynh.dev/auth (handled by main GitLab NGINX on port 80)
```

Common issues:
- **ERR_SSL_VERSION_OR_CIPHER_MISMATCH**: You still have a wildcard `*.pages` DNS record — delete it and use the exact `pages` CNAME instead
- **502 Bad Gateway**: Pages daemon not running — check `gitlab-ctl status gitlab-pages`
- **404 on deployed page**: Check the CI job artifacts — the `public/` directory must exist in the artifacts. Also verify the URL uses the path-based format: `pages.taphuynh.dev/<namespace>/<project>/`
- **OAuth redirect loop**: Access control callback can't reach GitLab — verify `internal_gitlab_server` in `gitlab.rb`
- **DNS not resolving**: `pages` CNAME not set in Cloudflare, or tunnel ingress rule missing

## 11. Enable MinIO Object Storage (After VM 402 is Live)

Once MinIO is deployed on VM 402, configure GitLab to use it:

### 10.1 — Edit gitlab.rb

```bash
sudo nano /srv/gitlab/config/gitlab.rb
```

Uncomment **section 7 (Object Storage)** and fill in the credentials from MinIO:

```ruby
gitlab_rails['object_store']['enabled'] = true
gitlab_rails['object_store']['proxy_download'] = true
gitlab_rails['object_store']['connection'] = {
  'provider'              => 'AWS',
  'endpoint'              => 'http://10.10.1.102:9000',
  'aws_access_key_id'     => 'YOUR_MINIO_ACCESS_KEY',
  'aws_secret_access_key' => 'YOUR_MINIO_SECRET_KEY',
  'region'                => 'us-east-1',
  'path_style'            => true
}
gitlab_rails['object_store']['objects']['artifacts']['bucket'] = 'gitlab-artifacts'
gitlab_rails['object_store']['objects']['lfs']['bucket'] = 'gitlab-lfs'
gitlab_rails['object_store']['objects']['uploads']['bucket'] = 'gitlab-uploads'
gitlab_rails['object_store']['objects']['packages']['bucket'] = 'gitlab-packages'
gitlab_rails['object_store']['objects']['external_diffs']['bucket'] = 'gitlab-mr-diffs'
gitlab_rails['object_store']['objects']['terraform_state']['bucket'] = 'gitlab-terraform-state'
gitlab_rails['object_store']['objects']['ci_secure_files']['bucket'] = 'gitlab-ci-secure-files'
gitlab_rails['object_store']['objects']['pages']['bucket'] = 'gitlab-pages'
gitlab_rails['object_store']['objects']['dependency_proxy']['bucket'] = 'gitlab-dependency-proxy'
```

Also uncomment the **Registry on MinIO** block and **Backups to MinIO** block with the same credentials.

### 11.2 — Reconfigure

```bash
docker exec -it gitlab gitlab-ctl reconfigure
```

### 11.3 — Verify Object Storage

```bash
# Upload a file in GitLab, then check MinIO
mc ls homelab/gitlab-uploads --recursive
# → should show the uploaded file
```

## 12. Automated Backups

### 12.1 — Create Backup Script

```bash
sudo tee /usr/local/bin/gitlab-backup.sh <<'SCRIPT'
#!/bin/bash
set -euo pipefail

LOG_TAG="gitlab-backup"
TIMESTAMP=$(date +%F_%H%M)

logger -t "$LOG_TAG" "Starting GitLab backup..."

# Application backup (repos, DB, uploads, LFS, artifacts)
docker exec -t gitlab gitlab-backup create BACKUP="$TIMESTAMP" 2>&1 | logger -t "$LOG_TAG"

# Config backup (gitlab.rb, secrets — critical for restore)
docker exec -t gitlab tar czf /var/opt/gitlab/backups/gitlab-config-${TIMESTAMP}.tar.gz \
  /etc/gitlab/gitlab-secrets.json \
  /etc/gitlab/gitlab.rb \
  2>&1 | logger -t "$LOG_TAG"

# Prune local backups older than 7 days
find /srv/gitlab/backups -name "*.tar" -mtime +7 -delete 2>/dev/null || true
find /srv/gitlab/backups -name "gitlab-config-*.tar.gz" -mtime +7 -delete 2>/dev/null || true

# Copy to NFS shared storage (if mounted)
if mountpoint -q /mnt/shared 2>/dev/null; then
  mkdir -p /mnt/shared/backups/gitlab
  cp /srv/gitlab/backups/*_${TIMESTAMP}_gitlab_backup.tar /mnt/shared/backups/gitlab/ 2>/dev/null || true
  cp /srv/gitlab/backups/gitlab-config-${TIMESTAMP}.tar.gz /mnt/shared/backups/gitlab/ 2>/dev/null || true
  find /mnt/shared/backups/gitlab -mtime +30 -delete 2>/dev/null || true
  logger -t "$LOG_TAG" "Backup copied to NFS shared storage"
fi

logger -t "$LOG_TAG" "Backup completed successfully"
SCRIPT

sudo chmod +x /usr/local/bin/gitlab-backup.sh
```

### 12.2 — Schedule Cron

```bash
(sudo crontab -l 2>/dev/null; echo '0 3 * * * /usr/local/bin/gitlab-backup.sh') | sudo crontab -
sudo crontab -l
```

### 12.3 — Test Backup

```bash
sudo /usr/local/bin/gitlab-backup.sh
ls -lah /srv/gitlab/backups/
# → <timestamp>_gitlab_backup.tar + gitlab-config-<timestamp>.tar.gz
```

## 13. Registry Garbage Collection

> **If the metadata database is enabled (section 9.1)**: Online garbage collection runs automatically — the cron job below is **not needed** and should be removed. The legacy `registry-garbage-collect` command safely exits when the database is enabled. Verify no third-party GC cron jobs are scheduled.
>
> To monitor online GC health:
> ```bash
> docker exec -it gitlab sudo -u registry gitlab-ctl registry-database gc-stats
> ```
>
> If GC queues remain high after 48 hours, increase the worker frequency in `gitlab.rb`:
> ```ruby
> registry['gc'] = {
>   'blobs' => { 'interval' => '1s' },
>   'manifests' => { 'interval' => '1s' }
> }
> ```
> Then `docker exec -it gitlab gitlab-ctl reconfigure`. Revert to `5s` after the backlog clears.

**Legacy (without metadata database)** — schedule weekly cleanup of deleted image layers:

```bash
(sudo crontab -l 2>/dev/null; echo '0 5 * * 0 docker exec -t gitlab gitlab-ctl registry-garbage-collect -m 2>&1 | logger -t gitlab-registry-gc') | sudo crontab -
```

**After enabling metadata database** — remove the legacy cron job:

```bash
sudo crontab -l | grep -v 'registry-garbage-collect' | sudo crontab -
```

## 14. Restore Procedure (Reference)

If you need to restore from backup:

```bash
# Stop application services (keep PostgreSQL running)
docker exec -it gitlab gitlab-ctl stop puma
docker exec -it gitlab gitlab-ctl stop sidekiq

# Restore application backup
docker exec -it gitlab gitlab-backup restore BACKUP=<timestamp>

# Restore config (secrets are critical for encrypted data)
docker cp /srv/gitlab/backups/gitlab-config-<timestamp>.tar.gz gitlab:/tmp/
docker exec -it gitlab bash -c "cd / && tar xzf /tmp/gitlab-config-<timestamp>.tar.gz"

# Reconfigure and restart
docker exec -it gitlab gitlab-ctl reconfigure
docker restart gitlab
```

## 15. Monitoring Health

```bash
# Readiness endpoint
curl -s http://10.10.1.110/-/readiness | python3 -m json.tool

# Component status
docker exec -it gitlab gitlab-ctl status

# Resource usage
docker stats gitlab --no-stream

# PostgreSQL database size
docker exec -it gitlab gitlab-psql -c \
  "SELECT pg_database_size('gitlabhq_production') / 1024 / 1024 AS size_mb;"

# Disk usage breakdown
docker exec -it gitlab du -sh /var/opt/gitlab/git-data/repositories
docker exec -it gitlab du -sh /var/opt/gitlab/gitlab-rails/shared/registry
docker exec -it gitlab du -sh /var/opt/gitlab/gitlab-rails/shared/artifacts
docker exec -it gitlab du -sh /var/opt/gitlab/gitlab-rails/shared/lfs-objects
```

## 16. Upgrading GitLab

Always upgrade **one minor version at a time**. Check the [upgrade path](https://docs.gitlab.com/ee/update/index.html#upgrade-paths) first.

```bash
cd ~/gitlab

# 1. Backup
sudo /usr/local/bin/gitlab-backup.sh

# 2. Proxmox snapshot
# On host: qm snapshot 410 pre-upgrade

# 3. Update image tag in docker-compose.yml
# image: gitlab/gitlab-ce:17.9.1-ce.0 → 17.10.0-ce.0

# 4. Pull and recreate
docker compose pull
docker compose up -d

# 5. Monitor (migrations may take several minutes)
docker logs -f gitlab 2>&1 | tail -200

# 6. Verify
curl -s http://10.10.1.110/-/readiness
docker exec -it gitlab gitlab-rake gitlab:check SANITIZE=true
```

## 17. Verification Checklist

```bash
# Service health
curl -s http://10.10.1.110/-/readiness | python3 -m json.tool
# → {"status":"ok"}

# All internal components running
docker exec -it gitlab gitlab-ctl status
# → all services "run"

# External access via Cloudflare Tunnel
curl -sSI https://git.taphuynh.dev | head -5
# → HTTP/2 200 or 302

# SSH access
ssh -T git@git.taphuynh.dev
# → "Welcome to GitLab, @yourusername!"

# Container Registry login
docker login registry.taphuynh.dev -u <user> -p <token>
# → Login Succeeded

# Backup exists
ls -lah /srv/gitlab/backups/*.tar
# → recent backup file

# Disk space
df -h /
# → ~245 GB total, reasonable usage
```

## 18. Azure AD SSO Setup (Section 8 in `gitlab.rb`)

GitLab authenticates via Azure AD (Microsoft Entra ID) using the Generic OIDC provider. Users see an "Azure AD" button on the login page alongside local username/password. Auto-created users are **blocked until an admin approves** them.

> **Two separate App Registrations are needed** — one for SSO (this section) and one for email (section 18). They serve different purposes with different permissions.

### 18.1 — Create App Registration (Azure Portal)

1. Sign in to [portal.azure.com](https://portal.azure.com)
2. Navigate to **Microsoft Entra ID** → **App registrations** → **+ New registration**
3. Configure:
   - **Name**: `GitLab SSO`
   - **Supported account types**: `Accounts in this organizational directory only` (single tenant)
   - **Redirect URI**:
     - Platform: **Web**
     - URI: `https://git.taphuynh.dev/users/auth/openid_connect/callback`
4. Click **Register**

### 18.2 — Save the IDs

From the app's **Overview** page, copy:
- **Application (client) ID** → this is `YOUR_APP_CLIENT_ID` in `gitlab.rb`
- **Directory (tenant) ID** → this is `YOUR_TENANT_ID` in `gitlab.rb`

### 18.3 — Create a Client Secret

1. Go to **Certificates & secrets** → **Client secrets** → **+ New client secret**
2. Description: `GitLab OIDC`
3. Expires: **24 months**
4. Click **Add**
5. **Copy the Value immediately** (only shown once) → this is `YOUR_APP_CLIENT_SECRET` in `gitlab.rb`

### 18.4 — Configure API Permissions

1. Go to **API permissions** → **+ Add a permission**
2. Select **Microsoft Graph** → **Delegated permissions**
3. Add: `openid`, `profile`, `email`
4. Click **Grant admin consent for [your org]** → confirm with **Yes**
5. Remove the default `User.Read` permission if present (unnecessary)

### 18.5 — Update `gitlab.rb`

Edit section 8 in `/srv/gitlab/config/gitlab.rb` — replace the three placeholders:

| Placeholder | Value from Azure |
|---|---|
| `YOUR_TENANT_ID` | Directory (tenant) ID from step 18.2 |
| `YOUR_APP_CLIENT_ID` | Application (client) ID from step 18.2 |
| `YOUR_APP_CLIENT_SECRET` | Client secret Value from step 18.3 |

### 18.6 — Reconfigure and Verify

```bash
docker exec -it gitlab gitlab-ctl reconfigure
```

1. Open `https://git.taphuynh.dev/users/sign_in` — you should see an **"Azure AD"** button below the standard login form
2. Click it — redirects to Microsoft login
3. After authentication, you're redirected back to GitLab
4. **First-time users are blocked** — an admin must go to **Admin** → **Overview** → **Users** → **Blocked** tab → approve the user

### 18.7 — Troubleshooting SSO

```bash
# Check logs for OIDC errors
docker exec -it gitlab tail -100 /var/log/gitlab/gitlab-rails/production.log | grep -i omniauth

# Verify GitLab can reach the Azure discovery endpoint
docker exec -it gitlab curl -s "https://login.microsoftonline.com/YOUR_TENANT_ID/v2.0/.well-known/openid-configuration" | head -5
```

Common issues:
- **Redirect mismatch**: The URI in Azure must **exactly** match `https://git.taphuynh.dev/users/auth/openid_connect/callback` (case-sensitive, no trailing slash)
- **Discovery fails**: GitLab container needs outbound HTTPS access to `login.microsoftonline.com`
- **"Extern UID has already been taken"**: A user identity collision — check `Admin → Users → [user] → Identities`

---

## 19. Office 365 SMTP Setup (Section 9 in `gitlab.rb`)

GitLab sends emails via **Office 365 SMTP** (`smtp.office365.com:587`) using a shared mailbox with delegated `SMTP.Send` permission. The Entra ID app registration holds the permission; the service principal gets FullAccess to the mailbox. Authentication uses the **mailbox user password** (not the app secret).

> **This is a separate App Registration from the SSO app** (section 18). Different purpose, different permissions.

### 19.1 — Create Shared Mailbox

A shared mailbox does **not** require an M365 license (free 50 GB mailbox).

#### Option A: Microsoft 365 Admin Center

1. Sign in to [admin.microsoft.com](https://admin.microsoft.com)
2. **Teams & Groups** → **Shared mailboxes** → **+ Add a shared mailbox**
3. Name: `GitLab Notifications`, Email: `gitlab-noreply@4bits.vn`
4. Click **Save**

#### Option B: PowerShell

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline -ShowProgress $true

New-Mailbox -Shared -Name "GitLab Notifications" -DisplayName "GitLab Notifications" `
  -Alias gitlab-noreply -PrimarySmtpAddress gitlab-noreply@4bits.vn
```

### 19.2 — Create App Registration

1. **Entra ID** → **App registrations** → **+ New registration**
2. Configure:
   - **Name**: `GitLab SMTP`
   - **Supported account types**: `Accounts in this organizational directory only` (single tenant)
   - **Redirect URI**: Leave empty
3. Click **Register**
4. Copy the **Application (client) ID** — needed for the service principal

> An **Enterprise application** entry is automatically created for this app registration. You'll need its **Object ID** (different from the App Registration Object ID) in step 19.5.

### 19.3 — Configure API Permissions

1. **API permissions** → **+ Add a permission**
2. Select **Microsoft Graph** → **Delegated permissions**
3. Search for `SMTP.Send` → check it → **Add permissions**
4. Click **Grant admin consent for [your org]** → confirm with **Yes**
5. Remove the default `User.Read` delegated permission if present

### 19.4 — Create Client Secret

1. **Certificates & secrets** → **+ New client secret**
2. Description: `GitLab SMTP`
3. Expires: **24 months**
4. Click **Add** and save the **Value** securely

### 19.5 — Create Service Principal in Exchange Online

Connect to Exchange Online and create the service principal that links the app to Exchange:

```powershell
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline -ShowProgress $true
```

First, get the Enterprise Application IDs. Go to **Entra ID** → **Enterprise applications** → find `GitLab SMTP` → copy:
- **Application ID** (same as the App Registration client ID)
- **Object ID** (this is different from the App Registration Object ID)

```powershell
# Create service principal in Exchange Online
New-ServicePrincipal -AppId "YOUR_APP_CLIENT_ID" `
  -ObjectId "YOUR_ENTERPRISE_APP_OBJECT_ID" `
  -DisplayName "GitLab SMTP"

# Verify it was created
Get-ServicePrincipal | Format-List
```

Save the **ExchangeObjectId** from the output — you need it in the next step.

### 19.6 — Verify SMTP Client Auth on the Mailbox

```powershell
# Check current setting
Get-CASMailbox -Identity gitlab-noreply@4bits.vn | Format-List SmtpClientAuthenticationDisabled

# If it returns $true (disabled), enable it:
Set-CASMailbox -Identity gitlab-noreply@4bits.vn -SmtpClientAuthenticationDisabled $false
```

### 19.7 — Grant Mailbox Access to the Service Principal

```powershell
# Grant FullAccess using the ExchangeObjectId from step 19.5
Add-MailboxPermission -Identity "gitlab-noreply@4bits.vn" `
  -User "EXCHANGE_OBJECT_ID_FROM_STEP_19_5" `
  -AccessRights FullAccess
```

### 19.8 — Set Mailbox Password

The shared mailbox needs a password for SMTP authentication. Set it in **Entra ID**:

1. **Entra ID** → **Users** → find the shared mailbox user `gitlab-noreply@4bits.vn`
2. **Reset password** → set a strong password
3. This password goes into `gitlab.rb` as `smtp_password`

> If the shared mailbox has sign-in blocked (default for shared mailboxes), you may need to temporarily enable sign-in to set the password, then block it again. The SMTP authentication still works with sign-in blocked — SMTP AUTH is a separate mechanism.

### 19.9 — Update `gitlab.rb`

Edit section 9 in `/srv/gitlab/config/gitlab.rb` — replace the placeholder:

| Placeholder | Value |
|---|---|
| `YOUR_MAILBOX_USER_PASSWORD` | Password set in step 19.8 |

The `smtp_user_name`, `smtp_domain`, `gitlab_email_from`, and `gitlab_email_reply_to` are already set to `gitlab-noreply@4bits.vn` / `4bits.vn`.

### 19.10 — Reconfigure and Test

```bash
docker exec -it gitlab gitlab-ctl reconfigure
```

Test from the Rails console:

```bash
docker exec -it gitlab gitlab-rails console
```

```ruby
Notify.test_email('your-personal@email.com', 'Test from GitLab', 'O365 SMTP works!').deliver_now
```

Check Sidekiq logs if the test email doesn't arrive:

```bash
docker exec -it gitlab tail -50 /var/log/gitlab/sidekiq/current
```

### 19.11 — Troubleshooting Email

```bash
# Check for SMTP errors
docker exec -it gitlab grep -i "smtp\|mail\|deliver" /var/log/gitlab/sidekiq/current | tail -20

# Verify outbound connectivity to Office 365 SMTP
docker exec -it gitlab bash -c "echo QUIT | openssl s_client -connect smtp.office365.com:587 -starttls smtp 2>/dev/null | head -5"
# → Should show certificate info and SMTP banner
```

Common issues:
- **535 5.7.139 Authentication unsuccessful**: SMTP client auth is disabled on the mailbox — run `Set-CASMailbox` from step 19.6
- **535 5.7.3 Authentication unsuccessful**: Wrong password — verify the mailbox password from step 19.8
- **Connection timeout**: GitLab container needs outbound TCP access to `smtp.office365.com:587`
- **Admin consent not granted**: Verify in Entra ID → App registrations → `GitLab SMTP` → API permissions → status shows green checkmark

---

## 20. Next Steps

1. **Deploy GitLab Runner** → see [deploy-vm411-gitlab-runner.md](./deploy-vm411-gitlab-runner.md)
2. **Enable Registry Metadata Database** → section 9.1 above (fixes "missing manifest digest" and enables online GC)
3. **GitLab Pages** → configure Cloudflare `pages` CNAME + tunnel route (see step 10)
4. **Enable MinIO** → fill in access keys in section 7 of `gitlab.rb` (see step 11)
5. **Azure AD SSO** → complete steps 18.1–18.6 above
6. **Email** → complete steps 19.1–19.10 above

---

## Quick Reference

```
VM 410 — GitLab CE 18.8.6
  IP:         10.10.1.110
  HTTP:       http://10.10.1.110:80    (git.taphuynh.dev via tunnel)
  Registry:   http://10.10.1.110:5050  (registry.taphuynh.dev via tunnel)
  Pages:      http://10.10.1.110:8090  (pages.taphuynh.dev/<ns>/<project>/ via tunnel)
  SSH:        ssh://10.10.1.110:2222   (git-remote.taphuynh.dev via tunnel, gitlab-sshd)
  VM SSH:     ssh://10.10.1.110:22    (ssh-git.taphuynh.dev via tunnel, VM management)
  Config:     /srv/gitlab/config/gitlab.rb
  Data:       /srv/gitlab/data
  Backups:    /srv/gitlab/backups       (daily 03:00)
  Compose:    ~/gitlab/docker-compose.yml
  Reconfigure: docker exec -it gitlab gitlab-ctl reconfigure
  Logs:       docker logs -f gitlab --tail 200
  Health:     curl http://10.10.1.110/-/readiness

  Registry:   Metadata database enabled (section 9.1)
              - OCI manifest support (BuildKit images display correctly)
              - Online GC (automatic, replaces manual cron)
              - GC health: docker exec -it gitlab sudo -u registry gitlab-ctl registry-database gc-stats

  SSO:        Azure AD (Entra ID) via OIDC
              - App Reg: "GitLab SSO" → openid, profile, email (delegated)
              - Login: Azure AD button + local password
              - Auto-create: yes, blocked until admin approves

  Email:      Office 365 SMTP (delegated SMTP.Send)
              - App Reg: "GitLab SMTP" → SMTP.Send (delegated)
              - Shared mailbox: gitlab-noreply@4bits.vn (no license)
              - Service principal with FullAccess to mailbox
              - Auth: mailbox user password (not app secret)
```
