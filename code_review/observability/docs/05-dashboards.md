# 05 — Dashboards

**Goal:** generate and provision the 13 Grafana dashboards, and know how to add or
change them safely.

**Before you start:** Prometheus (metrics) and Loki (logs) are running and reachable
from Grafana. Dashboards will still *load* without them, but panels will be empty.

```bash
source ~/obs.env
cd /path/to/repos/VOX
```

---

## 1. How dashboards are managed (do not hand-edit the YAML)

`manifests/07-grafana-dashboards.yaml` is a **generated** ConfigMap. Its single
source of truth is **`dashboards/generate.py`**. The generator:

- rewrites `07-grafana-dashboards.yaml` in place,
- preserves the two original dashboards (`prometheus-overview`, `logs-overview`)
  by reading them back from the existing file,
- writes the JSON with a header explaining it is generated.

Grafana reads the ConfigMap via the file provider in
`06-grafana-provisioning.yaml` (path `/var/lib/grafana/dashboards`, mounted by
`09-grafana.yaml`).

> **Golden rule:** edit `generate.py`, not `07-...yaml`. Never hand-edit the JSON.

---

## 2. Generate the dashboards

```bash
python3 review/observability/dashboards/generate.py
```

Expected:

```
wrote /.../manifests/07-grafana-dashboards.yaml with 13 dashboards:
  - prometheus-overview.json
  - logs-overview.json
  - k8s-infra.json
  - stt-gpu.json
  - vllm.json
  - app-hope-api-gateway.json
  - app-hope-guardrail.json
  - app-hope-harness.json
  - app-hope-nlp.json
  - app-hope-text.json
  - app-hope-tts.json
  - app-hope-harness-worker.json
  - app-hope-admin-console.json
```

---

## 3. Apply the ConfigMap

```bash
kubectl apply -f review/observability/manifests/07-grafana-dashboards.yaml
```

Expected: `configmap/grafana-dashboards created` (or `configured`).

Sanity check the ConfigMap has 13 keys:

```bash
kubectl -n $NS get cm grafana-dashboards \
  -o jsonpath='{range .data}{end}{.data}' | python3 -c 'import sys;print(len(__import__("json").load(sys.stdin)))'
```

Expected: `13`.

---

## 4. Restart Grafana (**required**)

Two things make a restart necessary:

1. **Grafana 13 loads file-provisioned dashboards on startup.** The
   `updateIntervalSeconds: 30` reload is not reliable for a swapped ConfigMap.
2. **Mounted ConfigMaps do not hot-reload into a running pod reliably.** You can
   see the old file list inside the pod until the volume syncs; a restart guarantees
   it.

```bash
kubectl -n $NS rollout restart deploy/grafana
kubectl -n $NS rollout status deploy/grafana --timeout=120s
```

> This is a **Deployment with no PVC-writer race** here; the `Recreate` strategy
> just means a short gap while the single pod is replaced. Fine.

Confirm the files are inside the pod:

```bash
kubectl -n $NS exec deploy/grafana -- ls /var/lib/grafana/dashboards
```

Expected: all 13 `.json` files listed.

---

## 5. Verify in Grafana (API)

```bash
PW=$(kubectl -n $NS get secret grafana-admin -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d)
kubectl -n $NS port-forward svc/grafana 3000:3000 >/tmp/grafana-pf.log 2>&1 &
sleep 5
curl -s -u admin:"$PW" 'http://localhost:3000/api/search?type=dash-db' | python3 -c '
import sys,json
d=json.load(sys.stdin); print("count:",len(d))
for x in sorted(d,key=lambda z:z.get("title","")): print(" ",x["uid"])'
pkill -f 'port-forward' || true
```

Expected: `count: 13` and the uids listed in step 2.

Then open Grafana in a browser (via `06-ingress-dns-cloudflare.md` or a
port-forward) and click through each dashboard.

---

## 6. What each dashboard shows

| uid / file | Title | Data sources | Highlights |
|---|---|---|---|
| `prometheus-overview` | Prometheus / Overview | Prometheus | target health, scrape/rule stats |
| `logs-overview` | Logs — project-hope-vox | Loki | cross-namespace search (`$namespace`, `$search`) |
| `k8s-infra` | Kubernetes Infrastructure | Prometheus | nodes ready/total, pod phases, CPU/mem/FS per node, top pods, restarts, capacity |
| `stt-gpu` | STT / GPU Server | Prometheus + Loki | **GPU host CPU & memory**, load, STT sessions/queue/latency/RTF, vLLM engine, STT logs |
| `vllm` | vLLM — GPU Inference | Prometheus + Loki | requests running/waiting, KV cache, throughput, TTFT/TPOT/e2e latency, vLLM logs/errors |
| `app-hope-api-gateway` | App — API Gateway | Prometheus + Loki | request rate/latency, connections, event-loop lag, STT relay lag, logs |
| `app-hope-guardrail` | App — Guardrail | Prometheus + Loki | request rate/latency, queue, circuit breaker, peer failures, logs |
| `app-hope-harness` | App — Harness | Prometheus + Loki | request rate/latency, regen rate, logs |
| `app-hope-nlp` | App — NLP | Prometheus + Loki | request rate, inference latency, logs |
| `app-hope-text` | App — Text generation | Prometheus + Loki | generations, tokens/s, TTFT, stop reasons, logs |
| `app-hope-tts` | App — TTS | Prometheus + Loki | request rate, chars, RTF, TTFA, streams, logs |
| `app-hope-harness-worker` | App — Harness Worker | Loki + cAdvisor | logs + CPU/mem (no scrapeable metrics) |
| `app-hope-admin-console` | App — Admin Console | Loki + cAdvisor | logs + CPU/mem (metrics endpoint excluded) |

Every app dashboard uses the Loki label `container="hope-<name>"` and PromQL
filtered by `{job="hope-apps", app="hope-<name>"}` where relevant.

---

## 7. Add or change a dashboard

1. Open `dashboards/generate.py`.
2. Add a panel with the helpers `stat(...)`, `ts(...)`, `logs(...)`, or a whole new
   dashboard function returning `dashboard(uid, title, tags, panels, ...)`.
3. Wire it in `main()` (e.g. `dashboards["my-new.json"] = my_new()`), or extend the
   `apps()` map.
4. Regenerate, apply, restart Grafana:

   ```bash
   python3 dashboards/generate.py
   kubectl apply -f manifests/07-grafana-dashboards.yaml
   kubectl -n project-hope-vox-infra rollout restart deploy/grafana
   ```

> **Alternative: Individual JSON files** — you can also use
> `dashboards/generate_individual.py` to copy dashboards to
> `manifests/dashboards/` as individual JSON files. These can be studied, modified,
> and imported via the Grafana UI (**+, Import**) or API, without touching
> `generate.py`. If you modify JSONs this way, remember that Grafana file provisioning
> only loads at startup — restart the pod after ConfigMap changes.

Notes:

- Datasource objects are fixed uids: `{"type":"prometheus","uid":"prometheus"}` and
  `{"type":"loki","uid":"loki"}`. Use the helpers, not raw strings.
- Panels auto-place on a 24-column grid (`_pack`); set `w`/`h` and let it flow.
- For rate-based panels use `$__rate_interval`; for log volume use `$__interval`
  and `$__range`.
- After any dashboard change, Grafana 13 requires a restart to load new file-provisioned
  dashboards reliably.

---

## 8. Phase checklist

- [ ] `generate.py` ran; `07-...yaml` has 13 dashboards.
- [ ] ConfigMap applied; 13 keys present.
- [ ] Grafana restarted; 13 files inside the pod.
- [ ] Grafana `/api/search?type=dash-db` returns 13.
- [ ] Dashboards with data: `k8s-infra` (yes), `app-hope-*` (yes), `vllm`/`stt-gpu`
      (GPU metrics yes; GPU-host CPU/mem + GPU logs need `07-gpu-server.md`).
- [ ] **Individual JSON files available** in `manifests/dashboards/` — generated by
      `generate_individual.py` for study/modification.
- [ ] If using individual JSONs: imported into Grafana and verified.

Next → [`06-ingress-dns-cloudflare.md`](./06-ingress-dns-cloudflare.md)
