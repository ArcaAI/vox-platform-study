# Database Access via Cloudflare Tunnel — Domain Setup

**Date**: 2026-03-21
**Services**: PostgreSQL HA Cluster (VMs 500–502) + HAProxy Dashboard
**Domains**: `db.taphuynh.dev` (PostgreSQL TCP) | `ha-db.taphuynh.dev` (HAProxy Stats HTTP)
**Related**: [Cloudflare Tunnel (CT 101)](../deployments/deploy-ct101-cloudflare-tunnel.md) | [SSH Setup (Mac)](./ssh-cloudflared-setup-mac.md) | [PostgreSQL HA Deployment](../deployments/deploy-vm500-502-postgres-ha.md)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Access Methods Summary](#3-access-methods-summary)
4. [Method 1 — SSH Port Forwarding (Recommended for Dev/Admin)](#4-method-1--ssh-port-forwarding-recommended-for-devadmin)
5. [Method 2 — cloudflared access tcp with db.taphuynh.dev](#5-method-2--cloudflared-access-tcp-with-dbtaphuynh-dev)
6. [HAProxy Dashboard — ha-db.taphuynh.dev](#6-haproxy-dashboard--ha-dbtaphuynh-dev)
7. [Internal Application Access](#7-internal-application-access)
8. [Shell Aliases and Convenience](#8-shell-aliases-and-convenience)
9. [Security Considerations](#9-security-considerations)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Overview

The PostgreSQL HA cluster runs on VMs 500–502 behind a private network (`10.10.1.0/24`). There are two access patterns:

| Consumer | Network | Connection Target | Protocol |
|----------|---------|-------------------|----------|
| **Internal apps** (API gateway, services on same LAN) | `10.10.1.x` | VIP `10.10.1.250:5000` (R/W) or `:5001` (RO) | Direct TCP |
| **External admin** (your Mac, remote dev) | Internet | Via Cloudflare Tunnel | TCP over SSH or `cloudflared access tcp` |

**Key principle**: Production application traffic stays on the LAN. Cloudflare Tunnel is for development and administration only.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Mac (External)                                                             │
│                                                                             │
│  ┌─ Method 1: SSH Port Forward ──────────────────────────────────────────┐  │
│  │  ssh -L 15432:10.10.1.250:5000 db0                                   │  │
│  │    → ~/.ssh/config resolves db0 → ssh-db0.taphuynh.dev               │  │
│  │    → ProxyCommand cloudflared access ssh --hostname %h               │  │
│  │    → SSH tunnel to VM 500 → forwards to VIP:5000 (HAProxy)          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─ Method 2: cloudflared access tcp ────────────────────────────────────┐  │
│  │  cloudflared access tcp --hostname db.taphuynh.dev --url :15432      │  │
│  │    → Cloudflare Edge → CT 101 → tcp://10.10.1.250:5000              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  psql -h localhost -p 15432 -U postgres                                     │
│                                                                             │
└─────────────────────┬───────────────────────────────────────────────────────┘
                      │ Cloudflare Tunnel
                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  CT 101 — cloudflared (multi-homed on vmbr1)                                │
│                                                                             │
│  ssh-db0.taphuynh.dev  → ssh://10.10.1.200:22   (Method 1)                 │
│  db.taphuynh.dev       → tcp://10.10.1.250:5000  (Method 2)                │
│  ha-db.taphuynh.dev    → http://10.10.1.250:7000 (HAProxy Stats)           │
│                                                                             │
└─────────────────────┬───────────────────────────────────────────────────────┘
                      │ L2 on vmbr1 (10.10.1.0/24)
                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  VIP 10.10.1.250 (Keepalived)                                               │
│    ├─ :5000 → HAProxy pg_primary  → Leader (10.10.1.200:5432)              │
│    ├─ :5001 → HAProxy pg_replicas → Replicas (round-robin)                 │
│    └─ :7000 → HAProxy stats dashboard                                       │
│                                                                             │
│  VM 500 (10.10.1.200) — pg-node1 (Leader)                                  │
│  VM 501 (10.10.1.201) — pg-node2 (Sync Standby)                            │
│  VM 502 (10.10.1.202) — pg-node3 (Replica)                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Access Methods Summary

| Method | Domain | Setup Effort | Auth | Best For |
|--------|--------|-------------|------|----------|
| **SSH Port Forward** | N/A (uses `ssh db0`) | None (already working) | SSH key | Solo dev, daily admin |
| **`cloudflared access tcp`** | `db.taphuynh.dev` | Tunnel rule + Access policy | Cloudflare SSO | Named domain, team access |
| **Direct LAN** | N/A | None | PostgreSQL auth | Internal apps (production) |

---

## 4. Method 1 — SSH Port Forwarding (Recommended for Dev/Admin)

This uses the existing SSH tunnel infrastructure. No new tunnel rules or DNS records needed.

### 4.1 One-Time Setup

Nothing — SSH access to `db0`, `db1`, `db2` is already configured via Cloudflare Tunnel (see [SSH Setup](./ssh-cloudflared-setup-mac.md)).

### 4.2 Start the Tunnel

```bash
# Read/Write (primary via HAProxy VIP)
ssh -f -N -L 15432:10.10.1.250:5000 db0

# Read-Only (replicas via HAProxy VIP)
ssh -f -N -L 15433:10.10.1.250:5001 db0
```

| Flag | Purpose |
|------|---------|
| `-f` | Background after authentication |
| `-N` | No remote command (tunnel only) |
| `-L 15432:10.10.1.250:5000` | Forward local port 15432 → VIP read/write |

### 4.3 Connect

```bash
# psql
psql -h localhost -p 15432 -U postgres

# With a specific database
psql -h localhost -p 15432 -U postgres -d hope

# Read-only replica
psql -h localhost -p 15433 -U postgres -d hope

# Connection string (for GUI tools like DBeaver, DataGrip, pgAdmin)
postgresql://postgres:<password>@localhost:15432/hope
```

### 4.4 Stop the Tunnel

```bash
# Find and kill the SSH tunnel process
kill $(lsof -ti:15432)

# Or kill both R/W and RO tunnels
kill $(lsof -ti:15432) $(lsof -ti:15433) 2>/dev/null
```

### 4.5 Direct Node Access (Bypass HAProxy)

For debugging or maintenance, connect directly to a specific node:

```bash
# Direct to pg-node1 (VM 500) PostgreSQL
ssh -f -N -L 15432:localhost:5432 db0

# Direct to pg-node2 (VM 501) PostgreSQL
ssh -f -N -L 15432:localhost:5432 db1

# Direct to Patroni REST API on pg-node1
ssh -f -N -L 18008:localhost:8008 db0
curl http://localhost:18008/cluster | python3 -m json.tool
```

---

## 5. Method 2 — `cloudflared access tcp` with `db.taphuynh.dev`

This creates a dedicated domain name for database access, protected by Cloudflare Access (Zero Trust SSO).

### 5.1 Add Public Hostnames in Zero Trust Dashboard

All tunnel configuration is managed via the **Cloudflare Zero Trust Dashboard** (not `config.yml`).

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Networks** → **Tunnels**
3. Select the **hope-homelab** tunnel → **Public Hostnames** tab
4. Click **Add a public hostname** and create each entry:

| Subdomain | Domain | Type | URL |
|-----------|--------|------|-----|
| `db` | `taphuynh.dev` | **TCP** | `10.10.1.250:5000` |
| `db-ro` | `taphuynh.dev` | **TCP** | `10.10.1.250:5001` |

> **Note**: When you add a public hostname via the dashboard, Cloudflare automatically creates the CNAME DNS record. No need to run `cloudflared tunnel route dns` manually.

### 5.2 Create Cloudflare Access Policy

Without an Access policy, anyone who knows the hostname can attempt to connect. Add a policy to require authentication:

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** → **Applications** → **Add an Application**
3. Choose **Self-hosted**
4. Configure:

| Field | Value |
|-------|-------|
| Application name | PostgreSQL HA Cluster |
| Application domain | `db.taphuynh.dev` |
| Additional domains | `db-ro.taphuynh.dev` |
| Session duration | 24 hours |

5. Create an Access Policy:

| Field | Value |
|-------|-------|
| Policy name | Allow Admin |
| Action | Allow |
| Include rule | Emails: `your-email@gmail.com` |

6. Save the application.

### 5.3 Client-Side — Connect

```bash
# Start the local TCP proxy (first connection opens browser for SSO)
cloudflared access tcp --hostname db.taphuynh.dev --url localhost:15432

# In another terminal — connect with psql
psql -h localhost -p 15432 -U postgres -d hope

# Read-only
cloudflared access tcp --hostname db-ro.taphuynh.dev --url localhost:15433
psql -h localhost -p 15433 -U postgres -d hope
```

On the first connection, your browser will open for Cloudflare Access SSO authentication. After authenticating, the token is cached for the session duration (24 hours).

> **Important**: You must use `cloudflared access tcp` as the local proxy. Do NOT try to connect `psql` directly to `db.taphuynh.dev` — Cloudflare Access injects an HTTP auth step that conflicts with PostgreSQL's binary protocol.

### 5.4 Automated Access (CI/CD, Scripts)

For non-interactive use, create a **Service Token** in Cloudflare Access:

1. Go to **Access** → **Service Auth** → **Create Service Token**
2. Save the `Client ID` and `Client Secret` (secret is shown only once)
3. Add a second policy to the PostgreSQL Access Application:

| Field | Value |
|-------|-------|
| Policy name | Allow CI/CD |
| Action | **Service Auth** |
| Include rule | Service Token: `ci-cd-db-access` |

> The policy action must be **Service Auth** (not Allow) for service tokens to work without a browser prompt.

```bash
cloudflared access tcp \
  --hostname db.taphuynh.dev \
  --url localhost:15432 \
  --service-token-id "$CF_SERVICE_TOKEN_ID" \
  --service-token-secret "$CF_SERVICE_TOKEN_SECRET"
```

> **Note**: Service tokens for TCP have [known stability issues](https://github.com/cloudflare/cloudflared/issues/602). For CI/CD pipelines running on the same LAN, prefer direct VIP access instead.

---

## 6. HAProxy Dashboard — `ha-db.taphuynh.dev`

The HAProxy stats dashboard is HTTP (port 7000), so it works natively with Cloudflare Tunnel.

### 6.1 Add Public Hostname in Zero Trust Dashboard

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Networks** → **Tunnels**
3. Select the **hope-homelab** tunnel → **Public Hostnames** tab
4. Click **Add a public hostname**:

| Subdomain | Domain | Type | URL |
|-----------|--------|------|-----|
| `ha-db` | `taphuynh.dev` | **HTTP** | `http://10.10.1.250:7000` |

> **Prerequisite**: CT 101 (`10.10.1.2`) must be allowed through UFW on VMs 500–502. Without this, all TCP connections from the tunnel to the DB cluster will silently hang. See [Section 6.5 of the deployment guide](../deployments/deploy-vm500-502-postgres-ha.md#65-configure-firewall) for the full UFW setup, which includes `sudo ufw allow from 10.10.1.2 to any`.

### 6.2 Create Cloudflare Access Policy (Strongly Recommended)

The HAProxy stats page has no built-in authentication. Protect it with Cloudflare Access:

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** → **Applications** → **Add an Application**
3. Choose **Self-hosted**
4. Configure:

| Field | Value |
|-------|-------|
| Application name | HAProxy DB Dashboard |
| Application domain | `ha-db.taphuynh.dev` |
| Session duration | 24 hours |

5. Create an Access Policy:

| Field | Value |
|-------|-------|
| Policy name | Allow Admin |
| Action | Allow |
| Include rule | Emails: `your-email@gmail.com` |

6. Save.

### 6.3 Verify

Open in your browser: `https://ha-db.taphuynh.dev`

You should see:
- Cloudflare Access login page (first visit)
- After SSO: HAProxy stats showing `pg_primary` and `pg_replicas` backends
- Primary node marked as UP in green, replicas as UP in green

---

## 7. Internal Application Access

Applications running on VMs within the `10.10.1.0/24` network connect directly — no Cloudflare Tunnel involved.

### 7.1 Connection Strings

```bash
# Read/Write (primary) — via HAProxy VIP
postgresql://postgres:<PG_PASSWORD>@10.10.1.250:5000/hope

# Read-Only (replicas) — via HAProxy VIP
postgresql://postgres:<PG_PASSWORD>@10.10.1.250:5001/hope

# Via PgBouncer (connection pooling) — if deployed
postgresql://postgres:<PG_PASSWORD>@10.10.1.250:6432/hope
```

### 7.2 Application Configuration Example

For the HOPE API Gateway (`apps/api`), set in the environment:

```bash
DATABASE_URL="postgresql://postgres:<PG_PASSWORD>@10.10.1.250:5000/hope"
DATABASE_READ_URL="postgresql://postgres:<PG_PASSWORD>@10.10.1.250:5001/hope"
```

### 7.3 Why HAProxy (5000/5001) for Remote, PgBouncer (6432) for Apps

| Target | Port | Use For | Reason |
|--------|------|---------|--------|
| HAProxy R/W | 5000 | Remote dev, admin | Auto-failover via Patroni health checks; few concurrent connections |
| HAProxy RO | 5001 | Remote dev, read queries | Load-balanced replicas with health checks |
| PgBouncer | 6432 | Production apps on LAN | Connection pooling for hundreds of concurrent connections |
| Individual nodes | 5432 | Debugging only (via SSH) | Bypasses HA failover; use SSH port forwarding |

Remote developer connections are infrequent (1–5 concurrent) — connection pooling adds no value. PgBouncer's transaction-mode pooling can also cause issues with `SET` commands, prepared statements, and advisory locks that developers commonly use in interactive sessions.

---

## 8. Shell Aliases and Convenience

Add to `~/.zshrc` on your Mac:

```bash
# ── Database Tunnel Aliases ──

# Start tunnels (background)
alias db-tunnel='ssh -f -N -L 15432:10.10.1.250:5000 db0 && echo "R/W tunnel: localhost:15432"'
alias db-tunnel-ro='ssh -f -N -L 15433:10.10.1.250:5001 db0 && echo "RO tunnel: localhost:15433"'
alias db-tunnel-all='db-tunnel && db-tunnel-ro'

# Connect via psql
alias db='psql -h localhost -p 15432 -U postgres'
alias db-ro='psql -h localhost -p 15433 -U postgres'
alias db-hope='psql -h localhost -p 15432 -U postgres -d hope'

# Stop tunnels
alias db-tunnel-stop='kill $(lsof -ti:15432) $(lsof -ti:15433) 2>/dev/null; echo "Tunnels stopped"'

# Patroni cluster status (via SSH)
alias db-status='ssh db0 "docker exec patroni patronictl -c /home/postgres/postgres.yml list"'

# HAProxy stats (via SSH, no tunnel needed)
alias db-haproxy='ssh db0 "curl -s http://10.10.1.250:7000/;csv" | column -t -s","'
```

### Usage

```bash
# Daily workflow
db-tunnel          # Start R/W tunnel in background
db-hope            # Connect to hope database
db-status          # Check cluster health
db-tunnel-stop     # Done for the day

# Quick one-liner
db-tunnel && db-hope
```

---

## 9. Security Considerations

### Layered Security Model

```
Layer 1: Cloudflare Access (SSO / email verification)
  └─ Layer 2: Cloudflare Tunnel (no ports exposed on WAN)
      └─ Layer 3: UFW firewall (CT 101 explicitly allowed on each DB VM)
          └─ Layer 4: SSH key authentication (ed25519) — Method 1
              └─ Layer 5: PostgreSQL authentication (scram-sha-256)
                  └─ Layer 6: pg_hba.conf (IP-based access control)
```

### Key Points

| Concern | Mitigation |
|---------|------------|
| No PG ports exposed to internet | All access via Cloudflare Tunnel (outbound-only) |
| Unauthorized tunnel access | Cloudflare Access policy (SSO + email allowlist) |
| Credential theft | scram-sha-256 (passwords never sent in cleartext) |
| Network-level access | UFW on each DB VM allows only cluster nodes + CT 101; `pg_hba.conf` restricts to `10.10.1.0/24` + localhost |
| Brute force | Cloudflare rate limiting + `pg_hba.conf` reject rule |
| SSH key compromise | ed25519 key with passphrase, macOS Keychain cached |

### What NOT to Do

- **Do NOT** expose PostgreSQL ports (5432, 5000, 5001) directly to the internet
- **Do NOT** add `0.0.0.0/0` to `pg_hba.conf` — the reject rule at the bottom is intentional
- **Do NOT** route production application traffic through Cloudflare Tunnel — use direct LAN
- **Do NOT** use `trust` authentication in `pg_hba.conf` — always use `scram-sha-256`
- **Do NOT** connect `psql` directly to `db.taphuynh.dev` without `cloudflared access tcp` — the Access auth layer will break PostgreSQL's binary protocol

---

## 10. Troubleshooting

### SSH tunnel won't start — "Address already in use"

Port 15432 is already bound (previous tunnel still running):

```bash
# Find what's using the port
lsof -i:15432

# Kill it
kill $(lsof -ti:15432)

# Retry
db-tunnel
```

### psql: "connection refused" on localhost:15432

The SSH tunnel is not running:

```bash
# Check if tunnel process exists
ps aux | grep "ssh.*15432"

# If not, start it
db-tunnel
```

### psql connects but authentication fails

Check credentials and pg_hba rules:

```bash
# Verify pg_hba.conf allows your connection
ssh db0 "docker exec patroni cat /home/postgres/pgdata/data/pg_hba.conf"

# Test from inside the container (bypasses network)
ssh db0 "docker exec patroni psql -U postgres -c 'SELECT 1;'"
```

### HAProxy dashboard shows nodes as DOWN

Patroni REST API is not responding:

```bash
# Check Patroni health on each node
ssh db0 "curl -s http://localhost:8008/health"
ssh db1 "curl -s http://localhost:8008/health"
ssh db2 "curl -s http://localhost:8008/health"

# Check Patroni logs
ssh db0 "docker logs --tail 20 patroni"
```

### `cloudflared access tcp` — browser auth loop

The Cloudflare Access token expired or is corrupted:

```bash
# Clear cached tokens
rm -rf ~/.cloudflared/*.json

# Retry
cloudflared access tcp --hostname db.taphuynh.dev --url localhost:15432
```

### Tunnel hangs — `ha-db.taphuynh.dev` or `db.taphuynh.dev` times out

CT 101 can ping the DB nodes but TCP connections hang. This means UFW on the DB VMs is blocking CT 101:

```bash
# On CT 101 — this will hang if UFW is blocking
curl -v --max-time 5 http://10.10.1.200:7000/

# On VM 500 — check if CT 101 is allowed
sudo ufw status | grep 10.10.1.2

# If missing, add it (run on all 3 VMs: 500, 501, 502)
sudo ufw allow from 10.10.1.2 to any comment "CT 101 - Cloudflare Tunnel"
```

The default UFW policy is `DROP`, so any IP not explicitly allowed will have its TCP connections silently dropped (no RST, just timeout). ICMP ping still works because it's handled before the INPUT chain filter.

### Slow queries through tunnel

Expected — the tunnel adds 20–80ms latency per round-trip. This is acceptable for interactive admin but not for production workloads. If you're running bulk operations, SSH into a DB node and run them locally:

```bash
ssh db0
docker exec -it patroni psql -U postgres -d hope
# Run bulk operations here — zero network overhead
```

---

## Summary — Tunnel Public Hostnames

All hostnames are configured in the **Cloudflare Zero Trust Dashboard** under **Networks** → **Tunnels** → **hope-homelab** → **Public Hostnames**.

| Hostname | Type | Service Target | Purpose |
|----------|------|---------------|---------|
| `ssh-db0.taphuynh.dev` | SSH | `ssh://10.10.1.200:22` | SSH to VM 500 |
| `ssh-db1.taphuynh.dev` | SSH | `ssh://10.10.1.201:22` | SSH to VM 501 |
| `ssh-db2.taphuynh.dev` | SSH | `ssh://10.10.1.202:22` | SSH to VM 502 |
| `db.taphuynh.dev` | TCP | `tcp://10.10.1.250:5000` | PostgreSQL R/W (primary) |
| `db-ro.taphuynh.dev` | TCP | `tcp://10.10.1.250:5001` | PostgreSQL RO (replicas) |
| `ha-db.taphuynh.dev` | HTTP | `http://10.10.1.250:7000` | HAProxy stats dashboard |
