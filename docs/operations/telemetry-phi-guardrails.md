# PHI-Safe Telemetry Guardrails

> Operator + developer reference for keeping PHI (transcripts, prompts, completions,
> summaries) out of metrics, traces, and logs.

HOPE's telemetry plane (OTel traces/metrics/logs) is a **separate system** from the
usage ledger and from the HIPAA audit log. Telemetry exists to answer "is the system
healthy" — it must never carry clinical content. This page is the four-layer defense
that keeps it that way, plus the two naming conventions and the tenant-label rule
every new emitter (STT/TTS/NLP/guardrail/harness Prometheus counters, TEXT spans, gateway
proxies) must follow.

---

## 1. The four defense layers

No single layer is trusted alone — each is independently sufficient to catch the
failure mode the others might miss.

| # | Layer | What it does | Where |
|---|---|---|---|
| 1 | **`NO_CONTENT` pinned everywhere** | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` in every env file, enforced at process boot in production | `.env.sample` / `.env.dev` / `.env.test`; `apps/api/src/bootstrap/genai-content-capture-audit.ts`; `apps/text/src/text/core/config.py` (`TelemetryPhiGuardConfig`) |
| 2 | **Attribute allow-list** (not a deny-list) | Every `gen_ai.*` attribute a service is allowed to stamp is enumerated explicitly; anything not on the list fails CI | `apps/text/src/text/tests/unit/test_phi_safe_telemetry.py` |
| 3 | **OTel Collector deny-list** | An independent transform/filter stage drops content-bearing attributes even if a misbehaving library ignores layer 1 | Collector config (§2 below) — defense-in-depth for libraries that ignore the capture switch |
| 4 | **CI assertions** | The allow-list test above runs in `pnpm py:text:test` (and the equivalent job in CI); a new content-bearing attribute anywhere in the scanned tree fails the build before it ships | CI job that runs `py:text:test` |

### Layer 1 — why `NO_CONTENT` needs an explicit pin, not just a good default

OpenTelemetry's GenAI semantic-convention instrumentation already defaults to *not*
capturing prompt/completion content. The problem: the switch that controls this,
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, is an **instrumentation-library
convention** — it is not part of the official OTel SDK env-var specification. A
library that has never heard of the convention captures content regardless of what
the variable is set to. Pinning the variable is necessary but not sufficient, which
is exactly why layers 2–4 exist independently of it.

Enforcement is **production-scoped only**:

- `apps/api/src/bootstrap/genai-content-capture-audit.ts` — `assertGenaiContentCaptureDisabled()`,
  called from `main.ts` immediately after `loadEnv()`. Refuses to boot when
  `NODE_ENV=production` and the variable is unset or not exactly `NO_CONTENT`. Mirrors
  the existing `assertJwtSecretNotPlaceholder` "refuse to boot on a bad security knob"
  posture.
- `apps/text/src/text/core/config.py` — `TelemetryPhiGuardConfig`, a `pydantic-settings`
  model validator wired into `Settings`. Raises (propagating out of `get_settings()` →
  `create_app()`) under the same condition. TEXT is the only Python service that stamps
  `gen_ai.*` span attributes today (verified by grepping the whole monorepo for
  `gen_ai\.` — every hit lives under `apps/text/src/text/{core/observability.py,providers/}`),
  so it is the only Python service that carries this guard; a future service that starts
  emitting `gen_ai.*` attributes must add the same guard.

Dev and test are **not** enforced the same way: they are not a PHI exposure surface,
and forcing the check there would fail a plain checkout with no env file configured
yet. The env-sample flow (`pnpm env:sync`) still pins `NO_CONTENT` as the template
value in every generated sample file, so a normal `pnpm setup:dev` / `pnpm setup:test`
already gets the safe value without anyone having to remember to set it.

### Layer 2 — allow-list, not deny-list

A deny-list only catches attribute names someone thought to ban in advance. An
allow-list fails closed: any `gen_ai.*` attribute that appears in the source tree and
is *not* on the explicit allow-list fails the build, even if nobody anticipated it.
`test_phi_safe_telemetry.py`'s `ALLOWED_GEN_AI_ATTRIBUTES` is the list; adding to it is
a deliberate, reviewed action that requires confirming the new attribute is not
content-bearing per the list below.

Content-bearing attributes that must **never** be set, anywhere:

```
gen_ai.input.messages
gen_ai.output.messages
gen_ai.system_instructions
gen_ai.prompt.*
gen_ai.completion.*
gen_ai.retrieval.*
```

### Layer 4 — CI

`apps/text/src/text/tests/unit/test_phi_safe_telemetry.py` runs as part of
`pnpm py:text:test`, which is a monorepo CI gate. It scans every non-test `.py` file
under `apps/text/src/text` for `gen_ai.*` string literals and asserts the found set is a
subset of the allow-list and disjoint from the banned list above. No OTel runtime is
started — it is a pure static/regex scan, so it is cheap and cannot flake.

---

## 2. OTel Collector deny-list (layer 3)

Even with layers 1, 2, and 4 in place, a future dependency upgrade or a new
auto-instrumented library could start emitting a content-bearing attribute before a
human notices. The Collector-side filter is the layer that catches that case in a
running system, independent of application code.

Configure the deployed OTel Collector with an `attributes` (or `transform`) processor
that unconditionally deletes the banned attribute names before any exporter sees them:

```yaml
processors:
  attributes/phi-redact:
    actions:
      - key: gen_ai.input.messages
        action: delete
      - key: gen_ai.output.messages
        action: delete
      - key: gen_ai.system_instructions
        action: delete
  # Prefix families need the `transform` processor's OTTL pattern matching
  # (the `attributes` processor only matches exact keys):
  transform/phi-redact-prefixes:
    trace_statements:
      - context: span
        statements:
          - 'delete_matching_keys(attributes, "^gen_ai\\.(prompt|completion|retrieval)\\..*")'

service:
  pipelines:
    traces:
      processors: [attributes/phi-redact, transform/phi-redact-prefixes, batch]
```

This is a deny-list deliberately — the Collector cannot know a service's full
allow-list, so its job is narrower: guarantee the *known-bad* names never leave the
collector, as a backstop for whatever layers 1/2/4 might miss on a given release.

---

## 3. Naming conventions

| Namespace | Signal | Used by |
|---|---|---|
| `gen_ai.*` | LLM generation spans (chat/completion operations) — the OpenTelemetry GenAI semantic convention | `apps/text` (the only text-generation service) |
| `hope.*` | Everything the GenAI convention does not model: speech-to-text, text-to-speech, medical NER/classification | `apps/stt`, `apps/tts`, `apps/nlp` |

Why the split: per research-findings.md §2, the OTel GenAI convention has **no**
`speech_to_text` / `text_to_speech` / NER operation values today (open PRs exist but
are unmerged, `Development` maturity throughout, no pinnable schema version). Stamping
STT/TTS/NLP spans under `gen_ai.*` would misrepresent them as chat/completion
operations and would inherit `gen_ai.*`'s (still-evolving) content-capture surface for
signals that were never in scope for it. `hope.*` is HOPE's own namespace for exactly
this gap — e.g. `hope.stt.audio_seconds`, `hope.tts.characters`,
`hope.nlp.entities_extracted` — non-content-bearing usage/duration facts only, same
allow-list discipline as `gen_ai.*` applies to any new `hope.*` attribute.

Both namespaces are attribute/span-name namespaces only. Neither is a place for
prompt text, transcript text, entity text, or any other clinical content — that
restriction is layer 1–4 above, not a naming convention.

---

## 4. Standing rule: Prometheus metrics never carry tenant labels

**No Prometheus metric (counter, histogram, gauge) may carry a `tenant_id` label, or
any other per-tenant identifier, in any service.** Verified as the current practice
across `apps/text/src/text/core/metrics.py` and `apps/stt/src/stt/core/metrics.py` —
label sets are `provider`, `model`, `status`, `direction`, `error_type`, and similar
low-cardinality operational dimensions, never a tenant or user identifier.

Two independent reasons this is a hard rule, not a style preference:

1. **Cardinality.** A `tenant_id` label multiplies every time series by the tenant
   count. On a multi-tenant platform this is an unbounded-cardinality footgun that
   degrades or crashes Prometheus at scale — the standard operational reason to keep
   tenant identifiers out of labels regardless of the PHI question.
2. **PHI adjacency.** Per research-findings.md §10, `consultation_id` is PHI-adjacent
   under HIPAA Safe Harbor's "unique identifying number" prong, and `tenant_id` is an
   organization identifier that becomes sensitive once cross-referenced with other
   signals. Prometheus is a shared, broadly-queryable surface (Grafana dashboards,
   on-call access) — not the place to introduce that correlation risk even at the
   organization-identifier level.

Per-tenant analytics belong in the tenant-scoped **Postgres** usage ledger (the
`AiUsageEvent`/rollup tables, a different lane), never in a
Prometheus label. If a dashboard needs a per-tenant breakdown, it queries Postgres;
Prometheus stays aggregate-only.

---

## 5. Relationship to the HIPAA audit log and the usage ledger

Three parallel systems, easy to conflate — kept explicitly separate:

| System | Carries PHI? | Legal basis | Retention | Mutability |
|---|---|---|---|---|
| OTel telemetry (this page) | No — enforced by the 4 layers above | Operational health, not compliance | Standard telemetry retention (short) | N/A — no PHI to protect |
| HIPAA audit log (`AuditLog`/sys-events) | Yes — PHI *references* | §164.312(b) audit controls | 6 years (§164.316(b)(2)(i)) | Tamper-evident |
| Usage ledger (`AiUsageEvent`) | No — enums/ids only, no free text | Billing/FinOps | Long (no PHI, no BAA complication) | Re-ratable |

Keeping the separation clean is what lets the usage ledger have long retention and
broad analyst access without a BAA — the moment free-text or content sneaks into any
of these three, that property is gone for whichever system it landed in.

---

## 6. Checklist for a new emitter

Before adding a new span, metric, or log field anywhere in the platform:

- [ ] Attribute/label names use `gen_ai.*` (LLM generation only) or `hope.*`
      (everything else) — never a bespoke prefix.
- [ ] No attribute name or value carries prompt text, completion text, transcript
      text, entity text, or any other clinical content.
- [ ] No Prometheus label is a tenant, user, patient, or consultation identifier.
- [ ] If the emitter is `gen_ai.*` in a NEW service (TEXT is the only one today), add
      the same `NO_CONTENT` production boot guard as `apps/text` and extend
      `test_phi_safe_telemetry.py`'s scan (or an equivalent test in that service) to
      cover it.
- [ ] New `gen_ai.*` attributes are added to `ALLOWED_GEN_AI_ATTRIBUTES` only after
      confirming against the banned list in §1 that they are not content-bearing.
