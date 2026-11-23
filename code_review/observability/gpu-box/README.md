# GPU-server telemetry (host 192.168.112.2)

Two small containers on the GPU host feed the cluster monitoring stack:

| Container | Purpose | Consumed by |
|---|---|---|
| `hope-node-exporter` (`:9100`) | host CPU, memory, disk, network | Prometheus job `node-exporter-gpu` |
| `hope-promtail` | vLLM + STT container logs | Loki (NodePort `31100`) |

Without these, the **STT / GPU** dashboard's CPU & memory panels and the **vLLM**
dashboard's log/error panels stay empty. Everything else is already live.

## Install

```bash
# from a machine that can reach 192.168.112.2
scp -r review/observability/gpu-box sumankumar@192.168.112.2:~/gpu-box
ssh sumankumar@192.168.112.2
cd ~/gpu-box

# LOKI_URL = any control-plane/worker node IP, NodePort 31100
LOKI_URL=http://192.168.112.6:31100 docker compose up -d
docker ps
```

Then confirm from the cluster side (already reachable — the host is on the node LAN):

```bash
curl -s http://192.168.112.2:9100/metrics | head        # node-exporter
curl -s http://192.168.112.6:31100/ready                # Loki NodePort from the host
```

Prometheus will pick up `node-exporter-gpu` within ~15 s (the "down" alert clears
automatically once scraped).

## Verify in Grafana

- **Kubernetes Infrastructure** → unaffected.
- **STT / GPU** → "GPU host CPU" / "GPU host memory" panels populate.
- **vLLM** → "Logs" and "Errors" panels populate once promtail ships.

## Adjusting to your setup

- **Container names** — the `keep` regex in `promtail-gpu.yml` matches
  `vllm|whisper|stt|tts|triton|embed|inference`. If your containers are named
  differently, edit that regex. Check what promtail discovered:
  `docker logs hope-promtail | grep -i target`.
- **Non-Docker services** (systemd binaries) — replace the `gpu-containers`
  `docker_sd_configs` block with a file scrape, e.g.:

  ```yaml
  scrape_configs:
    - job_name: vllm
      static_configs:
        - targets: [localhost]
          labels: { job: vllm, host: gpu-server, __path__: /var/log/vllm/*.log }
    - job_name: stt
      static_configs:
        - targets: [localhost]
          labels: { job: stt,  host: gpu-server, __path__: /var/log/stt/*.log }
  ```
  and point the compose volume at those directories.
- **GPU utilisation (optional)** — vLLM already exposes `vllm:kv_cache_usage_perc`.
  For hardware-level GPU metrics, add `nvidia/dcgm-exporter` (see
  `dcgm-exporter.compose.yml`) and scrape `192.168.112.2:9400`.
- **Loki NodePort** — if `31100` is not free on the nodes, change it in
  `manifests/14-loki-nodeport.yaml` and here.
