# promptfoo PDSQI-9 output-contract gate

promptfoo check (run via `npx`) that validates the judge emits schema-valid PDSQI-9 JSON for
every case in the pinned golden set (`synthetic-v0.1.0`). Offline-deterministic by default
(mock provider), so it runs with no secrets. It is one of the two steps `../run-gate.sh` runs
locally (see `../README.md` for why the eval gate as a whole is a local/scheduled check, not a
per-MR blocking CI job).

## Layout

| Path | What |
|---|---|
| `promptfooconfig.yaml` | Eval config (prompt + provider + tests + assertions), pinned to `goldenSetVersion: synthetic-v0.1.0` |
| `prompt.py` | Builds the PDSQI-9 judge prompt from each case |
| `provider.py` | Mock judge (offline, default) / OpenAI-compatible call (real); stdlib only |
| `tests.py` | Generates tests from the pinned golden-set fixture |
| `assertions.py` | PDSQI-9 output-contract assertion (keys + ranges) |

## Commands

```bash
cd apps/harness/eval/promptfoo
npx --yes promptfoo@0.121.15 eval -c promptfooconfig.yaml --no-cache
```

Exits non-zero if any case fails the contract.

Score against a real model instead of the offline mock provider:

```bash
export HARNESS_PROMPTFOO_BASE_URL="http://localhost:1234/v1"
export HARNESS_PROMPTFOO_API_KEY="lm-studio"
export HARNESS_PROMPTFOO_MODEL="google/gemma-4-e4b"
npx --yes promptfoo@0.121.15 eval -c promptfooconfig.yaml --no-cache
```

`provider.py` falls back to `OPENAI_BASE_URL` / `OPENAI_API_KEY` if the `HARNESS_PROMPTFOO_*`
pair is unset, and to `HARNESS_PROMPTFOO_MODEL` (default `gpt-4o-mini`) for the model id.

## How it works

Pin a different/real golden set with `HARNESS_GOLDEN_SET_PATH=/path/to/golden.json` — this
keeps promptfoo and the Python gate (`python -m harness.eval.ci`) scoring the same set. The
authoritative instrument is the vendored Epic prompts in `harness.eval.judge.prompts`; this
lane pins the JSON output contract (keys present, value ranges), not the rubric itself.

## Related

- [`../README.md`](../README.md) — the eval harness this gate is one step of (`run-gate.sh`,
  judge selection, live gate results)
