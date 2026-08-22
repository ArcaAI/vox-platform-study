# TASK-789 Remediation — Ownership Map (binding on all four tickets)

Four tickets run in PARALLEL, each in its own git worktree, one writer per tree (rule 14 §3).
**A file appears in exactly one column. If you need to change a file you do not own, STOP and
report it to the orchestrator — do not edit it, and do not "just add one line".**

| Surface | Owner |
|---|---|
| `apps/api/src/modules/**` except `harness-admin/**` | **790** |
| `apps/api/src/modules/harness-admin/**` | **792** |
| `packages/applications/src/services/workflow-*/**` | **790** |
| `packages/applications/src/services/consultation/harness/**`, `.../workflow-dispatch/**` | **790** |
| `packages/applications/src/services/consultation/summary/**` | **792** (owns the `approveSummary` enqueue) |
| `packages/applications/src/services/{gate-edit-mining,eval,agent-trajectory}/**` | **792** |
| `packages/applications/src/services/consultation/prompt/**` | **792** (few-shot retriever wiring) |
| `packages/database/**`, `packages/domains/**` | **790** (sole schema/migration owner) |
| `packages/workflow-contract/src/node-registry.ts` + `rule-catalogue.ts` + `node-config-schemas.ts` | **791** |
| `packages/workflow-contract/**` (everything else) | **790** |
| `apps/harness/**` except `src/harness/eval/**` | **791** |
| `apps/harness/src/harness/eval/**` | **792** |
| `apps/{nlp,text,guardrail,stt}/**` | **791** |
| `apps/admin-console/**` | **793** |
| `packages/agentic-sdk-v2/**`, `packages/vox-node/**` | **793** |

## Cross-boundary protocol

- **Schema changes are 790's alone.** 791/792/793 needing a column or enum value must request it
  from the orchestrator with the exact Prisma snippet and reason. Nobody else runs `db:*`.
- **The node registry is a CROSS-LANGUAGE PAIR.** Adding a node type means editing
  `packages/workflow-contract/src/node-registry.ts` AND
  `apps/harness/src/harness/temporal/interpreter/registry.py` AND the committed parity fixture,
  together. **791 owns all three** precisely so they cannot drift. 790 must not touch them.
- **Contract-first for cross-ticket APIs.** If your work needs an endpoint another ticket owns,
  write the contract (path, method, request/response TS type) into your ticket README under
  `## Requested contracts`, and the orchestrator brokers it. Do not stub a fake client.

## Non-negotiables for every ticket

1. **TDD, and see RED.** Write the failing test first and paste its failure. A test that never
   failed verifies nothing (`01-development-workflow.md`).
2. **Evidence, not assertion.** "Tests pass" with no pasted output is not a result.
3. **Do not trust a code comment over the code.** TASK-789 struck two of its own findings for
   exactly this — a stale Python docstring and a stale contract doc. Verify against the source.
4. **No hardcoded config.** Engine/model ids, endpoints, thresholds, taxonomies resolve
   tenant → SYSTEM via the settings registry. Selection fails CLOSED; tuning may fail open
   (`00-project-context.md` §Configuration Principles).
5. **Never run** `pnpm install`, `pnpm db:*`, `pnpm gen:mapper` (destructive), `infra:*`, or any
   Docker command. The orchestrator owns shared surfaces.
6. **Never `git stash`** — the stash stack is repo-wide (rule 14 §3). Commit, then
   `git checkout HEAD~1 -- <path>` for a baseline.
7. **Do not read `docs/archive/**`** — off-limits this sprint.
8. Update your ticket README's Implementation Summary + Change History before you finish.

## Definition of done (every ticket)

- [ ] Failing test shown first, then green
- [ ] Affected packages build; lint shows no NEW warnings from your files
- [ ] Ticket README updated with pasted evidence
- [ ] A short report: branch, gates run with output, anything left undone and why
