# k6 Application-Shape Load (optional)

This directory holds the k6 load-test script for the optional application-shape load test that
complements the `pgbench` baseline in `../pgbench/`.

## Layout

| Path | What it holds |
|---|---|
| `hope-shape.js` | The k6 script simulating a HOPE-style request mix against the pooler |

### Status
Not executed as part of the standard rig run. The headline `pgbench` result (pooled/direct =
0.999, comfortably above the >= 0.85 target recorded in `../README.md`) already answers the
pooling GO/NO-GO question; k6 with PostgreSQL requires the `xk6-sql` extension, which is not a
standard part of `k6`.

If a future pass wants to run this:

```zsh
# 1. Build a k6 binary with the SQL extension (once):
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD:/xk6" \
  grafana/xk6:latest build latest \
    --with github.com/grafana/xk6-sql@latest \
    --with github.com/grafana/xk6-sql-driver-postgres@latest \
    --output ./k6-sql

# 2. Run against the rig (rig must be `pnpm pgbv:up` first):
./k6-sql run packages/database/tests/pgbouncer-validation/k6/hope-shape.js
```

## How it works

`hope-shape.js` simulates a simplified HOPE-style request mix per virtual user:

| Step | Description | Frequency |
|---|---|---|
| 1 | `BEGIN; set_config('app.tenant_id', ..., true); SELECT ... LIMIT 20; COMMIT;` | every iteration |
| 2 | `BEGIN; UPDATE ... SET resourceStatus = ...; COMMIT;` | every 10th iteration |
| 3 | `BEGIN; INSERT INTO audit ...; COMMIT;` | every 5th iteration |

The script targets `DATABASE_URL` (port 6532, the pooler) by default.

## Gotchas

- The PgBouncer-specific failure modes (`DISCARD ALL`, prepared-statement collision, advisory-lock
  survival, GUC leak) are already covered by the Vitest suite in `../__tests__/` and the pgbench
  workload — this script's marginal value is a more realistic HOPE-shape transaction mix, which
  tightens latency numbers but does not change a GO/NO-GO verdict on its own.

## Related

- [PgBouncer validation rig README](../README.md)
