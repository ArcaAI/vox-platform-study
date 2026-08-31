# Deploy K3s + GPU — VM 200 (10.10.1.10)

**Status**: BUILT — k3s cluster is live on this VM, confirmed in live-state discovery 2026-08-07 as the single GPU node hosting the cluster.

**Date**: 2026-03-18
**VM**: 200 | **IP**: 10.10.1.10 | **Bridge**: vmbr1 | **Specs**: 8c / 16 GB / 64 GB disk + 2× NVIDIA RTX 2000 Ada (GPU passthrough)
**Related**: [Infrastructure Overview](../infrastructure/proxmox-infrastructure-gitlab-rancher-plan.md) | [Rancher + Argo (VM 400)](./deploy-vm400-master.md) | [GitLab Runner (VM 411)](./deploy-vm411-gitlab-runner.md) | [GPU Setup](../infrastructure/proxmox-setup-dell-7920-step-by-step.md)

---

## Prerequisites

- VM 200 running Ubuntu 24.04 Server with GPU passthrough configured
- SSH access: `ssh hope@10.10.1.10`
- NVIDIA drivers installed and both GPUs visible via `nvidia-smi`
- Cloudflare Tunnel (CT 101) configured with `server-gpu.taphuynh.dev → ssh://10.10.1.10:22`

---

## 1. Verify GPU Passthrough

```bash
ssh hope@10.10.1.10
```

```bash
nvidia-smi
# Should show both RTX 2000 Ada GPUs:
# +-------------------------+
# | GPU 0: NVIDIA RTX 2000 Ada Generation |
# | GPU 1: NVIDIA RTX 2000 Ada Generation |
# +-------------------------+
```

If GPUs are not visible, refer to the [GPU passthrough setup guide](../infrastructure/proxmox-setup-dell-7920-step-by-step.md).

---

## 2. Install K3s

```bash
curl -sfL https://get.k3s.io | sh -s - server \
  --tls-san 10.10.1.10 \
  --write-kubeconfig-mode 644 \
  --kubelet-arg="feature-gates=DevicePlugins=true"

sudo systemctl status k3s
kubectl get nodes
```

> **`DevicePlugins=true`**: Required for the NVIDIA device plugin to expose GPUs to Kubernetes pods.

---

## 3. Install NVIDIA Container Toolkit

The container toolkit enables containerd (K3s runtime) to access NVIDIA GPUs inside containers.

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update && sudo apt install -y nvidia-container-toolkit
```

---

## 4. Configure containerd for GPU Access

Generate the CDI (Container Device Interface) spec and configure K3s's containerd:

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

sudo nvidia-ctk runtime configure --runtime=containerd \
  --config /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl

sudo systemctl restart k3s
```

---

## 5. Import into Rancher

> **Requires**: Rancher deployed on VM 400. See [deploy-vm400-master.md](./deploy-vm400-master.md).

In Rancher UI (`https://rancher.taphuynh.dev` or `https://10.10.1.100`):

1. **Cluster Management** → **Import Existing** → **Generic**
2. Cluster name: `hope-gpu`
3. Copy the generated `kubectl apply` command
4. Run it on VM 200:

```bash
kubectl apply -f <generated-manifest-url>
```

5. Wait for the cluster to show as **Active** in Rancher

---

## 5.1 Internal DNS override — keep cluster traffic off Cloudflare

> **Added 2026-08-31 after a full day lost to this.** VM 411 and VM 400 both got
> this treatment when they were built (see [CT 101 workaround strategy](./deploy-ct101-cloudflare-tunnel.md#workaround-strategy));
> **VM 200 never did**, and it is the node that pulls the largest images and holds
> the Rancher websocket.

The tunnel doc's principle is *"All VM-to-VM traffic MUST stay on the internal
`10.10.1.x` network."* Step 5 above imports this cluster using
`https://rancher.taphuynh.dev`, which sets `CATTLE_SERVER` to the **public**
hostname — so out of the box this node violates that principle twice.

### What breaks, measured

| Flow | Symptom |
|---|---|
| `cattle-cluster-agent` → Rancher | Websocket dies with `close 1006`; every consumer sees `error trying to reach service: sync from client`. Argo applied only **115 of 124** objects in one run, all 9 failures transport-only |
| kubelet/containerd → registry | **80–200 KB/s** (413 MB took 29m20s). Multi-GB ML images exceed the Deployment progress deadline and look like an app fault |

LAN latency to the same hosts is **1.1–8.5 ms**, versus **350–800 ms** through
the edge.

### Fix 1 — image pulls (safe, do this one)

A CoreDNS entry does **not** work: containerd resolves through the **node**, not
cluster DNS. Pin the mirror instead:

```bash
sudo tee /etc/rancher/k3s/registries.yaml >/dev/null <<'EOF'
mirrors:
  registry.taphuynh.dev:
    endpoint:
      - "http://10.10.1.110:5050"
configs:
  "10.10.1.110:5050":
    tls:
      insecure_skip_verify: true
EOF
sudo systemctl restart k3s
```

`10.10.1.110:5050` is the same origin the tunnel already points at, so this
changes the path, not the content. Verify with a fresh pull and compare the
`Pulled ... in <duration>` event against the figures above.

### Fix 2 — the agent websocket (⚠ needs a prerequisite)

Do **not** just add `10.10.1.100 rancher.taphuynh.dev` to `/etc/hosts`. The
Rancher origin serves **no TLS** for that hostname — the tunnel ingress is
`http://10.10.1.100:80`, so traefik builds no router on `:443`:

```
:443 /healthz -> 404      :80 /healthz -> 200      :80 /v3/connect -> 302
```

An `/etc/hosts` entry alone therefore **breaks the agent**. Order of operations:

1. On VM 400, add a `tls:` section to the `rancher` Ingress using the existing
   `tls-rancher-ingress` Secret (cert-manager is installed there).
2. Confirm `curl -k --resolve rancher.taphuynh.dev:443:10.10.1.100 https://rancher.taphuynh.dev/healthz` returns **200**, not 404.
3. Only then add the `/etc/hosts` entry on VM 200.

The agent runs with `CATTLE_CA_CHECKSUM=` empty and `STRICT_VERIFY=false`, so it
tolerates the origin's own certificate.

**Or skip both**: set the Cloudflare DNS records for `rancher.taphuynh.dev` and
`registry.taphuynh.dev` to **DNS-only (grey cloud)** and every internal client
resolves the origin directly. Owner decision — it changes external reachability.

### Argo no longer depends on any of this

Argo CD (VM 400) previously reached this cluster through
`https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq`, inheriting every tunnel
drop. Since 2026-08-31 it targets the API server **directly** at
`https://10.10.1.10:6443` via a `hope-v2-direct` cluster Secret — 8.5 ms, and
the first sync after the change applied **124 of 124 objects with 0 failures**.
See [VM 400 guide](./deploy-vm400-master.md#5-install-argo-cd).

---

## 6. Install NVIDIA GPU Operator

The GPU Operator automates the management of GPU resources in Kubernetes. Install via Rancher UI or Helm.

### Via Rancher UI

`hope-gpu` cluster → **Apps** → **Charts** → search "NVIDIA GPU Operator"

### Via Helm (on VM 200)

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set driver.enabled=false \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true
```

> **`driver.enabled=false`**: The NVIDIA driver is already installed on the host. The operator should not try to install its own.

### GPU Time-Slicing Configuration

To share each physical GPU across multiple pods, apply a time-slicing config:

```yaml
# gpu-time-slicing.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  any: |-
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4
```

```bash
kubectl apply -f gpu-time-slicing.yaml

# Patch the GPU operator to use the config
kubectl -n gpu-operator patch clusterpolicy/cluster-policy \
  --type merge \
  -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'
```

With `replicas: 4` on 2 physical GPUs, Kubernetes will see 8 allocatable GPU slots.

---

## 7. Verify GPU Access

```bash
# Check allocatable GPUs (should show "8" with time-slicing)
kubectl get nodes -o json | jq '.items[].status.allocatable["nvidia.com/gpu"]'
# → "8"

# Run a test pod
kubectl run gpu-test --rm -it --restart=Never \
  --image=nvidia/cuda:12.6.0-base-ubuntu24.04 \
  --limits=nvidia.com/gpu=1 \
  -- nvidia-smi

# Should display GPU info inside the container
```

---

## 8. Register GitLab Kubernetes Runner (Optional)

After the GPU cluster is verified, register a GitLab Runner with the Kubernetes executor for GPU-accelerated CI jobs.

> **Requires**: GitLab Runner on VM 411 deployed. See [deploy-vm411-gitlab-runner.md](./deploy-vm411-gitlab-runner.md).

On VM 411:

```bash
sudo gitlab-runner register \
  --non-interactive \
  --url "http://10.10.1.110" \
  --token "glrt-<ANOTHER-TOKEN>" \
  --executor "kubernetes" \
  --kubernetes-host "https://10.10.1.10:6443" \
  --kubernetes-namespace "gitlab-ci" \
  --kubernetes-service-account "gitlab-runner" \
  --description "k8s-runner-01" \
  --tag-list "kubernetes,deploy,gpu"
```

> **Internal URL**: The runner communicates with both GitLab (`10.10.1.110`) and the K3s API server (`10.10.1.10`) over the internal network.

---

## Operational Notes

### Upgrading K3s

```bash
curl -sfL https://get.k3s.io | sh -s - server \
  --tls-san 10.10.1.10 \
  --write-kubeconfig-mode 644 \
  --kubelet-arg="feature-gates=DevicePlugins=true"

sudo systemctl status k3s
kubectl get nodes
```

### Upgrading GPU Operator

```bash
helm repo update
helm upgrade gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --set driver.enabled=false \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true
```

### Monitoring GPU Usage

```bash
# Host-level GPU monitoring
nvidia-smi dmon -s u -d 5

# Kubernetes GPU allocation
kubectl describe node | grep -A5 "Allocated resources"
```

### Logs

```bash
# K3s logs
sudo journalctl -u k3s -f --no-pager

# GPU operator logs
kubectl -n gpu-operator logs -f deployment/gpu-operator

# Device plugin logs
kubectl -n gpu-operator logs -f daemonset/nvidia-device-plugin-daemonset
```
