# Vault DB-Engine Staging Soak Log

| Field | Value |
|---|---|
| Ticket | TASK-302 Stream B — Phase 5 Task 5.9 |
| Environment | staging |
| Started | _(fill in on Day 1)_ |
| Owner | _(SRE on-call)_ |
| Status | **Not yet started — depends on Stream C's PgBouncer staging soak completing first** |

> Daily entries are appended at the bottom. Each entry uses the template
> in §"Entry template". Soak is acceptable after **3 consecutive passing
> days** under steady traffic with at least **one full lease-rotation
> cycle observed per pod** (default TTL 1 h ⇒ ≥ 24 rotations per pod per
> day).

The soak validates the Phase 5 changes end-to-end:
- Vault `database/creds/hope-app-role` issues dynamic users via
  AppRole-authenticated pods.
- Pods drive PostgreSQL traffic through PgBouncer (transaction mode)
  using the dynamic creds (Stream C decision Q2: `auth_file` stays;
  resolution recorded in §"PgBouncer auth_file vs dynamic users").
- The `VaultLeaseRenewer` keeps each lease alive at 50 % of TTL and
  signals `degraded=true` after three consecutive renewal failures
  without dropping live traffic (stale-while-revalidate per D6
  deviation, Gate 5).

---

## Pre-soak prerequisites

- [ ] Stream C's PgBouncer staging soak signed off (7-day rubric in
      `03-pgbouncer-soak-log.md`).
- [ ] `vault-admin-bootstrap.sql` executed by the staging DBA against
      `hope_main` (manual; ticket-tracked SRE task).
- [ ] Staging Vault has `database/config/hope-main` and
      `database/roles/hope-app-role` configured (`infrastructure/docker/configs/vault/dev-init.sh`
      mirrors the dev path; staging uses the equivalent terraform/CLI
      runbook).
- [ ] Staging API pods deployed with `SECRETS_PROVIDER=vault` and
      `PG_DYNAMIC_CREDS=true`.
- [ ] Staging Grafana board imports the dashboard tile listed in §"Metrics
      to scrape" — alerts are at most warning level for the soak.

---

## Acceptance rubric

| Metric | Threshold |
|---|---|
| Live-traffic credential-rotation success rate | ≥ 99.9 % per day |
| Vault `database/creds/<role>` p95 latency | ≤ 250 ms |
| Vault `sys/leases/renew` p95 latency | ≤ 250 ms |
| PrismaClient `P1001`/`P2024` count attributable to rotation | **0** |
| Pods reporting `secrets.health.degraded=true` (sustained) | **0** |
| PgBouncer `sorry, too many clients` count | **0** |
| PgBouncer `auth_file` reload count | Matches expected (none unless template rotated) |
| New `v-*` PG roles created per pod per day | Within `max_open_connections × 24` envelope |

Soak fails on any single day missing any threshold.

---

## Metrics to scrape

> Prometheus / Grafana names are illustrative; rename to match the
> staging stack.

| Metric | Source | Direction |
|---|---|---|
| `vault_db_creds_request_seconds` (histogram) | API pods, instrumented around `secrets.requestDbCredential()` | p50/p95/p99 |
| `vault_db_lease_renew_seconds` (histogram) | API pods, instrumented in `VaultLeaseRenewer.tick()` | p50/p95/p99 |
| `vault_db_lease_renew_failures_total` (counter, labels: `pod`, `lease_prefix`) | API pods | rate per pod |
| `secrets_health_degraded` (gauge, label: `pod`) | API pods via `/healthz/secrets` | sustained-1 alarm |
| `pgbouncer_total_received` (gauge) | PgBouncer exporter | sanity |
| `vault_audit_dynamic_user_create_total` | Vault audit log → log-shipper | rate per role |

> Lease ids and dynamic usernames MUST be redacted to the first 24 chars
> in any high-cardinality label. The `secrets.requestDbCredential()`
> call site already enforces this for logs; the metric labels should
> mirror the same redaction policy.

---

## Entry template

```markdown
## YYYY-MM-DD — Day N

**Owner**: <name>
**Window**: <UTC range>
**Traffic profile**: <baseline | replay | partner test>

### Lease accounting

| Pod | Rotations observed | Failed renewals | Degraded events | Notes |
|---|---|---|---|---|
| api-0 | <int> | <int> | <int> | |
| api-1 | <int> | <int> | <int> | |
| api-2 | <int> | <int> | <int> | |

### Vault latency (24h aggregate)

| Op | p50 | p95 | p99 | Threshold | Status |
|---|---|---|---|---|---|
| `database/creds/hope-app-role` | <ms> | <ms> | <ms> | p95 ≤ 250 ms | ✓ / ✗ |
| `sys/leases/renew` | <ms> | <ms> | <ms> | p95 ≤ 250 ms | ✓ / ✗ |

### PgBouncer interaction

| Metric | Value | Threshold | Status |
|---|---|---|---|
| `sorry, too many clients` | <count> | 0 | ✓ / ✗ |
| `auth_file` reloads | <count> | matches plan | ✓ / ✗ |
| Active dynamic users (peak) | <count> | < `max_open_connections × pods` | ✓ / ✗ |

### Application correctness

| Signal | Value | Threshold | Status |
|---|---|---|---|
| Prisma `P1001` rotation-attributed | <count> | 0 | ✓ / ✗ |
| Prisma `P2024` rotation-attributed | <count> | 0 | ✓ / ✗ |
| `secrets.health.degraded=true` (sustained > 60 s) | <count> | 0 | ✓ / ✗ |

### Smoke verification

`pnpm --filter @arcaai/database exec tsx scripts/vault-db-smoke.ts` from
a jump host:
- Exit code: <0|1|2>
- Lease prefix observed: `<first 24 chars>…`
- TTL observed: <sec> (sanity: should be ≤ default_ttl)

### Incidents / observations

- (none) — OR — <ticket links + summary>

### Verdict

PASS / FAIL (if FAIL: rollback decision + ticket)
```

---

## Rollback procedure

If a soak day fails:

1. Set `PG_DYNAMIC_CREDS=false` on the affected pod(s) and recycle. The
   `VAULT_PRISMA_FACTORY` provider returns `null` in that mode (see
   `apps/api/src/vault-prisma.module.ts`), so `CoreDatabaseService`
   falls back to the env-mode `DATABASE_URL` singleton.
2. Confirm the pod's `/healthz/secrets` reports `degraded=false` and
   that traffic is served against the static-user path.
3. Page the on-call to record the incident; open a follow-up to either
   raise lease TTL ceilings (Vault), expand `max_open_connections`, or
   harden the renewer.
4. The dynamic v-* roles created in the failed window can be cleaned up
   by Vault's revocation step (`vault lease revoke -prefix database/creds/hope-app-role/<lease-prefix>`).
   PostgreSQL's `REASSIGN OWNED` / `DROP ROLE` is part of the
   revocation_statements; no manual `DROP` from the SRE.

---

## PgBouncer auth_file vs dynamic users (cross-cutting note)

Stream C decision Q2 kept `auth_file` rather than `auth_query` for
PgBouncer authentication. The interplay with dynamic Vault users
matters here:

- `auth_file` must contain entries that match Vault's dynamic users,
  OR PgBouncer must be configured to accept the application's
  authentication and merely forward the credential to PostgreSQL.
- The staging plan uses `auth_user` + `auth_query` per-database
  override **only** for the dynamic role's database. The static admin
  / migration paths continue to authenticate via `auth_file`.
- See `infrastructure/docker/README.md` (Vault DB-engine section) for
  the exact PgBouncer userlist layout: the staging environment ships a
  `auth_user=pgbouncer_authuser` that runs an `auth_query` view
  scoped to the `hope_app_template` parent role, returning the
  dynamic users PgBouncer needs to authenticate.
- The dev-mode docker-compose preserves the original Stream C
  `auth_file`-only setup because the dev-init script also pre-seeds
  static users.

If the staging soak exposes friction with `auth_query` at the per-pod
fan-out (≤ 50 dynamic users × 3 pods × hourly rotation = ~ 150
short-lived rows visible at peak), Phase 7 can re-open the decision and
either:
- bump PgBouncer's `auth_query` cache, or
- regress to a long-lived application user authenticated via `auth_file`
  with Vault-issued dynamic creds delivered out-of-band (the simpler
  model Stream C originally proposed).

---

## Sign-off

| Date | Owner | Status | Notes |
|---|---|---|---|
| YYYY-MM-DD | _(SRE)_ | PASS / FAIL | Day-1 entry |
| YYYY-MM-DD | _(SRE)_ | PASS / FAIL | Day-2 entry |
| YYYY-MM-DD | _(SRE)_ | PASS / FAIL | Day-3 entry |

Three consecutive PASS days unlock the Phase 7 production cutover
decision (user-gated).
