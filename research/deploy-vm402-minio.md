# Deploy MinIO — VM 402 (10.10.1.102)

**Date**: 2026-03-16
**VM**: 402 | **IP**: 10.10.1.102 | **Bridge**: vmbr1 | **Specs**: 8c / 16 GB / 64 GB disk
**Config files**: [`configs/minio/`](./configs/minio/)
**Related**: [Infrastructure Overview](./proxmox-infrastructure-gitlab-rancher-plan.md) | [GitLab Deployment](./deploy-vm410-gitlab.md) | [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md)

---

## Prerequisites

- VM 402 running Ubuntu 24.04 Server
- SSH access: `ssh hope@10.10.1.102`
- Cloudflare Tunnel (CT 101) configured with `s3.taphuynh.dev → http://10.10.1.102:9000`

---

## 1. Expand Disk (Proxmox Host)

MinIO stores all object data on disk. 64 GB is not enough for GitLab artifacts, LFS, registry layers, and backups.

```bash
# On the Proxmox host (SSH or web shell)
qm resize 402 virtio0 +136G
```

This is instant and non-disruptive. The guest OS still needs to see the new space.

## 2. Extend Filesystem (Inside VM 402)

```bash
ssh hope@10.10.1.102
```

```bash
# Check current layout
lsblk
df -h /

# Ubuntu 24.04 LVM layout:
#   /dev/vda1 = EFI (512M)
#   /dev/vda2 = /boot (1G)
#   /dev/vda3 = LVM PV (rest)

# Grow the GPT partition
sudo growpart /dev/vda 3

# Resize the LVM physical volume
sudo pvresize /dev/vda3

# Extend the logical volume
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv

# Resize the filesystem
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv

# Verify — should show ~195 GB
df -h /
```

> **Non-LVM layout?** Use `sudo growpart /dev/vda 2` then `sudo resize2fs /dev/vda2` instead.

## 3. Install Docker

```bash
# Install Docker Engine
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Log out and back in for group change to take effect
exit
```

```bash
# Reconnect and verify
ssh hope@10.10.1.102
docker --version
docker compose version
```

## 4. Prepare Directories

```bash
# Data directory — all S3 objects live here
sudo mkdir -p /srv/minio/data
sudo chown -R $USER:$USER /srv/minio

# Docker Compose project
mkdir -p ~/minio && cd ~/minio
```

## 5. Deploy Config Files

### 5.1 — Environment File

Create the `.env` file with your root credentials:

```bash
cd ~/minio

cat > .env <<'EOF'
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=CHANGE_ME_TO_A_STRONG_PASSWORD
EOF

# Secure the file
chmod 600 .env
```

> **Important**: Change `MINIO_ROOT_PASSWORD` to a strong password (24+ characters recommended). This is the admin account for MinIO Console and the initial S3 access key.

### 5.2 — Docker Compose

Copy the compose file from this repo:

```bash
# Option A: SCP from dev machine
scp docs/research/configs/minio/docker-compose.yml hope@10.10.1.102:~/minio/

# Option B: Create directly on VM 402
cat > ~/minio/docker-compose.yml <<'COMPOSE'
services:
  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
    container_name: minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: "${MINIO_ROOT_USER}"
      MINIO_ROOT_PASSWORD: "${MINIO_ROOT_PASSWORD}"
      MINIO_SERVER_URL: "https://s3.taphuynh.dev"
      MINIO_BROWSER_REDIRECT_URL: "https://s3-console.taphuynh.dev"
      MINIO_SCANNER_SPEED: "slow"
    volumes:
      - /srv/minio/data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 1G
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "3"
COMPOSE
```

## 6. Start MinIO

```bash
cd ~/minio

# Pull the image
docker compose pull

# Start MinIO
docker compose up -d

# Verify it's running
docker compose ps
docker logs minio --tail 20
```

Expect output containing:
```
MinIO Object Storage Server
API: http://0.0.0.0:9000
WebUI: http://0.0.0.0:9001
```

### Quick Health Check

```bash
curl -s http://10.10.1.102:9000/minio/health/live
# → HTTP 200 (no body) means healthy

curl -s http://10.10.1.102:9000/minio/health/ready
# → HTTP 200 means ready to serve
```

## 7. Install MinIO Client (mc)

```bash
# Download mc binary
curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /tmp/mc
sudo install /tmp/mc /usr/local/bin/mc
rm /tmp/mc

# Verify
mc --version
```

### Configure mc alias

```bash
mc alias set homelab http://10.10.1.102:9000 minioadmin 'CHANGE_ME_TO_A_STRONG_PASSWORD'

# Test connection
mc admin info homelab
```

## 8. Create GitLab Service Account

GitLab should use a dedicated service account instead of the root credentials.

### 8.1 — Create User

```bash
# Generate a strong password for the service account
GITLAB_SVC_PASSWORD=$(openssl rand -base64 32)
echo "GitLab service account password: $GITLAB_SVC_PASSWORD"
echo "Save this password — you'll need it for gitlab.rb"

# Create the service account
mc admin user add homelab gitlab-svc "$GITLAB_SVC_PASSWORD"
```

### 8.2 — Create Access Policy

```bash
cat > /tmp/gitlab-policy.json <<'POLICY'
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
        "s3:ListBucketMultipartUploads",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning"
      ],
      "Resource": [
        "arn:aws:s3:::gitlab-*",
        "arn:aws:s3:::gitlab-*/*"
      ]
    }
  ]
}
POLICY

mc admin policy create homelab gitlab-policy /tmp/gitlab-policy.json
mc admin policy attach homelab gitlab-policy --user gitlab-svc
rm /tmp/gitlab-policy.json
```

> **Why these extra permissions?** The Container Registry's S3 driver uses multipart uploads for blob layers. `s3:ListBucketMultipartUploads` is required for the registry to list and resume in-progress uploads. `s3:GetBucketVersioning` and `s3:PutBucketVersioning` are checked by some S3 drivers during initialization. Without these, the registry returns 500 Internal Server Error on push with `AccessDenied` in the logs.

### 8.3 — Create Access Keys for gitlab-svc

```bash
mc admin user svcacct add homelab gitlab-svc \
  --name "gitlab-s3" \
  --description "GitLab object storage"
```

This outputs an `Access Key` and `Secret Key`. **Save both** — you'll enter them in `gitlab.rb` section 7 as `aws_access_key_id` and `aws_secret_access_key`.

## 9. Create GitLab Buckets

```bash
# Create all required buckets
BUCKETS=(
  gitlab-artifacts
  gitlab-lfs
  gitlab-uploads
  gitlab-packages
  gitlab-mr-diffs
  gitlab-terraform-state
  gitlab-ci-secure-files
  gitlab-pages
  gitlab-dependency-proxy
  gitlab-registry
  gitlab-backups
)

for bucket in "${BUCKETS[@]}"; do
  mc mb "homelab/$bucket" --ignore-existing
  echo "  [ok] $bucket"
done

# Verify
mc ls homelab
```

Expected output: 11 buckets listed.

## 10. Configure Bucket Lifecycle (Optional)

Set expiration policies to prevent unbounded growth:

```bash
# Expire incomplete multipart uploads after 7 days (all buckets)
for bucket in "${BUCKETS[@]}"; do
  mc ilm rule add "homelab/$bucket" \
    --expire-delete-marker \
    --noncurrent-expire-days 7
done

# Expire old backups after 90 days
mc ilm rule add homelab/gitlab-backups \
  --expiry-days 90
```

## 11. Access MinIO Console (Web UI)

From a machine on the internal network:

```
http://10.10.1.102:9001
```

Login with your `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`.

From the console you can:
- Browse buckets and objects
- Manage users and policies
- View server metrics
- Create additional access keys

## 12. Cloudflare Tunnel (External Access)

If `s3.taphuynh.dev` is configured in the Cloudflare Tunnel (CT 101), verify:

```bash
# From your Mac
curl -s https://s3.taphuynh.dev/minio/health/live
# → 200 OK
```

> **Cloudflare Free Tier Note**: External S3 API access via `s3.taphuynh.dev` is subject to the 100 MB HTTP upload limit. This is fine for browsing and small operations. GitLab ↔ MinIO traffic uses the internal `10.10.1.x` network and is **not affected**. For large uploads from outside, use `mc` via SSH tunnel or push through the internal network.

## 13. Automated Backup

MinIO data lives at `/srv/minio/data`. Back up to NFS shared storage:

```bash
sudo tee /usr/local/bin/minio-backup.sh <<'SCRIPT'
#!/bin/bash
set -euo pipefail

LOG_TAG="minio-backup"
TIMESTAMP=$(date +%F_%H%M)

logger -t "$LOG_TAG" "Starting MinIO metadata backup..."

# Back up MinIO internal metadata (.minio.sys)
tar czf /tmp/minio-meta-${TIMESTAMP}.tar.gz -C /srv/minio/data .minio.sys 2>&1 | logger -t "$LOG_TAG"

# Copy to NFS if mounted
if mountpoint -q /mnt/shared 2>/dev/null; then
  mkdir -p /mnt/shared/backups/minio
  mv /tmp/minio-meta-${TIMESTAMP}.tar.gz /mnt/shared/backups/minio/
  find /mnt/shared/backups/minio -mtime +30 -delete 2>/dev/null || true
  logger -t "$LOG_TAG" "Metadata backup copied to NFS"
else
  mv /tmp/minio-meta-${TIMESTAMP}.tar.gz /srv/minio/
  find /srv/minio/minio-meta-*.tar.gz -mtime +7 -delete 2>/dev/null || true
  logger -t "$LOG_TAG" "Metadata backup saved locally (NFS not mounted)"
fi

logger -t "$LOG_TAG" "Backup completed"
SCRIPT

sudo chmod +x /usr/local/bin/minio-backup.sh

# Schedule daily at 02:00
(sudo crontab -l 2>/dev/null; echo '0 2 * * * /usr/local/bin/minio-backup.sh') | sudo crontab -
```

## 14. Upgrading MinIO

```bash
cd ~/minio

# 1. Check current version
docker exec minio mc --version

# 2. Update the image tag in docker-compose.yml
# Visit https://github.com/minio/minio/releases for latest stable tag

# 3. Pull and recreate
docker compose pull
docker compose up -d

# 4. Verify
docker logs minio --tail 10
curl -s http://10.10.1.102:9000/minio/health/ready
```

## 15. Verification Checklist

```bash
# Service running
docker compose ps
# → minio  running (healthy)

# S3 API reachable
curl -sI http://10.10.1.102:9000/minio/health/live
# → HTTP/1.1 200 OK

# Console reachable
curl -sI http://10.10.1.102:9001
# → HTTP/1.1 200 OK

# mc can list buckets
mc ls homelab
# → 11 gitlab-* buckets listed

# Service account works
mc alias set gitlab-test http://10.10.1.102:9000 <ACCESS_KEY> <SECRET_KEY>
mc ls gitlab-test
# → lists buckets allowed by policy

# Disk space
df -h /
# → ~195 GB available
```

## 16. Next Steps

After MinIO is verified:

1. **Deploy GitLab** → see [deploy-vm410-gitlab.md](./deploy-vm410-gitlab.md)
2. **Enable object storage** → uncomment section 7 in [`configs/gitlab/gitlab.rb`](./configs/gitlab/gitlab.rb), fill in the access key/secret from step 8.3, then `docker exec -it gitlab gitlab-ctl reconfigure`
3. **Deploy GitLab Runner** → see [deploy-vm411-gitlab-runner.md](./deploy-vm411-gitlab-runner.md)

---

## Quick Reference

```
VM 402 — MinIO Object Storage
  IP:        10.10.1.102
  S3 API:    http://10.10.1.102:9000  (s3.taphuynh.dev via tunnel)
  Console:   http://10.10.1.102:9001
  Data:      /srv/minio/data
  Compose:   ~/minio/docker-compose.yml
  Backup:    daily 02:00 → /mnt/shared/backups/minio/
  Buckets:   11 gitlab-* buckets
```
