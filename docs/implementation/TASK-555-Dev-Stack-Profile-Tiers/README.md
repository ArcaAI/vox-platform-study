# TASK-555 — Dev Stack Profile Tiers (core+rag / -o / -e)

| | |
|---|---|
| **Status** | Completed |
| **Type** | infrastructure |
| **Created** | 2026-07-25 |
| **Depends on** | TASK-346 (dev-infra / dev-stack), TASK-330 (rag reranker), TASK-386/397 (observability) |

## Requirement Analysis

Local entry points must bring up a complete Docker tier without hidden opt-ins:

| Command | Docker profiles | Starts apps? |
|---|---|---|
| `pnpm dev:setup` / `pnpm dev:stack` | core + `vault` + `temporal` + `rag` | setup=no / stack=yes |
| `pnpm dev:setup-o` / `pnpm dev:stack-o` | base + `prometheus` (Prometheus + Grafana) | setup=no / stack=yes |
| `pnpm dev:setup-e` / `pnpm dev:stack-e` | base + `inference` (vLLM, llama.cpp, TEI embed) | setup=no / stack=yes |

`dev:stack*` must ensure Docker infra is up (idempotent) before spawning app processes.

Out of scope: auto-flipping `SMR_V2_VLLM_ENABLED` in `.env.dev`; HA/auth-hardening of Compose Grafana (dev convenience auth stays); replacing LM Studio/Ollama as the default local LLM path.

## Current State Evaluation

- `dev-infra.sh` defaults to `vault` + `temporal` only; `rag` requires `--rag`
- `dev:setup` calls `dev-infra.sh up` with no flags → no reranker
- `dev:stack` does not start Docker infra at all
- Observability via separate `infra:observability:up` (diverges from `dev-infra.sh`)
- Inference gated behind compose `inference` profile with no pnpm alias

## Implementation Plan

1. Extend `dev-infra.sh`: default `vault+temporal+rag`; `-o`/`--observability`; `-e`/`--inference`; full-profile `down`/`status`/`logs`; arm64 TEI image defaults; NVIDIA warn on `-e`
2. Wire `dev-setup.sh` / `dev-stack.sh` flag passthrough; stack ensures infra up
3. Add `package.json` aliases; point `infra:observability:up` at `dev-infra.sh up -o`
4. Update docs/rules/compose comments

## Implementation Summary

Base tier now includes `rag` (`hope-reranker` :8870). `-o` / `-e` tiers and matching `dev:setup-*` / `dev:stack-*` aliases land in `package.json`. `dev:stack` ensures Docker infra is up before spawning apps.

### Files changed

| File | Change |
|---|---|
| `scripts/dev-infra.sh` | Default +rag; `-o`/`-e`; ignore pnpm `--`; full-profile down/status/logs; arm64 TEI auto-image; `-e` NVIDIA warn |
| `scripts/dev-setup.sh` | Flag passthrough; tier label in step banner |
| `scripts/dev-stack.sh` | Ensure infra up first; `-o`/`-e` flags |
| `package.json` | `dev:setup-o/e`, `dev:stack-o/e`; `infra:observability:up` → `dev-infra.sh up --observability` |
| `docs/development-guide.md` | Tier docs |
| `scripts/README.md` | Script table updated |
| `.cursor/rules/09-infrastructure-devops.mdc` / `.claude/rules/09-infrastructure-devops.md` | Command table + profiles |
| `docs/architecture/overview.md` | Entry points + profile tiers |
| `infrastructure/docker/docker-compose.dev.yml` | Comment updates for default rag / -o / -e |
| `docs/implementation/TASK-555-…/README.md` | This ticket |

### Notes

- Apple Silicon: HF docs advertise `cpu-arm64-1.9`, but GHCR currently only publishes `cpu-arm64-latest` (linux/arm64). `dev-infra.sh` auto-selects that when unset.
- Local Grafana keeps `admin`/`admin` + anonymous Viewer (dev convenience). Production observability is not this Compose stack.
- `infra:observability:down` still stops only prometheus/grafana (does not tear down the whole stack).

### Verification evidence

```text
$ ./scripts/dev-infra.sh up --print
... --profile vault --profile temporal --profile rag ... up -d

$ ./scripts/dev-infra.sh up -o --print
... --profile vault --profile temporal --profile rag --profile prometheus ... up -d

$ ./scripts/dev-infra.sh up -e --print
... --profile vault --profile temporal --profile rag --profile inference ... up -d

$ ./scripts/dev-infra.sh down --print
... --profile vault --profile temporal --profile rag --profile prometheus --profile inference ... down

$ pnpm infra:up
# hope-reranker created (cpu-arm64-latest on arm64 host)

$ curl -s -o /dev/null -w '%{http_code}' http://localhost:8870/health
200

$ pnpm infra:up -- -o
# hope-prometheus healthy, hope-grafana up
$ curl … :9090/-/healthy → 200 ; :3001/api/health → 200

$ pnpm run | rg 'dev:(setup|stack)'
  dev:stack / dev:stack-o / dev:stack-e
  dev:setup / dev:setup-o / dev:setup-e
```

## Change History

| Date | Change |
|---|---|
| 2026-07-25 | Ticket opened; plan approved |
| 2026-07-25 | Implemented tiers; arm64 image → `cpu-arm64-latest`; ignore pnpm `--`; verified live base + `-o` |
| 2026-07-25 | `infra:down` tears down both compose projects (`hope-infra-dev` + `hope-infra`) with all profiles + `--remove-orphans`; fails if leftovers remain |
