# TimescaleDB HA Cluster Configs — a dated research/config snapshot

Ready-to-deploy configuration files for a 3-node Patroni-managed TimescaleDB HA cluster (VMs
500-502), built around the official `timescale/timescaledb-ha:pg18-all-amd64` image (PostgreSQL 18
+ TimescaleDB 2.25.2 + Patroni 4.1.0 + pgBackRest, 30+ extensions). This is a point-in-time
research/config record under `docs/research/`, not current guidance about what is actually
deployed — `.claude/rules/09-infrastructure-devops.md` states that the external
Patroni/HAProxy/PgBouncer Postgres was superseded by an in-cluster Postgres server (TASK-847,
2026-09-01); treat the files here as a historical design rather than the live topology. The
deployment guide this folder pairs with is
[`../../deployments/deploy-vm500-502-postgres-ha.md`](../../deployments/deploy-vm500-502-postgres-ha.md).

## Layout

| Path | What it holds |
|---|---|
| `.env.example` | Environment variables template (copy to `.env` per node) |
| `docker-compose.yml` | Unified compose file for all three nodes, profile-gated |
| `patroni/entrypoint.sh`, `patroni/patroni.yml` | Patroni config generation (`entrypoint.sh` generates `postgres.yml` from env vars at container start; `patroni.yml` is reference only) |
| `pgbackrest/pgbackrest.conf`, `pgbackrest/pgbackrest-local.conf.example` | Backup config — MinIO S3 repo, with a local-disk fallback example |
| `pgbouncer/userlist.txt.example` | PgBouncer user list template |
| `haproxy/haproxy.cfg` | HAProxy load balancer config |
| `keepalived/keepalived-master.conf`, `keepalived/keepalived-backup.conf` | Floating-VIP configs for VM 500 (MASTER) and VM 501 (BACKUP) |
| `prometheus/pgbouncer-scrape.yml`, `prometheus/pgbouncer-alerts.yml`, `prometheus/vault-transit-alerts.yml` | Prometheus scrape config and alert rules for this stack |

## Related

- [`../../deployments/deploy-vm500-502-postgres-ha.md`](../../deployments/deploy-vm500-502-postgres-ha.md) — the deployment guide this config set pairs with
- [`../../README.md`](../../README.md) — the top-level research index this folder is part of
- [`../../../../.claude/rules/09-infrastructure-devops.md`](../../../../.claude/rules/09-infrastructure-devops.md) — the current, in-cluster Postgres topology that superseded this design
- [`../../../../.claude/rules/02-database-prisma.md`](../../../../.claude/rules/02-database-prisma.md) — current Postgres/Prisma standards
