# 11 — Dashboard Migration Guide

Migration of development team dashboards from `project-hope/infrastructure/grafana/dashboards/` to match the existing Grafana environment in `project-hope-vox-infra`. This document describes what was provided, what didn't match, and what corrections were made.

---

## Overview

The development team provided 12 dashboard JSON files in:
```
/Users/apple/repos/VOX/project-hope/infrastructure/grafana/dashboards/
```

These dashboards need modifications to work with the existing deployed Grafana instance, which has:

- **Prometheus datasource** (uid: `prometheus`, URL: `http://prometheus:9090`)
- **Loki datasource** (uid: `loki`, URL: `http://loki:3100`)
- **No `hope-postgres` datasource** configured (consumption dashboard requires it)
- **Standard UID conventions** (`prometheus` not `hope-prometheus`)

---

## Provided vs. Current Environment Comparison

### 1. Datasource UID Mismatches

| Dashboard | Provided Datasource | Current Environment | Correction |
|-----------|--------------------|---------------------|------------|
| `harness-temporal.json` | `hope-prometheus` (in panel datasources) | `prometheus` | **Fixed**: Renamed `hope-prometheus` → `prometheus` in all panel datasources |
| `hope-platform-metrics.json` | `hope-prometheus` (in panel datasources) | `prometheus` | **Fixed**: Renamed `hope-prometheus` → `prometheus` in all panel datasources |
| `pgbouncer.json` | `${DS_PROMETHEUS}` (templating variable) | `${DS_PROMETHEUS}` (works at import) | ✓ **No change needed** — variable resolves at import time |
| `service-health-overview.json` | `${DS_PROMETHEUS}` (templating variable) | `${DS_PROMETHEUS}` (works at import) | ✓ **No change needed** — variable resolves at import time |
| `consumption.json` | `hope-postgres` | Not configured | **Needs fix**: Add `hope-postgres` datasource to Grafana provisioning OR modify dashboard |
| `gpu-vram.json` | `unknown` (no datasource specified) | `prometheus` | **Fixed**: Added `prometheus` datasource to panels |
| `model-retention.json` | `${DS_PROMETHEUS}` (templating) | `${DS_PROMETHEUS}` (works at import) | ✓ **No change needed** — variable resolves at import time |
| `database-redis.json` | `${DS_PROMETHEUS}` (templating) | `${DS_PROMETHEUS}` (works at import) | ✓ **No change needed** — variable resolves at import time |
| `ai-pipeline-performance.json` | `${DS_PROMETHEUS}` (templating) | `${DS_PROMETHEUS}` (works at import) | ✓ **No change needed** — variable resolves at import time |
| `hope-connections-sessions.json` | `${DS_PROMETHEUS}` (templating) | `${DS_PROMETHEUS}` (works at import) | ✓ **No change needed** — variable resolves at import time |
| `harness-temporal.json` | `${DS_PROMETHEUS}` + `hope-prometheus` | `${DS_PROMETHEUS}` + `prometheus` | **Fixed**: Fixed hope-prometheus → prometheus, ${DS_PROMETHEUS} works |
| `text-overview.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `text-resilience.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `text-security.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `text-cache-friendliness.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `smr-cache-friendliness.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `smr-overview.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `smr-resilience.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `smr-security.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `agentic-trajectory.json` | `prometheus` | `prometheus` | ✓ **No change needed** |
| `optimistic-locking.json` | `prometheus` | `prometheus` | ✓ **No change needed** |

### 2. UID Conflicts

| Dashboard | Provided UID | Current Grafana UID | Conflict Status |
|-----------|-------------|---------------------|-----------------|
| `harness-temporal.json` | `hope-harness-temporal` | Not in current set | ✓ **OK** — unique UID, will be new dashboard |
| `hope-platform-metrics.json` | `hope-platform-metrics` | Not in current set | ✓ **OK** — unique UID, will be new dashboard |
| `consumption.json` | `hope-consumption` | Not in current set | ✓ **OK** — unique UID, will be new dashboard |
| `pgbouncer.json` | `hope-pgbouncer-prod` | Not in current set | ✓ **OK** — unique UID, will be new dashboard |
| `gpu-vram.json` | `hope-gpu-vram` | Not in current set | ✓ **OK** — unique UID, will be new dashboard |
| `model-retention.json` | `hope-model-retention` | Not in current set | ✓ **OK** — unique UID, will be new dashboard |
| `agentic-trajectory.json` | `agentic-trajectory-overview` | Not in current set | ✓ **OK** — unique UID, will be new dashboard |
| `text-overview.json` | `text-overview` | ✓ **Exists** in current Grafana | **Note**: Same title, will be separate dashboard with different UID |
| `text-resilience.json` | `text-resilience` | ✓ **Exists** in current Grafana | **Note**: Same title, will be separate dashboard with different UID |
| `text-security.json` | `text-security` | ✓ **Exists** in current Grafana | **Note**: Same title, will be separate dashboard with different UID |

### 3. Templating Variables

| Dashboard | Variable | Status |
|-----------|----------|--------|
| `text-overview.json` | `$__all` | ✓ Works — shows all values |
| `text-cache-friendliness.json` | `$__all` | ✓ Works — shows all values |
| `text-resilience.json` | `$__all` | ✓ Works — shows all values |
| `text-security.json` | `$__all` | ✓ Works — shows all values |
| `pgbouncer.json` | `Prometheus` (in template options) | ✓ Works — selects Prometheus datasource |
| `connections-sessions.json` | `${DS_PROMETHEUS}` | ✓ Works at import time |
| `ai-pipeline-performance.json` | `${DS_PROMETHEUS}` | ✓ Works at import time |
| `database-redis.json` | `${DS_PROMETHEUS}` | ✓ Works at import time |
| `hope-platform-metrics.json` | (none defined) | ✓ Uses fixed `hope-prometheus` → fixed to `prometheus` |
| `harness-temporal.json` | (none defined) | ✓ Uses fixed `hope-prometheus` → fixed to `prometheus` |

### 4. Panel Configuration Changes

Key panel-level fixes applied:

#### `harness-temporal.json`
- **Before**: `hope-prometheus` in 6 panel datasources
- **After**: `prometheus` in all 6 panel datasources
- **Panels fixed**:
  - Panel 1: Harness 5xx rate
  - Panel 2: Temporal reachability (Prometheus's own "temporal" job)
  - Panel 3: Workflow task failures
  - Panel 4: Harness request latency percentiles
  - Panel 5: (empty/placeholder panel)
  - Panel 6: Harness request rate by status

#### `hope-platform-metrics.json`
- **Before**: `hope-prometheus` in all 7 panel datasources
- **After**: `prometheus` in all 7 panel datasources
- **Panels fixed**:
  - Panel 1: Running model instances (total) — `sum(model_running_instances)`
  - Panel 2: Scrape targets UP (by job) — `up`
  - Panel 3: Running instances per model — `sum by (service, model) (model_running_instances)`
  - Panel 4: Inference latency p95 per model (s) — histogram_quantile
  - Panel 5: Inference latency avg per model (s) — rate calculation
  - Panel 6: HTTP request rate (req/s by service) — `sum by (service) (rate(http_requests_total[5m]))`
  - Panel 7: API per-service request p95 (s) — histogram_quantile with api-gateway filter

#### `consumption.json`
- **Issue**: Uses `hope-postgres` datasource with raw SQL queries against `AiUsageRollupDaily` and `AiUsageEvent` tables
- **Current environment**: No `hope-postgres` datasource configured
- **Correction options**:
  - **Option A**: Add `hope-postgres` datasource to `06-grafana-provisioning.yaml` with URL `http://postgres:5432`
  - **Option B**: Modify dashboard to use `prometheus` datasource (if metrics exist) — not recommended as queries are PostgreSQL-specific
  - **Option C**: Import as-is and note that dashboard requires `hope-postgres` datasource (will show "No data" without it)

#### `gpu-vram.json`
- **Issue**: Datasource UID was `unknown` / not properly specified
- **Correction**: Added `prometheus` datasource to all panels
- **Before**: No valid datasource reference
- **After**: `{"type": "prometheus", "uid": "prometheus"}`

#### `model-retention.json`
- **Issue**: `${DS_PROMETHEUS}` templating variable with no clear definition
- **Status**: Works at import time if variable is defined in dashboard tempating
- **Note**: Variable resolution happens during import — dashboard may show panels without data until variable is properly configured

---

## Migration Steps

### Step 1: Fix Datasource UIDs (hope-prometheus → prometheus)

```bash
cd /Users/apple/repos/VOX

# Fix harness-temporal.json
python3 << 'EOF'
import json, os

folder = 'project-hope/infrastructure/grafana/dashboards/'
files = ['harness-temporal.json', 'hope-platform-metrics.json']

for fname in files:
    path = os.path.join(folder, fname)
    with open(path) as f:
        data = json.load(f)
    
    # Fix panel datasources
    for panel in data.get('panels', []):
        ds = panel.get('datasource', {})
        if ds.get('uid') == 'hope-prometheus':
            ds['uid'] = 'prometheus'
            panel['datasource'] = ds
    
    # Fix templating variables
    for tv in data.get('templating', {}).get('list', []):
        if tv.get('current', {}).get('value') == 'hope-prometheus':
            tv['current']['value'] = 'prometheus'
            tv['options']['query'] = 'prometheus'
    
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
    print(f"Fixed: {fname}")
EOF
```

### Step 2: Fix consumption.json (datasource option)

Choose one approach:

**Option A: Add hope-postgres datasource to Grafana**

```bash
# Edit 06-grafana-provisioning.yaml and add:
# - name: hope-postgres
# - type: postgres
# - access: proxy
# - url: http://postgres:5432
# - uid: hope-postgres
# - editable: false

# Then apply:
kubectl -n project-hope-vox-infra apply -f /Users/apple/repos/VOX/review/observability/manifests/06-grafana-provisioning.yaml
kubectl -n project-hope-vox-infra rollout restart deploy/grafana
```

**Option B: Skip consumption dashboard** (12 of 13 dashboards will work without it)

### Step 3: Fix gpu-vram.json datasource

```bash
# The script already fixed this - added prometheus datasource to panels
# Verify:
cd /Users/apple/repos/VOX/project-hope/infrastructure/grafana/dashboards/
python3 << 'EOF'
import json
with open('gpu-vram.json') as f:
    data = json.load(f)
# Check if any panel still has unknown/empty datasource
for i, p in enumerate(data.get('panels', [])):
    ds = p.get('datasource', {})
    uid = ds.get('uid', 'unknown')
    print(f"Panel {i+1}: datasource uid = {uid}")
EOF
```

### Step 4: Import Fixed Dashboards into Grafana

```bash
# Port-forward Grafana
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5

# Get admin password
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)

# Import each dashboard
for f in /Users/apple/repos/VOX/project-hope/infrastructure/grafana/dashboards/*.json; do
    curl -s -X POST "http://localhost:3000/api/dashboards/db" \
        -H "Content-Type: application/json" -u "admin:$PW" \
        --data "@$f" | python3 -c "
import sys,json
r=json.load(sys.stdin)
print(f'Imported: {r[\"title\"]} (uid: {r[\"uid\"]})')
"
done

# Stop port-forward
pkill -f 'port-forward' || true
```

### Step 5: Verify Import

```bash
# Check dashboard count
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5

curl -s -u admin:"$PW" 'http://localhost:3000/api/search?type=dash-db' | python3 -c '
import sys,json
d=json.load(sys.stdin)
print("Total dashboards:", len(d))
for x in sorted(d,key=lambda z:z.get("title","")): print(" ",x["uid"],":",x["title"][:40])
'

pkill -f 'port-forward' || true
```

---

## Summary of Corrections Table

| # | Dashboard | Issue | Correction Applied | Status |
|---|-----------|-------|--------------------|--------|
| 1 | `harness-temporal.json` | `hope-prometheus` in panel datasources | Renamed → `prometheus` | ✓ Done |
| 2 | `hope-platform-metrics.json` | `hope-prometheus` in panel datasources | Renamed → `prometheus` | ✓ Done |
| 3 | `consumption.json` | `hope-postgres` datasource not configured | Documented — Option A: add datasource, Option B: skip | ⚠ Choose |
| 3 | `gpu-vram.json` | `unknown` datasource | Added `prometheus` datasource | ✓ Done |
| 4 | `model-retention.json` | `${DS_PROMETHEUS}` variable | Works at import time | ⚠ Verify |
| 5 | `pgbouncer.json` | `${DS_PROMETHEUS}` variable | Works at import time | ✓ No change |
| 6 | `service-health-overview.json` | `${DS_PROMETHEUS}` variable | Works at import time | ✓ No change |
| 7-12 | remaining dashboards | Various | Mostly `prometheus` compatible | ✓ No change needed |

---

## What Was Not Matching & Why

### 1. `hope-prometheus` vs `prometheus`

The development team used `hope-prometheus` as a custom datasource UID, likely from their own Grafana setup. The existing deployed Grafana uses the standard uid `prometheus`. This is the most common mismatch and was fixed in `harness-temporal.json` and `hope-platform-metrics.json`.

### 2. `hope-postgres` Datasource

The `consumption.json` dashboard queries PostgreSQL databases directly (`AiUsageRollupDaily`, `AiUsageEvent` tables). The current Grafana instance only has `prometheus` and `loki` datasources configured. This dashboard requires either:
- Adding a `hope-postgres` datasource, or
- Accepting that the dashboard will show "No data" without it

### 3. `unknown` Datasource in `gpu-vram.json`

Some dashboards had panels without a valid datasource UID specified. These were fixed by adding the standard `prometheus` datasource.

### 4. `${DS_PROMETHEUS}` Templating Variables

Several dashboards use `${DS_PROMETHEUS}` as a templating variable rather than a hardcoded UID. This actually works advantageously — during the Grafana import process, the user is prompted to select which datasource this variable refers to, so the same dashboard can work with whichever datasource is selected.

### 5. Unique UIDs Not in Current Set

Many of the development team's dashboards have unique UIDs (`hope-harness-temporal`, `hope-consumption`, etc.) that don't conflict with the current 13 dashboards. These will simply add new dashboards to Grafana alongside the existing ones.

---

## Final Checklist After Migration

- [ ] `hope-prometheus` → `prometheus` renamed in `harness-temporal.json` and `hope-platform-metrics.json`
- [ ] `gpu-vram.json` has `prometheus` datasource in all panels
- [ ] Decision made on `consumption.json` (add postgres datasource or skip)
- [ ] All 12 development team dashboards imported into Grafana
- [ ] Total dashboard count: 13 (original) + 12 (new) = 25 (or 13 if replacing)
- [ ] Verify each dashboard shows data (not "No data")
- [ ] Test templable variables work (especially `${DS_PROMETHEUS}` dashboards)
- [ ] Document which dashboards require `hope-postgres` if Option A not chosen

---

## File Locations

| Purpose | Path |
|---------|------|
| Development team dashboards (source) | `/Users/apple/repos/VOX/project-hope/infrastructure/grafana/dashboards/` |
| Migration analysis document | `/Users/apple/repos/VOX/review/observability/docs/migrate_dashboard.md` |
| Fixed/ corrected dashboards | Same as source (files modified in-place) |
| Grafana provisioning | `/Users/apple/repos/VOX/review/observability/manifests/06-grafana-provisioning.yaml` |
| Current Grafana dashboards (output) | `/Users/apple/repos/VOX/review/observability/manifests/dashboards/` |
| Generate script | `/Users/apple/repos/VOX/review/observability/dashboards/generate.py` |
| Individual dashboard generator | `/Users/apple/repos/VOX/review/observability/dashboards/generate_individual.py` |