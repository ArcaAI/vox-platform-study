# Assessment Queue — TASK-539 Continuous Quality Program

Living document. Risk-ranked subsystem queue for deep assessment; re-scored each cycle. Seeded 2026-07-21 from the Phase-0 baseline. Doctrine: **"Review" status = statically green, runtime-unproven** — every assessment must produce a runtime-evidence section.

## Cycle 1 (before first release cut) — order of execution

| # | Subsystem / action | Why it ranks here | Evidence to gather | Status |
|---|---|---|---|---|
| 0 | Commit checkpoint (OD-7) | Every assessment before it targets unlanded work | Clean tree at a recorded SHA | ✅ done — `c6c44de2` (2026-07-21) |
| 1 | **TASK-534 E2E execution** | Highest-leverage single action: converts 9 Review tickets' claims into evidence | Run the ~65 authored specs. Pre-flight: `lsof -i :8868`; test infra up; apply S3-enum + task_524 migrations to test DB | **first run DONE 2026-07-21: 649 passed / 22 failed / 23 skipped** — failures clustered in config-plane write lane (4), ai-task-defaults (6), model discovery (6), BYO OCC+privilege (2), template clone slug-read (2), agentic-policy OCC (1), SYSTEM-role clone (1); triage in progress |
| 2 | Config plane (524/525/526) | Largest never-runtime-verified surface; secret handling | Live-DB boot; Vault-Transit round-trip; BYO azure/bedrock→SMR live; per-service effective-config `source` diagnostics | queued |
| 3 | Harness agentic loop + stt-v2 producers | Clinical documentation core; D-22 chain unproven | Live streamed consultation → non-empty `segment_citations`; toggle-without-redeploy; replay fixtures | queued |
| 4 | Admin-console governance wave | Waiver-built screens never driven headed | Headed pass per screen (next dev + BFF + gateway + seeded DB); axe on live DOM; retired-route redirects | queued |
| 5 | Security/tenancy governance (OD-2) | Force-locked toggles; prod blast radius unknown | `affected-tenants.sql` on production; 403-on-locked-key live; cross-tenant suite | queued (owner-gated) |
| 6 | Retention/VRAM on GPU host | Perf claims unproven on hardware | Env-gated live-engine suite; LM Studio `ttl` + Ollama `keep_alive` acceptance; NVML smoke | queued (hardware-gated) |
| 7 | Clinical eval / golden set | Blocks every accuracy claim | SME assignment; hard-fail flip preconditions | queued (owner-gated) |
| QW | Quick-wins defect-clearance mini-ticket | Cheap, closes known gaps | F-007 sys-event subscriber; F-018 NUL byte; F-019 gen-check re-run; pynvml extra; stt-v2 black drift | queued |

## Cycle 2+ seeds

| Subsystem | Trigger/gate |
|---|---|
| TASK-499 SAML assertion-attack matrix (tampered/expired/replayed/XSW, real signed assertions) | cycle 2 — top security candidate |
| MiniCheck/GGUF logit-fn wiring (F-014) | staged GGUF host available |
| Dormant-feature enablement matrix (533-C) | hardware-tier decision; each flip needs before/after scorecard numbers |
| TASK-505 review-fix regression sample (19+12+16 fixes) | fold into cycle-1 §1 or cycle 2 |
| Release-readiness workstreams themselves (536/537/538 outputs) | as their waves complete |

## Re-scoring log

- 2026-07-21 — Queue seeded from Phase-0 baseline; item 0 completed at `c6c44de2`; TASK-540/541 spun out (F-001/002/003/016 owned).
