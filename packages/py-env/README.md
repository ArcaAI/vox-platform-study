# hope-env — shared Python environment loader

One implementation of the monorepo's env-file contract for the six Python services (`stt`, `text`,
`guardrail`, `nlp`, `harness`, `tts`), plus a handful of related boot-time concerns that outgrew
their own justification for a separate package: container-aware CPU allowance, build-identity
reading, and service self-registration/heartbeat.

Before TASK-558 the Python services each carried their own copy of `_load_dotenv_into_environ()`
(four near-identical bodies) or a bare `dotenv.load_dotenv()`. Every copy walked the tree
collecting `.env` only — never `.env.dev`. The TypeScript gateway, meanwhile, reads `.env.dev`
through `loadEnv()`. Editing `.env.dev` therefore reconfigured half the platform and silently did
nothing to the other half.

## Layout

| Path | What it holds |
|---|---|
| `src/hope_env/__init__.py` | `load_env`, `hope_settings_sources`, `find_monorepo_root`, `reload_secrets`, `register_settings_cache`, `resolve_secrets_dir` — the public `__all__` surface |
| `src/hope_env/settings_sources.py` | `hope_settings_sources` — the pydantic-settings source ordering |
| `src/hope_env/_provenance.py` | Tracks which `os.environ` entries came from the env FILE vs the host, so the Vault `secrets_dir` tier can rank correctly against both |
| `src/hope_env/cpu.py` | `resolve_cpu_allowance`, `effective_cpu_quota` — cgroup-aware CPU allowance (v1 and v2) |
| `src/hope_env/build_info.py` | `BuildInfo`, `BuildInfoReader` — reads the Dockerfile-baked build-identity contract, mirroring the TS reader |
| `src/hope_env/service_registration.py` | `start_registration`/`stop_registration` — self-registration + heartbeat client |
| `src/hope_env/placeholders.py` | `PLACEHOLDER_SENTINEL`, `is_placeholder`, `real_secret`, `first_real_secret` — the `CHANGE_ME` unfilled-secret sentinel |
| `tests/` | pytest suite: `test_load_env.py`, `test_settings_sources.py`, `test_cpu.py`, `test_build_info.py`, `test_service_registration.py`, `test_placeholders.py` |

## Commands

```bash
pnpm py-env:test      # conda run -n arcaenv pytest packages/py-env/tests -v --tb=short
```

Also runs as part of the aggregate `pnpm test:py`.

## How it works

### The env-file contract

```
init  >  host env  >  secrets_dir (Vault Agent)  >  <root>/.env.<environment>  >  field default
```

| Rule | Behavior |
|---|---|
| File selection | `NODE_ENV`: `development` = `.env.dev`, `test` = `.env.test`, `staging` = `.env.staging`. Unset/unrecognized -> `development`. |
| Precedence | A key already in `os.environ` is never overwritten — including when its value is the empty string. |
| CI / production | `CI` truthy or `NODE_ENV=production` -> no env file is read, host env only. The Vault `secrets_dir` tier still applies — that is the deployed path. |
| Root discovery | Walk up for the `package.json` named `hope-monorepo`. No fixed parent count, so worktrees and editable installs work; in a container no root is found and nothing is loaded. |
| Legacy `.env` | In `development` only, `.env` is used when `.env.dev` is absent — parity with the TS loader. |

`NODE_ENV` (not a Python-specific alias) is deliberate: one variable must decide which file BOTH
runtimes read, or the split brain reappears under a new name.

```python
from hope_env import hope_settings_sources, load_env


class Settings(BaseSettings):
    settings_customise_sources = hope_settings_sources   # one line, every class


def get_settings() -> Settings:
    load_env()          # once, immediately before building settings
    return Settings()
```

`load_env()` is idempotent — the first call wins, later calls are no-ops.

### The Vault `secrets_dir` tier

A Vault Agent sidecar authenticates with Kubernetes auth, renders secrets into a shared memory
volume, and handles renewal and rotation. The service stays entirely Vault-unaware: it reads files
through pydantic-settings' own `SecretsSettingsSource`. No Vault SDK, no extra dependency, no
in-process auth.

`hope_settings_sources` exists because pydantic-settings' default order is
`init > env > dotenv > file_secret` — the secret file LAST, so a stale dotenv would outrank a
freshly re-rendered Vault file. Reordering the four sources alone is not enough, because
`load_env()` merges the dotenv into `os.environ`: the dotenv values arrive inside `env_settings`,
not `dotenv_settings`, so moving `file_secret_settings` above `dotenv_settings` moves it above
nothing. The env source is therefore split by provenance (`_provenance.py`) — host exports rank
above the Vault tier, env-file values below it.

**File contract — what the k3s manifests must render:**

| Requirement | Value |
|---|---|
| Directory | `/vault/secrets` (override with `HOPE_SECRETS_DIR`) |
| Layout | One file per secret. No `.env`-style file, no JSON, no YAML |
| Filename | Exactly the environment-variable name, including the service's pydantic `env_prefix` |
| File contents | The raw secret value and nothing else. A trailing newline is stripped |
| Volume | Memory-backed (`emptyDir.medium: Memory`) — secrets must never touch disk |
| Permissions | Readable by the service's non-root `hope` user; nothing wider |

```
/vault/secrets/
  JWT_SECRET_KEY               -> Settings(env_prefix="") jwt_secret_key
  GUARDRAIL_SERVICE_TOKEN       -> Settings(env_prefix="GUARDRAIL_") service_token
  AZURE_SPEECH_KEY
  HUGGINGFACE_TOKEN
```

The filename is the full env var name because pydantic applies the class's `env_prefix` when
looking a secret up: a field `service_token` on a class with `env_prefix="GUARDRAIL_"` is read
from the file `GUARDRAIL_SERVICE_TOKEN`. A field declared with an explicit `validation_alias`
bypasses the prefix entirely — that is how the unprefixed, shared `INTERNAL_ACCESS_TOKEN` is read.

**An absent directory is a silent no-op** — no warning, no error. `hope_env` resolves the directory
itself and passes `None` when it is missing, because `SecretsSettingsSource` otherwise emits a
`UserWarning` on every settings construction and raises `SettingsError` if the path is not a
directory.

### Rotation

The agent rewrites the files IN PLACE, so a settings object built once at startup would serve the
pre-rotation value for the life of the process. Five of the six services build a fresh `Settings()`
on every `get_settings()` call and pick up a rotated secret with no extra machinery. `stt` caches
with `@lru_cache`, so it registers its cache: `register_settings_cache(get_settings.cache_clear)`.
`hope_env.reload_secrets()` drops every registered cache; choosing the TRIGGER (a SIGHUP, an admin
endpoint, a bounded TTL) is a deployment decision, deliberately not wired here.

### CPU allowance (`cpu.py`)

`os.cpu_count()` and `nproc` answer "how many CPUs does the NODE have", which is the wrong question
inside a cgroup-quota'd container. Measured on `hope-nlp`: a pod held a 2-CPU quota on a 48-core
node, PyTorch sized its intra-op pool at 48, and the cgroup recorded a 12.7x wall-clock tax.
`resolve_cpu_allowance()`/`effective_cpu_quota()` are the one place the fleet asks the CPU-count
question correctly (cgroup v1 and v2 aware), so a service configuring a thread pool never has to
know which cgroup version its host runs.

### Build identity (`build_info.py`)

Reads the Dockerfile-baked build-identity contract at process boot, uniform with the TypeScript
reader (`packages/applications/src/common/build-info/build-info.service.ts`). Never throws: a
missing, unreadable, or malformed file logs a warning and degrades to a best-effort identity — this
runs on the boot path of PHI-serving services, so version reporting can never become a new startup
dependency. The path is overridable via a constructor argument for tests, not an environment
variable — build identity is immutable artifact data, not configuration.

### Service self-registration (`service_registration.py`)

Every HOPE process registers its baked build identity with the gateway on boot (`POST
/internal/service-releases`, idempotent upsert), then heartbeats every 5 minutes — a repeat call IS
the heartbeat. Registration is best-effort and must NEVER block or fail process boot: every
function swallows every exception, logs a warning, and returns.

### The `CHANGE_ME` placeholder sentinel (`placeholders.py`)

`CHANGE_ME` is what `scripts/env-sync.mts`/`generate-env-file.sh` write for an unfilled secret — it
means "no operator has filled this in," not a value. Because it is a non-empty string, a truthiness
fallback (`self.x.get_secret_value() or legacy.get_secret_value()`) would treat it as a real value.
`is_placeholder`/`real_secret`/`first_real_secret` are the one place that check is made correctly.

### Secrets are `SecretStr`

Every credential-bearing field across the six services is typed `SecretStr`, so it cannot appear in
`repr()`, `model_dump()`, `model_dump_json()`, logs, or tracebacks. Unwrap with
`.get_secret_value()` at the point of use only.

## Gotchas

- `hope_env` merging dotenv values into `os.environ` means pydantic's default source order alone
  cannot rank the Vault tier correctly — `hope_settings_sources` plus the provenance split in
  `_provenance.py` are both required; do not "simplify" one away.
- Reading a Vault secret file by the BARE field name instead of the full prefixed env-var name is a
  silent no-op — the file is never found and the field falls through to the next source.

### Install
A `uv` workspace member (root `pyproject.toml`) and an editable install in the shared conda env
`arcaenv` (`scripts/setup-python-env.sh`). Every service declares it as
`hope-env = { workspace = true }`.

## Related

- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — env loading contract, per-tenant config resolution
- [`09-infrastructure-devops.md`](../../.claude/rules/09-infrastructure-devops.md) — Environment & Secrets Strategy, Release Versioning & Build-Metadata
