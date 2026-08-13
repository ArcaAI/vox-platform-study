# Agent Operating Contract — TASK-617 … TASK-626

Shared by every ticket in the TASK-616 phase program. Each ticket README links here rather
than restating it. Derived from [TASK-616 Appendix D §D0](../TASK-616-Deployment-CICD-Observability-Modernization/execution-plan.md)
and re-confirmed against the live cluster on 2026-08-08.

---

## 1. Tier mapping

| Task complexity | Tier | Effort | Use for |
|---|---|---|---|
| Trivial / simple | `haiku-4-5` | default | Classification, formatting, extraction, short lookups, simple rewrites, one-line manifest edits, doc-claim corrections, dead-file deletion |
| Moderate | `sonnet-5` | medium–max | Summarization, standard coding, single-concern manifest authoring, one CI job, data transformation, Q&A over provided context |
| Complex | `sonnet-5` or `opus-4-8` | medium–max | Multi-file changes with tradeoffs, cross-service code changes, structured reasoning, agentic tool use, policy authoring |
| Very high | `opus-5` or `fable-5` | medium–max | Architecture design/re-design, PHI-safety-critical design, irreversible migrations, blast-radius-wide policy, ambiguous open-ended problems |

## 2. Four rules that override the tier table

1. **Agents author; they do not mutate live infrastructure.** Every agent task produces a *diff,
   manifest, script, or analysis* that is reviewed before it touches a cluster. No agent holds
   `kubectl apply`, `vault write`, `argocd app sync`, or `git push` to the deployment repo.
   Cluster mutations are marked **⚙ human-applied** and are listed separately in each ticket.
2. **Irreversible or PHI-touching work gets a tier bump**, regardless of mechanical complexity.
   Secret rotation is a simple script and a very-high-consequence action.
3. **Blocked-on-owner work is never assigned to an agent.** Proxmox VM provisioning, Cloudflare
   ingress rules, Entra ID app registration, GitLab admin actions, runner registration, and every
   ⚠ decision. Agents may *prepare* these (write the exact command, the exact manifest) but not run them.
4. **Read-only live inspection is allowed and encouraged.** Rancher/ArgoCD MCP reads, `kubectl get`,
   log reads, and Prometheus queries are how an agent grounds a claim. Writes are not.

## 3. Verification is not self-reported

Each task's gate is checked by the reviewer of the diff — never asserted by the agent that wrote it.
Where a gate needs live evidence (a pod actually starting, a trace actually landing, an alert
actually arriving), that evidence is captured **after** the human applies the change, and pasted
into the ticket's Implementation Summary.

An agent that cannot verify its own work says so explicitly. "Should work" is not a gate.

## 4. Task-brief template

Every agent dispatched under these tickets receives a brief in this shape. Anything missing from
the brief is a defect in the brief, not a licence for the agent to improvise.

```
TICKET:      TASK-6xx
TASK ID:     x.y
TIER:        haiku-4-5 | sonnet-5 | opus-4-8 | opus-5 | fable-5
EFFORT:      default | medium | high | max

GOAL:        <one sentence — the outcome, not the activity>

REPO:        hope-v2 | hope-v2-deployment   (absolute path given)
FILES:       <the exact files expected to change; "discover" only when genuinely unknown>

CONTEXT:     <the findings this task closes, by ID, with their file:line or live citation>

CONSTRAINTS: <what must not change; conventions to match; the CLAUDE.md rule file that governs>

DELIVERABLE: <diff | new file | analysis doc | script> — and where it is written

GATE:        <the checkable condition; who checks it; what evidence is captured>

DO NOT:      apply to any cluster · push to any remote · rotate any credential ·
             modify files outside FILES without reporting why
```

## 5. Concurrency and isolation

- Agents that touch **disjoint file sets** run concurrently in the same worktree.
- Agents that touch **overlapping files** either run sequentially or use `isolation: "worktree"`.
  In this program, the deployment repo's `base/` manifests are the main contention point — the
  per-service manifest tasks are partitioned by service so they stay disjoint.
- Peak concurrency is capped at **6** per ticket. The bottleneck is review, not compute: a wave of
  16 diffs that nobody can read is slower than 6 that get merged.

## 6. What must never be delegated

| Item | Why |
|---|---|
| Proxmox VM creation, Cloudflare ingress rules, Entra ID registration | No capability |
| Every `kubectl apply` / `vault write` / deployment-repo `git push` | Agents author; humans apply. Non-negotiable on a PHI platform |
| Secret rotation | Irreversible, and the actual security boundary of any secrets migration |
| Enabling Argo `prune` / `selfHeal` | Deletes untracked live state. See LIVE-06 — `hope-ui` dies the moment prune is on |
| k3s hardening flag application | Cluster-wide restart; recoverable only if the join token is in Vault **first** |
| SLI/SLO definition | A product decision about what "good" means |
| The hybrid AWS boundary | A business/cost decision; the agent supplies analysis, the owner decides |
