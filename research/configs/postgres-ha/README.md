# TimescaleDB HA Cluster — Config Files

Deployment guide: [`../../deploy-vm500-502-postgres-ha.md`](../../deploy-vm500-502-postgres-ha.md)

## Stack

Uses the official `timescale/timescaledb-ha:pg17-all-amd64` image which bundles:
- **PostgreSQL 17** + **TimescaleDB 2.25.2** + **Patroni 4.1.0** + **pgBackRest**
- 30+ extensions: PostGIS 3, pgvector, pg_cron, timescaledb_toolkit, pgai, etc.

No custom Dockerfile needed.

## File Structure

```
postgres-ha/
├── README.md                         ← You are here
├── .env.example                      ← Environment variables (copy to .env per node)
├── docker-compose.yml                ← Unified compose file (all nodes)
├── patroni/
│   └── patroni.yml                   ← Patroni cluster configuration (TimescaleDB-tuned)
├── haproxy/
│   └── haproxy.cfg                   ← HAProxy load balancer config
└── keepalived/
    ├── keepalived-master.conf        ← VM 500 (MASTER) — install on host
    └── keepalived-backup.conf        ← VM 501 (BACKUP) — install on host
```

## Deployment Per Node

| VM | NODE_NAME | NODE_IP | HAProxy | Keepalived |
|----|-----------|---------|---------|------------|
| 500 | pg-node1 | 10.10.1.200 | Yes (`--profile haproxy`) | MASTER (`keepalived-master.conf`) |
| 501 | pg-node2 | 10.10.1.201 | Yes (`--profile haproxy`) | BACKUP (`keepalived-backup.conf`) |
| 502 | pg-node3 | 10.10.1.202 | No | No |

## Quick Start

```bash
# 1. Copy this directory to each VM
scp -r configs/postgres-ha/ hope@10.10.1.200:~/postgres-ha/

# 2. SSH into the VM and configure
ssh hope@10.10.1.200
cd ~/postgres-ha
cp .env.example .env
# Edit .env: set NODE_NAME=pg-node1, NODE_IP=10.10.1.200, passwords

# 3. Pull the image (no build needed)
docker pull timescale/timescaledb-ha:pg17-all-amd64

# 4. Start services (in order)
docker compose up -d etcd               # All 3 nodes — start simultaneously
docker compose up -d patroni            # All 3 nodes — node1 first, then 2 & 3
docker compose --profile haproxy up -d  # VM 500 and 501 only
docker compose --profile pgbouncer up -d
docker compose --profile monitoring up -d

# 5. Install Keepalived on host (VM 500 and 501 only)
sudo apt-get install -y keepalived
sudo cp keepalived/keepalived-master.conf /etc/keepalived/keepalived.conf
sudo systemctl enable --now keepalived

# 6. Enable TimescaleDB in your database
psql -h 10.10.1.250 -p 5000 -U postgres -c "CREATE DATABASE hope;"
psql -h 10.10.1.250 -p 5000 -U postgres -d hope -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

## Docker Compose Profiles

Services use profiles to control which components run on which node:

| Profile | Services | Deploy On |
|---------|----------|-----------|
| (default) | etcd, patroni | All 3 nodes |
| `haproxy` | haproxy | VM 500, VM 501 |
| `pgbouncer` | pgbouncer | All 3 nodes (optional) |
| `monitoring` | postgres-exporter | All 3 nodes (optional) |

## VIP

Applications connect to **10.10.1.250** (floating VIP managed by Keepalived):
- Port `5000` — Read/Write (routes to primary)
- Port `5001` — Read-Only (round-robin to replicas)
