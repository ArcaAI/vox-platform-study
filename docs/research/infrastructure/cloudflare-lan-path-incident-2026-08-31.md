# LAN traffic through Cloudflare — investigation, 2026-08-31

**Status**: root cause confirmed · image-pull half FIXED · Rancher-websocket half OPEN
**Scope**: CT 101 (tunnel) · VM 200 (k3s, 10.10.1.10) · VM 400 (Rancher + Argo, 10.10.1.100) · VM 410 (GitLab registry, 10.10.1.110)
**Related**: [CT 101 tunnel](../deployments/deploy-ct101-cloudflare-tunnel.md) · [VM 200 k3s](../deployments/deploy-vm200-k3s-gpu.md) · [VM 400 master](../deployments/deploy-vm400-master.md) · [Network topology](./proxmox-network-topology-design.md)

---

## 1. One-paragraph summary

`rancher.taphuynh.dev` and `registry.taphuynh.dev` are Cloudflare-proxied, so
traffic between VMs sitting in the same rack was crossing to a **Hong Kong edge
and back**. That single fact produced a day of symptoms that looked like a
dozen unrelated faults: partial Argo syncs, `kubectl` failing at random,
crash-looping workers, and a service that appeared "down" in the admin console.
CT 101's own design doc already stated the correct principle — *"All VM-to-VM
traffic MUST stay on the internal `10.10.1.x` network"* — and implemented it for
VM 411 and VM 400. **VM 200 was never covered**, and it is the node that pulls
the largest images and holds the Rancher websocket.

---

## 2. The measurements everything else rests on

```
$ dig +short rancher.taphuynh.dev        $ curl -sS -D - https://rancher.taphuynh.dev/ping
104.21.78.11                             HTTP/2 200
172.67.214.109                           server: cloudflare
                                         cf-ray: a33a3e60898684b4-HKG
```

`registry.taphuynh.dev` resolves to the same edge IPs and also reports `-HKG`.

| Path | Latency / throughput |
|---|---|
| VM 400 → VM 200 k3s API, direct (`10.10.1.10:6443`) | **8.5 ms** |
| VM 200 → Rancher origin, LAN (`10.10.1.100:80`) | **1.1 ms** |
| Either host via the Cloudflare edge | **350–800 ms** |
| Image pull via Cloudflare | **57 KB/s** |
| Same image via LAN mirror | **~25 MB/s** (2.4 GiB in 96.7 s) |

For the 3.0 GiB `stt-ml-runtime` image that is **~15 hours versus ~2 minutes** —
about **440×**.

---

## 3. Three distinct faults, and how they masked each other

### 3.1 The tunnel drops (root cause)

`cattle-cluster-agent` holds a long-lived websocket to
`wss://rancher.taphuynh.dev/v3/connect`. Cloudflare recycles long-lived
connections, and each recycle appears as:

```
Remotedialer proxy error: websocket: close 1006 (abnormal closure): unexpected EOF
```

Every consumer of the Rancher proxy then sees:

```
an error on the server ("error trying to reach service: sync from client")
```

Observed on `kubectl apply/logs/exec/set env`, and on `port-forward` — which
needed **5 attempts** to establish. Argo, whose destination was the Rancher
proxy, failed an **arbitrary subset** of objects per run: one sync applied
**115 of 124**, the 9 failures being purely transport. Because they landed in
early sync waves, later waves never ran — `hope-temporal` (`syncWave: 2`) was
never created, which in turn crash-looped `hope-harness-worker` on
`tcp connect error … 7233 Connection refused`. **That worker was behaving
correctly** — it hard-requires Temporal (`06-python-services.md`).

### 3.2 Wedged kubelet pod workers

Separately, kubelet stopped acting on the STT pods entirely: **no log lines for
30+ minutes**, while `k3s crictl pods` listed **five** STT sandboxes all `Ready`,
including ones the API showed as `Terminating`. Pods sat in `PodInitializing`
for two hours with the image **absent from containerd**. Same family as the
`FailedCreatePodSandBox: DeadlineExceeded` seen earlier in the day.

Cleared with `kubectl delete pod --force --grace-period=0` on the label;
kubelet then built working replacements.

### 3.3 The pull that could never finish

Once genuinely restarted, the pull ran at **57 KB/s** — progressing, but
hopeless for a 3.0 GiB image. This is 3.1's root cause expressed as bandwidth
rather than connection loss.

---

## 4. What was ruled out, with evidence

Recorded so nobody re-walks these.

| Suspected | Evidence against |
|---|---|
| Rancher server crash-looping | 48 restarts are **historical**: `lastState.terminated.finishedAt = 2026-08-28`, three days before |
| `cattle-cluster-agent` OOM | It has **no resource requests or limits at all** — no limit could kill it |
| Node resource pressure | `MemoryPressure=False DiskPressure=False PIDPressure=False Ready=True`; 127 GB free on the image filesystem |
| GPU unavailable (STT needs one) | `capacity=6 allocatable=6`; the pod held its allocation and its init container completed |
| Application/config fault in STT | The gateway reached it in **10.8 ms** the moment the image landed — nothing about the app changed |

---

## 5. Fixes applied

### 5.1 Argo off the tunnel (VM 400) ✅

Argo never needed Rancher: both clusters are on `10.10.1.0/24`. Registered
`hope-v2-direct` → `https://10.10.1.10:6443` using the pre-existing
`argocd-manager` service account (verified `can-i '*' '*'` → yes, so no
privilege change), and repointed the Application.

**Result: 124 of 124 objects applied, 0 failures**, against 9 failures minutes
earlier.

> The AppProject destination whitelist must be updated in the same change, or
> the Application parks at `Unknown/Unknown` with `do not match any of the
> allowed destinations` — indefinitely, not transiently.

### 5.2 Registry over the LAN (VM 200) ✅ — and no restart was needed

An earlier version of this analysis claimed the fix required a k3s restart or a
Cloudflare change. **Both were wrong.** A CoreDNS override genuinely cannot help
— containerd resolves through the **node**, not cluster DNS — but the node
already has:

```
/var/lib/rancher/k3s/agent/etc/containerd/config.toml:58
  config_path = "/var/lib/rancher/k3s/agent/etc/containerd/certs.d"
```

containerd re-reads those files **per pull**, so the mirror went in live:

```toml
# certs.d/registry.taphuynh.dev/hosts.toml   — immediate, no restart
server = "https://registry.taphuynh.dev"

[host."http://10.10.1.110:5050"]
  capabilities = ["pull", "resolve"]
  skip_verify = true
```

and the same mirror was added to `/etc/rancher/k3s/registries.yaml` so it
survives a restart (k3s regenerates `certs.d` from it at startup). Backup:
`registries.yaml.bak-2026-08-31`.

`10.10.1.110:5050` is the **same origin the tunnel already points at** — this
changes the path, not the content.

Outcome: `hope-stt` and `hope-stt-worker` went from two hours of
`PodInitializing` to `1/1 Running`; namespace reached **25 ready / 0 not-ready**;
gateway → `http://hope-stt:8861/api/v1/health` in **10.8 ms**.

---

## 6. Still open

**The Rancher websocket half is unfixed.** Argo was taken *off* the tunnel
rather than the tunnel being repaired, so `kubectl` through Rancher and the
Rancher UI still ride the edge and still flap.

⚠ **Do not "fix" it with an `/etc/hosts` entry alone.** The tunnel ingress for
`rancher` is `http://10.10.1.100:80` — Cloudflare terminates TLS and speaks
plain HTTP to the origin, so traefik builds no TLS router for that host:

```
:443 /healthz -> 404      :80 /healthz -> 200 (1.6 ms)      :80 /v3/connect -> 302
```

A DNS override therefore **breaks the agent** rather than speeding it up. A
`tls-rancher-ingress` Secret exists and cert-manager is installed on VM 400, so
adding a `tls:` section to the Rancher Ingress is the enabling step — then the
override becomes safe.

**Cleanest global fix**: set both DNS records to **DNS-only (grey cloud)** in
Cloudflare. Internal clients then resolve the origin directly and every per-host
workaround becomes unnecessary. This changes external reachability, so it is an
owner decision.

---

## 7. Reusable diagnostics

### Is a pull slow, stalled, or already done?

Kubelet reports `PodInitializing` for all three, and events age out after an
hour. From a privileged pod with the host mounted at `/host`:

```bash
# downloading?  content store grows
du -sk /var/lib/rancher/k3s/agent/containerd/io.containerd.content.v1.content
# unpacking?    snapshotter grows
du -sk /var/lib/rancher/k3s/agent/containerd/io.containerd.snapshotter.v1.overlayfs
# finished?
k3s ctr -n k8s.io images ls | grep <image>
```

Sample twice, 60–90 s apart. **Zero growth in both, with the image absent, is a
genuine stall** — not slowness.

### Is it the tunnel?

If failures are **arbitrary and differ between runs**, and the message contains
`sync from client`, stop and read §3.1. Nothing downstream is meaningful until
that is understood. Argo's own reconcile loop is a good probe: run it ten times
and count failures.

---

## 8. Corrections to earlier claims in this investigation

Kept deliberately, because each was believed and acted on before being disproved.

| Claimed | Corrected by |
|---|---|
| "The registry fix needs a k3s restart / access we don't have" | `config_path` is enabled — `hosts.toml` is read per-pull; the mirror went in live (§5.2) |
| "Rancher's 48 restarts are the cause" | `lastState` shows the last was 2026-08-28, three days earlier (§4) |
| "The pull is slow but progressing" | It was **stalled** — image absent after 111 minutes, zero kubelet activity, five orphaned sandboxes (§3.2) |
| "`hope-harness-worker` is broken" | It hard-requires Temporal, which the wedged sync never created (§3.1) |

---

## 9. Cross-cutting lesson

The CT 101 communication matrix scored every flow by **payload size**, because
the Cloudflare free-tier 100 MB cap was the known constraint. Nothing in that
model predicts a websocket dying or a download running at 57 KB/s. **Connection
longevity and latency are a second, independent risk axis** — and the matrix now
carries rows 13–15 for the flows it never enumerated.
