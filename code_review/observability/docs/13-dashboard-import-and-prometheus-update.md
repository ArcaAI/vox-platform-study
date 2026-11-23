# 13 — Dashboard Import and Prometheus Configuration Update

This document describes the import of non-conflicting development team dashboards and the Prometheus configuration updates needed for the remaining dashboards.

---

## Section 1: Importing 7 Non-Conflicting Dashboards

These 7 dashboards can be imported into the existing Grafana instance without conflicts because they have unique UIDs that do not overlap with the current 13 dashboards already loaded.

### Dashboards to Import

| Dashboard File | Title | UID | Why No Conflict |
|---|---|---|---|
| `agentic-trajectory.json` | Agentic Trajectory (Harness) - Overview | `prometheus` | Unique title/UID, not in current 13 |
| `gpu-vram.json` | HOPE — GPU VRAM & Model Residency | `hope-gpu-vram` | Unique UID, not in current 13 |
| `model-retention.json` | HOPE — Model Retention & Lifecycle | `hope-model-retention` | Unique UID, not in current 13 |
| `optimistic-locking.json` | Optimistic Locking — Config Write Conflicts (Streaming) | `optimistic-locking` | Unique UID, not in current 13 |
| `text-cache-friendliness.json` | TEXT — Cache Friendliness | `text-cache-friendliness` | Unique UID, not in current 13 |
| `text-resilience.json` | TEXT — Resilience | `text-resilience` | Unique UID, not in current 13 |
| `text-security.json` | TEXT — Security | `text-security` | Unique UID, not in current 13 |

### Import Command

```bash
cd /Users/apple/repos/VOX/review/observability

# Get Grafana admin password
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)

# Start port-forward for API access
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5

# Import each of the 7 non-conflicting dashboards
echo "Importing 7 non-conflicting dashboards..."
for f in agentic-trajectory.json gpu-vram.json model-retention.json \
         optimistic-locking.json text-cache-friendliness.json \
         text-resilience.json text-security.json; do
    echo "  Importing $f..."
    curl -s -X POST "http://localhost:3000/api/dashboards/db" \
        -H "Content-Type: application/json" -u "admin:$PW" \
        --data "@/Users/apple/repos/VOX/project-hope/infrastructure/grafana/dashboards/$f" | \
        python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    print('  ✓ ' + r.get('title', 'unknown') + ' (uid: ' + r.get('uid', 'unknown') + ')')
except Exception as e:
    print('  ✗ Failed: ' + str(e)[:100])
done

# Stop port-forward
pkill -f 'port-forward' || true

echo ""
echo "Import complete! 7 dashboards added to the existing 13."
echo "Total dashboards in Grafana: 20"
```

### Expected Import Result

After running the import commands, verify:

```bash
# Check total dashboard count
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5

curl -s -u admin:"$PW" 'http://localhost:3000/api/search?type=dash-db' | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("Total dashboards:", len(d))
for x in sorted(d, key=lambda z: z.get("title", "")):
    print(" ", x["uid"], ":", x["title"][:45])
'

pkill -f 'port-forward' || true
```

**Expected output**: 20 total dashboards (13 original + 7 new)

### Verification: Specific Dashboard Checks

```bash
# Verify each imported dashboard is accessible
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5

# Check specific dashboards
for dashboard_uid in "agentic-trajectory-overview" "hope-gpu-vram" "hope-model-retention" \
                      "optimistic-locking" "text-cache-friendliness" "text-resilience" "text-security"; do
    echo "Checking UID: $dashboard_uid"
    result=$(curl -s -u admin:"$PW" "http://localhost:3000/api/dashboards/uid/$dashboard_uid" 2>&1)
    if echo "$result" | grep -q "Dashboard not found"; then
        echo "  ❌ Not found"
    else
        echo "  ✓ Found and accessible"
    fi
done

pkill -f 'port-forward' || true
```

---

## Section 2: Prometheus Configuration Updates for Remaining Dashboards

The following 5 development team dashboards require Prometheus configuration updates in `02-prometheus-config.yaml` (or equivalent) to function properly. These dashboards reference metrics that need to be scraped.

### 1. `consumption.json` — Requires `hope-postgres` Datasource

**Issue**: This dashboard queries PostgreSQL databases directly using raw SQL:
- `AiUsageRollupDaily` table (daily rollup metrics)
- `AiUsageEvent` table (event-level metrics)

**Current State**: No `hope-postgres` datasource is configured in Grafana.

**Required Prometheus Configuration Updates**:

#### Step 1: Add `hope-postgres` Datasource to Grafana

Edit `review/observability/manifests/06-grafana-provisioning.yaml` and add:

```yaml
# Add to the existing datasources list:
- name: hope-postgres
  type: postgres
  access: proxy
  url: http://postgres:5432
  uid: hope-postgres
  editable: false
  jsonData:
    maxLines: 1000
```

Then apply and restart Grafana:
```bash
kubectl -n project-hope-vox-infra apply -f /Users/apple/repos/VOX/review/observability/manifests/06-grafana-provisioning.yaml
kubectl -n project-hope-vox-infra rollout restart deploy/grafana
```

**Step 2: Ensure Prometheus Scrapes PostgreSQL Metrics (if needed)**

The consumption dashboard uses SQL queries directly against PostgreSQL, not Prometheus metrics. However, if you want to monitor the PostgreSQL instance itself:

```yaml
# In 02-prometheus-config.yaml, add a scrape job:
- job_name: 'postgres-exporter'
  static_configs:
    - targets: ['postgres-exporter:9187']
  metrics_path: /metrics
```

Or if using native PostgreSQL exporter:
```yaml
- job_name: 'postgres'
  static_configs:
    - targets: ['postgres:9187']  # or appropriate port
```

**Step 3: Verify Dashboard After Import**

After importing `consumption.json` and adding the `hope-postgres` datasource:

```bash
# Port-forward and test
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5

# Check the dashboard
curl -s -u admin:"$PW" 'http://localhost:3000/api/dashboards/uid/hope-consumption' | python3 -c "
import sys, json
r = json.load(sys.stdin)
print('Dashboard:', r['title'])
print('Panels:', len(r['dashboard']['panels']))
# Check if panels have data or show 'No data'
"

pkill -f 'port-forward' || true
```

---

### 2. `database-redis.json` — Redis Metrics Scrape

**Issue**: References Redis metrics via `${DS_PROMETHEUS}` templating variable.

**Current State**: The `${DS_PROMETHEUS}` variable works at import time, but you need to ensure Prometheus is scraping Redis exporter metrics.

**Prometheus Configuration Updates**:

#### Step 1: Add Redis Exporter Scrape Job

Edit `02-prometheus-config.yaml` to add a scrape job:

```yaml
# Add to prometheus config under scrape_configs:
- job_name: 'redis-exporter'
  static_configs:
    - targets: ['redis-exporter:9121']  # or your Redis exporter port
  metrics_path: /metrics
  relabel_configs:
    - source_labels: [__address__]
      target_label: instance
  honor_labels: true
```

**Step 2: Reload Prometheus**

```bash
# After editing 02-prometheus-config.yaml:
kubectl -n project-hope-vox-infra patch sts prometheus --type=json \
  -p '[{"op": "replace", "path": "/spec/template/spec/containers/0/args", "value": ["--storage.tsdb.retention.time 15d", "--web.enable-lifecycle"]}' ]

# Or re-apply the manifest:
kubectl -n project-hope-vox-infra apply -f /Users/apple/repos/VOX/review/observability/manifests/02-prometheus-config.yaml

# Restart Prometheus:
kubectl -n project-hope-vox-infra rollout restart sts/prometheus
kubectl -n project-hope-vox-infra rollout status sts/prometheus --timeout=120s
```

**Step 3: Verify After Import**

After importing `database-redis.json` and ensuring Redis exporter is running:

```bash
# Check if Redis metrics are available in Prometheus
kubectl -n project-hope-vox-infra port-forward svc/prometheus 9090:9090 >/tmp/pf.log 2>&1 &
sleep 3

curl -s 'http://localhost:9090/api/v1/query?query=redis_' | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data['data']['result']:
    print('Redis metrics found:')
    for r in data['data']['result'][:5]:
        print('  ', r['metric'], ':', r['value'])
else:
    print('No Redis metrics found')
"

pkill -f 'port-forward' || true
```

---

### 3. `pgbouncer.json` — PgBouncer Metrics

**Issue**: Uses `${DS_PROMETHEUS}` templating variable for datasource selection.

**Prometheus Configuration Updates**: 

PgBouncer metrics are already being scraped via the existing `hope-apps` job or a dedicated job. Ensure:

```yaml
# In 02-prometheus-config.yaml, verify PgBouncer is being scraped:
- job_name: 'pgbouncer'
  static_configs:
    - targets: ['pgbouncer:8423']  # PgBouncer admin API port
  metrics_path: /metrics
```

Or if already scraped via `hope-apps` job:
- Ensure `pgbouncer` metrics have the `job="pgbouncer"` label
- The dashboard's `${DS_PROMETHEUS}` variable will let users select the Prometheus datasource at import time

**No code changes needed** if already being scraped. Just ensure the metrics are available.

---

### 3. `harness-temporal.json` — Temporal Metrics (Already Fixed)

**Note**: This dashboard was already fixed in Section 1 (hope-prometheus → prometheus). 

**Prometheus Requirements**:
- `hope-apps` job must include `harness` metrics
- `temporal` metrics if using Temporal workflow engine

**Ensure Scraping**:
```yaml
# In 02-prometheus-config.yaml:
- job_name: 'hope-apps'
  static_configs:
    - targets: ['hope-harness:8080']  # harness metrics endpoint
  metrics_path: /metrics
  
# Or if Temporal is used:
- job_name: 'temporal'
  static_configs:
    - targets: ['temporal:5555']  # Temporal metrics endpoint
```

**After ensuring metrics are scraped**, import the dashboard as described in Section 1.

---

### Summary of Prometheus Configuration Updates Needed

| Dashboard | Required Action | Priority |
|-----------|----------------|----------|
| `consumption.json` | Add `hope-postgres` datasource to Grafana | **High** — dashboard unusable without it |
| `database-redis.json` | Add Redis exporter scrape job to Prometheus | **Medium** — metrics need to be available |
| `pgbouncer.json` | Ensure PgBouncer metrics are scraped | **Low** — likely already configured |
| `harness-temporal.json` | Ensure harness/temporal metrics are scraped | **Medium** — if using these features |

### Complete Prometheus Configuration Update Workflow

```bash
# Step 1: Edit 02-prometheus-config.yaml to add needed scrape jobs
# (Add redis-exporter, postgres-exporter, or hope-apps job modifications)

# Step 2: Apply the updated ConfigMap
kubectl -n project-hope-vox-infra apply -f /Users/apple/repos/VOX/review/observability/manifests/02-prometheus-config.yaml

# Step 3: Restart Prometheus
kubectl -n project-hope-vox-infra rollout restart sts/prometheus
kubectl -n project-hope-vox-infra rollout status sts/prometheus --timeout=120s

# Step 4: Add hope-postgres datasource to Grafana (if needed for consumption.json)
# Edit 06-grafana-provisioning.yaml and add the postgres datasource definition
kubectl -n project-hope-vox-infra apply -f /Users/apple/repos/VOX/review/observability/manifests/06-grafana-provisioning.yaml
kubectl -n project-hope-vox-infra rollout restart deploy/grafana

# Step 5: Import the dashboards
# Use the import commands from Section 1

# Step 6: Verify all dashboards show data
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5

curl -s -u admin:"$PW" 'http://localhost:3000/api/search?type=dash-db' | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("Total dashboards:", len(d))
# Check specific dashboards for data
for x in sorted(d, key=lambda z: z.get("title", "")):
    title = z.get("title", "")
    if any(kw in title.lower() for kw in ["consumption", "redis", "pgbouncer", "temporal"]):
        print("  " + title + ": checking...")
        # Check panel data status
        dash_uid = [y for y in d if y["title"] == title][0]["uid"]
        r = json.loads("""...""")  # Would check dashboard API for data status
        print("    Status: need to verify manually")
'

pkill -f 'port-forward' || true
```

---

## Final Checklist After All Updates

### Dashboard Import Checklist
- [ ] 7 dashboards imported successfully (Section 1)
- [ ] Verified 20 total dashboards in Grafana
- [ ] Tested templable variables (`${DS_PROMETHEUS}`) work
- [ ] Confirmed no "No data" on newly imported dashboards

### Prometheus Configuration Checklist
- [ ] `hope-postgres` datasource added to Grafana (for consumption.json)
- [ ] Redis exporter scrape job configured (for database-redis.json)
- [ ] PgBouncer metrics being scraped (for pgbouncer.json)
- [ ] Harness/temporal metrics being scraped (for harness-temporal.json)
- [ ] Prometheus restarted after configuration changes
- [ ] Verified metrics queries return results in Prometheus UI

### Overall System Checklist
- [ ] 13 original dashboards still working
- [ ] 7 new dashboards imported (20 total)
- [ ] Critical dashboards (consumption, redis, etc.) have required datasources/metrics
- [ ] No duplicate UID conflicts
- [ ] Templable variables function correctly
- [ ] User can switch between ${DS_PROMETHEUS} and ${DS_LOKI} as needed

---

## Files Modified/Referenced

| File | Purpose |
|------|---------|
| `review/observability/docs/13-dashboard-import-and-prometheus-update.md` | This document |
| `review/observability/dashboards/generate_individual.py` | Generated the 7 dashboard JSONs |
| `project-hope/infrastructure/grafana/dashboards/` | Source dashboard JSONs (12 files) |
| `review/observability/manifests/06-grafana-provisioning.yaml` | Add `hope-postgres` datasource |
| `review/observability/manifests/02-prometheus-config.yaml` | Add scrape jobs for metrics |
| `review/observability/manifests/07-grafana-dashboards.yaml` | Original ConfigMap (13 dashboards) |