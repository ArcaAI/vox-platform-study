# PgBouncer Staging Soak Log

| Field | Value |
|---|---|
| Ticket | TASK-302 Stream C — Phase 3A.2 |
| Environment | staging |
| Started | _(fill in on Day 1)_ |
| Owner | _(DBA on-call)_ |
| Status | **Not yet started — Stream C is stopped before staging cutover** |

> Daily entries are appended at the bottom. Each entry uses the template
> in §"Entry template" below. Soak is acceptable after **7 consecutive
> passing days** per the rubric in [`03-pgbouncer-cutover-runbook.md`](./03-pgbouncer-cutover-runbook.md) §2.

---

## Acceptance rubric (mirror of runbook §2)

| Metric | Threshold |
|---|---|
| `prepared statement does not exist` count | **0** |
| `sorry, too many clients` count | **0** |
| Prisma `P1017` (connection lost) count | **0** |
| API p95 latency vs pre-cutover baseline | ≤ +15 % |
| `cl_waiting` peak per day | < 5 for ≤ 1 minute total |
| `maxwait_seconds` peak per day | < 1 s |

Soak fails if any single day misses any threshold.

---

## Entry template

```markdown
## YYYY-MM-DD — Day N

**Owner**: <name>
**Window**: <UTC range>

### SHOW POOLS snapshot (representative)

```text
(paste output of: psql -h ... -p 6432 -U hope_admin pgbouncer -c 'SHOW POOLS;')
```

### Metrics

| Metric | Value | Threshold | Status |
|---|---|---|---|
| `prepared statement does not exist` | <count> | 0 | ✓ / ✗ |
| `sorry, too many clients` | <count> | 0 | ✓ / ✗ |
| Prisma `P1017` | <count> | 0 | ✓ / ✗ |
| API p95 latency (vs baseline) | <ms> (+X%) | +15 % | ✓ / ✗ |
| `cl_waiting` peak | <count> for <duration> | < 5 / < 1 min | ✓ / ✗ |
| `maxwait_seconds` peak | <seconds> | < 1 | ✓ / ✗ |

### Incidents / observations

- (none) — OR — <ticket links + summary>

### Rollback rehearsal (Day 4 recommended)

- [ ] Steps 4.2.1 → 4.2.3 executed
- [ ] Time-to-rollback: <elapsed>
- [ ] API smoke after rollback: PASS / FAIL
- [ ] Re-cut to pooled state: <elapsed>
```

---

## Daily entries

_(none yet — first entry will land on staging cutover Day 1)_
