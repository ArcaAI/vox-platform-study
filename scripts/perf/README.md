# TASK-1047 validation tooling (V2 / V3 / V4)

Tools that MEASURE the governed-prompts / incremental-screening change against a LIVE local stack.
They never start, stop or restart a service (the one exception is the safety ceiling below),
use synthetic text only, and read `INTERNAL_ACCESS_TOKEN` from `.env.dev` (host env wins) without
ever printing it. Run them with the arcaenv interpreter:

```
PY=~/miniconda3/envs/arcaenv/bin/python
```

| Tool | Validates | Needs up |
|---|---|---|
| `apps/nlp/scripts/bench_guard_memory.py` | V2 / S1 | `apps/nlp` (:8864); `apps/guardrail` (:8863) for `--via-guardrail` |
| `scripts/perf/screening-replay/screening_replay.py` | V3 / S3 S4 S5 S6 | `apps/guardrail` + `apps/nlp` (+ `apps/text` for the judge route) |
| `scripts/perf/screening-load/screening_load.py` | V4 / S2 S5 | `apps/guardrail` + `apps/nlp` (LLM-free plane) |

Shared pure helpers live in `scripts/perf/_perfkit/perfkit.py`; their tests in `scripts/perf/tests/`
(`$PY -m pytest scripts/perf/tests -q`).

## Safety

* `bench_guard_memory.py --ceiling-mib N` (default 12288) and `screening_load.py --ceiling-mib N`
  SIGKILL the NLP process when its RSS exceeds N and exit `2`. Start low on the first run.
* Run on a quiet box; other consumers of NLP distort RSS/latency.
* After a ceiling kill, the supervisor (`pnpm stack:dev`) restarts NLP; the run is void.
* Pass `--tenant-id` (or `HOPE_PERF_TENANT_ID`) for a test tenant; the default is the test tenant
  used by the original probe. Guardrail requires `X-Tenant-Id`.

## V2 - `bench_guard_memory.py`

```
$PY apps/nlp/scripts/bench_guard_memory.py --direct --endpoint both --repeat 30 --concurrent 4,8 \
    --json-out /tmp/v2-direct.json --assert
$PY apps/nlp/scripts/bench_guard_memory.py --via-guardrail --sizes 1k,2k,4k,8k,16k,32k,64k,200k \
    --repeat 30 --json-out /tmp/v2-guardrail.json --assert
$PY apps/nlp/scripts/bench_guard_memory.py --window-sweep 1000,2000,4000 --overlap 256 \
    --json-out /tmp/v2-window.json
```

* `--direct`: sizes above `--expect-cap-chars` (8192, FC-8) must answer **413**; smaller ones must
  stay within `--budget-mib` (1024) of the warm baseline. `--via-guardrail`: every size is accepted
  and must stay within budget (200k chars goes through the guardrail region windowing).
* `--repeat N`: N identical requests; the RSS after each is recorded and the last third must not
  exceed the middle third by more than `--plateau-tol-mib` (64) - the leak / high-water check.
* `--window-sweep`: the PII golden set (`apps/nlp/scripts/data/pii_golden_sample.jsonl`, synthetic;
  pass `--golden` for a bigger labelled set, JSON lines `{"text", "spans":[{"label","start","end"}]}`)
  is scored per window size plus an `unwindowed` baseline: precision / recall / F1 (span match =
  same label, IoU >= `--iou`), per-call p50/p95 latency and peak RSS. Choose the OD-6 window as the
  smallest with F1 not below the baseline. `--generate-golden PATH` rewrites the sample.
* Exit: `0` ok, `1` an `--assert` failure, `2` ceiling hit. Output: table + JSON (`s1_pass`).

## V3 - `screening_replay.py`

```
$PY scripts/perf/screening-replay/screening_replay.py --dry-run          # plan + expected windows
$PY scripts/perf/screening-replay/screening_replay.py --minutes 20 --flush-s 20 \
    --system-mode governed --json-out /tmp/v3.json --assert
$PY scripts/perf/screening-replay/screening_replay.py --system-mode untrusted ...   # control: system region screened
```

One consultation: attachment + case note blocks stay byte-identical, the transcript block grows by
`--speech-chars-per-min` each flush. Per flush it calls guardrail `/screen/inbound` with `regions`
(and `/api/medical/validate` with `regions` unless `--no-judge`). Counters are read from `/metrics`
before / after the first flush / at the end. `--real-time` paces at the true cadence (default: back
to back; the cache does not depend on wall time).

Asserts: **S3** chars screened per minute extrapolated to `--scale` (100) consultations <=
150,000; **S4** cache-hit rate after the first flush >= 90 %; **S5** warm inbound p95 <= 300 ms;
**S6** judge calls <= `--s6-judge-ratio` x windows computed (proportional to new text, not to
flushes). Read the JSON `deltas`, and compare with the `--dry-run` plan (`~unique windows` is what a
perfect cache computes).

### Assumed metric names (Lane L5 owns them - override with the flags)

| Flag | Default counter | Meaning |
|---|---|---|
| `--metric-requested` | `guardrail_screen_windows_requested_total` | windows asked for (all tasks) |
| `--metric-computed` | `guardrail_screen_windows_computed_total` | windows that ran ML |
| `--metric-cached` | `guardrail_screen_windows_cached_total` | windows served from the verdict cache |
| `--metric-judge` | `guardrail_medical_judge_calls_total` | medical judge window calls |
| `--metric-chars` | `guardrail_screen_chars_computed_total` | chars ML-screened (optional; else `computed x window`) |

Samples are summed across label sets. A missing metric FAILS its assertion (never silently passes)
unless `--allow-missing-metrics`. Endpoints are flags too: `--inbound-path`
(`/api/v1/guardrail/screen/inbound`), `--medical-path` (`/api/medical/validate`), `--metrics-path`
(`/metrics`).

## V4 - `screening_load.py`

```
$PY scripts/perf/screening-load/screening_load.py --consultations 100 --duration 120 --out-dir /tmp/v4-smoke
$PY scripts/perf/screening-load/screening_load.py --consultations 100 --duration 7200 --out-dir /tmp/v4-soak --assert
```

100 consultations (flush every 20 s, 20-minute lifetime then replaced by a fresh one, 30 % with 1-3
attachments of 2-20k chars) hit guardrail's regions API; NLP and guardrail pids are found by port
(`lsof`; override `--nlp-pid/--guardrail-pid`) and sampled every 5 s. Outputs in `--out-dir`:
`samples.csv` (t, RSS, CPU per process), `requests.csv` (every call), `summary.json`.

Verdicts: **S2** NLP peak RSS <= 6144 MiB and drift (mean of the last vs first
`--drift-window-s`, 600 s, clamped to a third of the run) < 5 %; **S5** p95 of 200s <= 300 ms; no
crashed process and no non-200/503 response; shed (503) rate <= `--max-shed-rate` (1 %). Read
`summary.json` -> `verdicts`; the CSVs plot directly. A 120 s smoke run cannot prove the soak
property (drift is computed over a clamped window) - it proves wiring only.
