# Phase 1: Observability Stack Deployment Guide

| Field | Value |
|-------|-------|
| **Phase** | 1 — Infrastructure Foundation |
| **Target** | VM 400 (10.10.1.100) |
| **Effort** | ~1 day |
| **Prerequisites** | SSH access to VM 400, Proxmox console access, MinIO admin access (VM 402) |

---

## Pre-Deployment Checklist

- [ ] SSH access to VM 400 (`ssh hope@10.10.1.100`)
- [ ] Proxmox console access (`https://192.168.68.130:8006`)
- [ ] Docker and Docker Compose installed on VM 400
- [ ] MinIO CLI (`mc`) available (on VM 402 or any machine)

---

## Step 1: Expand VM 400 Disk to 128 GB

**Where**: Proxmox host (192.168.68.130)

```bash
# On Proxmox host
qm resize 400 scsi0 +64G
```

**Where**: VM 400

```bash
ssh hope@10.10.1.100

# Check current partition layout
lsblk
df -h /

# Option A: Standard partition (ext4)
sudo growpart /dev/sda 2
sudo resize2fs /dev/sda2

# Option B: LVM (if using LVM)
sudo pvresize /dev/sda2
sudo lvextend -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv

# Verify
df -h /
# Expected: ~128 GB total
```

**Verification**: `df -h /` shows ~128 GB.

---

## Step 2: Create MinIO Buckets for Cold Storage

**Where**: Any machine with `mc` (MinIO client)

```bash
mc alias set hope https://10.10.1.102:9000 <ACCESS_KEY> <SECRET_KEY> --insecure

mc mb hope/loki-chunks
mc mb hope/loki-ruler
mc mb hope/tempo-traces

# Verify
mc ls hope/
# Expected output:
#   [DATE]      0B loki-chunks/
#   [DATE]      0B loki-ruler/
#   [DATE]      0B tempo-traces/
```

**Verification**: All 3 buckets listed.

---

## Step 3: Create Directory Structure on VM 400

**Where**: VM 400

```bash
ssh hope@10.10.1.100

sudo mkdir -p /opt/observability/{configs,data}
sudo mkdir -p /opt/observability/configs/{otel,prometheus,loki,tempo,grafana}
sudo mkdir -p /opt/observability/configs/grafana/{provisioning/datasources,provisioning/dashboards,provisioning/alerting,dashboards}
sudo mkdir -p /opt/observability/data/{prometheus,loki,tempo,grafana}

sudo chown -R hope:hope /opt/observability
```

**Verification**: `ls -la /opt/observability/` shows correct structure.

---

## Step 4: Copy Configuration Files

**Where**: VM 400

Transfer all config files from this repository to VM 400. Use `scp`, `rsync`, or `git clone`.

```bash
# Option A: scp from your local machine
scp -r docs/implementation/TASK-251-Observability-Stack/configs/* \
  hope@10.10.1.100:/opt/observability/configs/

scp docs/implementation/TASK-251-Observability-Stack/docker-compose.observability.yml \
  hope@10.10.1.100:/opt/observability/

scp docs/implementation/TASK-251-Observability-Stack/.env.example \
  hope@10.10.1.100:/opt/observability/.env.example

# Option B: git clone the repo on VM 400 and copy
ssh hope@10.10.1.100
cd /tmp
git clone <repo-url> hope-v2
cp -r hope-v2/docs/implementation/TASK-251-Observability-Stack/configs/* /opt/observability/configs/
cp hope-v2/docs/implementation/TASK-251-Observability-Stack/docker-compose.observability.yml /opt/observability/
cp hope-v2/docs/implementation/TASK-251-Observability-Stack/.env.example /opt/observability/.env.example
rm -rf /tmp/hope-v2
```

**Verification**: Run this on VM 400:

```bash
ls -la /opt/observability/
# Expected:
#   configs/
#   data/
#   docker-compose.observability.yml
#   .env.example

ls -R /opt/observability/configs/
# Expected:
#   otel/otel-collector-config.yaml
#   prometheus/prometheus.yml
#   loki/loki-config.yaml
#   tempo/tempo-config.yaml
#   grafana/grafana.ini
#   grafana/provisioning/datasources/datasources.yaml
#   grafana/provisioning/dashboards/dashboards.yaml
```

---

## Step 5: Configure Environment Variables

**Where**: VM 400

```bash
ssh hope@10.10.1.100
cd /opt/observability

# Create .env from template
cp .env.example .env

# Edit — set a strong Grafana admin password
nano .env
```

Set `GRAFANA_ADMIN_PASSWORD` to a strong password.

**Verification**: `cat .env` shows non-placeholder values.

---

## Step 6: VM 400 Firewall Hardening (UFW)

**Where**: VM 400

```bash
ssh hope@10.10.1.100

sudo apt install -y ufw

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH (from vmbr1 subnet)
sudo ufw allow from 10.10.1.0/24 to any port 22 proto tcp

# Rancher (existing)
sudo ufw allow from 10.10.1.0/24 to any port 80 proto tcp
sudo ufw allow from 10.10.1.0/24 to any port 443 proto tcp

# K3s API (existing)
sudo ufw allow from 10.10.1.0/24 to any port 6443 proto tcp

# Observability — OTel Collector (services on VM 200 push here)
sudo ufw allow from 10.10.1.0/24 to any port 4317 proto tcp   # OTLP gRPC
sudo ufw allow from 10.10.1.0/24 to any port 4318 proto tcp   # OTLP HTTP

# Observability — Grafana (Cloudflare Tunnel CT 101 at 10.10.1.2)
sudo ufw allow from 10.10.1.2 to any port 3000 proto tcp

# Enable
sudo ufw enable
sudo ufw status verbose
```

**Important**: Docker bypasses UFW by default. Restrict Docker-published ports:

```bash
# Restrict Docker-published ports to vmbr1 subnet only
sudo iptables -I DOCKER-USER -i enp6s18 ! -s 10.10.1.0/24 -j DROP

# Persist iptables rules
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

**Verification**: `sudo ufw status verbose` shows all rules. Test from another VM:
- `curl http://10.10.1.100:4317` from VM 200 — should connect
- `curl http://10.10.1.100:9090` from VM 200 — should be refused (internal only via Docker)

---

## Step 7: Deploy the Stack

**Where**: VM 400

```bash
ssh hope@10.10.1.100
cd /opt/observability

# Pull images first (so we can see progress)
docker compose -f docker-compose.observability.yml pull

# Deploy
docker compose -f docker-compose.observability.yml up -d

# Watch startup logs
docker compose -f docker-compose.observability.yml logs -f --tail=50
# Wait until all containers report healthy. Press Ctrl+C to stop following.
```

---

## Step 8: Verify All Containers Are Healthy

**Where**: VM 400

```bash
cd /opt/observability

# Check container status
docker compose -f docker-compose.observability.yml ps
# Expected: all 5 containers show "healthy"

# Verify each component individually:

# 1. Prometheus
curl -s http://localhost:9090/-/healthy
# Expected: "Prometheus Server is Healthy."

# 2. Loki
curl -s http://localhost:3100/ready
# Expected: "ready"

# 3. Tempo
curl -s http://localhost:3200/ready
# Expected: "ready"

# 4. OTel Collector
curl -s http://localhost:13133/
# Expected: {"status":"Server available",...}

# 5. Grafana
curl -s http://localhost:3000/api/health
# Expected: {"commit":"...","database":"ok","version":"12.4.2"}
```

---

## Step 9: Verify Prometheus Self-Scrape

**Where**: VM 400

```bash
# Check that Prometheus is scraping its own metrics
curl -s http://localhost:9090/api/v1/targets | python3 -c "
import json, sys
data = json.load(sys.stdin)
for target in data['data']['activeTargets']:
    job = target['labels'].get('job', 'unknown')
    health = target['health']
    error = target.get('lastError', '')
    print(f'  {job:25s} {health:6s} {error}')
"
# Expected: at least "prometheus" shows "up"
# Other targets (api-gateway, stt, etc.) may show "down" until Phase 2
```

---

## Step 10: Verify Grafana Datasources

**Where**: Browser or VM 400

```bash
# Via API
curl -s -u admin:<GRAFANA_PASSWORD> http://localhost:3000/api/datasources | python3 -m json.tool
# Expected: 3 datasources — Prometheus, Loki, Tempo
```

Or open `http://10.10.1.100:3000` in a browser:
1. Log in with `admin` / `<your-password>`
2. Go to Connections → Data Sources
3. Verify: Prometheus, Loki, and Tempo are listed with green checkmarks

---

## Step 11: Configure Cloudflare Tunnel

**Where**: Cloudflare Zero Trust Dashboard

1. Log in to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. Go to Networks → Tunnels → Select your tunnel (CT 101)
3. Add a new public hostname:

| Field | Value |
|-------|-------|
| Public hostname | `grafana.taphuynh.dev` |
| Service type | HTTP |
| URL | `http://10.10.1.100:3000` |

4. Save and test: open `https://grafana.taphuynh.dev` in a browser.

**Verification**: Grafana login page loads at `https://grafana.taphuynh.dev`.

---

## Completion Checklist

| Check | Command | Expected |
|-------|---------|----------|
| All 5 containers healthy | `docker compose ps` | All show `healthy` |
| Prometheus self-scrape UP | `curl localhost:9090/api/v1/targets` | prometheus job = `up` |
| Loki ready | `curl localhost:3100/ready` | `ready` |
| Tempo ready | `curl localhost:3200/ready` | `ready` |
| OTel Collector health | `curl localhost:13133` | `Server available` |
| Grafana health | `curl localhost:3000/api/health` | `database: ok` |
| Grafana datasources provisioned | Grafana UI → Data Sources | 3 datasources listed |
| Cloudflare Tunnel | `curl https://grafana.taphuynh.dev/api/health` | Returns Grafana health |
| Disk expanded | `df -h /` | ~128 GB total |
| MinIO buckets | `mc ls hope/` | 3 buckets listed |
| UFW enabled | `sudo ufw status verbose` | Rules active |

---

## Troubleshooting

### Container won't start: "port already in use"

```bash
# Check which process uses the port
sudo lsof -i :4317
# If K3s/Rancher uses it, change the host port mapping in docker-compose
```

### Loki fails with "error creating WAL"

```bash
# Fix directory permissions
sudo chown -R 10001:10001 /opt/observability/data/loki
# Or use Docker volumes (already configured in docker-compose)
```

### Prometheus "context deadline exceeded" on scrape targets

The target VM may have firewall rules blocking Prometheus. Check:
```bash
# From VM 400, test connectivity to a scrape target
curl -s http://10.10.1.10:8868/metrics | head -5
```

### Grafana "database is locked"

```bash
# Stop Grafana, fix permissions
docker stop grafana
sudo chown -R 472:472 /opt/observability/data/grafana
docker start grafana
```

---

## Post-Deployment: What's Next?

After Phase 1 is verified, proceed to:
- **Phase 2**: [02-TELEMETRY-PLAN.md](./02-TELEMETRY-PLAN.md) — Wire telemetry in all apps and services
- **Phase 3**: [03-DASHBOARD-PLAN.md](./03-DASHBOARD-PLAN.md) — Build dashboards and configure alerting
- **Phase 4**: Client-side RUM with Grafana Faro (covered in 02-TELEMETRY-PLAN.md, Section 5)
