# Wave A.4 — Argo Direct-API Repoint Runbook (L-01)

**Status**: Authored, owner-executed. **Nothing in this document has been applied.**
**Author**: Claude (sonnet-5), read-only live inspection only — no `mcp__argocd__*` write tool, no
`mcp__rancher__kubernetes_create/_patch/_delete/_exec`, no `kubectl apply/patch/delete`, no
`argocd cluster add`, no `git push` was executed while producing this document.
**Scope**: `Application/hope-v2-dev` + its `AppProject`, namespace `argocd`, cluster `local`
(Rancher management cluster) → destination cluster `c-nfhxq` ("hope-v2" in Rancher).
**Companion file**: [`wave-a4-argocd-manager-rbac.yaml`](./wave-a4-argocd-manager-rbac.yaml)

---

## 0. Headline recommendation

**Fold the destination repoint into the TASK-619 cutover. Do not patch the live ad-hoc
`Application`/`AppProject` today, and do not run this runbook's cutover step until Wave A.1's
nil-pointer panic has a confirmed clean sync.** Rationale and evidence in §4 and §6. The two
preparation steps (§3.1–3.2 — the RBAC on the target cluster, and the Argo cluster-secret shape)
are safe to execute at any time; they touch neither the live `Application` nor the live `AppProject`.

---

## 1. Live-state findings this runbook is grounded in

All read via `mcp__argocd__get_application_details`, `mcp__argocd__get_settings`,
`mcp__rancher__kubernetes_get`/`kubernetes_list`, and by reading the four files in
`hope-v2-deployment/deployment/argocd/` — no write call was made.

1. **Argo CD itself runs on the Rancher `local` cluster**, namespace `argocd` — confirmed by
   `kubernetes_list(cluster=local, kind=namespace, name=argocd)` returning the namespace, and the
   same query against `c-nfhxq` and `c-9lwv8` returning `[]`. So the ServiceAccount/RBAC on the
   *destination* cluster (`c-nfhxq`) and the cluster-registration `Secret` on the *management*
   cluster (`local`) are two different objects in two different clusters — this runbook treats
   them as such throughout.
2. **`Application/hope-v2-dev`** (`get_application_details`): `spec.destination.server:
   "https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq"`, `spec.project: "hope-v2"`,
   `spec.syncPolicy.automated: {}` (both `prune` and `selfHeal` **absent → default `false`**),
   `metadata.managedFields[0].manager: "kubectl"` (hand-created 2026-03-31, not from Git — matches
   the ticket's LIVE-08). Current `status.sync.status: "OutOfSync"`,
   `status.health.status: "Missing"`, `status.operationState.phase: "Error"`,
   `status.conditions[0].message: "Failed sync attempt to [...]: runtime error: invalid memory
   address or nil pointer dereference"`. Despite the `Missing` app-level health, **44 of 46 tracked
   resources report `status: Synced` and `health.status: Healthy`** individually — only
   `hope-ui` (retiring, prune-pending) and `hope-db-migrate`/`hope-vault-init` (the two hook Jobs,
   owned by Wave A.1/A.3) are not.
3. **`AppProject/hope-v2`** (the only `AppProject` that exists live — `hope-v2-dev` does not exist
   yet): `spec.destinations: [{server: "https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq",
   namespace: "hope-v2-dev"}]`. This is an **allow-list** — an `Application` whose
   `destination.server` doesn't match an entry here is rejected at admission
   (`argo-cd` project-boundary validation), so the `AppProject`'s `destinations[].server` must move
   in lockstep with the `Application`'s, never independently.
4. **Three Argo cluster `Secret`s exist today** in `argocd` on `local`
   (`kubernetes_list(cluster=local, kind=secret, namespace=argocd,
   labelSelector=argocd.argoproj.io/secret-type=cluster)`):
   - `cluster-kubernetes.default.svc-3396314289` — Argo's built-in in-cluster secret (`local`
     itself).
   - `cluster-rancher.taphuynh.dev-1826568627` — decodes to `name: hope-v1`,
     `server: https://rancher.taphuynh.dev/k8s/clusters/c-9lwv8` (the *other* HOPE cluster, unrelated).
   - `cluster-rancher.taphuynh.dev-644569324` — decodes to `name: hope-v2`,
     `server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq` — **this is the Rancher-proxy
     cluster credential the live `Application` uses today.**
   - **No cluster `Secret` for a direct API address exists yet.** This is the one genuinely new
     object this runbook introduces (§3.2).
5. **The direct API address, verified, not assumed**:
   - `kubernetes_list(cluster=c-nfhxq, kind=node)` → one node, `name: dell`,
     `status.addresses: [{type: InternalIP, address: "10.10.1.10"}, {type: Hostname, address:
     "dell"}]`, `metadata.annotations["k3s.io/node-args"]: ["server"]` (no `--https-listen-port`
     override, so k3s's compiled-in default `6443` applies).
   - `kubernetes_get(cluster=c-nfhxq, kind=endpoints, name=kubernetes, namespace=default)` →
     `subsets[0].addresses: [{ip: "10.10.1.10"}]`, `subsets[0].ports: [{name: "https", port:
     6443}]` — this is the literal `host:port` every in-cluster client resolves the API server to,
     independently confirming both the address and the port.
   - **Verified target: `https://10.10.1.10:6443`.**
6. **The `argocd-manager` ServiceAccount + RBAC already exist on `c-nfhxq`, right now** — this
   was not expected going in and changes what this runbook has to *create* vs. *document*:
   - `ServiceAccount/argocd-manager` in `kube-system`, created `2026-03-19T01:31:53Z`.
   - `ClusterRole/argocd-manager-role`: `rules: [{apiGroups: ["*"], resources: ["*"], verbs:
     ["*"]}, {nonResourceURLs: ["*"], verbs: ["*"]}]` — byte-for-byte the upstream Argo CD
     `argocd-manager-role` bootstrap manifest (cluster-admin-equivalent; Argo needs it to
     create/update/delete arbitrary kinds during sync).
   - `ClusterRoleBinding/argocd-manager-role-binding` → binds `ServiceAccount/argocd-manager` in
     `kube-system` to `ClusterRole/argocd-manager-role`.
   - `Secret/argocd-manager-long-lived-token` in `kube-system`, type
     `kubernetes.io/service-account-token`, annotated `kubernetes.io/service-account.name:
     argocd-manager` — the Kubernetes ≥1.24 manual-token-secret pattern, already done correctly.
     Its `kubernetes.io/legacy-token-last-used` label reads **2026-08-08** (today), meaning
     *something* is actively authenticating with this token right now, separately from the
     Application's own sync traffic (which goes through the Rancher proxy, not this SA).
   - **Reading**: this is not a greenfield setup. All three RBAC objects and the token Secret
     already exist, created 2026-03-19 — eleven days before the Application itself was
     hand-created (2026-03-31) — strongly suggesting a prior, abandoned attempt at exactly this
     direct-API registration. The companion manifest (§3.1) therefore documents current state
     (idempotent, safe to re-apply) rather than requesting new privilege.
7. **`bootstrap.dev.yaml`'s documented apply order** (its own header, lines 35–46):
   `bootstrap.dev.yaml` → `appproject-dev.yaml` → `application-dev.yaml` → repeat for
   staging/prod — all via `kubectl apply --server-side --force-conflicts -n argocd`, gated on
   `secrets.<env>.yaml` being pre-applied. This runbook's cutover step (§4) is designed to slot
   into that same sequence, not run separately from it.
8. **The already-authored, unpushed `application-dev.yaml` still targets the Rancher proxy**
   (`destination.server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq`, read directly from
   `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-deployment/deployment/argocd/application-dev.yaml:26`)
   — TASK-619's rename (`hope-v2` project → `hope-v2-dev`, one-`AppProject`-per-environment) does
   **not** by itself fix L-01. `appproject-dev.yaml`'s `destinations[].server` (line 24 of that
   file) is likewise still the proxy URL. **If TASK-619 applies these two files unmodified, the
   destination bug survives the cutover.**
9. **Wave A.1's diagnosis** (`wave-a1-argo-sync-panic-diagnosis.md`, same ticket) explicitly
   **refutes** the Rancher proxy as the cause of the nil-pointer panic itself (hypothesis (b),
   §3 of that document) — the panic is driven by the stuck `hope-vault-init` hook — but explicitly
   leaves the proxy's causal role in the separate `health.status: Missing` reading
   **"UNDETERMINED by this investigation."** The two defects are independent; this runbook does
   not depend on A.1's fix to be *correct*, only to be **verifiable** (§4, step gate).

---

## 2. Preconditions

- [ ] Wave A.1's remediation (image fix + hook clear + re-sync) has been applied and
      `operationState.phase` reads `Succeeded` at least once against the **current** (proxy)
      destination. See §4 for why this gates the cutover, not the prep steps.
- [ ] Read access confirmed to both clusters via the Rancher MCP (used throughout this
      investigation) or equivalent `kubectl` contexts.
- [ ] Owner has decided *when* TASK-619's `deployment/argocd/*.yaml` files will be pushed/applied
      — this runbook's cutover step (§4) is written to be a small diff against those files, applied
      as part of that same event, not a standalone change.
- [ ] `argocd-manager-long-lived-token`'s active use today (finding §1.6) has been explained, or at
      minimum not contradicted, before treating it as reusable — if a different, unrelated
      consumer is minting requests against `c-nfhxq`'s direct API with this exact SA, rotating or
      reusing its token could affect that consumer too. Not established either way by this
      read-only pass; flagged for the owner to confirm before Step 3.2.

---

## 3. Preparation steps (safe now, independent of A.1 and TASK-619)

These do not touch `Application/hope-v2-dev` or `AppProject/hope-v2` in any way. They can be
executed at any time, including before A.1 lands.

### Step 3.1 — Confirm (or re-apply, idempotently) the target-cluster RBAC

**Command** (against the `c-nfhxq` context — see the companion file's header for the exact
`kubectl --context` invocation):
```bash
kubectl --context c-nfhxq apply --server-side --force-conflicts \
  -f docs/implementation/TASK-617-Dev-Environment-Correctness-And-GitOps-Recovery/wave-a4-argocd-manager-rbac.yaml
```
**What it does**: declares `ServiceAccount/argocd-manager` (kube-system), `ClusterRole/argocd-manager-role`,
`ClusterRoleBinding/argocd-manager-role-binding`, and `Secret/argocd-manager-long-lived-token` (a
K8s ≥1.24 manual SA-token secret with no `data.token` supplied — Kubernetes' own token controller
populates `data.token`/`data.ca.crt`/`data.namespace` once the Secret exists; nothing in the file
carries a real credential).
**Expected output**: given finding §1.6, this is expected to report `unchanged` (or `configured`
with a no-op diff) for all four objects — not `created`. If any object reports `created`, the
09-infra rule's read-only-inspection assumption was wrong somewhere; stop and re-verify against
live state before proceeding.
**Verify**:
```bash
kubectl --context c-nfhxq get sa,clusterrolebinding,secret -n kube-system \
  -l 'app.kubernetes.io/part-of notin (nothing)' 2>/dev/null; \
kubectl --context c-nfhxq get secret argocd-manager-long-lived-token -n kube-system \
  -o jsonpath='{.data.token}' | base64 -d | cut -c1-20
```
Expect a JWT prefix (`eyJhbGciOi...`), confirming Kubernetes populated the token.
**Undo**: `kubectl --context c-nfhxq delete -f wave-a4-argocd-manager-rbac.yaml` — but see §5
(Rollback) for why this is very unlikely to ever be the right move, since these objects predate
this runbook.

### Step 3.2 — Register the direct API as an Argo CD cluster (new object)

This is the one genuinely new object. Two equivalent ways to create it; pick one.

**Option A — `argocd cluster add` against a kubeconfig context** (simpler, but requires a local
`kubeconfig` with a context pointed at `https://10.10.1.10:6443`, which is not assembled here):
```bash
argocd cluster add <context-name-for-10.10.1.10> --name hope-v2-direct \
  --service-account argocd-manager --system-namespace kube-system \
  --kubeconfig <path-to-kubeconfig-with-that-context>
```
`argocd cluster add` on Argo CD ≥2.4 (we run 3.3.4 — `mcp__argocd__get_version`) creates its own
ServiceAccount/token Secret in the target cluster if they don't exist, and reuses them if they do
— given §1.6, it should detect and reuse the existing `argocd-manager` SA rather than create a
second one, but confirm with `--dry-run` first if available in the installed CLI version.

**Option B — hand-authored `Secret`, matching the existing `hope-v2` proxy secret's shape exactly**
(shown here as the declarative equivalent, in the same `stringData`/`config`-JSON shape already
live for `cluster-rancher.taphuynh.dev-644569324` — see finding §1.4):
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cluster-hope-v2-direct
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: hope-v2-direct
  server: https://10.10.1.10:6443
  config: |
    {
      "bearerToken": "__SUPPLIED_OUT_OF_BAND__",
      "tlsClientConfig": {
        "insecure": false,
        "caData": "__SUPPLIED_OUT_OF_BAND__"
      }
    }
```
**Never put a real token or CA value in this file** — matches the convention already used in
`bootstrap.dev.yaml`'s `repo-creds` Secret (`password: "__SUPPLIED_OUT_OF_BAND__"`). At apply time,
the owner supplies both out-of-band:
```bash
# bearerToken — base64-decode the existing token Secret from Step 3.1
kubectl --context c-nfhxq get secret argocd-manager-long-lived-token -n kube-system \
  -o jsonpath='{.data.token}' | base64 -d
# caData — pass the *already-base64* ca.crt straight through, no re-encode
kubectl --context c-nfhxq get secret argocd-manager-long-lived-token -n kube-system \
  -o jsonpath='{.data.ca\.crt}'
```
`insecure: false` (not `true`) is the deliberate choice here: k3s auto-includes the node's detected
`InternalIP` (`10.10.1.10`, confirmed in finding §1.5) in its self-signed server certificate's SAN
list by default, so `caData` should validate cleanly. **Verify this before committing to
`insecure: false`** — if the k3s install has `--tls-san` restricted or overridden, the direct-IP
connection will TLS-fail and the owner will need `insecure: true` as a documented, deliberate
downgrade, not a silent fallback.
**Expected output**: `secret/cluster-hope-v2-direct created`.
**Verify**:
```bash
argocd cluster list
# expect a new row: SERVER https://10.10.1.10:6443, NAME hope-v2-direct, STATUS "Successful"
```
`STATUS: Successful` here means Argo CD's server process itself can reach and authenticate to
`10.10.1.10:6443` — this is the cheapest possible verification that Steps 3.1–3.2 are wired
correctly, and it produces zero effect on `Application/hope-v2-dev` (that Secret is not yet
referenced by any `Application`/`AppProject`).
**Undo**: `kubectl --context local delete secret cluster-hope-v2-direct -n argocd` (or
`argocd cluster rm https://10.10.1.10:6443` if Option A was used). Safe — nothing references it
until §4.

---

## 4. The cutover — fold into TASK-619, do not patch live objects today

### Why not a standalone patch against today's ad-hoc `Application`/`AppProject`

The ticket README's Wave B table lists `B.3 ⚙ Re-register Argo against the direct API per A.4` as
a step separate from `B.2 ⚙ Push the audited commits`. Read literally, that implies patching
`spec.destination.server` on **today's** hand-created `Application`/`AppProject` (`project:
hope-v2`, finding §1.2–1.3) directly. Three things this runbook found argue against doing that:

1. **The `AppProject` allow-list must move with it.** `AppProject/hope-v2`'s `destinations[]`
   (finding §1.3) only permits the proxy server string. A standalone `Application` patch to
   `https://10.10.1.10:6443` would be rejected at admission unless `AppProject/hope-v2` is patched
   in the same breath — two live objects, two patches, on a project that TASK-619 is about to
   delete and replace with `hope-v2-dev` anyway (per the six-file inventory in
   `deployment/argocd/`).
2. **TASK-619's own unpushed files would silently revert it.** Finding §1.8: the already-authored
   `application-dev.yaml`/`appproject-dev.yaml` still hard-code the Rancher proxy URL. If a
   standalone B.3 patch fixes the *live* ad-hoc objects today, and TASK-619 later applies its files
   as currently written, the apply **replaces** `spec.destination.server` right back to the proxy
   — the fix would be silently undone by the very cutover meant to modernize delivery, and nobody
   watching TASK-619 land would think to check for a regression here.
3. **Two risky transitions instead of one.** A destination-server change is the one step in this
   runbook whose blast radius (§6) is not fully provable from documentation alone. Compounding it
   with an *unrelated*, imminent second transition (the project rename + `prune`/`selfHeal` flip
   TASK-619 owns) makes root-causing any post-change anomaly strictly harder — was it the address
   change, the project boundary change, or the newly-active `prune`? One clean transition, one
   clean verification pass, is preferable to two.

**Recommendation: edit the destination field in the same two already-authored files TASK-619 owns,
before that ticket applies them — do not touch this repo's files to do it (out of scope for A.4;
`hope-v2-deployment` is a separate repo owned by TASK-619), just hand the following two-line diff
to whoever executes the TASK-619 cutover:**

```diff
--- a/deployment/argocd/appproject-dev.yaml
+++ b/deployment/argocd/appproject-dev.yaml
@@ spec.destinations
   destinations:
-    - server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq
+    - server: https://10.10.1.10:6443
       namespace: hope-v2-dev
```
```diff
--- a/deployment/argocd/application-dev.yaml
+++ b/deployment/argocd/application-dev.yaml
@@ spec.destination
   destination:
-    server: https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq
+    server: https://10.10.1.10:6443
     namespace: hope-v2-dev
```

### Ordering answer, explicitly

- **Before TASK-619's apply**: Steps 3.1–3.2 (RBAC confirmation + cluster-secret registration).
  These must exist before the cutover apply, or the very first reconcile against the new
  destination fails with `"cluster ... not found"` / `"destination ... not permitted in project"`.
- **During TASK-619's apply** (same commit, same `kubectl apply --server-side --force-conflicts`
  sequence documented in `bootstrap.dev.yaml`): the destination-address fix, bundled into
  `appproject-dev.yaml`/`application-dev.yaml` as shown above.
- **Not after**: shipping TASK-619's rename first and the destination fix later means living
  through the project-boundary/`prune`/`selfHeal` transition once, then repeating a second
  live-object transition immediately afterward for no benefit — strictly worse than bundling.
- **Gate on A.1, not on TASK-619's timeline**: regardless of when TASK-619 ships, **do not apply
  the destination-bearing files until Wave A.1's fix has produced at least one `Succeeded` sync
  against the current proxy destination.** If the cutover apply is the first sync attempt after
  months of `Error`, and it also happens to change the destination, a continued `Missing`/`Error`
  reading afterward is unattributable — you cannot tell whether the panic is still live, whether
  the new address is unreachable, or whether the AppProject boundary rejected something. Clearing
  A.1 first, on the *old* destination, isolates the address change as the only remaining variable.

---

## 5. Verification (after the cutover ships)

1. **Sync status**:
   ```bash
   argocd app get hope-v2-dev -o json | \
     jq '{sync: .status.sync.status, health: .status.health.status, phase: .status.operationState.phase, server: .spec.destination.server}'
   ```
   Expect `sync: "Synced"`, `health: "Healthy"`, `phase: "Succeeded"`,
   `server: "https://10.10.1.10:6443"`.
2. **Resource-count parity** — the single most important check for §6's orphaning question. Before
   the cutover, capture:
   ```bash
   argocd app get hope-v2-dev -o json | jq '[.status.resources[] | select(.health.status=="Healthy")] | length'
   ```
   This runbook observed **43** (finding §1.2, excluding the two hook Jobs and `hope-ui`) on
   2026-08-08. Immediately after the cutover, re-run the same query against the new destination and
   confirm the count is unchanged (modulo whatever Wave A.1/A.3/B.4 have independently fixed by
   then — cross-reference against those tickets' own state, not a static number).
3. **No duplicate objects on the direct path** — confirms the two destination strings really were
   two paths to one cluster, not two clusters:
   ```bash
   kubectl --context c-nfhxq get deploy,sts,svc -n hope-v2-dev -o json | \
     jq '[.items[].metadata.uid] | length'
   ```
   Compare against the pre-cutover count taken the same way through the Rancher-proxy context. A
   mismatch (more objects after the cutover) would mean Argo created fresh resources instead of
   recognizing the live ones — see §6 for why this is not expected, and what to do if it happens.
4. **Tracking annotation intact**:
   ```bash
   kubectl --context c-nfhxq get deploy hope-api -n hope-v2-dev \
     -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/tracking-id}'
   ```
   Expect the same `hope-v2-dev:apps/Deployment:hope-v2-dev/hope-api`-shaped value both before and
   after — the tracking-id format has no destination-server component (§6), so this should be
   byte-identical across the cutover.
5. **No new pods rolled** (address change alone should not touch running workloads):
   ```bash
   kubectl --context c-nfhxq get pods -n hope-v2-dev \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.startTime}{"\n"}{end}'
   ```
   Compare `startTime` values against a pre-cutover capture; none should be newer than the cutover
   timestamp except pods independently restarted by Wave A.3/B.4/B.6 work.

---

## 6. Risk — does a destination-server change orphan or re-create live resources?

**Short answer: not expected to, in this specific case — but the "specific case" caveat is load
bearing, and the mitigation below is the conservative path if that reasoning is wrong.**

- Argo CD's default resource-tracking mechanism (Argo CD ≥2.x, confirmed still default in the
  installed 3.3.4 via `get_settings`'s `trackingMethod: "annotation"`) identifies a resource it
  manages by the `argocd.argoproj.io/tracking-id` annotation, whose value is
  `<app-name>:<group/kind>:<namespace>/<name>` — **it contains no destination-server component**
  ([Argo CD resource-tracking docs](https://argo-cd.readthedocs.io/en/latest/user-guide/resource_tracking/)).
  When Argo reconciles `hope-v2-dev`, it queries whatever server `spec.destination.server` currently
  names, for resources in `spec.destination.namespace`, and compares what it finds against the
  desired manifests. It does not consult a separate "which server did I last see this app on"
  ledger.
- **This differs from the documented failure mode in
  [argoproj/argo-cd#9172](https://github.com/argoproj/argo-cd/issues/9172)**, which reports that
  changing `destination.name` to point at a genuinely *different* registered cluster leaves the old
  cluster's resources behind (Argo stops looking there, so nothing prunes them, and they become
  true orphans on a cluster Argo no longer reconciles). That is a real, confirmed, currently-open
  Argo CD bug — but it describes moving an `Application` between two *distinct* clusters with two
  *distinct* sets of live objects. **Our case is not that**: `https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq`
  and `https://10.10.1.10:6443` are two network paths to the *same* physical apiserver, on the
  *same* single-node k3s cluster (finding §1.5 — the node's own `Endpoints/kubernetes` object
  reports the literal `10.10.1.10:6443` the proxy forwards to). There is only one set of live
  objects, reachable both ways; changing which path Argo uses does not create a second cluster's
  worth of state to strand.
- **What could not be independently confirmed**: no Argo CD documentation was found that speaks
  directly to "same cluster, two different registered `server` strings" as a named, supported
  scenario — it is not how clusters are normally registered (one canonical URL per cluster), so
  there is no first-party test coverage or explicit statement to cite. The reasoning above is sound
  from first principles (tracking-id has no server component; live-state queries are per-reconcile,
  not cached against the old server string) but is this runbook's own inference, not a quoted
  guarantee.
- **Conservative mitigation, given that gap**:
  1. `automated.prune` is `false` today (finding §1.2 — `automated: {}` defaults both flags off,
     confirmed by the appproject-dev.yaml's own inline comment about this exact footgun). **Do not
     let the cutover apply also flip `prune: true`** (TASK-619's `application-dev.yaml` as
     currently authored sets `prune: true, selfHeal: true` explicitly — see finding §1.8). If the
     cutover and the `prune` flip must ship in the same commit for TASK-619's own reasons, request
     one manual, non-automated `argocd app sync hope-v2-dev --prune=false` as the *first* sync
     against the new destination, inspect the diff Argo reports (§5 step 2–3) with human eyes
     before any prune-capable sync runs, and only then let automated `prune`/`selfHeal` take over.
  2. If §5's resource-count check (step 3) ever shows *more* live objects after the cutover than
     before, stop immediately — do not let a subsequent automated sync run — and follow §7's
     rollback. That signature (extra objects, not missing ones) is the concrete, checkable symptom
     that would falsify the "same cluster, one set of objects" reasoning above.
  3. Because `Application.spec.destination.server` must match an entry in the target
     `AppProject.spec.destinations[]` (finding §1.3) before Argo will even attempt a reconcile
     against it, a typo'd or unreachable direct-API address fails **closed**, as an admission-time
     rejection or a connection error surfaced on the `Application`'s own `status.conditions` — not
     as a silent partial-apply. This bounds the failure mode of a bad address to "nothing happens,
     loudly," not "half the resources move."

---

## 7. Rollback

If `health.status` does not recover to `Healthy` after the cutover, or §6's mitigation trips:

1. **Revert the destination string** — since the change ships as part of TASK-619's own commit
   (§4), this is a `git revert` of that commit in `hope-v2-deployment`, then re-apply
   `appproject-dev.yaml`/`application-dev.yaml` per `bootstrap.dev.yaml`'s documented order (§1.7):
   ```bash
   git revert <cutover-commit-sha>
   kubectl apply --server-side --force-conflicts -f appproject-dev.yaml -n argocd
   kubectl apply --server-side --force-conflicts -f application-dev.yaml -n argocd
   ```
   This restores `spec.destination.server` to `https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq`
   and `AppProject.spec.destinations[].server` to match, in one apply — the exact inverse of §4.
2. **Verify the rollback took**:
   ```bash
   argocd app get hope-v2-dev -o json | jq '.spec.destination.server'
   # expect "https://rancher.taphuynh.dev/k8s/clusters/c-nfhxq"
   ```
3. **Leave the new cluster registration in place** — `Secret/cluster-hope-v2-direct` (§3.2) and the
   target-cluster RBAC (§3.1) are inert once nothing references
   `https://10.10.1.10:6443` as a destination; there is no need to unwind them as part of a
   rollback, and leaving them saves re-doing §3 if the cutover is retried later. Remove them only
   if the owner decides the direct-API path is abandoned entirely, using the `Undo` commands in
   §3.1/§3.2.
4. **Do not re-attempt the cutover on the same revision** — per Argo's own behavior observed in
   Wave A.1 (`wave-a1-argo-sync-panic-diagnosis.md` §5: *"will not retry for [rev]"* once
   `syncPolicy.automated.retry.limit` is exhausted), a second automated attempt against the exact
   same failed commit will not fire on its own. A fresh commit (even a no-op comment change) or a
   manual `argocd app sync hope-v2-dev` is required to try again after diagnosing why the first
   attempt failed.

---

## 8. Summary checklist

- [ ] §3.1 — target-cluster RBAC confirmed present/idempotently re-applied (expected: no-op)
- [ ] §3.2 — `Secret/cluster-hope-v2-direct` created in `argocd` on `local`; `argocd cluster list`
      shows `STATUS: Successful` for `https://10.10.1.10:6443`
- [ ] Wave A.1's fix has produced one `Succeeded` sync against the **current** (proxy) destination
- [ ] TASK-619's `appproject-dev.yaml`/`application-dev.yaml` carry the two-line destination diff
      from §4 before that ticket's cutover apply runs
- [ ] First sync against the new destination is manual, `--prune=false`, and hand-inspected (§6.5.1)
- [ ] §5 verification (sync/health status, resource-count parity, no duplicate objects, tracking-id
      intact, no unexpected pod restarts) all pass
- [ ] If any of the above fails: §7 rollback executed and confirmed
