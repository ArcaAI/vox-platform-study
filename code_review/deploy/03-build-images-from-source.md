# 03 — Building Docker Images from Source Code

This document explains how to rebuild Docker images for every HOPE service
directly from the `project-hope` source code folder — without needing the
CI pipeline.

---

## Prerequisites

Install these tools on your machine:

```bash
# Docker Desktop (macOS)
# Download from https://www.docker.com/products/docker-desktop/

# Verify Docker works
docker version

# Node.js >= 22 and pnpm (for TypeScript services)
brew install node
npm install -g pnpm@10

# Python 3.11, conda, uv (for Python services)
# Install Miniconda from https://docs.conda.io/en/latest/miniconda.html
conda --version
pip install uv
```

---

## Understanding the Repository Structure

All Dockerfiles live inside the `project-hope/` monorepo:

| Service | Dockerfile location |
|---------|-------------------|
| API Gateway (NestJS) | `project-hope/apps/api/Dockerfile` |
| STT (speech-to-text) | `project-hope/apps/stt/docker/Dockerfile` |
| SMR (summarization) | `project-hope/apps/smr/Dockerfile` |
| Guardrail | `project-hope/apps/guardrail/Dockerfile` (check for this) |
| NLP | `project-hope/apps/nlp/Dockerfile` |
| Harness | `project-hope/apps/harness/Dockerfile` |
| TTS | `project-hope/apps/tts/Dockerfile` |
| Admin Console | `project-hope/apps/admin-console/Dockerfile` |
| Database migrations | `project-hope/packages/database/Dockerfile` |

> **Note for STT**: There is also a `Dockerfile.apple` in `apps/stt/docker/` for
> Apple Silicon Macs (M1/M2/M3 chips). If you are building on an Apple Mac,
> use `Dockerfile.apple` for the STT service.

---

## Building Images

All build commands must be run from the **`project-hope/` directory** (the monorepo
root) because the Dockerfiles reference shared workspace packages.

```bash
cd /Users/apple/repos/VOX/project-hope
```

### Build the API Gateway (NestJS)

```bash
docker build \
  --file apps/api/Dockerfile \
  --tag hope-v2/api:local \
  --build-arg DATABASE_URL="postgresql://user:pass@localhost:5432/hopedb" \
  .
```

> `DATABASE_URL` is required at build time for Prisma to generate the client.
> Use a real (or test) database URL here.

### Build the STT Service (speech-to-text)

```bash
# On Linux / Intel Mac:
docker build \
  --file apps/stt/docker/Dockerfile \
  --tag hope-v2/stt:local \
  .

# On Apple Silicon (M1/M2/M3):
docker build \
  --file apps/stt/docker/Dockerfile.apple \
  --tag hope-v2/stt:local \
  .
```

> The STT service is large — it includes ML model weights. Expect a long build.

### Build SMR (summarization)

```bash
docker build \
  --file apps/smr/Dockerfile \
  --tag hope-v2/smr:local \
  .
```

### Build Guardrail

```bash
docker build \
  --file apps/guardrail/Dockerfile \
  --tag hope-v2/guardrail:local \
  .
```

### Build NLP

```bash
docker build \
  --file apps/nlp/Dockerfile \
  --tag hope-v2/nlp:local \
  .
```

### Build Harness

```bash
docker build \
  --file apps/harness/Dockerfile \
  --tag hope-v2/harness:local \
  .
```

### Build TTS (text-to-speech)

```bash
docker build \
  --file apps/tts/Dockerfile \
  --tag hope-v2/tts:local \
  .
```

### Build Admin Console (Next.js)

```bash
docker build \
  --file apps/admin-console/Dockerfile \
  --tag hope-v2/admin-console:local \
  .
```

### Build Database Migrations image

```bash
docker build \
  --file packages/database/Dockerfile \
  --tag hope-v2/database:local \
  --build-arg DATABASE_URL="postgresql://user:pass@localhost:5432/hopedb" \
  .
```

---

## Build a Shared Python Base Image First (Python services)

The Python services (STT, SMR, Guardrail, NLP, Harness, TTS) share a base image.
If builds fail looking for `hope-python-base`, build it first:

```bash
docker build \
  --file infrastructure/docker/python-base/Dockerfile \
  --tag hope-python-base:latest \
  infrastructure/docker/python-base/
```

---

## Pushing Images to the Registry (optional)

If you want to push your locally built images to the team's registry so ArgoCD
can deploy them:

```bash
# Log in to the registry
docker login registry.taphuynh.dev -u <username> -p <password>

# Tag with registry prefix
docker tag hope-v2/api:local registry.taphuynh.dev/arca/hope-v2/api:dev-manual

# Push
docker push registry.taphuynh.dev/arca/hope-v2/api:dev-manual
```

Then update the image tag in `arca-deployment-template/deployment/k8s/overlays/dev/kustomization.yaml`:
```yaml
images:
- name: hope-v2/api
  newName: registry.taphuynh.dev/arca/hope-v2/api
  newTag: dev-manual  # ← change this
```

---

## Troubleshooting Build Failures

### "pnpm workspace package not found"
The Dockerfiles copy specific `package.json` files from workspace packages.
If a new package was added to the workspace, the Dockerfile needs to be updated
to include it. Look for lines like:
```dockerfile
COPY packages/new-package/package.json ./packages/new-package/
```

### "DATABASE_URL is required"
The API and database Dockerfiles need a real `DATABASE_URL` at build time for
Prisma to generate its client. Pass any valid PostgreSQL connection string — the
database doesn't need to have data, just needs to exist and be reachable.

### "Cannot find module" errors
Run `pnpm install` in `project-hope/` first, then retry the build.

### STT build is very slow
The STT Dockerfile downloads large ML model files. This is expected. First build
can take 20–40 minutes depending on internet speed.

### Apple Silicon errors
If you see `exec format error` or architecture errors on an M1/M2/M3 Mac:
- Use `Dockerfile.apple` for the STT service
- Add `--platform linux/amd64` to other builds if deploying to x86 servers:
  ```bash
  docker build --platform linux/amd64 --file apps/api/Dockerfile ...
  ```

---

## Verify a Built Image Works

After building, run a quick smoke test:

```bash
# Start the container with a minimal config
docker run --rm -it \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  -e REDIS_HOST="host" \
  -e REDIS_PORT="6379" \
  -e REDIS_PASS="" \
  -e JWT_SECRET_KEY="test-secret" \
  -e NODE_ENV="development" \
  -e SECRETS_PROVIDER="env" \
  -p 8868:8868 \
  hope-v2/api:local

# In another terminal, check the health endpoint
curl http://localhost:8868/api/v1/health/startup
```

See `04-laptop-validation-guide.md` for full service-by-service validation.
