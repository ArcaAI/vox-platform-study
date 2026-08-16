# promptfoo PDSQI-9 contract gate

Release-blocking promptfoo check (run via `npx`) that validates the judge emits
**schema-valid PDSQI-9 JSON** for every case in the pinned golden set
(`synthetic-v0.1.0`). It is **offline-deterministic** by default (mock provider)
so it runs in CI with no secrets.

## Run

```bash
cd apps/harness/eval/promptfoo
npx --yes promptfoo@0.121.15 eval -c promptfooconfig.yaml --no-cache
```

Exits non-zero if any case fails the contract → blocks the release.

## Score against a real model

Point the provider at any OpenAI-compatible endpoint (LM Studio / vLLM / Azure):

```bash
export HARNESS_PROMPTFOO_BASE_URL="http://localhost:1234/v1"
export HARNESS_PROMPTFOO_API_KEY="lm-studio"
export HARNESS_PROMPTFOO_MODEL="google/gemma-4-e4b"
npx --yes promptfoo@0.121.15 eval -c promptfooconfig.yaml --no-cache
```

## Files

| File                   | Role                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `promptfooconfig.yaml` | Eval config (prompt + provider + tests + assertions)              |
| `prompt.py`            | Builds the PDSQI-9 judge prompt from each case                    |
| `provider.py`          | Mock judge (offline) / OpenAI-compatible call (real); stdlib only |
| `tests.py`             | Generates tests from the pinned golden-set fixture                |
| `assertions.py`        | PDSQI-9 output-contract assertion (keys + ranges)                 |

Pin a different/real golden set with `HARNESS_GOLDEN_SET_PATH=/path/to/golden.json`.
The authoritative instrument is the vendored Epic prompts in
`harness.eval.judge.prompts`; this lane pins the JSON output contract.
