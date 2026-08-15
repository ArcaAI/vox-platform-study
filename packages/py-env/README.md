# `hope-env` — shared Python environment loader

One implementation of the monorepo's env-file contract for the six Python
services (`stt`, `smr`, `guardrail`, `nlp`, `harness`, `tts`).

## Why it exists

Before TASK-558 the Python services each carried their own copy of
`_load_dotenv_into_environ()` (four near-identical bodies) or a bare
`dotenv.load_dotenv()`. Every copy walked the tree collecting **`.env` only** —
never `.env.dev`. The TypeScript gateway, meanwhile, reads `.env.dev` through
`loadEnv()`. Editing `.env.dev` therefore reconfigured half the platform and
silently did nothing to the other half.

## Contract

```
init  >  host env  >  secrets_dir (Vault Agent)  >  <root>/.env.<environment>  >  field default
```

| Rule            | Behaviour                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File selection  | `NODE_ENV` → `development` = `.env.dev`, `test` = `.env.test`, `staging` = `.env.staging`. Unset/unrecognised → `development`.                                               |
| Precedence      | A key already in `os.environ` is never overwritten — including when its value is the empty string.                                                                           |
| CI / production | `CI` truthy or `NODE_ENV=production` → **no env file is read**, host env only. The Vault `secrets_dir` tier still applies — that is the deployed path.                       |
| Root discovery  | Walk up for the `package.json` named `hope-monorepo`. No fixed parent count, so worktrees and editable installs work; in a container no root is found and nothing is loaded. |
| Legacy `.env`   | In `development` only, `.env` is used when `.env.dev` is absent — parity with the TS loader. Retired together with the `.env` file itself.                                   |

`NODE_ENV` (not a Python-specific alias) is deliberate: one variable must decide
which file _both_ runtimes read, or the split brain reappears under a new name.

## Usage

```python
from hope_env import hope_settings_sources, load_env


class Settings(BaseSettings):
    settings_customise_sources = hope_settings_sources   # one line, every class


def get_settings() -> Settings:
    load_env()          # once, immediately before building settings
    return Settings()
```

`load_env()` is idempotent — the first call wins, later calls are no-ops.

## The Vault `secrets_dir` tier

A [Vault Agent](https://developer.hashicorp.com/vault/docs/platform/k8s/injector)
sidecar authenticates with Kubernetes auth, renders secrets into a shared memory
volume, and handles renewal and rotation. The service stays **entirely
Vault-unaware**: it reads files, through pydantic-settings' own
`SecretsSettingsSource`. No Vault SDK, no extra dependency, no in-process auth.

`hope_settings_sources` exists because pydantic-settings' default order is
`init > env > dotenv > file_secret` — the secret file **last**, so a stale dotenv
would outrank a freshly re-rendered Vault file.

> Reordering the four sources is not by itself enough here, because `load_env()`
> merges the dotenv into `os.environ`: the dotenv values arrive inside
> `env_settings`, not `dotenv_settings`, so moving `file_secret_settings` above
> `dotenv_settings` moves it above nothing. The env source is therefore **split by
> provenance** — host exports rank above the Vault tier, env-file values below it.
> Pinned by `tests/test_settings_sources.py::test_default_pydantic_order_loses_to_the_dotenv`.

### File contract — what the k3s manifests must render

**This is the interface. Lane K's Vault Agent annotations must match it exactly.**

| Requirement   | Value                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| Directory     | `/vault/secrets` (override with `HOPE_SECRETS_DIR`)                                       |
| Layout        | **One file per secret.** No `.env`-style file of `KEY=VALUE` lines, no JSON, no YAML.     |
| Filename      | **Exactly the environment-variable name**, including the service's pydantic `env_prefix`. |
| File contents | The raw secret value and nothing else. A trailing newline is stripped.                    |
| Volume        | **Memory-backed** (`emptyDir.medium: Memory`) — secrets must never touch disk.            |
| Permissions   | Readable by the service's non-root `hope` user; nothing wider.                            |

```
/vault/secrets/
├── JWT_SECRET_KEY            # -> Settings(env_prefix="")     jwt_secret_key
├── TEXT_SERVICE_TOKEN         # -> Settings(env_prefix="TEXT_") service_token
├── GUARDRAIL_SERVICE_TOKEN
├── AZURE_SPEECH_KEY
└── HUGGINGFACE_TOKEN
```

The filename is the full env var name because pydantic applies the class's
`env_prefix` when looking a secret up: a field `service_token` on a class with
`env_prefix="TEXT_"` is read from the file `TEXT_SERVICE_TOKEN`. A file named
`SERVICE_TOKEN` would be ignored. Both directions are pinned by tests.

**An absent directory is a silent no-op** — no warning, no error. That is the
path every developer takes: `/vault/secrets` does not exist locally, so the
`.env.<NODE_ENV>` tier supplies everything and nothing changes. (`hope_env`
resolves the directory itself and passes `None` when it is missing, because
`SecretsSettingsSource` otherwise emits `UserWarning: directory "…" does not
exist` on every settings construction and raises `SettingsError` if the path is
not a directory.)

### Rotation

The agent rewrites the files **in place**, so a settings object built once at
startup would serve the pre-rotation value for the life of the process.

Five of the six services build a fresh `Settings()` on every `get_settings()`
call and therefore pick up a rotated secret with no extra machinery — a property
worth preserving. `stt` caches with `@lru_cache`, so it registers its cache:

```python
register_settings_cache(get_settings.cache_clear)   # apps/stt/…/config/settings.py
```

`hope_env.reload_secrets()` drops every registered cache. Choosing the _trigger_
(a SIGHUP from the agent's `command`, an admin endpoint, or a bounded TTL) is a
deployment decision and deliberately not wired here — this package exposes the
capability only.

### Secrets are `SecretStr`

Every credential-bearing field across the six services is typed `SecretStr`, so
it cannot appear in `repr()`, `model_dump()`, `model_dump_json()`, logs or
tracebacks. Unwrap with `.get_secret_value()` at the point of use only.

## Install

A `uv` workspace member (root `pyproject.toml`) and an editable install in the
shared conda env `arcaenv` (`scripts/setup-python-env.sh`). Every service
declares it as `hope-env = { workspace = true }`.

## Tests

```bash
pnpm py-env:test      # pytest packages/py-env/tests
```
