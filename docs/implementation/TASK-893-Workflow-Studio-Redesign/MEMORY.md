# TASK-893 — memory snapshot

Verbatim copies of the orchestrator's persistent memory files that govern this ticket, taken 2026-09-08 from
`~/.claude/projects/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/memory/`. The memory files stay the live source;
this snapshot exists so the ticket folder carries every decision, hazard and working rule the wave was run under.

| File | One-line hook |
|---|---|
| `task-893-workflow-studio-redesign.md` | TASK-893 Phase 1 shipped and pushed 2026-09-07; why deprecated node types still exist; Phases 2-4 planned but unstarted. |
| `task-930-931-893-wave-in-flight.md` | 2026-09-08 five-lane wave (TASK-893 R, TASK-930 N/P/S, TASK-931 K) in worktrees ../hope-v2-t{893-r,930-n,930-p,930-s,931-k} — UNMERGED while in flight; merge order N→P→R→S→K into dev-2.2; then regen seeds, artifacts, DB reset, local tests, SDK 3.1.0 publish, ALaaS. |
| `parallel-lane-orchestration-lessons.md` | What made a five-lane parallel worktree fan-out merge with zero conflicts, and the defect classes it did and did not catch. |
| `model-tier-and-worktree-policy.md` | Owner rules for delegating work — pick the model tier by task complexity, and every subagent works in its own git worktree, merged to feat/loop by the orchestrator. |
| `worktree-agent-hazards.md` | Three traps when running parallel subagents in hope-v2 git worktrees — stale base, conda editable installs, unbuilt node_modules. |
| `subagent-watchdog-600s.md` | Background subagents die after 600 s without tool output; long suites must be backgrounded to a log, and a stalled lane is recovered by a fresh agent on the same worktree |
| `deprecate-then-remove-after-two-releases.md` | Owner rule (2026-09-04) — old/unused code is marked deprecated first and removed only after the next two releases; seeds and owner-named removals are the exceptions. |
| `pre-production-build-for-day-one.md` | HOPE has no production data yet, so ship features complete and ENABLED for day-1 rather than flag-gated |

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

