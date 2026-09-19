# TASK-930 — memory snapshot

Verbatim copies of the orchestrator's persistent memory files that govern this ticket, taken 2026-09-08 from
`~/.claude/projects/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/memory/`. The memory files stay the live source;
this snapshot exists so the ticket folder carries every decision, hazard and working rule the wave was run under.

| File | One-line hook |
|---|---|
| `task-930-931-893-wave-in-flight.md` | 2026-09-08 five-lane wave (TASK-893 R, TASK-930 N/P/S, TASK-931 K) in worktrees ../hope-v2-t{893-r,930-n,930-p,930-s,931-k} — UNMERGED while in flight; merge order N→P→R→S→K into dev-2.2; then regen seeds, artifacts, DB reset, local tests, SDK 3.1.0 publish, ALaaS. |
| `task-890-agent-prompt-context-plan.md` | TASK-890 (2026-09-06) — review + plan for the tenant-admin agent/prompt/context journeys (provider→model picker, one templating grammar, context-schema binding, publish gate, SDK surface); status Pending, untracked, 12 owner decisions open; do not re-review, execute from the README. |
| `task-890-execution-in-flight.md` | TASK-890 EXECUTION started 2026-09-06 — wave-1 worktrees ../hope-v2-task-890-l{0,1,7,11,12} on branches task-890-l<n> hold UNMERGED work; merge into dev-2.2 (owner-named target) before any cleanup; opus wave-close pass before closing each wave. |
| `task-893-workflow-studio-redesign.md` | TASK-893 Phase 1 shipped and pushed 2026-09-07; why deprecated node types still exist; Phases 2-4 planned but unstarted. |
| `model-tier-and-worktree-policy.md` | Owner rules for delegating work — pick the model tier by task complexity, and every subagent works in its own git worktree, merged to feat/loop by the orchestrator. |
| `parallel-lane-orchestration-lessons.md` | What made a five-lane parallel worktree fan-out merge with zero conflicts, and the defect classes it did and did not catch. |
| `worktree-agent-hazards.md` | Three traps when running parallel subagents in hope-v2 git worktrees — stale base, conda editable installs, unbuilt node_modules. |
| `subagent-watchdog-600s.md` | Background subagents die after 600 s without tool output; long suites must be backgrounded to a log, and a stalled lane is recovered by a fresh agent on the same worktree |
| `never-git-stash-in-worktrees.md` | git stash is repo-global and shared across all hope-v2 worktrees; concurrent agents corrupt each other's stash stack. Commit instead. |
| `config-tenant-first-no-hardcoding.md` | Two standing owner rules for HOPE config — minimise env vars / never hardcode config, and always resolve tenant config before platform default (BYO-first). |
| `pre-production-build-for-day-one.md` | HOPE has no production data yet, so ship features complete and ENABLED for day-1 rather than flag-gated |
| `deprecate-then-remove-after-two-releases.md` | Owner rule (2026-09-04) — old/unused code is marked deprecated first and removed only after the next two releases; seeds and owner-named removals are the exceptions. |
| `one-shared-internal-service-token.md` | All internal service-to-service calls use ONE shared access token set by devops — not per-service or per-pair tokens |
| `api-boot-audits-need-a-boot-smoke.md` | apps/api refuses to START on a silent admin route (service-account surface audit) and other boot audits; no unit suite exercises them, so every controller change needs a boot smoke before \"gates green\" |
| `e2e-test-api-launcher-pins-8968.md` | pnpm test:up:api hard-checks port 8968 and runs dotenv -o, so a host PORT override is ignored; a running test API on the current HEAD is a valid spec target without starting a second one |
| `skip-tests-playgrounds-and-ui.md` | Never run unit tests for compat-playground, quick-compat-app, or packages/ui unless the change is inside them. |
| `zsh-bash-tool-pitfalls.md` | The Bash tool runs zsh on this Mac; five word-splitting/quoting traps that produced wrong branch names, empty loops and false test results in TASK-870 |
| `hope-v2-checkout-filter-branch-rewrites-history.md` | Something in the hope-v2 primary checkout periodically runs `git filter-branch` that strips the Co-Authored-By trailer, so local dev-2.2 hashes diverge from origin (same trees) — never force-push; re-anchor on origin and re-commit. |
| `new-sprint-no-old-tickets.md` | From 2026-08-15 the HOPE work is a NEW SPRINT — do not anchor on or cite old TASK-XXX tickets; assess code as it is today. |

---

## task-930-931-893-wave-in-flight.md


Owner brief 2026-09-08: finish TASK-893 (Phases 2+4), meet the five business commitments, rebuild
ALL seed data in `core.*` (Global = SYSTEM → ArcaAI, promotion process), test locally, release the
SDKs (3.1.0) and update ALaaSv3.0. Plan committed at `dev-2.2 @ 7793d09ca`:
`docs/implementation/TASK-930-Agent-Workflow-Platform-Commitments/{README,INTERFACES}.md`,
`TASK-931-Sdk-3.1.0-Release-And-ALaaS/README.md`, TASK-893 README updated. Decisions D-1..D-10 in
TASK-930 §3 (NER = agent task; guardrail stays OD-R policy; svc scopes on the invocation plane;
run-scoped stream ticket; outputSchema → response_format; `core` palette governs consultations;
agent promote-to-system; seeds deleted+rebuilt; SDK 3.1.0 minor; publish to GitHub Packages from
this machine via ~/.npmrc).

Five opus lanes spawned from 7793d09ca, briefs in the session scratchpad `briefs/`:
R `../hope-v2-t893-r` (task-893-retire), N `../hope-v2-t930-n` (task-930-ner-plane),
P `../hope-v2-t930-p` (task-930-promotion), S `../hope-v2-t930-s` (task-930-seeds),
K `../hope-v2-t931-k` (task-931-sdk). Rule 14 §5: never remove a worktree before its branch is
merged into dev-2.2.

**How to apply (resume):** merge N → P → R → S → K (S after R because the registry checksum
changes; then `pnpm --filter @arcaai/database seed:regen:workflows`), `pnpm db:generate`, apply the
NER migration to dev+test DBs, five artifacts, `build:packages`, reset+seed dev DB (owner consent
text "you must reset dev database"), start `stack-dev` (launch.json; LM Studio :1234 has
gemma-4-e2b-it-qat loaded), local tests (Global workflow via API + consultation; promotion round-trip;
3 random ArcaAI workflows), then `pnpm changeset version` → publish → tag `SDK-3.1.0` → ALaaS edits
(uncommitted on the owner's dirty branch; token rotation is the owner's). Owner items: ALaaS `.npmrc`
live GitHub PAT in both apps; ~/.zshrc:149 + .env.dev:1651 exFAT HF_HOME.
Related: [[task-893-workflow-studio-redesign]], [[task-890-execution-in-flight]],
[[parallel-lane-orchestration-lessons]], [[worktree-agent-hazards]], [[subagent-watchdog-600s]].

## 2026-09-08 first spawn killed by the account spend limit (HTTP 429, "monthly spend limit… resets Sep 11")
N committed 66241bb57 (enum+migration), K committed cf62eff3d (SDK_VERSION); R/P/S/A nothing. All six
relaunched/resumed the same session. Lane log + amendments A-1..A-6 recorded in TASK-930 README §4.1/§4.2
and INTERFACES (docs commit dev-2.2 @ 4a04065f2). If the 429 recurs, the fallback is to do the lanes
sequentially in the main session from the briefs (`briefs/full-*.md` + `N-discovery.md`).

---

## task-890-agent-prompt-context-plan.md


On 2026-09-06 the owner reported that the shipped Agent / Workflow Studio / prompt surfaces do not
meet six product requirements (tenant admin builds + publishes agents and workflows for SDK
developers; provider → model selection; per-task hyper-parameters + prompt with context-variable
injection bound to an admin-defined consultation context schema; platform-admin-only model registry
that tenants can still SEE; prompt picker with quick view + deep link, prompt versions + test with
provider/model/variables). The review ran as four read-only discovery lanes + one opus evaluation
(12 claims re-verified) + a fable plan. Result:
`docs/implementation/TASK-890-Agent-Prompt-Context-Journeys/README.md` (746 lines, status
`Pending`, UNTRACKED — never committed; the owner never asked for a commit).

Six BLOCKERs found: workflow publish gate unwired (`workflowPublishProblems` has no caller, every
rule `status:'DRAFT'`); no tenant-readable model catalogue (all 13 `/admin/ai-models*` routes are
`manage:all`, yet the agent wizard calls `GET admin/ai-models`); no provider-first selection; SIX
`{{var}}`/`{var}` renderers (realtime lane flat-key vs harness dotted on the same node); agent
prompt variables have no link to `ConsultationContextSchema` (`contextSchemaId` is authorable but
inert); `core.humanReview` decisions exist only inside apps/harness (no gateway route).

Plan = 9 lanes (L0 grammar+fixture+publishFindings, L1 catalogue route + `read:AiModel`, L2
schema/migration/context pin, L3 renderers + `PromptVersion.syntax`, L4 typed variables + shared
prompt picker, L5 agents console, L6 studio, L7 review proxy + SDK, L8 agent service + draft test)
in waves 1 / 2a / 2b / 3; day-1 cut = the six blockers. Owner decisions OD-A..OD-L in README §6;
OD-A/B/C/D/G/H block lane starts. Proposed follow-ups TASK-891..900 are PROPOSALS only (no dirs).

**Why:** the next session must execute from the README after the owner answers §6, not
re-derive the review; the decisions D-2 (no provider stored on the Agent) and the hand-rolled
grammar (no Jinja2) were argued on invariant grounds and should not be re-litigated casually.

**How to apply:** confirm TASK-890 numbering (docs/archive was deny-listed this session — highest
known archived is 858, implementation tops at 889); spawn lanes per README §4.1 briefs with
worktrees `../hope-v2-task-890-l<n>`; orchestrator owns merges, `db:push`, the five artifacts,
the §4.4 data proofs. Related: [[ai-platform-consolidation-program-859]],
[[task-870-config-governance-landed]], [[config-tenant-first-no-hardcoding]],
[[api-boot-audits-need-a-boot-smoke]].

## Owner decisions (2026-09-06, second round — supersede the README §6 recommendations where they differ)
- OD-A/OD-L: providers offered to a tenant = its BYO connections first, then ONE built-in provider named
  **"Hope provider"** fronting every engine-served tier (lmstudio, ollama, vllm, ...); its model list is
  the SYSTEM catalogue filtered by LIVE availability. A BYO provider is declared WITH task + model +
  endpoint + key, so picking it fixes the model. Platform admin must be able to monitor readiness of all
  inference services.
- OD-B yes (tenant read-only catalogue). OD-C yes (named render error day one; publish WARNING one
  release then ERROR). OD-D "best practical practice for a fast win" (hand-rolled grammar stands).
- OD-E **every inference activity counts against quota** — including draft-agent tests and prompt
  test-runs (reverses the plan's recommendation).
- OD-F browser SDK may invoke published agents with an API key carrying the agent/workflow scopes;
  NO management capability from the browser SDK.
- OD-G both inline and reference context schemas.
- OD-H **NO SYSTEM shared-read for context schemas**: tenant-owned, shared only inside the tenant; SYSTEM
  schema/agents/workflows are a REFERENCE SET cloned into a tenant at tenant creation. Never cross-tenant.
- OD-I plumb the four generation params. OD-J best practice → provisioning-time clone, not a runtime
  SYSTEM tier for workflow assignment. OD-K **deprecated code is removed now** (pre-production), no new
  register rows.

## Round 2 state (2026-09-06, end of session)
README rewritten in place (746 → 1035 lines) with §1.4 decisions applied, §2.7 round-2 facts, §3.12
readiness, §3.13 metering parity, 13 lanes (L0–L13, L9 = vox admin-surface removal, L10 = BYO
connection models as tenant-owned AiModel rows, L11 = metering, L12 = readiness, L13 = reference-set
provisioning + clone retirements), §6.1 answered / §6.2 open. Artifact (round 2):
https://claude.ai/code/artifact/de9f6841-a21f-4b35-8722-23f66dd3ae53
- Blocker #7 found in round 2: `POST /agents/:slug/invocations` (text) checks NO quota and records
  NO usage (the speech route on the same controller does both); prompt test-run and the realtime
  live-documentation lane post to TEXT directly with no `recordUsage`.
- Round-2 facts: `tenant.service.ts` still clones the whole SYSTEM AiModel catalogue AND the retired
  AsrPipelines per new tenant, and copies GlobalSettings from the GLOBAL customer tenant (rule-00
  violation); `AiModel.wireModelId` has zero consumers (`sourceUri` hits the wire; Azure
  `deploymentName` overrides the agent's model); the connection probe discards vendor model lists;
  readiness is per-request only (inventory cron off, keys unregistered); `@arcaai/vox` has 212
  admin refs / 26 hooks with ZERO first-party importers; the routing-policy table is the BYO tuple
  but super-admin-locked and unused by the agent path (rejected as BYO carrier).
- Open owner questions: OD-M keep agent/prompt SYSTEM shared-read for now; OD-N whole register
  cleanup = TASK-901; OD-O retire per-tenant catalogue clone; OD-P retire the Global-tenant
  GlobalSetting clone; OD-Q Hope = every SYSTEM row; OD-R reference-set kinds (no guardrail policy).
- Follow-ups renumbered: 896/897 dropped; 901 = register execution. TASK-891 approved (OD-I).

## Round-3 owner decisions (2026-09-06) — OWNER RULES, do not re-litigate
- OD-M: content entities (agents + fallbacks + assignments, prompt templates/versions, workflows +
  assignments, context schemas) are CLONED from SYSTEM at tenant creation and tenant-owned; SYSTEM
  is NEVER a runtime fallback for content ("we have fallback configurations per agent node,
  tenant-controlled"). Config (connections, platform settings, guardrail, routing, catalogue) keeps
  tenant → SYSTEM or is SYSTEM-only. Rule 00 §2 needs this refinement recorded.
- OD-N: whole deprecation register executes now → TASK-901.
- OD-O: Hope provider-models = refer to the SYSTEM catalogue, never clone; BYO models tenant-specific.
- OD-P: retire the Global-tenant settings clone; platform settings writable by platform admin ONLY,
  global-wide effective.
- OD-Q: Hope = out-of-the-box provider-model set incl. cloud, default, cross-tenant, in SYSTEM.
- OD-R: guardrail is platform-wide, platform-admin-only, shared, NOT cloned; tenant admin MUST be
  able to opt out per agent node or per workflow.
- Owner wants a "best practical practice fast-win solution".

## Round-3 state (2026-09-06, end of session) — READY TO EXECUTE once D-1/D-2 are answered
README rewritten in place to 1197 lines: §1.5 owner rule (content cloned / config cascades), §3.14
guardrail opt-out (`guards.enabled` on agent, `guardrail:{enabled}` on core.agent + core.trigger,
precedence node>workflow>agent, `guardrail_policy.enabled` on every TEXT post, text `resolve_posture`
honours it with the platform switch as floor, ledger attribute), §3.15 platform-settings guard
(legacy GlobalSettingService create/update/delete lack the SYSTEM-tier super-admin check; registry
lane has it), §4.8 fast-win path (28.5 engineer-days, ≈16 elapsed; critical path L0/L1 → L2 → L3 →
L13; L10/L12/L9 deferrable), 15 lanes L0–L14 (L14 = guardrail opt-out, wave 2b). L13 = five ordered
steps ending with the shared-read FLIP (remove Agent/AgentAssignment/PromptTemplate/PromptVersion
from SYSTEM_SHARED_READ_MODELS; AgentAssignmentService.resolve → department→tenant→null
`AGENT_NOT_ASSIGNED`; text-agent-resolver.service.ts:219 + tts-agent-resolver.service.ts:163 lose
their terminal SYSTEM candidate) as the LAST merge after backfill.
- Round-3 facts: guardrail already SYSTEM-only + super-admin (TASK-886) and never cloned; no per-call
  enable flag anywhere; `text.externalGuardrail.enabled` defaults false, never seeded ("dev/CI
  bypass" by its own descriptor) → TASK-871 gates inert until flipped; H-6 fallback bug in runtime
  (`agent-resolver.service.ts:117`) AND clone (`agent.service.ts:888`); only WorkflowDefinition has
  the unscoped reference-read pattern (`findCloneSource`/`findSystemTemplates`); BYO slug could
  shadow SYSTEM slug (L10 409).
- Open discussion items: D-1 keep MANDATORY_NODE_TYPES mandatory (recommended); D-2 seed the
  external-guardrail switch ON (recommended, after proof #8 + reachable guardrail client on every
  stack incl. the test stack). Neither blocks the start.
- Artifact round 3: https://claude.ai/code/artifact/de9f6841-a21f-4b35-8722-23f66dd3ae53

---

## task-890-execution-in-flight.md


Owner directive (2026-09-06): execute TASK-890 with one team of agents in parallel worktrees (no
overlapping files), detailed briefs with an identical cacheable preamble
(`scratchpad/lane-common-preamble.md` in the session scratchpad), merge every lane into `dev-2.2`,
then an OPUS wave-close agent runs the gated tests, reviews and bug-fixes the MERGED tree before the
wave closes. D-1 = YES (opt-out covers mandatory guard nodes; hitlGate + trigger/output excluded on
invariant grounds — README §3.14a), D-2 = YES (seed `text.externalGuardrail.enabled` ON, L14).

Base: `dev-2.2` @ `b2511b005` (docs commit with the 1277-line plan, status In Progress).
Wave 1 (spawned 2026-09-06, all opus): L0 grammar+fixture+publishFindings (`../hope-v2-task-890-l0`),
L1 catalogue+read:AiModel+settings guard (`-l1`), L7 review proxy+SDK (`-l7`), L11 metering (`-l11`),
L12 readiness (`-l12`). Each worktree: pnpm installed, db:generate run, `build:packages` done,
`.env.dev/.env.test` copied. Wave order after: 2a L2 alone → 2b L3 L4 L8 L14 (+L10) → 3 L13 L5 L6 (+L9).

**Why:** rule 14 §5 — never remove a worktree with unmerged commits; a resumed session must merge
wave 1 (in any order; disjoint files) then run: five artifacts, `pnpm db:seed` (policy), boot smoke,
data proofs #1-#3, then the opus wave-close pass.

**How to apply:** orchestrator-only surfaces: merges, `pnpm install`, db commands, artifacts,
`.claude/rules/*` edits (rule 00/05/09 amendments per README §8). Related:
[[task-890-agent-prompt-context-plan]], [[worktree-agent-hazards]], [[subagent-watchdog-600s]].

## 2026-09-06 wave-1 MERGED (not yet closed)
All five wave-1 lanes merged into dev-2.2 with no conflicts (808edbd60 L0, b1ab9f0b2 L11, be2a896d2 L7,
cc5a13343 L12, 3392eadf2 L1), marker dropped, rule-05 row cb6853ea8. Lockfiles unchanged. The merged
tree FAILED `build:packages`: four TS2308 ambiguous re-exports in `packages/applications/src/services/index.ts`
(L1 `model-readiness.port.ts` vs L12 `services/ai-readiness/**`; interim `ENGINE_SERVED_PROVIDERS` copy).
An opus WAVE-CLOSE agent is integrating, regenerating the five artifacts, seeding, running gates + task-890
e2e + authz matrix + full e2e, data proofs #1-#3, reviewing and fixing, then writing README §9.
Ledger of cross-lane requests: session scratchpad `wave1-ledger.md` (also summarized in README §9 once written).
Worktrees l0/l1/l7/l11/l12 are MERGED — safe to remove after the close verdict; branches keep.

## 2026-09-06 WAVE 1 CLOSED at dev-2.2 @ 200990662 (opus wave-close: all gates green, full e2e 1144/0 failed,
proofs #1-#3 clean; W1-1 fixed a real platform-tier bypass via `PATCH admin/tenants/configs/<key>`).
Worktrees l0/l1/l7/l11/l12 REMOVED (branches kept). Wave 2a: `../hope-v2-task-890-l2` (branch task-890-l2)
created from 200990662 — UNMERGED while in flight. Carry-over requests: scratchpad `wave2-carryover.md`
(also in README §9). Two owner questions from the close (tenant-config key addressing; reserved-tenant
entitlement override no-op).

## 2026-09-06 WAVE 2a: L2 MERGED at e02ac10c2 (close chain running: db:generate, db push dev+test with
--accept-data-loss (4 AiModel columns dropped), builds, five artifacts + checks, gen:*:check, seeds, proof #4).
Migration `20260906101622_task_890_context_schema_byo_model_provenance` (empty-diff proven on hope_shadow_890).
`../hope-v2-task-890-l2` still present (merged) — remove after the 2a close. Next: opus wave-2a close, then
wave 2b worktrees l3/l4/l8/l14/l10 from the closed 2a head.

## 2026-09-06 wave 2a: migration APPLIED to dev (hope@5432) and test (hope_test@5433) via psql (Prisma's AI guard
refuses `db push --accept-data-loss`; the migration SQL was proven equivalent on the shadow DB); `migrate diff`
empty on both; seeds run (`RUN_SEED=all` needed on dev too — plain `pnpm db:seed` skipped 07g). l2 worktree
REMOVED (merged). Opus wave-2a close running on e02ac10c2. Proof #4 = 5 single-brace rows until L4.

## 2026-09-06 WAVE 2a CLOSED at dev-2.2 @ 1cc9b915a (full e2e 1144/0; typecheck fix; py-workflow-contract exports).
Wave 2b worktrees `../hope-v2-task-890-l{3,4,8,14,10}` (branches task-890-l<n>) created from 1cc9b915a — UNMERGED
while in flight. Owner questions open: Postgres CHECK for wireModelId; `required` kinds enforcing (orchestrator chose
ENFORCING, fail closed). A pre-existing repo `stash@{0}` belongs to the owner — never touch it.

## 2026-09-06 WAVE 2b MERGED at dev-2.2 @ e8c12d971 (L14, L8, L10 clean; L3 + L4 conflicts resolved by hand).
Close chain running; then the opus wave-2b close (must: wire L14's three guardrail one-liners into live-documentation
/ nodes/core.py / prompt-management; enforce the frozen context schema in agent-invocation (L8's code); wire
PublishContext.agents via publishAgentViews in workflow-definition.service.ts; own the text-compat
summary-prompt.builder.ts seam; settle the task-stream double-metering trigger; delete L8's local compiled types now
that packages/types carries them; verify `{{transcript}}` rendering). D-2 seed row = commit 4e60b52ff (kept; e2e
stack has no TEXT so it is inert there; dev/k3s need a reachable guardrail). Worktrees l3/l4/l8/l14/l10 still
present (merged) — remove after the close verdict. Ledger: scratchpad `wave2b-ledger.md`.

## 2026-09-06 wave 2b: artifacts committed 9316e8117; worktrees l3/l4/l8/l14/l10 REMOVED (all merged; branches kept).
Opus wave-2b close running on 9316e8117 (integration A.1–A.8 + gates + e2e + proofs + README §9). Next: wave 3
worktrees l13/l5/l6/l9 from the closed 2b head.

## 2026-09-06 WAVE 2b CLOSED at dev-2.2 @ fe536e880 (full e2e 1170/0; nine review fixes incl. render-scope parity,
context-bound agents invocable, BYO re-declare 409; A.6 ledger back-fills missing attribute keys on idempotency
conflict). Follow-ups TASK-903..907 in README §8. Owner questions: D-1 presence is ADVISORY (deleting a consent gate
publishes 200 with WF-CONS-001 non-blocking) — promote the rule set?; azure `deploymentName` still required?;
`svc:admin:agent:manage` on the seeded SA? Wave 3 worktrees `../hope-v2-task-890-l{13,5,6,9}` created from
fe536e880 — UNMERGED while in flight. L13 = reference set + backfill + clone retirements + the FLIP (last commit).
Wave-3 carry-over is in README §9 (wave-2b block).

## FINAL-PHASE DIRECTIVE (owner, 2026-09-06) — runs AFTER wave 3 + TASK-890 close, all green
Black-box browser e2e with opus agents against a RESET dev DB (owner consent given: "you must reset dev database"
→ PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION with that exact text, DEV only) + the local dev stack. Verify: service
status (LM Studio runs on the Mac at :1234 — seeds target k8s addresses → fix seed/connection base URLs for local);
platform admin manages provider→model; tenant admin manages prompts with DEPARTMENT TAGS (departments deprecated);
Studio create/update/drag/drop/connect/note; agents: realtime transcription with
`whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF Q8_0`, pre-summarization with lmstudio + `gemma-4-e2b-it-qat`;
realtime consultation workflow: transcription + PII NER `fastino/GLiNER2-Guardrails-PII-Multi` + `blaze999/Medical-NER`
(playground highlights entities) + incremental partial summarization from a department template by user profile + key
points + review/finalize + work-notes as context items; publish + external calls (webhook/http/sse/socket/vox-node) +
a small React app on browser Vox; full seed parity arcaai + SYSTEM (+ Global = SYSTEM); release readiness.
Verbatim text: session scratchpad `owner-decisions-2026-09-06.md` (final-phase section).

## 2026-09-06 WAVE 3 merged PRE-FLIP at dev-2.2 @ ea177e32e (L13 steps i–iv @85689e120, L9, L5, L6 clean).
Pre-flip chain running (builds, artifacts, seeds incl. phase 26, backfill dry-run+apply on dev and test, proof #9).
THEN merge L13 HEAD 803e127f4 (the flip: Agent/AgentAssignment/PromptTemplate/PromptVersion leave
SYSTEM_SHARED_READ_MODELS), rebuild, wave-3 close (opus), rules 00/09 amendments, README status → Completed,
then the final black-box phase. Worktrees l13/l5/l6/l9 still present (merged except the flip commit).

## 2026-09-07 WAVE 3 fully merged incl. THE FLIP: dev-2.2 @ a4bad23b6 (artifacts 6264a8180, flip merge, rules 00/09
amendments). Proof #9 post-flip: every tenant ok on dev (2) and test (18 incl. L13's throwaway REFSET_*/FAILCLOSED_*
fixtures — harmless; final phase resets DBs). Opus wave-3 + TICKET close running (README → Completed).
Worktrees l13/l5/l6/l9 being removed (merged). Final black-box phase facts: launch.json has api:8868,
admin-console:5176, admin-console-agent:5178, compat-playground:5177; `pnpm stack:dev` supervisor (api stt stt-worker
text guardrail nlp harness worker admin); HF_HOME=/Volumes/aillusion/huggingface; seed hook
SEED_LMSTUDIO_BASE_URL (default http://hope-lmstudio:1234/v1 → set http://localhost:1234/v1 at seed time for local);
nlp seeds have `medical-ner` (blaze999/Medical-NER) and `gliner2-guardrails-pii-multi`; LM Studio :1234 has
gemma-4-e2b-it-qat loaded.

## 2026-09-07 TASK-890 CLOSED — README status Completed @ 58051735e; dev-2.2 head after the note fix. All fifteen
task-890-l* branches merged (ancestors of dev-2.2); all worktrees removed by the orchestrator. Full e2e 1181/0/49;
console e2e green except 4 pre-existing specs (TASK-911). Nine owner questions in README §6.4; follow-ups
TASK-891..912 in §8. NOT PUSHED. NEXT: the final black-box phase (see FINAL-PHASE DIRECTIVE above).

## 2026-09-07 BLACK-BOX PHASE in progress (dev stack RUNNING via preview `stack-dev`, serverId 42b304bb…; dev DB
reset+seeded at 18:0x with SEED_LMSTUDIO_BASE_URL=http://localhost:1234/v1 in .env.dev; WORKFLOW_EXPOSURE_ENABLED=true
in .env.dev pending API restart). J7 (read-only) + J1 (browser) DONE — findings ledger: scratchpad
`blackbox-findings.md`; journey briefs: `blackbox-journeys.md`. J1 fixes committed a03a4b365..63b78f021.
F2a (code: runtime-path usability via per-service `internal/models/resolvable` + readiness; text probe status;
seed J7-1 generic prompts on SYSTEM; tags policy; tenant-scope comments; workflowExposure default true + env:sync;
inventory→readiness invalidation) and F2b (docs/changelogs/register/release notes/architecture) RUNNING in
parallel with pathspec-only commits. NEXT: restart stack (preview_stop/start), reset+seed dev DB again (consent
text: "you must reset dev database, then start local development environment."), then J2→J3→J4→J5→J6 one at a
time (single Browser pane; one fresh tab per route — next dev wedges under load).

## 2026-09-07 black-box progress: J1 J2 J7 done; F2a F2b F3 landed (up to bc94205c1 + fe3dce266); stt/nlp relaunched by
hand on the fixed probe (supervisor untouched, serverId c38eaa8b…); named models usable via the runtime path. RUNNING: J4
(Studio, browser), F4 (guardrail dropped-column read = BLOCKER for every guardrailed generation; J2 server items).
NEXT after both: stop stack → regen five artifacts (stack DOWN) → reset+seed dev DB (consent text) → start stack →
J3 → J5 → J6 → final release close (README §9 black-box block, memory, artifact).

## 2026-09-07 black-box: J1 J2 J3 J4 J7 DONE; F2a F2b F3 F4 F5 F6 landed (HEAD ~18e8d6aaa + F5/F6 commits). F7 RUNNING
(guardrail judge response_format json_schema — BLOCKER for every guardrail-ON generation; publish gate honours readiness;
SSE CRLF metering; draft-test metering; single-kind `context` envelope unwrap TS+Python; minors). AFTER F7: full stack
restart (preview_stop/start `stack-dev`), re-activate `arcaai-pre-summarization` v1 (guardrail ON), publish
`arcaai-realtime-transcription` (01a078ce-bedd-7279-8eeb-c4a8bd8b998c), then J5 (live consultation; recreate J4's
workflow from its node spec with J3's agents — the re-seed wiped it), then J6 (external + vox React app), then the
release close. Findings ledger: scratchpad blackbox-findings.md; J3 key: scratchpad/j3/apikey.txt.

## 2026-09-07 black-box: F7 F8 F9 landed (HEAD c5b0cad75): guardrail judge json_schema; guardrail→text judge CONNECTION
(text forwards provider_overrides; guardrail resolves keyless engine-served base_url from SYSTEM row); invocation sends
`wireModelId` not the catalogue slug. Screened invocation through the gateway = 200, ledger `guardrail=screened`.
HF cache moved to `/Users/taphuynh/.cache/hope-hf` (exFAT volume wedged probes): `.env.dev` HF_HOME edited BUT
`~/.zshrc:149` exports the old path (host env wins → `.claude/launch.json` stack-dev now runs `env HF_HOME=… pnpm
stack:dev`, uncommitted), and `apps/stt/.env:96 HUGGINGFACE_CACHE_DIR` (gitignored, second pydantic env_file loader)
edited too. `.env.test:1600` still exFAT. Both named agents PUBLISHED active (ASR gate clean). Each preview_stop leaves
the stt Dramatiq worker + one nlp uvicorn orphaned — kill by hand before relaunch. tts not started by the stack.
RUNNING: J5 (rebuild workflow `arcaai_realtime_consultation` from scratchpad/j4-workflow-spec.md, live run).
NEXT: J6, then release close (README §9 black-box block, memory, artifact, owner report incl. the .zshrc note).
## 2026-09-07 black-box: J5 DONE (PASS-WITH-FINDINGS; workflow `arcaai_realtime_consultation` 01a07944-… published; consultation
SIGNED end to end; fixes aecbb47e0 playground route group, 08935fb61 canvas drag crash). F10 cb18d1f1f+7a814d7bd (harness
`service=harness` on agent resolve; illegal consultation transition → 409 non-retryable; draft lands in current state).
F11 1eddd7880 (`GET /internal/harness/models/resolve` — the route core.classify always called never existed; manifest 735).
Six PRE-EXISTING harness replay-compat reds (task-355 patch marker drift) — follow-up. Stack relaunched (serverId d1d1786e…).
RUNNING: J6 (developer access: API key with workflow scopes, http/sse/socket/webhook, vox-node script, React app on
@arcaai/vox, plus an api-trigger workflow `arcaai_api_consultation_summary` to exercise classify+agent durable nodes).
NEXT: release close — README §9 black-box block, seed parity line (`seed/25-agents.ts:309` wireModelId), prettier red in
`apps/api/tests/e2e/task-635-prompt-test-bench.spec.ts:371`, memory, artifact, owner report (incl. ~/.zshrc HF_HOME note,
.env.test exFAT path, launch.json uncommitted, owner questions J5-Q1..Q3 + earlier).
## 2026-09-07 black-box: J6 DONE (PASS-WITH-FINDINGS; fixes 187491712 webhook unscoped hook read, 376837df7 vox-node flat
invoke body, 281af3759 baseUrl doc; workflow `arcaai_api_consultation_summary` v5; React app scratchpad/j6/vox-app :5199;
J6 key LEAKED into its transcript → revoke `01a079ba-06d3-…` + `j6-developer-key` at the close; remove :5199 allowed origins).
F12 74c2f9155 (InternalServiceTokenGuard accepts the shared token). F13 bff2f4837+41821f765 (classify by task_type, json
format, activity_error cause, registry-declared timeouts). RUNNING F14: nlp GLiNER2 token-classification loader, text
lm-studio json→json_schema, workflow-lane metering (step stats → ledger). Stack serverId 18380272…. NEXT: restart, re-run
api workflow v5 (pii/ner/keypoints + ledger), revoke J6 keys, kill vox app pid 18988, release-close agent, owner report.
## 2026-09-07 black-box: F14 6c68818b9+5aaac5a52+a29b5b342 landed (nlp GLiNER2 token runtime, LM Studio json→json_schema,
workflow-lane LLM_CALL metering). FINAL verification run of `arcaai_api_consultation_summary` v5 (01a07a1a-191d-…): PII ✓,
Medical-NER ✓, pre-summary ✓, review decided via API key ✓, ledger WORKFLOW_RUN/screened ✓; key points BLOCKED by guardrail
`response_toxicity` false positive (owner tuning). J6 keys revoked (proven 401), :5199 origins deleted, vox app stopped.
RELEASE-CLOSE agent RUNNING (README §9 fifth block, seed wireModelId parity, prettier red, changelogs/release notes/traceability,
gates + full e2e with RESET_DB=false). After it: update this memory with shas, refresh the artifact
https://claude.ai/code/artifact/de9f6841-a21f-4b35-8722-23f66dd3ae53, final owner report. Stack serverId 01c6588a….
## 2026-09-07 BLACK-BOX PHASE CLOSED — dev-2.2 @ 89c532f01 (NOT pushed). README §9 fifth block "Black-box release phase —
CLOSED 2026-09-07 (J1–J7, F2a–F14)"; §6.4 Q-10..Q-24; §8 TASK-913..929. Close commits ff40cd21c (seed wireModelId parity),
7ee0c4128, 6f81c4ed7 (prettier), b25d098ce (HF_HUB_CACHE in turbo globalEnv + env:sync), c43926af7 (workflow-seed modules
regenerated for F13 timeouts), dd76e9e8d, e4bb8bda4 (changelogs/release notes/traceability/architecture), 40c56cc83
(public-internal-route inventory 34), 89c532f01 (README). Gates: typecheck:all 0; api lint 0 errors; root test:unit
24584 passed; full e2e 1181 passed / 47 skipped (one regression fixed). Only `.claude/launch.json` uncommitted (machine-local
HF_HOME override). Owner items to raise: ~/.zshrc:149 HF_HOME export, .env.test:1600 exFAT path, stale Aug-23 dev-stack.sh
supervisors, guardrail response_toxicity false positive (SYSTEM policy tuning), Q-10..Q-24.

---

## task-893-workflow-studio-redesign.md


TASK-893 **Phase 1 is done, merged and PUSHED** to `origin/dev-2.2` @ `4e0c9362e` (2026-09-07).
Plan + lane contract: `docs/implementation/TASK-893-Workflow-Studio-Redesign/{README.md,INTERFACES.md}`.

**Why deprecated node types still exist** (the owner's question, and the answer is not "nobody
cleaned up"): `ACTION_CATALOGUE` (`packages/workflow-contract/src/core-contract.ts:108`) is built by
filtering `WORKFLOW_NODE_REGISTRY` for the deprecated keys — every action `core.action` can perform
IS a deprecated legacy node type, and `actionDelegateOf()` resolves its config schema and ports from
that descriptor. **Deleting the 62 deprecated types today deletes every action a workflow can
perform.** The harness `registry.py` still declares all 64 as well.

**Phases 2-4 are planned but UNSTARTED**: (2) promote `ACTION_CATALOGUE` to a first-class table so
capabilities survive deletion, (3) migrate the 11 seeded graphs from the `consultation.*`/`agent.*`
vocabulary to `core.*` — assignments bind by `workflowDefinitionSlug`, so a new version per slug
keeps routing intact, (4) delete the legacy vocabulary, TS + Python in lockstep behind the parity
fixture. Order is a hard dependency, not a preference.

**Carve-out that needs a backend change**: per-node run overlays on the canvas cannot work.
`RunNodeRollupResponse` carries `nodeType` + `order` and deliberately no graph node id, so with two
`core.agent` nodes or any loop body, attributing a trace row is a guess. `useSandboxNodeStates`
returns an empty map today; the canvas rendering is already in place. Needs the interpreter to stamp
a node id onto trajectory rows.

See [[parallel-lane-orchestration-lessons]] for how it was built.

---

## model-tier-and-worktree-policy.md


Owner directive (2026-08-20), applies to every delegation from now on.

**1. Subagents work in WORKTREES, never the shared checkout.** Spawn with
`isolation: "worktree"`; when the agent finishes, the ORCHESTRATOR merges its branch
into `feat/loop` properly. See [[worktree-agent-hazards]] for the known traps.

**Why:** on 2026-08-20 thirteen agents shared one checkout. Three had their edits
silently reverted mid-run and had to redo them; one agent's `git stash` swept up
155 files of other sessions' uncommitted work; another agent restored a file from
HEAD and wiped a sibling's change (TASK-713's ICC threshold) while leaving that
sibling's tests behind, so the suite failed for a reason neither agent had caused.
Reports of "verified green" were true when written and false minutes later.

**2. Match the model tier to task complexity:**

| Complexity | Tier | Effort | Examples |
|---|---|---|---|
| Trivial / simple | `haiku` | default | classification, formatting, extraction, short lookups, simple rewrites |
| Moderate | `sonnet` | low–max | summarization, standard coding, data transformation, Q&A over given context |
| Complex | `opus` | low–max | multi-file changes, tradeoff analysis, structured reasoning, agentic tool use |
| Very high | `opus` or `fable` | low–xhigh | deep architecture, hard proofs, long-horizon agents, novel/ambiguous problems |

**How to apply:** commit the orchestrator's own work BEFORE spawning worktree agents,
so each worktree branches from a base that already contains it. Verify an agent's
artifacts yourself after it reports — a report describes the moment it was written.

---

## parallel-lane-orchestration-lessons.md


Five parallel worktree lanes (TASK-893) merged into `dev-2.2` with **zero conflicts**. What made
that work, and what it still missed:

**Write the interface contract BEFORE spawning, and commit it.** An `INTERFACES.md` with (a) an
exclusive file-ownership table and (b) the exact cross-lane signatures, committed to the base branch
so every worktree branches from a tree containing it. When one file is touched by nearly every task
(here a 767-line editor), give it a SINGLE owner and have the others code against the document —
their worktrees still hold the stale versions, and that is fine.

**Make "not yours" actionable.** Every brief said: if you need an edit outside your rows, do not
make it — report it under `### Cross-lane requests`. That surfaced four real cross-file needs
instead of four silent conflicts. Files owned by NOBODY (shared nav tests, route-group tests) still
need an explicit owner at integration; assign them to yourself up front.

**Require each lane to report the exact signatures it built or assumed.** Diffing Lane E's assumed
imports against Lanes A-D's delivered exports is what caught the mismatches before compiling.

**Defect classes, and which review catches them:**
- *Cross-lane semantic* — caught by reading two reports together. One lane predicted a bug in
  another's module that the other's own exhaustive sweep could not see, because the sweep ran
  without the argument the first lane would pass.
- *Wrong-layer* — caught by verifying an agent's claim against the real consumer. A binding written
  to config that the interpreter never reads would have validated, rendered as bound, and threaded
  nothing.
- *Only visible at runtime* — NOT caught by any suite. Collapsing node handles made React Flow
  silently drop every edge naming a removed handle; all unit fixtures used the surviving handle
  names, so 3400 green tests said nothing. **Drive the running app before calling a UI change done.**

**Subagents cannot be messaged mid-flight here** (no SendMessage), so a cross-lane finding that
arrives while another lane is running has to be queued for integration. Budget for that.

Tiering that worked: opus where correctness is load-bearing or other lanes depend on it (canvas
internals, state machine + algorithms, integration); sonnet for well-specified mechanical work.

Applies to [[task-893-workflow-studio-redesign]]; complements [[model-tier-and-worktree-policy]] and
[[worktree-agent-hazards]].

---

## worktree-agent-hazards.md


Running parallel agents in git worktrees on hope-v2 hit three traps on 2026-08-19. Verify all three in the agent's prompt.

1. **Auto-created isolation worktrees can branch off a stale base.** Four of six came up on a `dev` merge ~1943 commits behind `feat/loop`, where the ticket READMEs and target code did not exist yet. Create worktrees explicitly (`git worktree add -b wt/task-NNN <path> feat/loop`) and make the agent print `git log --oneline -1` to confirm before working.
2. **The shared conda env `arcaenv` has editable installs pointing at the MAIN checkout, not the worktree.** So `pnpm <svc>:test` inside a worktree silently tests stale main-repo code. Workaround: run pytest with `PYTHONPATH=<worktree>/apps/<svc>/src`. Do NOT reinstall the editable link — it repoints for every other concurrent worktree session.
3. **A fresh worktree has no `node_modules` and no built workspace packages**, producing hundreds of spurious "Failed to resolve entry for package @arcaai/domains" failures. Agents must `pnpm install` + `pnpm db:generate` + build the dependency chain first, or confirm a failure is pre-existing via `git stash`.

Also: agents must NOT merge their own branches. Serialize merges in the orchestrator — concurrent merges into one branch race. And a worktree running a server process (or holding `dist/`) refuses `git worktree remove`; kill the process first.

**Why:** each of these silently produces work that looks verified but wasn't, or corrupts the target branch.

**RECURRED 2026-08-23 (TASK-799 Phase 0).** Item 2 bit again because the briefs did not
carry it. All six `__editable__.<svc>-*.pth` files in
`~/miniconda3/envs/arcaenv/lib/python3.11/site-packages/` point at the PRIMARY checkout, so a
bare `pnpm <svc>:test` from a worktree goes GREEN while testing none of the agent's changes.
The paste-the-command form that works, and the proof to demand alongside it:
`PYTHONPATH=$PWD/apps/<svc>/src pnpm <svc>:test` plus
`PYTHONPATH=$PWD/apps/<svc>/src conda run -n arcaenv python -c "import <svc>; print(<svc>.__file__)"`
resolving under `.claude/worktrees/`. One lane discovered it independently; three had to be
corrected mid-flight. Item 1 also recurred (one of four worktrees came up on an unrelated old
`dev` merge).

**How to apply:** paste items 1-3 verbatim as preconditions into every worktree agent prompt —
summarising them is what failed twice; keep merges and DB resets with the orchestrator. See [[skip-tests-playgrounds-and-ui]].

---

## subagent-watchdog-600s.md


Background `Agent` runs are killed by a stream watchdog after 600 s of no progress. In TASK-870
this hit three lanes (TASK-874 first attempt, TASK-872 mid-work, TASK-876 at the very end —
"both suites still running" while the agent waited on them), because `pnpm harness:test`
(~3–4 min) and `applications test` (~2 min) run back-to-back exceed the window when the agent
awaits them in the foreground.

**Why:** the kill loses the agent's context, not its files — everything committed survives, and
the worktree stays usable — but an unfinished README or uncommitted edits need a continuation.

**How to apply:** every spawn brief carries: "keep every tool call short — one suite per call;
anything over ~2 minutes runs in the background with its output to a log you then read".
Recovery: inspect the worktree (`git status`, `git log base..HEAD`), then either finish the
mechanical remainder yourself (gates, README evidence, hash remap) or spawn a fresh agent on the
SAME worktree with a brief that states the commits so far and the dirty files. `SendMessage` to
resume a finished agent may be disabled in a session — plan for the fresh-agent path.
Related: [[worktree-agent-hazards]], [[model-tier-and-worktree-policy]].

---

## never-git-stash-in-worktrees.md


Never use `git stash` to get a clean baseline in a hope-v2 worktree. The stash
stack lives in the shared `.git` and is visible to the main repo and every
worktree at once. With sibling agents running, another session can push or pop
between your `stash` and your `stash pop`, so your `pop` restores *their* WIP
into *your* tree and your work stays stranded in the stack.

Observed 2026-08-20: a `stash -u` / `stash pop` pair to measure a test baseline
dumped 175 unrelated modified files from another session into the worktree and
left my own 8 files in `stash@{0}`.

**Why:** stashes are per-repository, not per-worktree, and are ordered by a
stack the other sessions are also mutating.

**How to apply:** to compare against a baseline, commit your work to the agent
branch first, then `git checkout HEAD~1 -- <path>` to look at the old state and
`git checkout HEAD -- <path>` to come back. Both are worktree-local and immune to
concurrent sessions. If you find yourself holding someone else's restored WIP,
re-stash it with a labelled message rather than discarding it. See
[[worktree-agent-hazards]].

---

## config-tenant-first-no-hardcoding.md


Owner directive (2026-08-16), applies to every service and every new surface:

1. **Configuration is never hardcoded and rarely an env var.** No engine, model,
   endpoint, credential, threshold, prompt or taxonomy may be a literal in code, and
   env vars are reserved for the bootstrap floor (what is needed to reach the DB or
   authenticate to Vault). Everything else is `db-config` / `vault-kv` / `global-kv` /
   `redis-flag` / `entitlement`.
2. **Resolution order is always tenant → SYSTEM. Two tiers, no third.** A tenant admin
   may configure or BYO-key as much as possible; the platform admin's SYSTEM-tenant rows
   are the *fallback* for tenants that expressed no opinion — never a ceiling that
   silently overrides a tenant's own choice. `AiProviderConnection` (three states:
   absent = no opinion, enabled+keyed = tenant wins, disabled = veto) is the reference
   implementation.

**The two reserved tenants are not two tiers** (owner clarification 2026-08-16):
`00000000-…` SYSTEM is a config TIER holding platform defaults and fallbacks;
`50000000-…` ("Global", `SEED_TENANT_ID`) is a **customer tenant** used as a
platform-admin playground for trialling config before promoting it into SYSTEM.
Promotion is an explicit admin action. "Global" must never appear in a runtime
cascade, and a request with no tenant context resolves SYSTEM — never a customer.
A `default_tenant_id` / "fallback tenant" knob pointing at `50000000-…` is the
failure mode to watch for; it was live in `apps/guardrail` until TASK-735/736.

**Owner ruling 2026-08-20 (TASK-763 OD-1) — the lifecycle, stated whole:** SYSTEM is
the reference point every tenant defaults to. A NEW TENANT IS PROVISIONED BY CLONING
SYSTEM's configuration, so SYSTEM is not only a read-time fallback but the seed of each
tenant's own rows. GLOBAL (`50000000-…`) is where super admins trial any configuration;
once validated it is SYNCED/PROMOTED from GLOBAL into SYSTEM — an explicit
update/transform/release step — and only then does every other tenant see it. This
settles the contradiction between `00-project-context.md` (cascade is tenant → SYSTEM)
and `09-infrastructure-devops.md` (which appeared to sanction Global as a platform
tier): the runtime cascade never reads GLOBAL; GLOBAL reaches other tenants only
through promotion into SYSTEM. Runtime code that ranked Global ABOVE SYSTEM
(`PLATFORM_TENANT_IDS`, `entitlements.constants.ts`, `rate-limit.constants.ts`) is
therefore wrong and is being corrected.

**Why:** the platform is multi-tenant healthcare AI; tenants must be able to run on
their own vendor accounts and their own models, and a value baked into an image or an
env var cannot change without a redeploy.

**How to apply:** when adding config, register a `SettingDescriptor` (or an
`AiTaskDefault` / `AiProviderConnection` row) instead of a `pydantic-settings` field
with a real default; when reading it, resolve the request tenant first and widen to
the SYSTEM tenant only when the tenant row is absent. A `pydantic-settings` default is
acceptable only as a bootstrap-transport address, never as an identity or a policy
value. Known outstanding violation: the guardrail service — see
[[guardrail-must-delegate-to-text-and-nlp]].

---

## pre-production-build-for-day-one.md


As of 2026-08-17 the platform has not gone live: no real tenants, no consultation traffic,
no production rows. Owner directive on the TASK-700..739 program: finish every approved ticket
"completely and properly for production day-1".

**Why:** many tickets shipped with enforcement switched OFF (consent, validator rules, exposure)
because enabling them might brick existing charts. There are no existing charts. That justification
is void, and "half-built behind a flag, decide later" is no longer an acceptable outcome.

**How to apply:** (1) Migrations, shadow-DB proofs, seed resets and destructive operations against
LOCAL dev/test databases proceed without further consent. (2) When a ticket offers "build it but
leave it off pending a posture decision", build it ON instead. (3) The blocking decisions this
dissolved: legacy-consent posture, DNA scan authorization, validator clinical review (a doctor team
reviews later), eval-gate backend. See [[agentic-workflow-platform-design]] and
`docs/architecture/agentic-workflow-platform/owner-decisions-2026-08-17.md`.

Two things it does NOT dissolve: the Figma design gate is waived but the implementation gates
(semantic tokens, both themes, WCAG 2.2 AA + 0-violation axe scan) still stand; and cluster or
deployed-environment work still needs a human — TASK-730 is deliberately deferred until all local
implementation and e2e are finished.

---

## deprecate-then-remove-after-two-releases.md


Owner directive 2026-09-04: "old/unused code must be marked as deprecated and we will remove those
deprecated after next 2 releases." Two exceptions were stated or implied in the same brief: seed data
is removed immediately (no production data — see [[pre-production-build-for-day-one]]), and a feature
the owner names for complete removal (Provider Reconciliation) is deleted outright.

**Why:** the platform is pre-production but integrators already consume SDK/API surfaces; a
two-release window keeps bookmarks, generated SDK resources and Python peers working while the
replacement lands.

**How to apply:** never delete a retired model/route/screen/package in the same change that ships its
replacement; add the marker (Prisma doc comment, `@deprecated` JSDoc, `DeprecationWarning`,
`@ApiDeprecated` + `Deprecation`/`Sunset` headers, `redirect()` stub, `package.json#deprecated`) and a
row in `docs/operations/deprecation-register.md` with the removal release. The register's release
placeholders (R1..R4) are waiting on the owner to name concrete tags (TASK-859 OD-2). Related:
[[ai-platform-consolidation-program-859]].

---

## one-shared-internal-service-token.md


Owner directive 2026-08-17: internal service communication uses a **single shared access token**,
set by the DevOps engineer, identical across every service, internal use only.

**Why:** it is an operational simplification the owner has chosen deliberately. Do not design
per-service tokens, per-pair tokens, or per-service rotation — proposing that architecture is
re-litigating a settled decision.

**How to apply:** this token is the sanctioned exception to [[config-tenant-first-no-hardcoding]]'s
"no configuration in env vars" rule — it is bootstrap-floor material, delivered from Vault in
deployed environments and declared in `turbo.json#globalEnv`. Everything else stays DB/Vault
resident. Pair it with the other half of the internal-call contract: `X-Tenant-Id` is MANDATORY on
every internal request carrying tenant-scoped work, and an absent header is a defect in the caller
(TASK-737/738).

---

## api-boot-audits-need-a-boot-smoke.md


`apps/api/src/main.ts` runs boot-time audits (`bootstrap/service-account-surface-audit.ts`,
the admin-scope audit, the deny-by-default authz audit). One of them refuses to start when an
admin route declares NOTHING about service-account access — "silence is ambiguous" — so a
controller that intends deny-by-default must say `@ForbidServiceAccount()` (or declare
`svc:*` scopes) explicitly. TASK-886 (2026-09-06) shipped such a controller with 4177 API unit
tests green, typecheck clean, artifacts regenerated — and the gateway would not boot; the
orchestrator's e2e run was the first thing to notice.

**Why:** unit suites construct controllers directly and never run `main.ts`; the manifest
regeneration doesn't boot either. A green chain says nothing about startup.

**How to apply:** any lane that adds or edits a controller pastes a boot line —
`pnpm api:build` then `NODE_ENV=test node apps/api/dist/main` (or `pnpm test:up:api`) until
`/api/v1/health` answers — as part of its gates. Recorded as a lane rule in the TASK-870
README. Also: `pnpm test:up:api` launches `nest --watch` into `apps/api/dist`; a second watcher
(the owner's) on the same dist makes `api:build`'s `rimraf` race and fail — check
`lsof -nP -iTCP:8968` before building. Related: [[e2e-test-api-launcher-pins-8968]],
[[subagent-watchdog-600s]].

---

## e2e-test-api-launcher-pins-8968.md


`pnpm test:up:api` (`scripts/start-test-app.sh api`) refuses to start while anything holds 8968
("port 8968 is already in use (PID …)"), and launches through `npx dotenv -o -e .env.test`, so a
host `PORT=8969` is overridden by the file's `PORT=8968` — running a second test API on another
port is not possible through the script. Playwright's own base URL IS overridable (`API_URL`),
which is only useful if an API already listens elsewhere.

**Why:** two e2e attempts in TASK-870 (2026-09-06) aborted on this; the listener turned out to be
the owner's own test-environment API (`NODE_ENV=test`, `nest` under the same launcher) serving
the current HEAD — the health endpoint's `version` (`0.0.0-<branch>.<sha8>`) proves which tree it
runs. Running the specs against it (nothing started or stopped) gave a valid 60/60.

**How to apply:** before killing or waiting, `curl :8968/api/v1/health` and read `version`; if it
is the current HEAD and `NODE_ENV=test`, run `RESET_DB=false npx dotenv -e .env.test -- npx
playwright test <specs>` against it. Never kill a listener this session did not start (the owner
runs their own watch/test APIs on 8968); ask instead. Related: [[zsh-bash-tool-pitfalls]].

---

## skip-tests-playgrounds-and-ui.md


Ignore the unit tests of `apps/compat-playground` (`@arcaai/compat-playground`),
`apps/quick-compat-app` (`quick-compat-app`), and `packages/ui` (`@arcaai/ui`).
Run a suite there ONLY when the change itself lives in that workspace.

**Why:** owner directive 2026-08-19 — those suites are noise for everything else and
their failures were being treated as gates on unrelated work.

**How to apply:** don't include them in verification runs; when a repo-wide aggregate
(`pnpm verify`, `pnpm test:unit`) surfaces their failures and your change is elsewhere,
report them as out of scope instead of fixing. Encoded in
`.claude/rules/01-development-workflow.md` §Test Scope Exclusions.

---

## zsh-bash-tool-pitfalls.md


The Bash tool here is zsh, not bash. Traps hit repeatedly during TASK-870 (2026-09-05):

- `set -- $var` and `for f in $var` do NOT word-split an unquoted variable — `$1` is the whole
  string, the loop runs once. Use a function with explicit positional args (`prep 879 name`),
  `while read a b`, or `${=var}`.
- `$s:test` is a zsh modifier, not `$s` + `:test` — write `"${s}:test"`.
- `${PIPESTATUS[0]}` is empty; capture `$?` directly (or use `pipestatus`, lowercase).
- Capturing pytest output in `$(...)` fails on non-UTF-8 bytes ("character not in range") —
  write suites to a log file and `grep -a`.
- The interactive `conda` is a shell function that dies with `__conda_exe: permission denied`
  when invoked from a subshell in a subdirectory — go through `sh -c 'conda run …'` or the
  root `pnpm <svc>:test` scripts, which run under sh.
- A leading `cd <worktree> && …` persists for the WHOLE command: a later `git merge` ran inside
  the worktree and merged the branch into itself (a silent no-op). Use absolute paths, or `cd`
  back before any git write.

**Why:** each of these produced a plausible-looking but wrong result (a "successful" merge that
did nothing, a loop that "removed" nothing, a gate that "passed" with 0 tests) rather than an
error.

**How to apply:** when a Bash step touches git state or iterates over a list, prefer absolute
paths and explicit functions; verify the effect (`git log -1`, counts) instead of trusting rc=0.
Related: [[worktree-agent-hazards]], [[never-git-stash-in-worktrees]].

---

## hope-v2-checkout-filter-branch-rewrites-history.md


Observed 2026-09-03 (reflog: `filter-branch: rewrite` at ~8 h and ~16 min marks): the local
`dev-2.2` in `~/Desktop/igglo/ARCAAI/hope-v2` was rewritten so every commit since the last
rebase point got a new hash — the only change was the removal of the
`Co-Authored-By: Claude …` trailer; trees were identical to what had been pushed. A naive
`git push` would then be non-fast-forward.

**Why:** a sibling session / hook enforces commit-message hygiene on this checkout by
rewriting history rather than by a pre-commit rule.

**How to apply:** before pushing, compare `git log origin/dev-2.2..HEAD` with
`git log HEAD..origin/dev-2.2`; if twins appear, do NOT force-push. Save a backup ref, then
`git checkout -B dev-2.2 origin/dev-2.2` and re-apply only the genuinely unpushed work
(`git checkout <backup> -- <files>` + one commit). Cherry-picking the rewritten commits can
abort on "empty" picks. Related: [[never-git-stash-in-worktrees]], [[worktree-agent-hazards]].

---

## new-sprint-no-old-tickets.md


As of 2026-08-15 HOPE is in a **new sprint**. Do not refer to, search for, or anchor
analysis on old ticket numbers (`TASK-XXX`), `docs/implementation/TASK-*`, or
`docs/archive/**`. TASK-654 specifically was **archived** — it is not a design baseline.

**Why:** the old ticket tree carries superseded designs and stale plans. Anchoring on it
makes new work inherit decisions the team has already dropped, and turns an assessment of
*what the code does* into an assessment of *what a retired document said it would do*.

**How to apply:** assess and design against the CODE AS IT IS TODAY plus the current
sprint's reference artifacts. Reading `docs/implementation/**` to understand existing
runtime behavior is fine; inheriting its plans, ticket ids, or roadmaps is not. When new
work needs a ticket number, follow the numbering rule in
[[hope-ticket-workflow]] only if the user asks for one — do not back-reference old ones.
Related: [[concurrent-sessions-destroy-work]].

