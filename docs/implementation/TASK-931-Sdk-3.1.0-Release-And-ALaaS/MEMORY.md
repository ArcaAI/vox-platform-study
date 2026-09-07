# TASK-931 — memory snapshot

Verbatim copies of the orchestrator's persistent memory files that govern this ticket, taken 2026-09-08 from
`~/.claude/projects/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/memory/`. The memory files stay the live source;
this snapshot exists so the ticket folder carries every decision, hazard and working rule the wave was run under.

| File | One-line hook |
|---|---|
| `task-930-931-893-wave-in-flight.md` | 2026-09-08 five-lane wave (TASK-893 R, TASK-930 N/P/S, TASK-931 K) in worktrees ../hope-v2-t{893-r,930-n,930-p,930-s,931-k} — UNMERGED while in flight; merge order N→P→R→S→K into dev-2.2; then regen seeds, artifacts, DB reset, local tests, SDK 3.1.0 publish, ALaaS. |
| `deprecate-then-remove-after-two-releases.md` | Owner rule (2026-09-04) — old/unused code is marked deprecated first and removed only after the next two releases; seeds and owner-named removals are the exceptions. |
| `no-local-container-image-builds.md` | Never build container images locally — GitLab CI is the only builder; author the Dockerfile and its CI job instead. |
| `hope-v2-checkout-filter-branch-rewrites-history.md` | Something in the hope-v2 primary checkout periodically runs `git filter-branch` that strips the Co-Authored-By trailer, so local dev-2.2 hashes diverge from origin (same trees) — never force-push; re-anchor on origin and re-commit. |
| `model-tier-and-worktree-policy.md` | Owner rules for delegating work — pick the model tier by task complexity, and every subagent works in its own git worktree, merged to feat/loop by the orchestrator. |
| `subagent-watchdog-600s.md` | Background subagents die after 600 s without tool output; long suites must be backgrounded to a log, and a stalled lane is recovered by a fresh agent on the same worktree |

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

## no-local-container-image-builds.md


Owner directive, 2026-08-30: **do not build container images locally — the GitLab CI
pipeline builds them.** Given while a subagent was building an LM Studio GPU image
(TASK-824) and applied to every lane, not just that one.

**Why:** CI is the only builder whose output is reproducible, digest-pinned and
promotable. A local build proves nothing about the artifact that ships — images are
promoted by DIGEST from a `dev-*`/`staging-*` pipeline (`.gitlab/ci/promote.sh`), never
rebuilt, so a laptop-built image can never become the deployed one. It also burns
minutes and disk on GPU/ML base layers for no verifiable gain.

**How to apply:** a Dockerfile change is AUTHORED, and argued from the file plus its
`.gitlab/ci/*` job — never from a local build log. Never offer "image builds
successfully" as evidence; if a lane already has a local build result, discard it as
evidence explicitly. Static checks remain fine: hadolint, YAML lint, reading published
base-image tags. When this leaves something unverifiable locally, say so and name what
CI must prove instead rather than substituting a local build.

Related: [[pre-production-build-for-day-one]], [[worktree-agent-hazards]].

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

