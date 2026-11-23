# 06 — Manifest Validation Guide

This document explains how to validate the Kubernetes manifest files in
`arca-deployment-template/` **without needing a running cluster**.

You can run all of these checks on your laptop.

---

## Prerequisites

Install these tools:

```bash
# Kustomize — builds the final YAML from base + overlays
brew install kustomize

# kubeconform — validates YAML against Kubernetes API schemas
brew install kubeconform

# kubectl — for applying to a real cluster (optional at this stage)
brew install kubectl

# Verify
kustomize version
kubeconform -v
kubectl version --client
```

---

## Step 1 — Render the Final Manifests (kustomize build)

This is the most important step. It merges `base/` + the overlay into one
big YAML file that shows exactly what would be deployed.

```bash
cd /Users/apple/repos/VOX/arca-deployment-template

# Render the dev environment
kustomize build deployment/k8s/overlays/dev > /tmp/hope-rendered-dev.yaml

# If the command succeeds with no output to stderr — the YAML is structurally valid
echo "Exit code: $?"   # Should be 0

# View the output (it will be large — ~2000+ lines)
cat /tmp/hope-rendered-dev.yaml | head -100
```

**If `kustomize build` fails**, it means there is a structural error in the
manifests (bad YAML, missing file reference, invalid patch target). The error
message will tell you which file.

Common errors:
```
Error: no matches for Id ~G_v1_ConfigMap|~X|hope-platform-config
→ A patch targets a resource name that doesn't exist in base/

Error: accumulating resources: read /path/to/file.yaml: no such file
→ kustomization.yaml lists a file that doesn't exist
```

---

## Step 2 — Schema Validation (kubeconform)

This validates every resource in the rendered output against the official
Kubernetes API schema:

```bash
# Validate dev overlay
kubeconform \
  -strict \
  -ignore-missing-schemas \
  -summary \
  /tmp/hope-rendered-dev.yaml
```

Expected output:
```
Summary: 109 resources found, 109 valid, 0 invalid, 0 errors, 0 skipped
```

**`-ignore-missing-schemas`** is needed for ArgoCD custom resources (like
`Application`, `AppProject`) which are not in the standard Kubernetes schema.

If you see validation errors, they look like:
```
hope-api (Deployment) - INVALID: ...
```
The error tells you which field is wrong and what the expected format is.

---

## Step 3 — Validate Each Overlay

Run the same steps for staging and prod:

```bash
# Staging
kustomize build deployment/k8s/overlays/staging > /tmp/hope-rendered-staging.yaml
kubeconform -strict -ignore-missing-schemas -summary /tmp/hope-rendered-staging.yaml

# Prod
kustomize build deployment/k8s/overlays/prod > /tmp/hope-rendered-prod.yaml
kubeconform -strict -ignore-missing-schemas -summary /tmp/hope-rendered-prod.yaml
```

---

## Step 4 — Check ConfigMap Key References

The manifests use `configMapKeyRef` to pull specific keys from ConfigMaps.
If a referenced key doesn't exist in the generated ConfigMap, the pod will crash
with `CreateContainerConfigError`.

The deployment repo includes a script to check this:

```bash
cd /Users/apple/repos/VOX/arca-deployment-template

# Run the config-refs validation script
python3 scripts/check-config-refs.py /tmp/hope-rendered-dev.yaml
```

This script finds every `configMapKeyRef` in the rendered output and checks that
the referenced key actually exists in the rendered ConfigMap.

---

## Step 5 — Check Image Tags

Images must use a digest (not `:latest`) in staging and prod.
For dev, the images should use `dev-<sha8>` tags or digests.

```bash
# Check for any ":latest" tags in the rendered output
grep "image:" /tmp/hope-rendered-dev.yaml | grep ":latest"
# Should return nothing (or only acceptable cases)

# Show all image references
grep "image:" /tmp/hope-rendered-dev.yaml
```

If you see `hope-v2/api:latest`, it means the image was not properly pinned
by CI. You need to update the image digest in the overlay:

```bash
# In arca-deployment-template/deployment/k8s/overlays/dev/kustomization.yaml
# Look for the images: section and update it
```

---

## Step 6 — Check Secret Key References

The manifests reference keys in the `hope-secrets` Secret using `secretKeyRef`.
Unlike ConfigMaps, these cannot be validated without the actual cluster (the
Secret is not in Git for security reasons).

To manually validate, compare what the manifests expect vs. what you have in
your `secrets.dev.yaml`:

```bash
# Extract all secretKeyRef key names from rendered output
grep -A1 "secretKeyRef" /tmp/hope-rendered-dev.yaml | grep "key:" | sort -u

# Then compare against what's in your secrets file
grep "^  [A-Z_]*:" arca-deployment-template/deployment/secrets.dev.yaml | sort
```

Every key listed by the first command must appear in the second command's output.

---

## Step 7 — Dry-run Apply Against a Real Cluster

If you have `kubectl` access to the cluster, you can do a dry-run to see what
would change without actually changing anything:

```bash
# Dry-run (no changes made)
kubectl apply -k deployment/k8s/overlays/dev --dry-run=server -n hope-v2-dev
```

`--dry-run=server` sends the manifests to the Kubernetes API server for
validation but doesn't commit anything. It will catch:
- Invalid field values
- Missing namespaces
- Resource quota violations

---

## Step 8 — Run the Full CI Validation Suite Locally

The deployment repo has a `.gitlab-ci.yml` with 8 validation jobs. You can run
the key ones locally:

```bash
cd /Users/apple/repos/VOX/arca-deployment-template

# 1. Build all overlays
kustomize build deployment/k8s/overlays/dev > /dev/null && echo "dev: OK"
kustomize build deployment/k8s/overlays/staging > /dev/null && echo "staging: OK"
kustomize build deployment/k8s/overlays/prod > /dev/null && echo "prod: OK"

# 2. Schema validation
for env in dev staging prod; do
  kustomize build deployment/k8s/overlays/${env} | \
    kubeconform -strict -ignore-missing-schemas -summary && \
    echo "${env}: schemas OK"
done

# 3. Config key references
kustomize build deployment/k8s/overlays/dev | \
  python3 scripts/check-config-refs.py /dev/stdin

# 4. Image hygiene (no :latest)
kustomize build deployment/k8s/overlays/prod | \
  grep "image:" | grep ":latest" && echo "FAIL: latest tag found" || echo "OK: no latest tags"

# 5. Secret scanning (requires gitleaks)
brew install gitleaks
gitleaks detect --no-git --source=. --config=.gitleaks.toml
```

---

## What These Tests Cannot Catch

Even after all validations pass:
- **Missing Secrets** — `secretKeyRef` pointing to a key not in `hope-secrets`
- **Network issues** — services that can't reach each other inside the cluster
- **Storage issues** — MinIO buckets that don't exist, PVC size constraints
- **GPU scheduling** — STT needs NVIDIA GPU resources that may not be available
- **LM Studio connectivity** — SMR/Guardrail need the LLM backend reachable

See `07-known-deployment-errors.md` for all known issues and their fixes.
