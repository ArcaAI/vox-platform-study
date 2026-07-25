# TASK-028: Remove STT V1 Service — Detailed Planning

## Execution Order

Phases must be executed in the order below. Within each phase, tasks can be run in parallel where noted.

---

## Phase 1: Delete STT v1 Directory

**Priority: Highest** — This is the core action.

### Task 1.1 — Delete `apps/stt/`

```
rm -rf apps/stt/
```

**Files removed** (~40+ files):
- `apps/stt/README.md`
- `apps/stt/pyproject.toml`
- `apps/stt/uv.lock`
- `apps/stt/Dockerfile`
- `apps/stt/.env`, `.env.dev.example`, `.env.production.example`, `env.dev.example`
- `apps/stt/src/` (entire source tree)
- `apps/stt/docs/` (10 documentation files)
- `apps/stt/.venv/` (virtual environment)

**Verification**: `ls apps/stt` should return "No such file or directory".

---

## Phase 2: Update CI/CD Pipelines

**Priority: High** — Broken pipelines block the team.

### Task 2.1 — Remove `build-stt` job from GitLab CI

**File**: `.gitlab-ci.yml`
**Action**: Delete lines 87–111 (the entire `build-stt:` job block).

**Before** (lines 87–111):
```yaml
build-stt:
  stage: build
  tags: [4bits-runner]
  variables:
    SERVICE: "stt"
    CONTEXT: "apps/stt"
    DOCKERFILE: "apps/stt/Dockerfile"
  before_script: *docker_before
  script:
    - *build_push_fn
  rules:
    - if: '$CI_COMMIT_BRANCH == "main" && $FORCE_REBUILD == "true"'
      when: on_success
    - if: '$CI_COMMIT_BRANCH == "main"'
      changes:
        - apps/stt/**/*
        - apps/stt/Dockerfile
        - apps/stt/pyproject.toml
        - apps/stt/uv.lock
  retry:
    max: 1
    when:
      - runner_system_failure
      - stuck_or_timeout_failure
      - scheduler_failure
```

**After**: Block removed entirely.

---

### Task 2.2 — Update GitHub Actions: `test-unit.yml`

**File**: `.github/workflows/test-unit.yml`

**Change A** — Remove `stt` from default python-services (line 38):
```yaml
# Before
default: 'smr,stt,stt,tts,nlp'
# After
default: 'smr,stt,tts,nlp'
```

**Change B** — Remove `apps/stt/**/*.py` from PR paths (line 50):
```yaml
# Remove this line:
      - 'apps/stt/**/*.py'
```

**Change C** — Remove `apps/stt/**/*.py` from push paths (line 76):
```yaml
# Remove this line:
      - 'apps/stt/**/*.py'
```

---

### Task 2.3 — Update GitHub Actions: `test-integration.yml`

**File**: `.github/workflows/test-integration.yml`

**Change A** — Remove `apps/stt/**/*.py` from PR paths (line 60):
```yaml
# Remove this line:
      - 'apps/stt/**/*.py'
```

**Change B** — Remove `apps/stt/**/*.py` from push paths (line 85):
```yaml
# Remove this line:
      - 'apps/stt/**/*.py'
```

---

### Task 2.4 — Update GitHub Actions: `ci.yml`

**File**: `.github/workflows/ci.yml`

**Change** — Remove `apps/stt/**/*.py` from python filter (line 81):
```yaml
# Remove this line:
              - 'apps/stt/**/*.py'
```

---

### Task 2.5 — Update GitHub Actions: `lint-format.yml`

**File**: `.github/workflows/lint-format.yml`

**Change** — Remove `stt` from matrix service list (line 110):
```yaml
# Before
        service: [smr, stt, tts, nlp]
# After
        service: [smr, tts, nlp]
```

---

### Task 2.6 — Update GitHub Actions: `setup-test-env/action.yml`

**File**: `.github/actions/setup-test-env/action.yml`

**Change** — Remove STT v1 env vars (lines 145–146):
```yaml
# Remove these lines:
        echo "STT_PORT=5003" >> $GITHUB_ENV
        echo "STT_URL=http://localhost:5003" >> $GITHUB_ENV
```

---

## Phase 3: Update Configuration Files

**Priority: High** — Prevents confusion when running the project locally.

### Task 3.1 — Clean STT v1 section from `.env.dev`

**File**: `.env.dev`

**Action**: Remove the STT v1 block (lines 111–119). Keep Azure Speech and STT variables.

**Before** (lines 111–128):
```env
# =============================================================================
# STT SERVICE (apps/stt) - Speech-to-Text
# =============================================================================
STT_HOST=0.0.0.0
STT_PORT=5003
STT_URL=http://localhost:5003
STT_WS_URL=ws://localhost:5003/ws/stt
STT_PROVIDER=azure

# Azure Speech Service
AZURE_SPEECH_KEY=<CHANGE_ME>-your-azure-speech-key
AZURE_SPEECH_REGION=eastus

# STT service URL (apps/stt)
STT_URL=http://localhost:8001

# STT-specific MinIO bucket
STT_MINIO_BUCKET=recordings
```

**After**:
```env
# =============================================================================
# STT SERVICE (apps/stt) - Speech-to-Text V2
# =============================================================================
# Azure Speech Service (used by STT)
AZURE_SPEECH_KEY=<CHANGE_ME>-your-azure-speech-key
AZURE_SPEECH_REGION=eastus

# STT service URL (apps/stt)
STT_URL=http://localhost:8001

# STT-specific MinIO bucket
STT_MINIO_BUCKET=recordings
```

---

### Task 3.2 — Clean STT v1 section from `.env.example`

**File**: `.env.example`

**Action**: Remove the STT v1 block (lines 115–129). Keep Azure Speech and STT variables.

**Before** (lines 115–133):
```env
# =============================================================================
# STT SERVICE (apps/stt) - Speech-to-Text (Legacy V1)
# =============================================================================
STT_HOST=0.0.0.0
STT_PORT=5003
STT_URL=http://localhost:5003
STT_WS_URL=ws://localhost:5003/ws/stt
STT_PROVIDER=azure

# Azure Speech Service (shared with STT)
AZURE_SPEECH_KEY=<CHANGE_ME>-your-azure-speech-key
AZURE_SPEECH_REGION=eastus

# STT-specific MinIO bucket
STT_MINIO_BUCKET=recordings

# =============================================================================
# STT SERVICE (apps/stt) - Speech-to-Text V2
```

**After**:
```env
# =============================================================================
# STT SERVICE (apps/stt) - Speech-to-Text V2
```

(The STT section header replaces the v1 section, and the Azure keys move under v2.)

---

### Task 3.3 — Remove STT v1 from PM2 ecosystem config

**File**: `ecosystem.config.js`

**Action**: Remove the STT v1 app entry (lines 22–31).

**Before** (lines 22–31):
```javascript
    {
      name: 'stt',
      cwd: './apps/stt',
      script: 'python3 src/main.py',
      interpreter: './apps/tts/.venv/bin/python',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
    }
```

**After**: Entry removed. Only `api` and `tts` remain.

---

## Phase 4: Update Infrastructure Files

**Priority: Medium** — Docker Compose won't break but references will be stale.

### Task 4.1 — Remove vault-init-stt from `docker-compose.dev.yml`

**File**: `infrastructure/docker/docker-compose.dev.yml`

**Action**: Remove the vault-init-stt volume mount (line 82) and command (line 83).

This needs careful review — the `vault-init` service may serve other purposes. If the entire `vault-init` service block is only for STT v1, remove the whole block. If it also handles other secrets, only remove the STT-specific lines.

**Lines to remove (from vault-init service)**:
```yaml
      - ./scripts/vault-init-stt.sh:/scripts/vault-init-stt.sh:ro
    command: /scripts/vault-init-stt.sh
```

**Decision required**: If the `vault-init` service has no other purpose, remove the entire service block (lines 62–83). If it has other responsibilities, only remove the STT-specific mount and command.

---

### Task 4.2 — Delete vault init script

**File**: `infrastructure/docker/scripts/vault-init-stt.sh`

**Action**: Delete the file entirely.

---

## Phase 5: Update Documentation

**Priority: Medium** — Won't break anything but keeps docs accurate.

All tasks in this phase can be executed in parallel.

### Task 5.1 — Update root `README.md`

**File**: `README.md` (line 14)

**Change**:
```markdown
# Before
stt/          Legacy STT service (deprecated)
# After - remove the line entirely or replace with:
stt/       Speech-to-Text service
```

---

### Task 5.2 — Update `docs/project-structure.md`

**File**: `docs/project-structure.md`

**Action**: Remove the `### STT Service (apps/stt/)` section. Ensure the STT section remains.

---

### Task 5.3 — Update `docs/ENVIRONMENT_VARIABLES.md`

**File**: `docs/ENVIRONMENT_VARIABLES.md`

**Action**:
- Remove `cd apps/stt && python -m stt.main` command (line 53)
- Remove `### STT Service (apps/stt)` section (line 179)

---

### Task 5.4 — Update `docs/project-brief.md`

**File**: `docs/project-brief.md`

**Action**: Remove references to `apps/stt/docs/` paths (lines 51–54). Replace with `apps/stt/` equivalents if they exist.

---

### Task 5.5 — Update `docs/README.md`

**File**: `docs/README.md`

**Action**: Remove the link `**[STT Service Documentation](../apps/stt/README.md)**` (line 49). Replace with a link to `apps/stt/README.md`.

---

### Task 5.6 — Update `docs/CONSULTATION_WORKFLOW.md`

**File**: `docs/CONSULTATION_WORKFLOW.md`

**Action**: Update reference at line 1050 from `apps/stt/` to `apps/stt/`.

---

### Task 5.7 — Update `docs/QUALITY_CONTROL.md`

**File**: `docs/QUALITY_CONTROL.md`

**Action**: Change `apps/stt/**/*.py` to `apps/stt/**/*.py` at line 687.

---

### Task 5.8 — Update `docs/immediate-next-steps.md`

**File**: `docs/immediate-next-steps.md`

**Action**: Remove or update `# Optimize apps/stt/src/stt/core/` reference at line 91.

---

### Task 5.9 — Update knowledge base API docs

**Files**:
- `knowledge/api/configuration.md` (line 43) — Remove STT v1 URL row from table
- `knowledge/api/api-reference.md` (line 347) — Remove `## STT Proxy (v1)` section
- `knowledge/api/README.md` (line 89) — Remove STT v1 SttModule row or update to reference v2

---

### Task 5.10 — Update `knowledge/architecture/infrastructure.md`

**File**: `knowledge/architecture/infrastructure.md`

**Action**: Change `apps/stt/**/*.py` to `apps/stt/**/*.py` at line 143.

---

### Task 5.11 — Update `apps/api/README.md`

**File**: `apps/api/README.md`

**Action**: Change `├── stt/                  # STT v1 proxy` reference at line 361.

---

## Phase 6: Update Cursor Rules

**Priority: Medium** — Keeps AI assistance accurate.

### Task 6.1 — Delete STT v1 Cursor rule

**File**: `.cursor/rules/04-app-stt.mdc`

**Action**: Delete the entire file. This rule is exclusively for `apps/stt/` (v1).

---

### Task 6.2 — Update Python services Cursor rule

**File**: `.cursor/rules/09-python-services.mdc`

**Action**: Remove all `apps/stt/` references from:
- The `globs:` header (line 3): Remove `apps/stt/**/*.py,`
- The overview list (line 11): Remove `- **STT** (Speech-to-Text): \`apps/stt/\``
- Any remaining references in the file body

---

### Task 6.3 — Update documentation Cursor rule

**File**: `.cursor/rules/01-documentation.mdc`

**Action**: Remove line 138: `- STT service: \`apps/stt/README.md\` and \`apps/stt/docs/\``

---

### Task 6.4 — Update workflow Cursor rule

**File**: `.cursor/rules/00-workflow.mdc`

**Action**: Remove `apps/stt/` from the location references (line 62).

---

### Task 6.5 — Update Cursor rules README

**File**: `.cursor/rules/README.md`

**Action**: Remove `apps/stt/**/*.py` glob pattern references.

---

## Phase 7: Clean Up Miscellaneous References

**Priority: Low** — Minor cleanup.

### Task 7.1 — Update WebSocket client comment

**File**: `packages/stt/src/websocket/WebSocketClient.ts`

**Action**: Update the comment at line 5 that references `apps/stt/src/stt/api/handlers/websocket.py`. Change to reference the stt equivalent path if applicable, or remove the comment.

---

## Verification Checklist

After all phases are complete, verify:

1. **Directory deleted**: `apps/stt/` no longer exists
2. **No broken CI/CD**: Run `grep -r "apps/stt/" .github/ .gitlab-ci.yml` — should return zero v1 results (only `apps/stt/` hits)
3. **No broken env configs**: `grep -n "STT_HOST\|STT_PORT=5003\|STT_URL=http://localhost:5003\|STT_WS_URL\|STT_PROVIDER" .env.dev .env.example` — should return zero results
4. **No broken PM2**: `grep "apps/stt" ecosystem.config.js` — should return zero results (no v1 references)
5. **No orphaned docs**: `grep -r "apps/stt/" docs/ knowledge/ --include="*.md"` — should return zero v1 results
6. **stt untouched**: `git diff apps/stt/` — should show zero changes
7. **Cursor rules clean**: `grep -r "apps/stt/" .cursor/rules/` — should return zero v1 results

---

## Estimated Effort

| Phase | Tasks | Estimated Time |
|-------|-------|----------------|
| Phase 1 — Delete directory | 1 | 1 minute |
| Phase 2 — CI/CD pipelines | 6 | 10 minutes |
| Phase 3 — Config files | 3 | 5 minutes |
| Phase 4 — Infrastructure | 2 | 5 minutes |
| Phase 5 — Documentation | 11 | 15 minutes |
| Phase 6 — Cursor rules | 5 | 5 minutes |
| Phase 7 — Miscellaneous | 1 | 2 minutes |
| **Total** | **29 tasks** | **~45 minutes** |
