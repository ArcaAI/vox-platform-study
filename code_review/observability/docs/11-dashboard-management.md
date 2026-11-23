# 11 — Dashboard Management

Procedures for adding, modifying, and updating Grafana dashboards in the
project-hope observability stack. Covers both the standard ConfigMap workflow
and the new individual JSON file workflow.

---

## Overview

Two workflows are available for dashboard management:

| Workflow | Method | Source of Truth | When to Use |
|---|---|---|---|
| **A: generate.py ConfigMap** | Edit `dashboards/generate.py` → regenerate → apply ConfigMap | `manifests/07-grafana-dashboards.yaml` | Standard practice, single source of truth, CI/CD |
| **B: Individual JSON files** | Use `dashboards/generate_individual.py` → modify JSONs → import | `manifests/dashboards/*.json` | Study, modification, version control, quick edits |

Both workflows result in dashboards being provisioned into Grafana. The key
difference is whether you edit the Python generator (Workflow A) or edit the
JSON files directly (Workflow B).

---

## Workflow A: Edit generate.py → Regenerate ConfigMap

### Step-by-step

```bash
# 1. Edit dashboards/generate.py
# - Add panel using helpers: stat(), ts(), logs()
# - Or add new dashboard function returning dashboard(uid, title, tags, panels, ...)
# - Or extend the apps() map with a new entry

# 2. Regenerate the ConfigMap
python3 dashboards/generate.py

# 3. Apply the updated ConfigMap
kubectl -n project-hope-vox-infra apply -f manifests/07-grafana-dashboards.yaml

# 4. Restart Grafana (CRITICAL — Grafana 13 loads file-provisioned dashboards only on startup)
kubectl -n project-hope-vox-infra rollout restart deploy/grafana
kubectl -n project-hope-vox-infra rollout status deploy/grafana --timeout=120s

# 5. Verify
kubectl -n project-hope-vox-infra exec deploy/grafana -- ls /var/lib/grafana/dashboards/ | wc -l
# Expected: 13

# Or via API
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
curl -s -u admin:"$PW" 'http://localhost:3000/api/search?type=dash-db' | python3 -c '
import sys,json
d=json.load(sys.stdin); print("count:",len(d))
for x in sorted(d,key=lambda z:z.get("title","")): print(" ",x["uid"])'
```

### Dashboard addition pattern (in generate.py)

See `dashboards/generate.py` for existing patterns. Key points:

- **Datasource UIDs**: Use `{"type":"prometheus","uid":"prometheus"}` or
  `{"type":"loki","uid":"loki"}`. Do NOT use `hope-prometheus` — it has been
  renamed to `prometheus` in the individual JSON files.
- **Template variables**: Use helpers like `search_var()` for search boxes,
  or define query variables in the dashboard `templating` section.
- **Grid placement**: Panels auto-place on a 24-column grid via `_pack()`.
- **Refresh**: Set in the top-level dashboard object (`"refresh": "15s"` or `"30s"`).

### What the generator preserves

- `prometheus-overview.json` and `logs-overview.json` — the two baseline dashboards
- All 13 dashboard UIDs and tags
- Provisioning ConfigMap format (header comment block)
- Panel grid positioning via `_pack()` auto-placement

---

## Workflow B: Individual JSON Files (New)

### Step-by-step

```bash
# 1. Generate individual JSON files (if not already present)
cd /Users/apple/repos/VOX/review/observability
python3 dashboards/generate_individual.py

# Output: review/observability/manifests/dashboards/<name>.json
# (21 files generated from project-hope, project-hope-sks, and TASK-251 archives)

# 2. Review or modify the JSON file
#   - Location: review/observability/manifests/dashboards/
#   - Edit with any JSON editor or IDE
#   - Change panel expressions, titles, titles, time ranges, etc.

# 3. Import the modified dashboard into running Grafana

# METHOD A: Via Grafana UI (recommended for occasional imports)
#   a. Port-forward Grafana
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 &
sleep 3

#   b. Open browser to http://localhost:3000
#   c. Click + → Import → Click "Choose File" → Select the .json file
#   d. Select the datasource:
#       - prometheus for metrics dashboards
#       - loki for log-based dashboards
#   e. Click "Import"

# METHOD B: Via Grafana API (batch/automated)
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 3

for f in review/observability/manifests/dashboards/*.json; do
    curl -s -X POST "http://localhost:3000/api/dashboards/db" \
        -H "Content-Type: application/json" -u "admin:$PW" \
        --data "@$f" | python3 -c "
import sys,json
r=json.load(sys.stdin)
print(f'Imported: {r[\"title\"]} (uid: {r[\"uid\"]})')
"
done

pkill -f 'port-forward' || true

# METHOD C: Via ConfigMap (update source of truth, then restart)
#   a. Copy the modified JSON into the ConfigMap YAML
#   b. Apply: kubectl apply -f manifests/07-grafana-dashboards.yaml
#   c. Restart Grafana: kubectl -n project-hope-vox-infra rollout restart deploy/grafana
#   d. Verify as in Workflow A

# 4. Verify dashboard appears and shows data
```

### When to use Workflow B

- Studying existing dashboard structures and expressions
- Making quick one-off modifications without editing Python
- Version-controlling dashboard JSONs in git
- When the Python generator's panel-building helpers don't match your needs
- Learning how dashboards are constructed

### Limitations of Workflow B

- JSONs are **not** the source of truth for the ConfigMap
- After importing via UI/API, the dashboard exists in Grafana's DB but is
  **not** reflected in `07-grafana-dashboards.yaml`
- If you later run `python3 dashboards/generate.py`, your manual JSON changes
  will be **overwritten** (the generator rebuilds from source)
- Grafana file provisioning only reloads on restart (Grafana 13 behavior)

---

## Comparing the Two Workflows

| Aspect | Workflow A (generate.py) | Workflow B (Individual JSON) |
|---|---|---|
| **Source of truth** | `manifests/07-grafana-dashboards.yaml` | `manifests/dashboards/*.json` + Git |
| **Edit location** | `dashboards/generate.py` (Python) | JSON files in `manifests/dashboards/` |
| **Reliable update path** | `generate.py` → `apply` → `restart` | UI Import / API / ConfigMap manual edit |
| **Grafana restart required** | Yes (Grafana 13) | Yes (Grafana 13) |
| **Good for** | Standard dashboard management, CI/CD | Study, quick edits, versioned JSONs |
| **Risk** | Editing Python can be intimidating | Manual JSON changes may be overwritten by generator |

---

## Dashboard Update Checklist

### After making changes via either workflow:

- [ ] Dashboard JSON(s) modified or generator edited
- [ ] Changes regenerated/applied (`generate.py` → ConfigMap, or JSON imported)
- [ ] Grafana restarted: `kubectl -n project-hope-vox-infra rollout restart deploy/grafana`
- [ ] Dashboard count verified: `kubectl -n project-hope-vox-infra exec deploy/grafana -- ls /var/lib/grafana/dashboards/ | wc -l` → 13
- [ ] Data visible in panels (check Prometheus/Loki targets)
- [ ] Template variables working (provider selection, search, time range)
- [ ] No "No data" on critical panels
- [ ] API verification: `curl -s -u admin:$PW 'http://localhost:3000/api/search?type=dash-db'`

### Rollback

- **Workflow A**: Re-edit `generate.py` to restore original, then `generate.py` → `apply` → `restart`
- **Workflow B**: Re-import the original JSON, or re-run `generate_individual.py` → `apply` → `restart`

---

## Troubleshooting

### Common issues:

1. **"No data" on panels after import**
   - Verify correct datasource is selected (prometheus for metrics, loki for logs)
   - Check that metrics exist in Prometheus: `kubectl -n project-hope-vox-infra port-forward svc/prometheus 9090:9090` then query `http://localhost:9090/api/v1/query?query=up`
   - For Loki: ensure Promtail is running and logs are flowing

2. **Dashboard panels overlapping or misplaced**
   - The generator uses `_pack()` for auto-placement on 24-column grid
   - If manually editing JSON, keep `gridPos.w` and `gridPos.h` values reasonable
   - overlapping `gridPos` values may cause visual issues

3. **Template variables not working**
   - Variables must be defined in the dashboard `templating.list`
   - Common variables: `$provider`, `$search`, `$__interval`, `$__rate_interval`
   - Ensure datasource UIDs match what the queries expect (`prometheus` or `loki`)

4. **"Version conflict" or dashboard overwritten**
   - If you imported a JSON via UI, then ran `generate.py`, the JSON changes are overwritten
   - To preserve manual changes, edit `generate.py` instead, or avoid running the generator

5. **Grafana does not show new dashboard after ConfigMap apply + restart**
   - Verify the JSON file is inside the pod: `kubectl -n project-hope-vox-infra exec deploy/grafana -- ls /var/lib/grafana/dashboards/`
   - Check ConfigMap has the new key: `kubectl -n project-hope-vox-infra get cm grafana-dashboards -o json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(list(d["data"].keys()))'`
   - Ensure `foldersFromFilesStructure: false` in provisioning ConfigMap (it is, by default)

6. **hope-prometheus → prometheus rename needed**
   - Two dashboards (`hope-platform-metrics.json`, `harness-temporal.json`) previously used `hope-prometheus` as the datasource UID
   - These have been fixed to use `prometheus` — if you re-generate from the original `generate.py`, you'll need to manually rename or use the individual JSON files instead

---

## File Locations

| Purpose | Path |
|---|---|
| **Generator source** | `review/observability/dashboards/generate.py` |
| **Individual dashboard generator** | `review/observability/dashboards/generate_individual.py` |
| **Generated ConfigMap** | `review/observability/manifests/07-grafana-dashboards.yaml` |
| **Individual JSON output** | `review/observability/manifests/dashboards/` (21 files) |
| **Dashboard import procedure** | `/Users/apple/.opencode/plan/import_dashboards_to_grafana.md` |
| **Day-2 operations** | `review/observability/docs/10-day2-operations.md` §5 |
| **Dashboard authoring** | `review/observability/docs/05-dashboards.md` §7 |

---

## Recommendations

1. **Standard dashboard management**: Use **Workflow A** (edit `generate.py`, regenerate ConfigMap, restart Grafana). This is the intended CI/CD pattern and keeps the single source of truth.

2. **Study and experimentation**: Use **Workflow B** (run `generate_individual.py`, modify JSONs, import via UI). Good for learning how dashboards are constructed and making quick one-off changes.

3. **Version control**: If you want dashboard JSONs in Git, use Workflow B and commit the `manifests/dashboards/` files. Note that these will be overwritten if you later run `generate.py` — either accept that, or also edit `generate.py` to match.

4. **Mixed approach**: You can have both — the ConfigMap from `generate.py` for the 13 standard dashboards, and individual JSONs in `manifests/dashboards/` for customization or study. The generator preserves the two baseline dashboards (`prometheus-overview`, `logs-overview`) and will not delete any JSON files you've added to the folder.