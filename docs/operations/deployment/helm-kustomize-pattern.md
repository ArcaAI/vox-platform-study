# Helm/Kustomize Hybrid Pattern — `arca/hope-v2-deployment`

> **Status: pattern documented, not yet built.** This page describes the pattern to follow the
> next time a third-party chart needs vendoring into `arca/hope-v2-deployment` — it is not a
> description of anything currently in the repo. Verified 2026-08-08:
> `grep -rn "helmCharts" deployment/k8s/` in `arca/hope-v2-deployment` returns **zero hits**, and
> there are no vendored charts anywhere in the tree. Nothing here builds GPU Operator, Kyverno,
> Prometheus Operator, or Alloy — that's separate, not-yet-scheduled work. This page exists so
> whoever does that work doesn't have to re-derive the pattern from scratch.

---

## 1. The decision

Phase 0 (a decisions-only gate, no code) evaluated three shapes for the config repo and
picked a hybrid:

| Option | Shape | Verdict |
|---|---|---|
| A | Kustomize only, for everything | Adopted as the base — `arca/hope-v2-deployment` already is this |
| B | A separate Helm-values repo (`hope-deployments`) | Rejected — this is the repo-that-never-existed CI used to claim to write to; see `.claude/rules/09-infrastructure-devops.md` |
| **C** | **Hybrid: Kustomize for HOPE's own 11 in-house services, Helm for vendored third-party charts (GPU Operator, Kyverno, Prometheus Operator, Alloy), composed via Kustomize's `helmCharts:` field** | **Adopted as the end state, layered on top of A** |

"Adopted" here means the *decision* was made and recorded — Phase 0 is explicitly "no code"
(no code). Implementing it (actually vendoring GPU Operator/Kyverno/Prometheus
Operator/Alloy via `helmCharts:`) is future work tracked against Phase 3/6.2,
not something this page builds.

## 2. Why hybrid, not one or the other

- **In-house services stay pure Kustomize.** HOPE's 11 services differ between `dev`/`staging`/
  `prod` by small deltas — an env var, a replica count, an image digest. Kustomize's overlay model
  (base + strategic-merge/JSON6902 patches) is the right fit, and it's what the repo already does
  end to end (`deployment/k8s/base/` + `overlays/{dev,staging,prod}`).
- **Third-party infrastructure charts get vendored as Helm, not hand-copied as raw manifests.**
  GPU Operator, Kyverno, and Prometheus Operator are large, actively-maintained upstream projects
  distributed as Helm charts with their own CRDs and versioning. Re-authoring them as static YAML
  means manually tracking upstream changes forever; vendoring the chart and pinning its version in
  one `helmCharts:` entry keeps upgrades to a version-string bump.
- **One render pipeline, not two.** `kustomize build --enable-helm` inflates the vendored
  `helmCharts:` entries and merges them with the in-house Kustomize tree in a single pass — CI
  runs one command, not a Helm pipeline and a Kustomize pipeline that have to be kept in sync by
  hand.

## 3. What it looks like

A `kustomization.yaml` that vendors a chart declares it with `helmCharts:` alongside (or instead
of) `resources:`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

helmCharts:
  - name: gpu-operator
    repo: https://helm.ngc.nvidia.com/nvidia
    version: <pinned-chart-version>
    releaseName: gpu-operator
    namespace: gpu-operator
    valuesFile: values-gpu-operator.yaml   # local file, checked into this repo
```

Notes for whoever implements this:

- **Pin `version:` explicitly** — the same "no `latest`, no floating tags" discipline this repo
  already applies to container images (`.claude/rules/09-infrastructure-devops.md` §Dockerfiles &
  Images) applies to vendored chart versions too. An unpinned chart is a supply-chain surface the
  deployment repo's own CI (gitleaks, image-hygiene, schema checks —
  `hope-v2-deployment/.gitlab-ci.yml:33-176`, five blocking jobs: `render`, `schemas`,
  `config-refs`, `image-hygiene`, `secrets`) does not currently check for.
- **Keep `valuesFile:` local and reviewed**, not inlined as a giant `values:` block in the
  kustomization — chart values for GPU Operator/Kyverno/Prometheus Operator run to hundreds of
  lines; a separate file keeps diffs reviewable.
- **Rendering requires `--enable-helm`** (and a `helm` binary on the CI runner/local machine) —
  plain `kustomize build` silently ignores `helmCharts:` entries without that flag. Whoever wires
  this into the deployment repo's CI needs to update the existing `render` job
  (`hope-v2-deployment/.gitlab-ci.yml`) to pass it, and the acceptance bar for this
  work is exactly that: *"`kustomize build --enable-helm` renders the full stack from one entry
  point"*.
- **Where the vendored charts live in the tree is not yet decided.** This repo's existing layout
  is `deployment/k8s/{base,overlays}/`; a vendored-chart kustomization needs its own home (a
  sibling directory, or folded into `base/` — precedent to be set by whoever builds this, not
  invented here).

## 4. What this replaces

Today, cluster-scoped infrastructure (GPU Operator, and anything else with cluster-wide CRDs) is
either hand-installed outside GitOps entirely, or deliberately excluded from
`base/kustomization.yaml` because it targets a different namespace (`gpu-operator`) than the app's
Argo `Application` manages. That exclusion is exactly the kind of gap `helmCharts:` vendoring is
meant to close: a chart-vendored GPU Operator would be a tracked, versioned, GitOps-managed
resource instead of a manual `kubectl apply` that nothing forces to happen in order (the same
sequencing trap that exists for the current, un-vendored `gpu-time-slicing.yaml`).

## Related

- [`README.md`](./README.md) — the deploy/rollback/k3s-upgrade runbook this pattern doc is a
  companion to

---

## Change History

| Date | Change | Author |
|---|---|---|
| 2026-08-08 | Initial version — documents the adopted Helm/Kustomize hybrid pattern per Phase 0 Option C. Confirmed zero `helmCharts:` usage exists anywhere in `arca/hope-v2-deployment` today; this is a forward-looking pattern doc, not current-state documentation. | Claude |
