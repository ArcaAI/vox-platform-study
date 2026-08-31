# Deploy Rancher + Argo — VM 400 `master` (10.10.1.100)

**Status**: BUILT — VM 400 is the k3s control-plane node, confirmed live with ArgoCD (v1.11+ installed) and Rancher running in live-state discovery 2026-08-07.

**Date**: 2026-03-18
**VM**: 400 | **Name**: `master` | **IP**: 10.10.1.100 | **Bridge**: vmbr1 | **Specs**: 8c / 16 GB / 64 GB disk
**Related**: [Infrastructure Overview](../infrastructure/proxmox-infrastructure-gitlab-rancher-plan.md) | [K3s + GPU (VM 200)](./deploy-vm200-k3s-gpu.md) | [GitLab (VM 410)](./deploy-vm410-gitlab.md) | [Cloudflare Tunnel (CT 101)](./deploy-ct101-cloudflare-tunnel.md)

---

## Prerequisites

- VM 400 running Ubuntu 24.04 Server
- SSH access: `ssh hope@10.10.1.100`
- Cloudflare Tunnel (CT 101) configured:
  - `rancher.taphuynh.dev → http://10.10.1.100:80`
  - `ssh-master.taphuynh.dev → ssh://10.10.1.100:22`

---

## 1. Install K3s

Rancher runs on top of a lightweight Kubernetes distribution. K3s is used as the local cluster.

```bash
ssh hope@10.10.1.100
```

```bash
curl -sfL https://get.k3s.io | sh -s - server \
  --disable traefik \
  --tls-san rancher.taphuynh.dev \
  --tls-san 10.10.1.100 \
  --write-kubeconfig-mode 644

sudo systemctl status k3s
kubectl get nodes
```

> **`--disable traefik`**: Rancher ships its own ingress controller. Disabling Traefik avoids port conflicts.
>
> **`--tls-san`**: Adds Subject Alternative Names to the K3s API server certificate so it can be accessed via both the hostname and IP.

---

## 2. Install Helm

Helm is the package manager used to install cert-manager and Rancher.

```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
```

---

## 3. Install cert-manager

cert-manager manages TLS certificates for Rancher's internal communication.

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.crds.yaml

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=false

kubectl -n cert-manager rollout status deployment cert-manager
```

---

## 4. Install Rancher

```bash
helm repo add rancher-stable https://releases.rancher.com/server-charts/stable
helm repo update

helm install rancher rancher-stable/rancher \
  --namespace cattle-system \
  --create-namespace \
  --set hostname=rancher.taphuynh.dev \
  --set bootstrapPassword=<STRONG-BOOTSTRAP-PASSWORD> \
  --set ingress.tls.source=rancher \
  --set replicas=1

kubectl -n cattle-system rollout status deployment rancher
```

> **`replicas=1`**: Single-node deployment. Sufficient for a homelab. Increase to 3 for HA.

---

## 5. Install Argo CD

Argo CD provides GitOps-based continuous delivery for Kubernetes clusters.

```bash
kubectl create namespace argocd

kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

kubectl -n argocd rollout status deployment argocd-server
```

### Get Initial Admin Password

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
```

### Access Argo CD

Internal: `https://10.10.1.100` (via K3s ingress or port-forward)

```bash
# Quick access via port-forward
kubectl port-forward svc/argocd-server -n argocd 8080:443 --address 0.0.0.0
# → https://10.10.1.100:8080
```

> Argo CD ingress configuration depends on your chosen setup. Configure an Ingress resource or expose via the Rancher ingress controller as needed.

---

### ⚠ Register downstream clusters DIRECTLY, not through the Rancher proxy

**Changed 2026-08-31.** Argo's destination for `hope-v2-dev` was
`https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq` — the Rancher proxy, which
resolves to **Cloudflare** and inherits every tunnel drop. Syncs failed an
arbitrary subset of objects (one run: **9 of 124**), and because the failures
land in early sync waves, later waves never ran — `hope-temporal` (`syncWave: 2`)
was simply never created, which in turn crash-looped `hope-harness-worker`.

VM 400 and VM 200 are both on `10.10.1.0/24`. Measured from an Argo pod:
`https://10.10.1.10:6443` answers in **8.5 ms**; the proxy path takes **506 ms**.

```bash
# On VM 200 — the SA usually already exists from the Rancher import. Verify it is admin:
kubectl auth can-i '*' '*' --all-namespaces \
  --as=system:serviceaccount:kube-system:argocd-manager      # -> yes

# k8s >= 1.24 does not auto-create a token; make a long-lived one:
kubectl -n kube-system apply -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: argocd-manager-token
  namespace: kube-system
  annotations: { kubernetes.io/service-account.name: argocd-manager }
type: kubernetes.io/service-account-token
EOF

# On VM 400 — register the cluster. The label is what makes Argo treat it as one.
#   stringData.server = https://10.10.1.10:6443
#   stringData.config = {"bearerToken":"<token>","tlsClientConfig":{"insecure":false,"caData":"<ca.crt b64>"}}
# Both values come from the Secret above; copy base64 to base64 and never echo them.

# Whitelist the destination in the AppProject, or the app parks at Unknown/Unknown:
kubectl -n argocd patch appproject hope-v2 --type=merge -p '{"spec":{"destinations":[
  {"server":"https://10.10.1.10:6443","namespace":"hope-v2-dev"}]}}'

# Repoint the Application:
kubectl -n argocd patch application hope-v2-dev --type=merge \
  -p '{"spec":{"destination":{"server":"https://10.10.1.10:6443","namespace":"hope-v2-dev"}}}'
```

Result: **124 of 124 objects applied, 0 failures**, against 9 failures minutes
earlier on the proxy path.

Forgetting the AppProject step is not a transient error — the Application
reports `destination server ... do not match any of the allowed destinations`
and never reconciles.

Background and the full measurement set:
[CT 101 — second failure mode](./deploy-ct101-cloudflare-tunnel.md#-second-failure-mode-long-lived-connections-and-latency-measured-2026-08-31).

---

## 6. Access & Initial Configuration

### Internal Access

`https://10.10.1.100` (accept self-signed cert)

### External Access

`https://rancher.taphuynh.dev` (via Cloudflare Tunnel)

### First Login

1. Enter the bootstrap password set in step 4
2. Set a permanent admin password
3. Set Rancher server URL: `https://rancher.taphuynh.dev`

### Optional: GitLab OAuth

Settings → Authentication → GitLab:
- Application ID and Secret from a GitLab OAuth application
- GitLab URL: `https://git.taphuynh.dev`

---

## 7. Import K3s GPU Cluster (After VM 200 Deployment)

Once K3s is running on VM 200 (see [deploy-vm200-k3s-gpu.md](./deploy-vm200-k3s-gpu.md)):

1. **Cluster Management** → **Import Existing** → **Generic**
2. Cluster name: `hope-gpu`
3. Copy the generated `kubectl apply` command
4. Run it on VM 200:

```bash
ssh hope@10.10.1.10
kubectl apply -f <generated-manifest-url>
```

5. Wait for the cluster to appear as **Active** in Rancher UI

---

## 8. Container Registry Access

To pull images from the GitLab Container Registry on VM 410, configure registry credentials:

### Option A: `/etc/hosts` Override (Recommended)

Add to `/etc/hosts` on VM 400 so registry traffic stays on the internal network:

```bash
echo "10.10.1.110 registry.taphuynh.dev git.taphuynh.dev" | sudo tee -a /etc/hosts
```

### Option B: Direct Internal IP

Configure Rancher cluster to use `10.10.1.110:5050` as the registry endpoint directly.

---

## 9. Verify

```bash
# K3s cluster health
kubectl get nodes
# NAME     STATUS   ROLES                  AGE   VERSION
# master   Ready    control-plane,master   ...   v1.31.x+k3s1

# Rancher pods
kubectl -n cattle-system get pods
# All should be Running

# Argo CD pods
kubectl -n argocd get pods
# All should be Running

# Rancher health endpoint
curl -sk https://10.10.1.100/healthz
# → ok

# External access (from your Mac)
curl -sSI https://rancher.taphuynh.dev | head -5
# → HTTP/2 200 or 302
```

---

## Operational Notes

### Upgrading Rancher

```bash
helm repo update
helm upgrade rancher rancher-stable/rancher \
  --namespace cattle-system \
  --set hostname=rancher.taphuynh.dev \
  --set ingress.tls.source=rancher \
  --set replicas=1

kubectl -n cattle-system rollout status deployment rancher
```

### Upgrading Argo CD

```bash
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deployment argocd-server
```

### Upgrading K3s

```bash
curl -sfL https://get.k3s.io | sh -s - server \
  --disable traefik \
  --tls-san rancher.taphuynh.dev \
  --tls-san 10.10.1.100 \
  --write-kubeconfig-mode 644

sudo systemctl status k3s
kubectl get nodes
```

### Backup

K3s stores its state in an embedded etcd or SQLite database. For snapshot-based backup:

```bash
# K3s etcd snapshot (if using embedded etcd)
sudo k3s etcd-snapshot save --name master-backup-$(date +%F)

# Or take a Proxmox-level snapshot
# On Proxmox host: qm snapshot 400 pre-upgrade
```

### Logs

```bash
# Rancher logs
kubectl -n cattle-system logs -f deployment/rancher --tail 200

# Argo CD logs
kubectl -n argocd logs -f deployment/argocd-server --tail 200

# K3s logs
sudo journalctl -u k3s -f --no-pager
```
