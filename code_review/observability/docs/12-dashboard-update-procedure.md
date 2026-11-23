# 12 — Dashboard Update Procedure

Step-by-step commands to update Grafana dashboards in the existing Kubernetes cluster,
with verification after each step. This procedure reproduces the dashboard update
that was just performed.

---

## Procedure: Update Grafana Dashboards

### Prerequisites
- `kubectl` configured for the cluster
- Namespace `project-hope-vox-infra` exists
- Grafana is running with provisioning ConfigMap mounted
- `review/observability/` folder is available at `/Users/apple/repos/VOX/review/observability`

---

### Step 1: Generate Individual Dashboard JSON Files

```bash
cd /Users/apple/repos/VOX/review/observability
python3 dashboards/generate_individual.py
```

**Verification**: Check that JSON files appeared in `manifests/dashboards/`:
```bash
ls -la /Users/apple/repos/VOX/review/observability/manifests/dashboards/ | grep .json | wc -l
# Expected: 21 (or more, from multiple source directories)
```

---

### Step 2: Regenerate the Grafana Dashboards ConfigMap

```bash
python3 dashboards/generate.py
```

**Verification**: Confirm the ConfigMap was regenerated with 13 dashboards:
```bash
# Check the generated YAML has 13 dashboard entries
grep -c "app-hope\|k8s-infra\|stt-gpu\|vllm\|prometheus-overview\|logs-overview" /Users/apple/repos/VOX/review/observability/manifests/07-grafana-dashboards.yaml
# Expected: 13 (or count the "name:" entries in the YAML)
```

---

### Step 3: Apply the Updated ConfigMap

```bash
kubectl -n project-hope-vox-infra apply -f /Users/apple/repos/VOX/review/observability/manifests/07-grafana-dashboards.yaml
```

**Verification**: Confirm the ConfigMap was updated:
```bash
kubectl -n project-hope-vox-infra get cm grafana-dashboards
# Should show 13 keys in the data section
kubectl -n project-hope-vox-infra exec deploy/grafana -- ls /var/lib/grafana/dashboards/ | wc -l
# Expected: 13
```

---

### Step 4: Restart Grafana (Critical for Grafana 13)

```bash
kubectl -n project-hope-vox-infra rollout restart deploy/grafana
```

**Verification**: Wait for the pod to become Ready:

```bash
# Method A: Wait for Ready condition
kubectl -n project-hope-vox-infra wait --for=condition=Ready pod -l app=grafana --timeout=180s

# Method B: Check pod status repeatedly
kubectl -n project-hope-vox-infra get pods -l app=grafana -o jsonpath='{.items[0}.status.phase}'
# Expected: "Running"

# Method C: Check dashboard files inside the pod
kubectl -n project-hope-vox-infra exec deploy/grafana -- ls /var/lib/grafana/dashboards/ | wc -l
# Expected: 13
```

---

### Step 5: Verify Dashboards Are Loaded and Visible

```bash
# Method A: Count dashboard files inside Grafana pod
kubectl -n project-hope-vox-infra exec deploy/grafana -- ls /var/lib/grafana/dashboards/ | wc -l
# Expected: 13

# Method B: Via Grafana API (port-forward required)
# 1. Start port-forward
kubectl -n project-hope-vox-infra port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5

# 2. Get admin password
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)

# 3. Query dashboard count
curl -s -u admin:"$PW" 'http://localhost:3000/api/search?type=dash-db' | python3 -c '
import sys,json
d=json.load(sys.stdin)
print("count:",len(d))
for x in sorted(d,key=lambda z:z.get("title","")): print(" ",x["uid"],":",x["title"][:40])
'

# 3. Stop port-forward
pkill -f 'port-forward' || true
```

**Expected Output** (from API query):
```
count: 13
  app-hope-api-gateway : App — API Gateway
  app-hope-admin-console : App — Admin Console
  app-hope-guardrail : App — Guardrail
  app-hope-harness : App — Harness
  app-hope-harness-worker : App — Harness Worker
  app-hope-nlp : App — NLP
  app-hope-tts : App — TTS
  app-hope-text : App — Text generation
  k8s-infra : Kubernetes Infrastructure
  logs-overview : Logs — project-hope-vox
  hope-prometheus-overview : Prometheus / Overview
  stt-gpu : STT / GPU Server
  vllm : vLLM — GPU Inference
```

---

### Step 6: Optional — Import Individual JSON Files for Study/Modification

If you want to modify dashboard JSONs directly:

```bash
# 1. Review/modify files in manifests/dashboards/
#    - Location: /Users/apple/repos/VOX/review/observability/manifests/dashboards/
#    - Edit with any JSON editor or IDE

# 2. Import a single dashboard via Grafana API
# (after starting port-forward as in Step 5B)
PW=$(kubectl -n project-hope-vox-infra get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
curl -s -X POST "http://localhost:3000/api/dashboards/db" \
    -H "Content-Type: application/json" -u "admin:$PW" \
    --data @/Users/apple/repos/VOX/review/observability/manifests/dashboards/hope-platform-metrics.json | \
    python3 -c "
import sys,json
r=json.load(sys.stdin)
print(f'Imported: {r[\"title\"]} (uid: {r[\"uid\"]})')
"

# 3. Or import all dashboards in a loop
for f in /Users/apple/repos/VOX/review/observability/manifests/dashboards/*.json; do
    curl -s -X POST "http://localhost:3000/api/dashboards/db" \
        -H "Content-Type: application/json" -u "admin:$PW" \
        --data "@$f" | python3 -c "import sys,json; r=json.load(sys.stdin); print(f'Imported: {r[\"title\"]}')"
done

# 3. Stop port-forward
pkill -f 'port-forward' || true
```

---

### Complete One-Command Summary

If you want to run the entire procedure in sequence without verifications:

```bash
cd /Users/apple/repos/VOX/review/observability && \
python3 dashboards/generate_individual.py && \
python3 dashboards/generate.py && \
kubectl -n project-hope-vox-infra apply -f manifests/07-grafana-dashboards.yaml && \
kubectl -n project-hope-vox-infra rollout restart deploy/grafana && \
kubectl -n project-hope-vox-infra wait --for=condition=Ready pod -l app=grafana --timeout=180s && \
kubectl -n project-hope-vox-infra exec deploy/grafana -- ls /var/lib/grafana/dashboards/ | wc -l
```

**Expected final output**: `13`

---

## Troubleshooting

### If dashboards don't appear after restart:

1. Check the ConfigMap has all 13 keys:
   ```bash
   kubectl -n project-hope-vox-infra get cm grafana-dashboards -o json | python3 -c 'import sys,json; d=json.load(sys.stdin); print("keys:", len(d["data"]))'
   ```

2. Verify the JSON files are inside the pod:
   ```bash
   kubectl -n project-hope-vox-infra exec deploy/grafana -- ls /var/lib/grafana/dashboards/
   ```

3. Check Grafana logs for errors:
   ```bash
   kubectl -n project-hope-vox-infra logs deploy/grafana
   ```

4. Ensure `foldersFromFilesStructure: false` in provisioning ConfigMap (it is by default):
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: grafana-provisioning
     namespace: project-hope-vox-infra
   data:
     dashboards.yaml: |
       apiVersion: 1
       providers:
         - name: hope
           orgId: 1
           folder: ''
           type: file
           disableDeletion: false
           updateIntervalSeconds: 30
           allowUiUpdates: true
           options:
             path: /var/lib/grafana/dashboards
             foldersFromFilesStructure: false
   ```

### If Grafana pod is CrashLooping:

1. Check for NFS permission issues:
   ```bash
   kubectl -n project-hope-vox-infra logs deploy/grafana | grep -i "permission denied"
   ```

2. Restart with a fallback:
   ```bash
   kubectl -n project-hope-vox-infra rollout restart deploy/grafana
   ```

### If dashboard panels show "No data":

1. Verify datasource selection during import (prometheus for metrics, loki for logs)
2. Check Prometheus targets: `kubectl -n project-hope-vox-infra port-forward svc/prometheus 9090:9090`
3. Check Loki is running and has logs: `kubectl -n project-hope-vox-infra get ds/promtail`
4. Verify metrics exist: `curl http://localhost:9090/api/v1/query?query=up`

---

## File Locations Referenced

| Purpose | Path |
|---|---|
| Individual dashboard generator | `review/observability/dashboards/generate_individual.py` |
| Main dashboard generator | `review/observability/dashboards/generate.py` |
| ConfigMap source file | `review/observability/manifests/07-grafana-dashboards.yaml` |
| Individual JSON output | `review/observability/manifests/dashboards/` |
| Dashboard import procedure | `import_dashboards_to_grafana.md` (in opencode plan dir) |
| Day-2 operations guide | `review/observability/docs/10-day2-operations.md` §5 |
| Dashboard authoring docs | `review/observability/docs/05-dashboards.md` §7 |
| New management docs | `review/observability/docs/11-dashboard-management.md` |
| This update procedure | `review/observability/docs/12-dashboard-update-procedure.md` |