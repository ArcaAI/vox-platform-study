# Test Audit — text

## Index

| Anchor | Section | Answers |
|---|---|---|
| [#0-metadata](#0-metadata) | 0. Metadata | bundle, commit, confidence, scope |
| [#1-executive-verdict](#1-executive-verdict) | 1. Verdict | what holds, what does not, top fix |
| [#2-input-inventory-and-integrity](#2-input-inventory-and-integrity) | 2. Inventory | artifact table, reproducibility |
| [#3-what-the-numbers-actually-say](#3-what-the-numbers-actually-say) | 3. Numbers | headline, low files, skips, warnings |
| [#5-coverage-gap-register](#5-coverage-gap-register) | 5. Gaps | GAP register |
| [#8-security--vapt-risk-register](#8-security--vapt-risk-register) | 8. Security | SEC register |
| [#9-mitigation-plan](#9-mitigation-plan) | 9. Mitigation | TEST / REF / FEAT |
| [#10-prioritisation](#10-prioritisation) | 10. Priority | P0–P3 |
| [#11-immediate-next-steps-next-5-working-days](#11-immediate-next-steps-next-5-working-days) | 11. Next steps | ≤7 owner actions |
| [#13-accepted-gaps-and-limitations](#13-accepted-gaps-and-limitations) | 13. Accepted | dead code, unknowns |

**GAP:** `GAP-001` vLLM health and prefix cache scrape · `GAP-002` Anthropic streaming response parsing · `GAP-003` OpenAI response format and stream parsing · `GAP-004` Redis pubsub config invalidation listener · `GAP-005` Redis task event replay stream cursor · `GAP-006` Retry-After HTTP date header calculation · `GAP-007` Lazy registry resolution in embedding and translation
**SEC:** `SEC-001` Untested runtime configuration cache invalidation via Redis · `SEC-002` Unverified stream chunk telemetry and token counting across cloud providers
**TEST / REF / FEAT:** `TEST-001` vLLM health check and prometheus metric scraper tests · `TEST-002` Anthropic and OpenAI SSE stream parsing tests · `TEST-003` Redis pubsub invalidation listener lifecycle tests · `TEST-004` HTTP date-string Retry-After parsing tests · `REF-001` Exclude typing-only blocks and abstract protocols from coverage · `FEAT-001` Hermetic streaming mock fixture for provider adapters
**Search terms:** vLLM, Anthropic streaming, Redis pubsub, SSE chunks, OpenAI response_format, Retry-After, config invalidation, task manager, embedding registry, vertex

---

## 0. Metadata

- **Bundle path:** `apps/text`
- **Audit date:** 2026-11-17
- **Auditor:** Antigravity Testing Auditor Skill v1.3
- **Repo commit:** `3dc8c2e7fbcd51c355ad9f69c0d1ed4b761d0df9`
- **Artifact age:** Fresh (< 1 hour)
- **Confidence:** **Medium** — Run emitted a `module-not-measured` warning for `text` package, and 16 e2e tests were deselected via `-m "not e2e"`.
- **Scope in:** `apps/text/src/text` (API endpoints, routing, provider adapters, core services, background task management, translation).
- **Scope out:** Multi-process live GPUs and external third-party cloud provider networks.

---

## 1. Executive verdict

The text service test suite demonstrates high baseline test coverage (91% overall across 5,643 statements) with 1,825 passing unit tests. Core routing, rate limiting, circuit breaker state machines, generation audit logging, and payload validation paths are thoroughly verified under mock conditions.

Critical gaps cluster in two production-sensitive operational areas: provider-level streaming generators (`AnthropicProvider`, `VertexProvider`, `OpenAIProvider`) and background infrastructure loops (`EffectiveConfigClient.listen_invalidations` and Redis task event tailing). The entire vLLM provider is under-tested (33% coverage) due to exclusion of e2e live GPU tests in default runs.

The highest-leverage immediate fix is introducing unit-level SSE stream fixtures for `AnthropicProvider` and `OpenAIProvider` to verify token metric accounting and stream termination handling without live external APIs.

### Scorecard

| Metric | Measured Value | Target | Status |
|---|---|---|---|
| Total statements | 5,643 | - | - |
| Missed statements | 498 | - | - |
| Code coverage | **91%** | ≥ 85% | PASS |
| Tests passed | 1,825 | 100% | PASS |
| Tests failed | 0 | 0 | PASS |
| Tests deselected | 16 (`-m "not e2e"`) | 0 | NOTE |
| Files < 80% coverage | 5 | 0 | GAP |
| P0 findings | 1 | 0 | ACTION |
| P1 findings | 3 | 0 | ACTION |
| P2 findings | 3 | - | PLANNED |
| P3 findings | 1 | - | ACCEPTED |

---

## 2. Input inventory and integrity

| Artifact | Required | Present | Size | Parse Status | Notes |
|---|:---:|:---:|:---:|:---:|---|
| `coverage_report.txt` | Yes | Yes | 6,424 B | Valid | Complete per-file statements and missing lines |
| `test_results.log` | Yes | Yes | 20,958 B | Valid | pytest 9.0.2 on Python 3.11.18 (Darwin) |
| `TEST_SUMMARY.md` | Yes | Yes | 534 B | Valid | Claims match log totals (1825 passed, 91% coverage) |
| `coverage_html/index.html`| Yes | Yes | 41,238 B | Valid | Snapshot source and mis lines browsable |
| `coverage.xml` | No | Yes | 216,632 B | Valid | Cobertura format line-level execution data |

**Reproducibility:** Run is directly reproducible on this checkout using `cd apps/text && ./generate_coverage_report.sh` inside the `arcaenv` conda environment.

---

## 3. What the numbers actually say

### 3.1 Headline Metrics
- Statements: 5,643
- Missing: 498
- Line coverage: 91%
- Passing tests: 1,825
- Deselected tests: 16 (marked `e2e`, requiring live GPU / cloud credentials)
- Warnings: 5 (including `CoverageWarning: Module text was previously imported, but not measured`)

### 3.2 Lowest Coverage Files (< 80%)

| File | Statements | Misses | Coverage | Missing Line Ranges |
|---|:---:|:---:|:---:|---|
| `src/text/providers/vllm.py` | 110 | 74 | 33% | 36, 76–77, 82–86, 120–122, 128–144, 153–174, 185–213 |
| `src/text/providers/embedding.py` | 38 | 16 | 58% | 32, 36, 40, 56, 63–71, 76–77, 85 |
| `src/text/providers/anthropic.py` | 180 | 48 | 73% | 44, 106, 214–223, 235–238, 240, 356–403, 415 |
| `src/text/core/dependencies.py` | 69 | 17 | 75% | 41–57, 157 |
| `src/text/translation/base.py` | 36 | 8 | 78% | 36, 40, 71–73, 79–80, 88 |

### 3.3 Skipped and Deselected Capabilities
- Deselected 16 tests in `apps/text/src/text/tests/e2e/test_vllm_live.py`, `test_azure_openai_e2e.py`, and `test_cross_provider_e2e.py`.
- Leaves live socket negotiation, GPU metric scraping, and external SSL handshakes unverified in unit runs.

### 3.4 Genuinely Well Covered Areas (100% Coverage)
- `src/text/services/circuit_breaker.py` (64/64 stmts): Trip threshold, recovery timeout, and half-open probes.
- `src/text/services/external_guardrail.py` (83/83 stmts): Synchronous and asynchronous guardrail evaluation.
- `src/text/services/output_gate.py` (63/63 stmts): PII filtering and moderation response transformation.
- `src/text/services/generation_audit.py` (24/24 stmts): Audit log schema emission.
- `src/text/services/shutdown_manager.py` (35/35 stmts): Graceful drain and connection closing.

---

## 5. Coverage-gap register

| ID | File / Symbol | Uncovered Lines | Untested Behaviour | Trigger | System Consequence | Class | Reachability | Severity | Detectability |
|---|---|:---:|---|---|---|---|:---:|:---:|:---:|
| `GAP-001` | `src/text/providers/vllm.py` (`health_check`, `scrape_cache_hit_rate`) | 128–144, 153–213 | Engine health probe and Prometheus cache hit rate parsing | Service startup or Prometheus scrape interval | Stale or unmonitored vLLM instances; silent metric omission | Telemetry | `[REACHABLE]` | Medium | Silent |
| `GAP-002` | `src/text/providers/anthropic.py` (`generate_stream`) | 356–403 | Streaming event iteration, token delta aggregation, and TTFT telemetry | Client requests streaming inference via Anthropic | Missing token accounting or dropped chunks on stream failures | Contractual | `[REACHABLE]` | High | Silent |
| `GAP-003` | `src/text/providers/openai.py` (`_apply_response_format`, `generate_stream`) | 182–193, 283–300 | Structured output JSON schema formatting and stream delta extraction | User requests structured JSON schema output | Malformed request rejected by OpenAI API | Validation | `[REACHABLE]` | High | Caught |
| `GAP-004` | `src/text/core/effective_config.py` (`listen_invalidations`) | 369–389 | Redis pubsub invalidation listener subscription and reconnection loop | Tenant config update published on Redis channel | Out-of-sync cache entries persist until TTL expiry | Sync / State | `[REACHABLE]` | High | Silent |
| `GAP-005` | `src/text/services/task_manager.py` (`read_events_blocking`) | 382–403 | Redis `XREAD` blocking poll for queued stream events | Long-running asynchronous generation reconnection | Reconnecting client experiences stream timeout or missing deltas | Reliability | `[REACHABLE]` | High | Logged |
| `GAP-006` | `src/text/services/retry_handler.py` (`retry_after_from_exception`) | 100–107 | HTTP-date format parsing from `Retry-After` header | Upstream provider returns HTTP 429 with date string header | Fallback to immediate retry or default backoff rather than respected delay | Reliability | `[REACHABLE]` | Medium | Logged |
| `GAP-007` | `src/text/providers/embedding.py` (`get`) | 63–71 | Lazy factory instantiation for unregistered embedding providers | Calling `get()` on embedding provider factory | Provider fails to instantiate lazily at runtime | Architecture | `[REACHABLE]` | Medium | Caught |

---

## 8. Security / VAPT risk register

| SEC-ID | Gap(s) | Category | Attack or failure path | Unverified Control | Exposure | Severity | Evidence |
|---|---|---|---|---|---|---|---|
| `SEC-001` | `GAP-004` | Tenant Isolation / Configuration Tampering | Tenant configuration updates (e.g. rate limits or model overrides) published via Redis are not invalidated across worker processes if listener fails | Redis pubsub listener exception recovery and channel message validation | Stale security parameters applied to tenant sessions | High | `src/text/core/effective_config.py:369–389` |
| `SEC-002` | `GAP-002`, `GAP-003` | Audit & Billing Integrity | Unverified stream token accounting across third-party providers | Cumulative token count calculation and OpenTelemetry span attributes | Undercounted token consumption in billing audit trails | Medium | `src/text/providers/anthropic.py:387–403` |

**Designed but unverified controls:**
- Distributed tenant invalidation broadcast via `CONFIG_INVALIDATION_CHANNEL`.
- Stream token telemetry emission (`gen_ai.usage.output_tokens`).

---

## 9. Mitigation plan

### 9.1 Tests to Add

| TEST-ID | Closes | Level | Suggested File | Assertion |
|---|---|:---:|---|---|
| `TEST-001` | `GAP-001` | Unit | `src/text/tests/unit/providers/test_vllm_provider.py` | Assert `scrape_cache_hit_rate()` parses Prometheus sample text and updates gauge without raising exceptions |
| `TEST-002` | `GAP-002` | Unit | `src/text/tests/unit/providers/test_anthropic_streaming.py` | Mock `messages.create` stream yielding `content_block_delta` and assert emitted `StreamChunk(type="usage")` matches exact cumulative tokens |
| `TEST-003` | `GAP-003` | Unit | `src/text/tests/unit/providers/test_openai_provider.py` | Pass `GenerateRequest(response_format={"type": "json_schema", ...})` and assert kwargs contains strict `json_schema` object |
| `TEST-004` | `GAP-004` | Unit | `src/text/tests/unit/core/test_effective_config_invalidation.py` | Simulate Redis message publication on invalidation channel and assert local in-memory cache is purged |
| `TEST-005` | `GAP-006` | Unit | `src/text/tests/unit/services/test_retry_handler.py` | Pass mock exception with `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` and assert computed backoff > 0 |

### 9.2 Refactors

| REF-ID | Closes | Change | Why It Removes Risk | Risk of Change |
|---|---|---|---|---|
| `REF-001` | Non-functional | Add `exclude_lines = ["if TYPE_CHECKING:", "\\.\\.\\."]` to `pyproject.toml` | Eliminates false-positive gap reporting for type stubs and protocols | None (coverage reporting only) |

### 9.3 New Capabilities

| FEAT-ID | Closes | Capability | Operational Value | Cost |
|---|---|---|---|---|
| `FEAT-001` | `GAP-002`, `GAP-003` | Standardized Mock Streaming Harness | Allows hermetic testing of streaming token counts across all cloud adapters | Low |

---

## 10. Prioritisation

- **Scoring rule:** Critical = P0; High + Silent = P0; High + Logged/Caught = P1; Medium + Silent = P1; Medium + Logged = P2; Low = P3.

| Priority | IDs | Rationale | Effort | Release-Blocking? |
|---|---|---|:---:|:---:|
| **P0** | `GAP-004`, `SEC-001` | Stale configuration persistence causes tenant isolation or rate-limit bypass | S | **Yes** |
| **P1** | `GAP-002`, `GAP-003`, `SEC-002` | Provider streaming token miscounts directly compromise customer billing records | M | **Yes** |
| **P2** | `GAP-001`, `GAP-005`, `GAP-006` | Edge-case retry delays, metrics scrape dropouts, and task polling hiccups | S | No |
| **P3** | `GAP-007`, `REF-001` | Lazy registry test coverage and typing stub coverage configuration | S | No |

---

## 11. Immediate next steps (next 5 working days)

| # | Action | Owner Role | Output Artifact | Acceptance Criteria | Due |
|---|---|---|---|---|---|
| 1 | Add unit tests for `EffectiveConfigClient.listen_invalidations` (`TEST-004`) | Backend Engineer | `tests/unit/core/test_effective_config_invalidation.py` | Invalidation loop handles connect, message, and disconnect cleanly | Day 1 |
| 2 | Add mocked streaming test for `AnthropicProvider` (`TEST-002`) | Backend Engineer | `tests/unit/providers/test_anthropic_streaming.py` | `generate_stream` verified for text and thinking deltas | Day 2 |
| 3 | Add mocked streaming and structured output tests for `OpenAIProvider` (`TEST-003`) | Backend Engineer | `tests/unit/providers/test_openai_provider.py` | `response_format` validated against OpenAI schema contract | Day 3 |
| 4 | Add date-based `Retry-After` header parsing unit test (`TEST-005`) | Backend Engineer | `tests/unit/services/test_retry_handler.py` | Header date parsed and validated against UTC now | Day 4 |
| 5 | Configure coverage exclusion for `TYPE_CHECKING` and `Protocol` stubs (`REF-001`) | DevOps / Tech Lead | `pyproject.toml` | `src/text/core/dependencies.py` reaches 95%+ coverage | Day 5 |

---

## 13. Accepted gaps and limitations

- **Live GPU inference (`pytest.mark.e2e`):** Live vLLM model execution is deselected from hermetic CI runs due to GPU hardware prerequisites.
- **Protocol signatures:** `EmbeddingProvider` and `TranslateProvider` define structural `...` methods that appear as missed lines under `coverage` without runtime execution.
- **Type checking imports:** `src/text/core/dependencies.py:41–57` imports types exclusively during static analysis (`if TYPE_CHECKING:`).

