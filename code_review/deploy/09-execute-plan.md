# 09 — Execute Plan: Build All HOPE Docker Images & Validate

## Environment
- **Platform:** macOS Apple Silicon (arm64), Docker Desktop 4.73.0, Docker Compose v5.1.3
- **Working directory:** `/Users/apple/repos/VOX/project-hope`

---

## Phase 0: Prerequisites & Environment Setup

### Step 0.1 — Install pnpm
```bash
npm install -g pnpm@10.31.0
```

### Step 0.2 — Create `.env.dev` with auto-filled dummy values
```bash
cp .env.sample .env.dev
sed -i '' 's/CHANGE_ME/dev-safe-placeholder/g' .env.dev
sed -i '' 's/SECRETS_PROVIDER=vault/SECRETS_PROVIDER=env/' .env.dev
```

### Step 0.3 — Create `infrastructure/docker/.env`
```bash
cp .env.dev infrastructure/docker/.env
```

### Step 0.4 — Start backing infrastructure
```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

### Step 0.5 — Run database migrations
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hope" \
  pnpm --filter @arcaai/database exec prisma migrate deploy
```

---

## Phase 1: Build Shared Python Base Image
```bash
docker build -f infrastructure/docker/python-base/Dockerfile -t hope-python-base:latest infrastructure/docker/python-base/
```

---

## Phase 2: Build Node.js Services

| # | Command |
|---|---------|
| 2.1 | `docker build -f apps/api/Dockerfile --target production -t hope-v2/api:local --build-arg DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hope" .` |
| 2.2 | `docker build -f apps/admin-console/Dockerfile -t hope-v2/admin-console:local .` |
| 2.3 | `docker build -f packages/database/Dockerfile -t hope-v2/database:local --build-arg DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hope" .` |

---

## Phase 3: Build Python Services

| # | Image | Dockerfile | Target |
|---|-------|-----------|--------|
| 3.1 | hope-v2/stt:local | `apps/stt/docker/Dockerfile.apple` | `ml-runtime` |
| 3.2 | hope-v2/smr:local | `apps/smr/Dockerfile` | `production` |
| 3.3 | hope-v2/guardrail:local | `apps/guardrail/Dockerfile` | `production` |
| 3.4 | hope-v2/nlp:local | `apps/nlp/Dockerfile` | `production` |
| 3.5 | hope-v2/tts:local | `apps/tts/Dockerfile` | `production` |
| 3.6 | hope-v2/harness:local | `apps/harness/Dockerfile` | `production` |

---

## Phase 4: Validate Health Checks

Run each service with `--network host` + env overrides, curl health endpoint.

---

## Phase 5: Batch Health Check
```bash
for port_path in "8868:/api/v1/health/startup" "8861:/health" "8862:/api/v1/health/ready" "8863:/api/health/live" "8864:/api/v1/health" "8865:/api/v1/health/live" "8866:/api/v1/health/live"; do
  port="${port_path%%:*}"; path="${port_path##*:}"
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}${path}" 2>/dev/null)
  echo "Port $port -> HTTP $status"
done
```
