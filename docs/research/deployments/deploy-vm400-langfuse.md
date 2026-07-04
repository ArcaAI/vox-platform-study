# Deploy Langfuse — VM 400 `master` (10.10.1.100)

**Date**: 2026-04-08
**VM**: 400 | **Name**: `master` | **IP**: 10.10.1.100 | **Bridge**: vmbr1 | **Specs**: 8c / 16 GB / 64 GB disk
**Config files**: [`configs/langfuse/`](../configs/langfuse/)
**Related**: [VM 400 — Rancher/Argo](./deploy-vm400-master.md) | [VM 402 — MinIO](./deploy-vm402-minio.md) | [VM 420/421 — Redis](./deploy-vm420-421-redis.md) | [VMs 500-502 — TimescaleDB HA](./deploy-vm500-502-postgres-ha.md) | [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md)

---

## Overview

Langfuse is an open-source LLM observability platform. This deployment tracks AI agent usage from Cursor IDE hooks, HOPE API LLM calls, and SDK traces.

### Architecture

```
                         INTERNET
                            │
                      Cloudflare Edge
                   langfuse.taphuynh.dev
                            │
                    CT 100 cloudflared
                            │
   ┌────────────────────────┼──────────────────────────────────┐
   │  VM 400 (10.10.1.100)                                     │
   │  ┌──────────────────────────────────────────────────────┐ │
   │  │  /opt/langfuse/  (Docker Compose project)            │ │
   │  │                                                      │ │
   │  │  ┌──────────────┐     ┌────────────────────────────┐ │ │
   │  │  │ langfuse-web │     │     langfuse-worker        │ │ │
   │  │  │ :3001 → :3000│     │     :3030 (localhost only) │ │ │
   │  │  └──────┬───────┘     └──────────┬─────────────────┘ │ │
   │  │         │                        │                   │ │
   │  │  ┌──────┴────────────────────────┴─────────────────┐ │ │
   │  │  │         langfuse-clickhouse (local)              │ │ │
   │  │  │  localhost:18123 (HTTP) / localhost:19000 (TCP)  │ │ │
   │  │  └─────────────────────────────────────────────────┘ │ │
   │  └──────────────────────────────────────────────────────┘ │
   │  ┌──────────────────────────────────────────────────────┐ │
   │  │  /opt/observability/  (existing — no changes)        │ │
   │  │  OTel · Prometheus(:9090) · Loki · Tempo             │ │
   │  │  Grafana(:3000)                                      │ │
   │  └──────────────────────────────────────────────────────┘ │
   │                        │                                   │
   │          ┌─────────────┼──────────────────┐               │
   │          ▼             ▼                   ▼               │
   │    VMs 500-502     VM 420            VM 402               │
   │    TimescaleDB     Redis 8           MinIO                │
   │    VIP:5000        :6379             :9000                │
   │    (db: langfuse)  (shared)          (bucket: langfuse)   │
   └───────────────────────────────────────────────────────────┘
```

### Components

| Component | Image | RAM Budget | Port (host) | Purpose |
|-----------|-------|------------|-------------|---------|
| langfuse-web | `langfuse/langfuse:3` | 512M–1G | 3001 | Web UI + API |
| langfuse-worker | `langfuse/langfuse-worker:3` | 512M–1G | 3030 (localhost) | Background jobs |
| langfuse-clickhouse | `clickhouse/clickhouse-server:25.3` | 1G–2G | 18123, 19000 (localhost) | Analytics store |
| **Total** | | **~2–4 GB** | | |

### Port Allocation on VM 400

| Port | Service | Notes |
|------|---------|-------|
| 3000 | Grafana (existing) | Observability stack |
| **3001** | **langfuse-web** | Remapped from 3000 to avoid conflict |
| **3030** | **langfuse-worker** | Localhost only |
| 3100 | Loki (existing) | Observability stack |
| 3200 | Tempo (existing) | Observability stack |
| 4317 | OTel gRPC (existing) | Observability stack |
| 4318 | OTel HTTP (existing) | Observability stack |
| 9090 | Prometheus (existing) | Observability stack |
| **18123** | **ClickHouse HTTP** | Remapped from 8123, localhost only |
| **19000** | **ClickHouse native** | Remapped from 9000, localhost only |

---

## Prerequisites

- VM 400 running Ubuntu 24.04 Server with Docker installed
- SSH access: `ssh hope@10.10.1.100` (or `ssh ssh-master`)
- Observability stack already deployed at `/opt/observability/` (see [deploy-vm400-master.md](./deploy-vm400-master.md))
- Cloudflare Tunnel (CT 100) operational

### Verify Existing Services

```bash
ssh hope@10.10.1.100
```

```bash
# Check available RAM (need ~4 GB free)
free -h

# Check existing containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Verify port 3001 is free
ss -tlnp | grep 3001
# (should return nothing)

# Verify connectivity to external dependencies
# PostgreSQL (VIP)
pg_isready -h 10.10.1.250 -p 5000
# → accepting connections

# Redis (VM 420)
redis-cli -h 10.10.1.120 -p 6379 -a '<REDIS_PASSWORD>' ping
# → PONG

# MinIO (VM 402)
curl -sk https://10.10.1.102:9000/minio/health/live
# → 200 OK
```

---

## 1. Create PostgreSQL Database

Langfuse stores its relational data (users, orgs, projects, traces metadata) in PostgreSQL. Create a dedicated database on the HA cluster.

### 1.1 — Create Database and User

Connect to the primary via HAProxy VIP:

```bash
psql -h 10.10.1.250 -p 5000 -U postgres
```

```sql
-- Create a dedicated user for Langfuse
CREATE USER langfuse WITH PASSWORD '76593cd720fd9d09a74628b0ad8584bdd7c60987df2be2be';

-- Create the database owned by the new user
CREATE DATABASE langfuse OWNER langfuse;

-- Connect to the new database
\c langfuse

-- Langfuse requires uuid-ossp for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Grant schema usage
GRANT ALL ON SCHEMA public TO langfuse;

-- Verify
\l langfuse
\du langfuse
\q
```

### 1.2 — Verify Connectivity from VM 400

```bash
# From VM 400
psql -h 10.10.1.250 -p 5000 -U langfuse -d langfuse -c "SELECT 1 AS connection_ok;"
#  connection_ok
# ---------------
#              1
```

> **Note**: Langfuse runs its own migrations on first startup. The database will be populated with ~50+ tables automatically. No manual schema setup is needed.

---

## 2. Create MinIO Bucket and Service Account

### 2.1 — Create the Bucket

From VM 402 (or any machine with `mc` configured):

```bash
# If mc is already configured with the homelab alias
mc mb homelab/langfuse --ignore-existing
mc ls homelab/ | grep langfuse
# → langfuse/
```

Or via MinIO Console at `https://s3-console.taphuynh.dev`:
1. Navigate to **Buckets** → **Create Bucket**
2. Bucket Name: `langfuse`
3. Leave versioning off
4. Click **Create Bucket**

### 2.2 — Create Service Account

```bash
# Create a dedicated user
LANGFUSE_SVC_PASSWORD=$(openssl rand -base64 32)
-- +BTCDYvA8qSJfgO1n1lEVD6gyg5m15wpnP1nH7gwGXA=
echo "Langfuse MinIO password: $LANGFUSE_SVC_PASSWORD"
echo "Save this — you need it for the service account"

mc admin user add homelab langfuse-svc "$LANGFUSE_SVC_PASSWORD"
```

### 2.3 — Create Access Policy

```bash
cat > /tmp/langfuse-minio-policy.json << 'POLICY'
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
        "s3:AbortMultipartUpload"
      ],
      "Resource": [
        "arn:aws:s3:::langfuse",
        "arn:aws:s3:::langfuse/*"
      ]
    }
  ]
}
POLICY

mc admin policy create homelab langfuse-policy /tmp/langfuse-minio-policy.json
mc admin policy attach homelab langfuse-policy --user langfuse-svc
rm /tmp/langfuse-minio-policy.json
```

### 2.4 — Create Access Keys

```bash
mc admin user svcacct add homelab langfuse-svc \
  --name "langfuse-s3" \
  --description "Langfuse event/media/export storage"

-- Access Key: P6MWIZBLZUB0GGBAU5NS
-- Secret Key: zvcZIcm7qVYz2eaUVIWGfsA+gwyLPNsAJgScFKQ2
-- Expiration: no-expiry
```

This outputs an **Access Key** and **Secret Key**. Save both — you'll use them as `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY` in the `.env` file.

### 2.5 — Copy MinIO CA Certificate to VM 400

MinIO on VM 402 is **HTTPS-only** (self-signed ECDSA cert, configured with `--certs-dir` — see [deploy-vm402-minio.md](./deploy-vm402-minio.md) §14). Plain HTTP returns "Client sent an HTTP request to an HTTPS server."

The Langfuse containers (Node.js) need to trust this CA. Docker containers don't inherit the host's trust store, so we:
1. Mount the CA cert file into each container
2. Set `NODE_EXTRA_CA_CERTS` to tell Node.js (and the AWS S3 SDK it uses) to trust it

```bash
# From VM 400
ssh hope@10.10.1.100

# Create the certs directory in the Langfuse project
mkdir -p ~/langfuse/certs

# Copy the CA cert from VM 402
scp hope@10.10.1.102:~/minio-certs/ca/ca.crt ~/langfuse/certs/minio-ca.crt

# Verify the cert is readable
openssl x509 -in ~/langfuse/certs/minio-ca.crt -noout -subject -issuer
# subject=CN = ARCAAI Internal CA, ...
# issuer=CN = ARCAAI Internal CA, ...

# Verify it can validate the MinIO server cert
openssl s_client -connect 10.10.1.102:9000 \
  -CAfile ~/langfuse/certs/minio-ca.crt < /dev/null 2>/dev/null \
  | grep "Verify return code"
# → Verify return code: 0 (ok)
```

The `docker-compose.yml` already handles the rest:
- Both `langfuse-web` and `langfuse-worker` mount `./certs/minio-ca.crt` into `/etc/ssl/certs/minio-ca.crt`
- `NODE_EXTRA_CA_CERTS` is set to that path, which tells the AWS SDK to trust the MinIO CA

```
~/langfuse/
├── docker-compose.yml
├── .env
└── certs/
    └── minio-ca.crt      ← copied from VM 402
```

> **Why not `update-ca-certificates`?** That updates the host OS trust store, but Docker containers run their own filesystem. The `NODE_EXTRA_CA_CERTS` approach is specific to Node.js and directly targets the AWS S3 SDK that Langfuse uses for MinIO connections.

---

## 3. Verify Redis Connectivity and Eviction Policy

Redis on VM 420 is shared with HOPE services. Langfuse uses key prefixes to isolate its data.

```bash
# From VM 400
redis-cli -h 10.10.1.120 -p 6379 -a '<REDIS_PASSWORD>' ping
# → PONG

# Check current keyspace usage
redis-cli -h 10.10.1.120 -p 6379 -a '<REDIS_PASSWORD>' INFO keyspace
# db0:keys=XXX,...

# Check memory headroom
redis-cli -h 10.10.1.120 -p 6379 -a '<REDIS_PASSWORD>' INFO memory | grep used_memory_human
# used_memory_human:XXX
```

### 3.1 — Fix Eviction Policy (Critical)

Langfuse uses BullMQ for job queues. BullMQ **requires** `maxmemory-policy noeviction` — if Redis evicts queue keys under memory pressure, jobs are silently lost and the worker log fills with warnings:

```
IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"
```

Check the current policy:

```bash
redis-cli -h 10.10.1.120 -a '<REDIS_PASSWORD>' CONFIG GET maxmemory-policy
# 1) "maxmemory-policy"
# 2) "allkeys-lru"    ← problem
```

**Option A: Change at runtime (takes effect immediately, persists via CONFIG REWRITE)**:

```bash
redis-cli -h 10.10.1.120 -a '<REDIS_PASSWORD>' CONFIG SET maxmemory-policy noeviction
redis-cli -h 10.10.1.120 -a '<REDIS_PASSWORD>' CONFIG REWRITE
```

**Option B: Edit `redis.conf` on VM 420** (persists across restarts):

SSH into VM 420 and edit the Redis config:

```bash
ssh hope@10.10.1.120
# Edit ~/redis/redis.conf (or the path mounted into the container)
# Change:  maxmemory-policy allkeys-lru
# To:      maxmemory-policy noeviction
# Then restart:
cd ~/redis && docker compose restart redis
```

Verify after change:

```bash
redis-cli -h 10.10.1.120 -a '<REDIS_PASSWORD>' CONFIG GET maxmemory-policy
# 1) "maxmemory-policy"
# 2) "noeviction"    ← correct
```

> **Impact on HOPE services**: The HOPE API and other services sharing this Redis don't rely on eviction — they use explicit TTLs and key expiration. Switching to `noeviction` means Redis will return errors (`OOM`) if memory fills up rather than silently evicting keys. This is the safer behavior for mixed workloads with job queues. Monitor memory usage via `redis-exporter` on `:9121`.

---

## 4. Generate Secrets

Generate all required secrets on VM 400:

```bash
ssh hope@10.10.1.100

echo "=== Langfuse Secrets ==="

echo -n "NEXTAUTH_SECRET=" && openssl rand -base64 32
echo -n "LANGFUSE_SALT=" && openssl rand -base64 32
echo -n "LANGFUSE_ENCRYPTION_KEY=" && openssl rand -hex 32
echo -n "CLICKHOUSE_PASSWORD=" && openssl rand -base64 24
echo -n "LANGFUSE_INIT_USER_PASSWORD=" && openssl rand -base64 16

echo ""
echo "Copy these values into /opt/langfuse/.env"
```

---

## 5. Deploy Config Files

### 5.1 — Create Deployment Directory

```bash
ssh hope@10.10.1.100

sudo mkdir -p /opt/langfuse
sudo chown $USER:$USER /opt/langfuse
cd /opt/langfuse
```

### 5.2 — Copy Docker Compose

```bash
# Option A: SCP from dev machine
scp research/configs/langfuse/docker-compose.yml hope@10.10.1.100:/opt/langfuse/

# Option B: SCP via Cloudflare Tunnel alias
scp research/configs/langfuse/docker-compose.yml ssh-master:/opt/langfuse/
```

### 5.3 — Create Environment File

Copy the example and fill in secrets:

```bash
cd /opt/langfuse

# Option A: SCP the example, then edit
scp research/configs/langfuse/.env.example hope@10.10.1.100:/opt/langfuse/.env

# Option B: Create from scratch
cat > .env << 'ENVEOF'
# ── PostgreSQL ──
PG_USER=langfuse
PG_PASSWORD=<paste-pg-password>

# ── Redis ──
REDIS_AUTH=<paste-redis-password>

# ── ClickHouse ──
CLICKHOUSE_USER=langfuse
CLICKHOUSE_PASSWORD=<paste-generated-clickhouse-password>

# ── MinIO ──
MINIO_ACCESS_KEY=<paste-minio-access-key>
MINIO_SECRET_KEY=<paste-minio-secret-key>

# ── Langfuse Core ──
NEXTAUTH_SECRET=<paste-generated-secret>
LANGFUSE_SALT=<paste-generated-salt>
LANGFUSE_ENCRYPTION_KEY=<paste-generated-hex-key>

# ── Initial Setup ──
LANGFUSE_INIT_ORG_NAME=ARCAAI
LANGFUSE_INIT_PROJECT_NAME=hope
LANGFUSE_INIT_USER_EMAIL=admin@taphuynh.dev
LANGFUSE_INIT_USER_NAME=admin
LANGFUSE_INIT_USER_PASSWORD=<paste-generated-admin-password>
ENVEOF

# Secure the file
chmod 600 .env
```

### 5.4 — Verify File Structure

```bash
find /opt/langfuse/ -type f | sort
# /opt/langfuse/.env
# /opt/langfuse/certs/minio-ca.crt
# /opt/langfuse/docker-compose.yml

# Verify the CA cert is present (required for MinIO HTTPS)
openssl x509 -in /opt/langfuse/certs/minio-ca.crt -noout -subject
# subject=CN = ARCAAI Internal CA, ...
```

---

## 6. Deploy

### 6.1 — Pull Images

```bash
cd /opt/langfuse

docker compose pull
# Pulling langfuse-web ...
# Pulling langfuse-worker ...
# Pulling clickhouse ...
```

### 6.2 — Start Services

```bash
docker compose up -d
```

### 6.3 — Watch Startup

```bash
# Watch all logs (Ctrl+C to stop)
docker compose logs -f

# Or watch specific service
docker compose logs -f langfuse-web
```

**What to expect during first startup** (~60-120 seconds):

1. **ClickHouse** starts first, passes health check in ~5s
2. **langfuse-web** and **langfuse-worker** start in parallel (both depend only on ClickHouse)
3. **langfuse-web** runs Prisma schema migrations (creates ~50+ tables in PostgreSQL)
4. **langfuse-worker** runs ClickHouse migrations and background data migrations
5. **langfuse-web** seeds initial org/project/user (from `LANGFUSE_INIT_*` vars)

> **Important**: `langfuse-web` must run its Prisma migrations before the worker can operate. On first startup, the worker will log errors about missing tables for ~30-60s until `langfuse-web` finishes creating them. This is normal — the worker retries automatically and recovers once the tables exist.

Look for these log lines indicating success:

```
langfuse-web     | prisma:migrate Applied migration ...
langfuse-web     | ▲ Next.js 14.x
langfuse-web     | - Local: http://localhost:3000
langfuse-web     | ✓ Ready in Xs
langfuse-worker  | Listening: http://...
```

### 6.4 — Verify Services

```bash
# All 3 services should be healthy
docker compose ps
# NAME                 STATUS           PORTS
# langfuse-clickhouse  Up (healthy)     127.0.0.1:18123->8123, 127.0.0.1:19000->9000
# langfuse-web         Up (healthy)     0.0.0.0:3001->3000
# langfuse-worker      Up (healthy)     127.0.0.1:3030->3030

# Health check endpoints
curl -s http://localhost:3001/api/public/health | python3 -m json.tool
# { "status": "OK" }

curl -s http://localhost:3030/api/public/health | python3 -m json.tool
# { "status": "OK" }

# ClickHouse
curl -s "http://localhost:18123/ping"
# Ok.
```

---

## 7. Configure Cloudflare Tunnel

### 7.1 — Add Public Hostname

1. Open [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Networks** → **Tunnels** → **hope-homelab**
3. Click **Edit** → **Public Hostname** tab
4. Click **Add a public hostname**

| Field | Value |
|-------|-------|
| Subdomain | `langfuse` |
| Domain | `taphuynh.dev` |
| Type | **HTTP** |
| URL | `10.10.1.100:3001` |

5. Expand **Additional application settings**:
   - **HTTP Settings** → HTTP Host Header: `langfuse.taphuynh.dev`

6. Click **Save hostname**

### 7.2 — Verify External Access

Wait ~30 seconds for propagation, then:

```bash
# From your Mac or any internet-connected machine
curl -sI https://langfuse.taphuynh.dev/api/public/health
# HTTP/2 200
# content-type: application/json

curl -s https://langfuse.taphuynh.dev/api/public/health
# {"status":"OK"}
```

### 7.3 — (Recommended) Add Cloudflare Access Policy

Protect the Langfuse UI with a Cloudflare Access gate so only authorized users can reach the login page:

1. In Zero Trust Dashboard → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Configure:

| Field | Value |
|-------|-------|
| Application name | Langfuse |
| Session Duration | 24 hours |
| Application domain | `langfuse.taphuynh.dev` |

4. Add a policy:

| Field | Value |
|-------|-------|
| Policy name | Allow ARCAAI Team |
| Action | Allow |
| Include — Emails | `admin@taphuynh.dev`, (add team members) |

5. Authentication method: **One-time PIN** (email-based, no OAuth setup required)

6. Click **Save**

Now, visiting `https://langfuse.taphuynh.dev` will first show a Cloudflare Access login page. After email verification, users reach the Langfuse login page.

### 7.4 — Bypass Access for API Ingestion

If your Cursor hooks or HOPE services send traces via the public URL, they need to bypass Cloudflare Access. Add a **Service Token** bypass:

1. **Access** → **Service Auth** → **Service Tokens** → **Create**
2. Name: `langfuse-ingestion`
3. Copy the **Client ID** and **Client Secret**
4. Go back to the Langfuse Access application → **Policies** → Add another policy:

| Field | Value |
|-------|-------|
| Policy name | API Ingestion |
| Action | Service Auth |
| Include — Service Token | `langfuse-ingestion` |

5. In your client SDK configuration, add these headers:

```
CF-Access-Client-Id: <client-id>
CF-Access-Client-Secret: <client-secret>
```

> **Simpler alternative**: If all ingestion happens from the internal network (`10.10.1.x`), configure clients to use `http://10.10.1.100:3001` directly instead of the public URL, bypassing Cloudflare entirely.

---

## 8. Post-Deployment Verification

### 8.1 — UI Login

1. Open `https://langfuse.taphuynh.dev` in your browser
2. Log in with the credentials from `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD`
3. Verify the org "ARCAAI" and project "hope" were created
4. Navigate to **Settings** → **API Keys** to get the project public/secret keys

### 8.2 — Database Tables

```bash
# From VM 400
psql -h 10.10.1.250 -p 5000 -U langfuse -d langfuse -c "\dt" | head -30
# Should list 50+ tables (users, traces, observations, scores, etc.)
```

### 8.3 — ClickHouse Tables

```bash
curl -s "http://localhost:18123/?query=SHOW+TABLES+FROM+default" \
  --user "langfuse:$(grep CLICKHOUSE_PASSWORD /opt/langfuse/.env | cut -d= -f2)"
# Should list analytics tables
```

### 8.4 — MinIO Bucket

```bash
# From VM 402 or any machine with mc
mc ls homelab/langfuse/
# May be empty until traces with media are ingested
```

### 8.5 — Redis Keys

```bash
redis-cli -h 10.10.1.120 -a '<REDIS_PASSWORD>' KEYS '*langfuse*' | head -10
# May show BullMQ queue keys after ingestion starts
```

### 8.6 — Send a Test Trace

Quick test using curl (replace keys with values from step 8.1):

```bash
curl -X POST https://langfuse.taphuynh.dev/api/public/ingestion \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'pk-lf-XXXXX:sk-lf-XXXXX' | base64)" \
  -d '{
    "batch": [{
      "id": "test-trace-001",
      "type": "trace-create",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
      "body": {
        "id": "test-trace-001",
        "name": "deployment-verification",
        "metadata": {"source": "manual-test"}
      }
    }]
  }'
# → {"successes":[{"id":"test-trace-001","status":200}],"errors":[]}
```

Verify the trace appears in the Langfuse UI under **Traces**.

---

## 9. Update HOPE Configuration

### 9.1 — Update Cursor Hooks

Update `.env.dev` in the HOPE project root:

```bash
# Old values (Langfuse Cloud)
# LANGFUSE_SECRET_KEY="sk-lf-..."
# LANGFUSE_PUBLIC_KEY="pk-lf-..."
# LANGFUSE_BASE_URL="http://localhost:3000"

# New values (self-hosted)
LANGFUSE_SECRET_KEY="sk-lf-<new-secret-key-from-ui>"
LANGFUSE_PUBLIC_KEY="pk-lf-<new-public-key-from-ui>"
LANGFUSE_BASE_URL="https://langfuse.taphuynh.dev"
```

The Cursor hooks client at `.cursor/hooks/lib/langfuse-client.js` already reads these variables. No code changes needed.

### 9.2 — Update HOPE API (if using Langfuse SDK)

If the HOPE API gateway or Python services use the Langfuse SDK, update their environment variables in the K3s deployment manifests or `.env.production`:

```bash
LANGFUSE_SECRET_KEY=sk-lf-<key>
LANGFUSE_PUBLIC_KEY=pk-lf-<key>
LANGFUSE_BASE_URL=http://10.10.1.100:3001  # Internal URL for in-cluster traffic
```

> **Best practice**: Services on the internal network should use `http://10.10.1.100:3001` (direct) instead of the public URL. This avoids the Cloudflare roundtrip and any Access policy complications.

---

## 10. Remove Init Variables

After verifying login and confirming the org/project/user were created:

```bash
cd /opt/langfuse

# Edit .env and comment out or remove these lines:
# LANGFUSE_INIT_ORG_NAME=...
# LANGFUSE_INIT_PROJECT_NAME=...
# LANGFUSE_INIT_USER_EMAIL=...
# LANGFUSE_INIT_USER_NAME=...
# LANGFUSE_INIT_USER_PASSWORD=...

# Restart to apply
docker compose restart
```

This prevents the init logic from running on every restart.

---

## Operational Notes

### Upgrading Langfuse

```bash
cd /opt/langfuse

# Check current version
docker compose exec langfuse-web cat package.json | grep version

# Pull latest images
docker compose pull

# Restart with new images (migrations run automatically)
docker compose up -d

# Watch migration logs
docker compose logs -f langfuse-worker | head -50

# Verify health
docker compose ps
curl -s http://localhost:3001/api/public/health
```

> **Breaking changes**: Check the [Langfuse changelog](https://langfuse.com/changelog) before major upgrades. Pin the image tag in `docker-compose.yml` if you want controlled upgrades (e.g., `langfuse/langfuse:3.5.0` instead of `:3`).

### Logs

```bash
cd /opt/langfuse

# All services
docker compose logs -f --tail 100

# Specific service
docker compose logs -f langfuse-web --tail 100
docker compose logs -f langfuse-worker --tail 100
docker compose logs -f langfuse-clickhouse --tail 100

# Search for errors
docker compose logs langfuse-web 2>&1 | grep -i error | tail -20
```

### Restart

```bash
cd /opt/langfuse

# Restart all
docker compose restart

# Restart specific service
docker compose restart langfuse-web

# Full recreate (if compose file changed)
docker compose down && docker compose up -d
```

### Backup

#### PostgreSQL (via HA cluster)

The `langfuse` database is included in the Patroni replication and pgBackRest backups automatically. To take an ad-hoc dump:

```bash
pg_dump -h 10.10.1.250 -p 5000 -U langfuse -d langfuse -Fc \
  -f /tmp/langfuse-$(date +%F).dump

# Copy to MinIO
mc cp /tmp/langfuse-$(date +%F).dump homelab/langfuse/backups/
```

#### ClickHouse

```bash
# Export all tables as backup
docker exec langfuse-clickhouse clickhouse-client \
  --user langfuse \
  --password "$(grep CLICKHOUSE_PASSWORD /opt/langfuse/.env | cut -d= -f2)" \
  --query "SELECT * FROM system.tables WHERE database = 'default'" \
  --format TSV
```

ClickHouse data is stored in the `clickhouse-data` Docker volume. For volume-level backup:

```bash
# Stop ClickHouse, tar the volume, restart
docker compose stop clickhouse
sudo tar czf /tmp/clickhouse-data-$(date +%F).tar.gz \
  -C /var/lib/docker/volumes/langfuse_clickhouse-data/_data .
docker compose start clickhouse
```

### Monitoring

Add Langfuse health checks to Prometheus. Add to `/opt/observability/configs/prometheus/prometheus.yml`:

```yaml
  - job_name: 'langfuse'
    metrics_path: /api/public/health
    scrape_interval: 30s
    static_configs:
      - targets: ['10.10.1.100:3001']
        labels:
          service: langfuse-web
      - targets: ['10.10.1.100:3030']
        labels:
          service: langfuse-worker
```

Then reload Prometheus:

```bash
curl -X POST http://localhost:9090/-/reload
```

### Resource Monitoring

```bash
# Container resource usage
docker stats --no-stream langfuse-web langfuse-worker langfuse-clickhouse

# Disk usage
docker system df -v | grep langfuse

# ClickHouse disk usage
curl -s "http://localhost:18123/?query=SELECT+formatReadableSize(sum(bytes_on_disk))+FROM+system.parts" \
  --user "langfuse:$(grep CLICKHOUSE_PASSWORD /opt/langfuse/.env | cut -d= -f2)"
```

---

## Troubleshooting

### langfuse-worker fails to start

**Symptom**: Worker exits with database connection error.

```bash
docker compose logs langfuse-worker | grep -i "error\|connect"
```

**Common causes**:
1. Wrong `DATABASE_URL` — check `PG_USER`, `PG_PASSWORD` in `.env`
2. `langfuse` database doesn't exist — see step 1
3. Network unreachable — check `ping 10.10.1.250` from VM 400
4. pg_hba.conf rejects connection — verify Patroni allows the VM 400 IP

### ClickHouse health check fails

**Symptom**: `langfuse-clickhouse` stays `unhealthy`.

```bash
docker compose logs langfuse-clickhouse | tail -20
curl -v http://localhost:18123/ping
```

**Common causes**:
1. Port conflict — another service on 18123/19000
2. Permission error — ClickHouse user `101:101` can't write to volume

### MinIO S3 errors

**Symptom**: "AccessDenied", "NoSuchBucket", or TLS errors in langfuse-worker logs.

```bash
docker compose logs langfuse-worker | grep -i "s3\|minio\|bucket\|certificate\|CERT\|tls\|ssl"
```

**Common causes**:
1. **`UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `CERT_HAS_EXPIRED`** — CA cert missing or wrong. Verify:
   ```bash
   ls -la /opt/langfuse/certs/minio-ca.crt
   # Must exist and be readable
   docker compose exec langfuse-worker cat /etc/ssl/certs/minio-ca.crt | head -1
   # → -----BEGIN CERTIFICATE-----
   ```
2. **`langfuse` bucket doesn't exist** — see step 2.1
3. **Wrong access key/secret** — verify `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` in `.env`
4. **Policy doesn't cover all required actions** — see step 2.3
5. **"Client sent an HTTP request to an HTTPS server"** — endpoint uses `http://` but MinIO is HTTPS-only. The compose file should use `https://10.10.1.102:9000`

### Port 3001 not accessible externally

**Symptom**: `curl http://10.10.1.100:3001` works from VM 400 but not from other VMs.

```bash
# Check if firewall is blocking
sudo ufw status
sudo iptables -L INPUT -n | grep 3001
```

**Fix**: Allow the port in the firewall:

```bash
sudo ufw allow from 10.10.1.0/24 to any port 3001 proto tcp comment "Langfuse web"
```

---

## Verification Checklist

```bash
# ── Services ──
docker compose -f /opt/langfuse/docker-compose.yml ps
# → 3 services healthy

# ── Health Endpoints ──
curl -s http://localhost:3001/api/public/health
# → {"status":"OK"}

curl -s http://localhost:3030/api/public/health
# → {"status":"OK"}

curl -s http://localhost:18123/ping
# → Ok.

# ── External Access ──
curl -s https://langfuse.taphuynh.dev/api/public/health
# → {"status":"OK"}

# ── Database ──
psql -h 10.10.1.250 -p 5000 -U langfuse -d langfuse -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
# → 50+ tables

# ── Redis ──
redis-cli -h 10.10.1.120 -a '<REDIS_PASSWORD>' ping
# → PONG

# ── MinIO ──
mc ls homelab/langfuse/
# → (bucket exists)

# ── UI Login ──
# https://langfuse.taphuynh.dev — login with admin credentials
```

---

## Quick Reference

```
VM 400 — Langfuse (self-hosted LLM observability)
  IP:          10.10.1.100
  Web UI:      http://10.10.1.100:3001  (langfuse.taphuynh.dev via tunnel)
  Worker:      http://10.10.1.100:3030  (localhost only)
  ClickHouse:  127.0.0.1:18123 (HTTP), 127.0.0.1:19000 (native)
  Compose:     /opt/langfuse/docker-compose.yml
  Env:         /opt/langfuse/.env (chmod 600)
  Network:     langfuse (Docker bridge)
  RAM budget:  ~3–4 GB (web 1G + worker 1G + CH 2G)

  External dependencies:
    PostgreSQL:  10.10.1.250:5000  (db: langfuse, user: langfuse)
    Redis:       10.10.1.120:6379  (shared, key-prefixed)
    MinIO:       10.10.1.102:9000  (bucket: langfuse)
```
