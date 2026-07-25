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
host env  >  <monorepo-root>/.env.<environment>  >  pydantic field default
```

| Rule | Behaviour |
|---|---|
| File selection | `NODE_ENV` → `development` = `.env.dev`, `test` = `.env.test`, `staging` = `.env.staging`. Unset/unrecognised → `development`. |
| Precedence | A key already in `os.environ` is never overwritten — including when its value is the empty string. |
| CI / production | `CI` truthy or `NODE_ENV=production` → **no file is read**, host env only. |
| Root discovery | Walk up for the `package.json` named `hope-monorepo`. No fixed parent count, so worktrees and editable installs work; in a container no root is found and nothing is loaded. |
| Legacy `.env` | In `development` only, `.env` is used when `.env.dev` is absent — parity with the TS loader. Retired together with the `.env` file itself. |

`NODE_ENV` (not a Python-specific alias) is deliberate: one variable must decide
which file *both* runtimes read, or the split brain reappears under a new name.

## Usage

```python
from hope_env import load_env


def get_settings() -> Settings:
    load_env()          # once, immediately before building settings
    return Settings()
```

`load_env()` is idempotent — the first call wins, later calls are no-ops.

## Install

A `uv` workspace member (root `pyproject.toml`) and an editable install in the
shared conda env `arcaenv` (`scripts/setup-python-env.sh`). Every service
declares it as `hope-env = { workspace = true }`.

## Tests

```bash
pnpm py-env:test      # pytest packages/py-env/tests
```
