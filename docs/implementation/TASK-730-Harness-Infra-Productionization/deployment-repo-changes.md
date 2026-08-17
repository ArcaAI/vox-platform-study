# Deployment-repo changes for Tasks 2 & 3 — NOT APPLIED

| | |
|---|---|
| **Status** | **DOCUMENTED, NOT APPLIED.** This session has read-only GitLab MCP access to
`arca/hope-v2-deployment` and no cluster access. Every command below is written for the owner (or
whoever holds write access to that repo / the `c-nfhxq` cluster) to run. No `create_or_update_file`,
`push_files`, `create_pipeline`, `mcp__rancher__*`, or `mcp__argocd__*` tool was used this session. |
| **Re-verified against** | `arca/hope-v2-deployment` @ commit `bb2f96f4c7d89e1099bdb300066e56b05ea43df5` (branch `main`), 2026-08-17 — same commit the ticket's §2.10/§2.11 cited; no drift since. |
| **Depends on** | `temporal-hosting-decision.md` §6 — Option A (self-hosted k3s) decided 2026-08-17 |

---

## Task 2 — reconnect `hope-harness` / `hope-harness-worker` to the in-cluster Temporal

### What's already true (no action needed)

- `deployment/k8s/base/harness.yaml` and `harness-worker.yaml` already exist, are wired into
  `base/kustomization.yaml`, and are already synced to `hope-v2-dev` (§2.10/§2.11 of `README.md`).
- Both workloads read `TEMPORAL_ADDRESS` (and `TEMPORAL_NAMESPACE`/`TEMPORAL_TASK_QUEUE`) via
  `configMapKeyRef: { name: hope-harness-config, key: TEMPORAL_ADDRESS }` — **verified this
  session** by reading both manifests directly (`harness.yaml:66-72`, `harness-worker.yaml:63-72`).
  There is exactly ONE place that sets the value: `deployment/k8s/base/config/harness.env`, which
  `base/kustomization.yaml`'s `configMapGenerator` renders into the `hope-harness-config` ConfigMap
  (content-hashed name, so a change here rolls both pods on the next `kubectl apply -k` / Argo
  sync automatically).
- `harness-worker.yaml`'s `HARNESS_INTERNAL_SERVICE_TOKEN` optionality (§2.11 correction) and
  `runAsUser`/`runAsGroup: 1001` are already fixed in the manifest at this commit — re-confirmed
  this session, no further action needed there.
- The cluster-side Prometheus `temporal` scrape job (`observability-config.yaml`, target
  `hope-temporal:9090`) is **unchanged and still targets the in-cluster Deployment** —
  re-confirmed this session at the same commit. Once the patch below lands, this scrape job
  becomes correct automatically — no separate observability change is needed for Task 2.

### The one-line patch

File: `deployment/k8s/base/config/harness.env`

```diff
 HARNESS_API_BASE_URL=http://hope-api:8868
 HARNESS_CLAIM_CHECK_ENABLED=true
 HARNESS_CLAIM_CHECK_STORE=s3
-TEMPORAL_ADDRESS=10.10.1.10:7233
+TEMPORAL_ADDRESS=hope-temporal:7233
 TEMPORAL_NAMESPACE=default
 TEMPORAL_TASK_QUEUE=harness-task-queue
```

`hope-temporal:7233` resolves via in-cluster DNS to the `hope-temporal` Service already defined in
`deployment/k8s/base/temporal.yaml` (grpc port 7233) — no new Service, no new DNS entry, nothing
else to create. This is a one-file, one-line change; every other Deployment/Service/ConfigMap/HPA
resource Task 2's original brief asked for already exists (§2.10/§2.11).

### Apply sequence (owner-run, not executed this session)

```bash
# 1. Land the patch above on a branch, PR it into arca/hope-v2-deployment main
#    (this repo's CI/CD conventions — .gitlab/ci/deploy.yml — apply there, not here).

# 2. Once merged to main and Argo syncs hope-v2-dev (auto-sync is ON for dev per
#    application-dev.yaml), confirm the rollout:
kubectl -n hope-v2-dev rollout status deployment/hope-harness
kubectl -n hope-v2-dev rollout status deployment/hope-harness-worker

# 3. Confirm the worker actually connects (it hard-requires Temporal, unlike the
#    FastAPI app's best-effort connect — .claude/rules/06-python-services.md §Temporal):
kubectl -n hope-v2-dev logs deploy/hope-harness-worker --tail=50 | grep -i temporal
kubectl -n hope-v2-dev get pod -l app=hope-harness-worker   # expect Running, not CrashLoopBackOff

# 4. Confirm the Prometheus scrape target flips from "wrong instance, technically up"
#    to "right instance, actually load-bearing" (no config change needed, just observe):
#    Prometheus UI / API -> targets -> job "temporal" -> should show the SAME hope-temporal:9090
#    target as before, but now backing real traffic.
```

### What this patch does NOT close (still open, tracked in `temporal-hosting-decision.md` §6)

- HA topology (still `replicas: 1`, no split-service frontend/history/matching pods).
- Node capacity headroom for any future HA topology (`dell` node already runs hot per
  `docs/deployment-runbook.md` §9).
- The Temporal/Postgres backup story (`docs/operations/temporal/README.md` §6 open items).

---

## Task 3 — staging + prod namespace/Argo bring-up

### What's already true (no action needed)

Re-verified this session, same commit, no drift from §2.10 finding 3:

- `deployment/k8s/overlays/staging/kustomization.yaml` and `.../overlays/prod/kustomization.yaml`
  both exist and both render `harness`/`harness-worker` (they `resources: [../../base]`).
- `deployment/argocd/appproject-staging.yaml` + `application-staging.yaml` and
  `appproject-prod.yaml` + `application-prod.yaml` all exist in Git. `application-{staging,prod}`
  each declare their `Namespace` object (`hope-v2-staging`, `hope-v2-prod`) inline alongside the
  Argo `Application`.
- None of the four files above have been applied to the cluster — `docs/deployment-runbook.md` §1
  states Argo `Application`/`AppProject` objects are "not self-managed": committing them to Git
  changes nothing on the cluster until someone runs `kubectl apply` by hand. §6 of the same
  runbook (as of its 2026-08-09 writing) confirms `hope-v2-staging`/`hope-v2-prod` do not exist.

### Apply sequence (owner-run, not executed this session — requires `c-nfhxq` cluster access)

AppProject before Application (the Application's `spec.project` must resolve):

```bash
kubectl config use-context <context for https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq>

# Staging — auto-sync/prune/selfHeal are ON by default in application-staging.yaml's spec, but
# BOTH are explicitly forced OFF in that file's syncPolicy on purpose: the namespace does not
# exist yet, so the first sync would go from nothing to a fully-reconciling environment in one
# step on a single node already near capacity. Per the file's own comment: selfHeal alone first,
# watch one sync, THEN prune.
kubectl apply -f deployment/argocd/appproject-staging.yaml
kubectl apply -f deployment/argocd/application-staging.yaml
argocd app get hope-v2-staging          # confirm it registered
argocd app sync hope-v2-staging         # first sync, manual and watched
# ... verify pods healthy in hope-v2-staging, THEN flip syncPolicy.automated.prune: true ...

# Prod — application-prod.yaml carries NO `automated:` block at all (its absence is what keeps
# auto-sync off; there is no clean "pause for an hour" primitive once selfHeal is on, so this is
# deliberate, not an oversight). A human syncs prod explicitly after promote-prod commits a digest.
kubectl apply -f deployment/argocd/appproject-prod.yaml
kubectl apply -f deployment/argocd/application-prod.yaml
argocd app get hope-v2-prod             # confirm it registered; stays un-synced until a human acts
```

### What this unblocks (verifiable from THIS repo, once the above is applied and a pipeline runs)

`.gitlab/ci/deploy.yml`'s `promote-staging` (`:82-92`, gated `$PIPELINE_TYPE == "staging"`,
targets `deployment/k8s/overlays/staging`) and `promote-prod` (`:95-107`, gated on a protected
`v*` tag, `when: manual`, targets `.../overlays/prod`) already exist and are digest-pinned,
zero-rebuild promotions (`promote.sh`) — they have simply never had a real namespace to land in.
Once the Argo objects above are applied, the ticket's Task 3 acceptance criterion ("a
`promote-staging` pipeline run succeeds end-to-end, CI job log pasted into README.md §7") becomes
something a future session with CI-trigger authority can actually run and paste evidence for. Not
attempted here — triggering a real deploy pipeline is outside this session's authorization
regardless of cluster access.
