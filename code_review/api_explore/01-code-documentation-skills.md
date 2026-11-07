# Code Documentation Skills — Recommendation for `apps/api`

- **Date:** 2026-10-23
- **Companion to:** `00-skills-and-plan.md` (testing/review skills and execution plan)
- **Target:** `apps/api` (`@arcaai/api`) — NestJS 11 gateway, 926 source files, 749 routes
- **Install constraint:** all installs MUST be **global** (`-g`) or manual into `~/.config/opencode/skill/`. A project-level install would write into `project-hope` and violates the "no writes in the repo" rule.
- **DECISION (2026-10-23):** use `acquire-codebase-knowledge` (not `doc-and-modernize`) and `create-architectural-decision-record` (not `documentation-and-adrs`). The final install list is in `02-install-set.md`.

---

## 1. Selection criteria

A documentation skill is only useful on this codebase if it:

1. **Is local-first** — reads the actual repository files instead of generating plausible prose from a template.
2. **Produces a checkable artifact** — a file tree, route table, ADR, diagram source, or diff — not just advice.
3. **Handles a large codebase** — 87 controllers / 145 modules / 749 routes will break a skill that assumes a small app.
4. **Separates reference from explanation** — Diátaxis-style structure, so the endpoint reference does not turn into narrative prose.
5. **Can run read-only** — important because this gateway carries PHI, tenancy, and consent logic.

---

## 2. Recommended core stack (install these four)

| # | Skill | Source / install | What it does | Where it fits |
|---|---|---|---|---|
| 1 | `acquire-codebase-knowledge` | `npx skills@latest add github/awesome-copilot --skill acquire-codebase-knowledge -g -a opencode` | Local-first codebase mapping and onboarding: reads the repository to produce architecture/onboarding docs. | Phase 1–2: architecture + module map |
| 2 | `documentation-writer` | `npx skills@latest add github/awesome-copilot --skill documentation-writer -g -a opencode` | Diátaxis expert: tutorial / how-to / reference / explanation, with audience, goal, and scope fixed before drafting. | Phase 2–3: shape the whole doc set, especially the API reference |
| 3 | `create-architectural-decision-record` | `npx skills@latest add github/awesome-copilot --skill create-architectural-decision-record -g -a opencode` | Produces standalone, structured ADRs for decisions and their rationale. | Phase 4: record why the guard pipeline, tenancy model, OCC, and envelope design are the way they are |
| 4 | `writing-guidelines` | `npx skills@latest add vercel-labs/agent-skills --skill writing-guidelines -g -a opencode` | Reviews docs/prose for voice, tone, and handbook compliance — a lint pass for documentation. | Phase 8: final editorial QA before hand-off |

**Why these four:** they cover the four distinct jobs that "documentation" collapses together — *understand the system*, *structure the doc set*, *record decisions*, and *edit the result*. They do not overlap much, and none of them replaces `archify` for diagrams.

---

## 3. Situational add-ons (install only if the need appears)

| Skill | Source | Use when |
|---|---|---|
| `lean-comments` | `github/awesome-copilot` | You want a deliberate pass over inline comments / TSDoc in `src/**`. It defaults to "no comment unless it preserves non-obvious intent" — a good counterweight to comment spam in a 926-file tree. |
| `docs-sync-audit` | `github/awesome-copilot` | Read-only drift audit: compares what the docs claim against what the code does. Excellent final gate for `apps/api/docs/*` and `README.md`, which may already lag the 749-route manifest. |
| `code-tour` | `github/awesome-copilot` | Produce a persona-targeted onboarding tour (`.tour` file) with real file/line links — useful for the "new engineer joining the gateway team" audience. |
| `create-architectural-decision-record` | `github/awesome-copilot` | Only if you want standalone ADR files separate from `documentation-and-adrs`. Pick one of the two, not both. |
| `acquire-codebase-knowledge` | `github/awesome-copilot` | Alternative to `doc-and-modernize` for a shorter "map + onboard" output. Do not install both; `doc-and-modernize` is the better fit for a comprehensive architecture doc. |
| `architecture-blueprint-generator` | `github/awesome-copilot` | Generates stack/pattern/folder blueprints with diagrams. Overlaps `doc-and-modernize` + `archify`; use only if you want its specific blueprint template. |
| `test-gap-audit` | `github/awesome-copilot` | **Adjacent, not documentation.** Read-only audit for missing/weak/stale/mis-scoped coverage. Pairs well with `typescript-testing` for the coverage-gap report. |
| `security-review` | `github/awesome-copilot` | **Adjacent, not documentation.** Data-flow-aware security review. Relevant for the auth/tenancy/consent surface and the code-review deliverable. |
| `skill-creator` | `anthropics/skills` | Author the two custom skills proposed in `00-skills-and-plan.md` (`nestjs-gateway-docs`, `test-coverage-gap-analysis`) with proper triggering and evals. |

Install examples:

```bash
npx skills@latest add github/awesome-copilot --skill lean-comments -g -a opencode
npx skills@latest add github/awesome-copilot --skill docs-sync-audit -g -a opencode
npx skills@latest add github/awesome-copilot --skill code-tour -g -a opencode
npx skills@latest add github/awesome-copilot --skill test-gap-audit -g -a opencode
npx skills@latest add github/awesome-copilot --skill security-review -g -a opencode
npx skills@latest add anthropics/skills --skill skill-creator -g -a opencode
```

---

## 4. Deliberately **not** recommended

| Skill | Why not |
|---|---|
| `doc-and-modernize` | Alternative considered; `acquire-codebase-knowledge` was chosen instead. Do not install both. |
| `documentation-and-adrs` | Alternative considered; `create-architectural-decision-record` was chosen instead. Do not install both. |
| `csharp-docs`, `java-docs` | Wrong language; this is TypeScript/NestJS. |
| `aspnet-minimal-api-openapi`, `openapi-to-application-code` | Generates apps from OpenAPI; the gateway already emits `openapi.json`. |
| `oo-component-documentation` | Object-oriented component template; does not model NestJS modules, guards, or DI. |
| `create-readme` / `readme-blueprint-generator` | The package already has a strong 11 KB `README.md`; regenerating it would lose curated detail. |
| `create-llms` / `update-llms` | Only useful if you intend to publish an `llms.txt` for agent consumption — not part of this task. |
| `doc-coauthoring` (Anthropic) | Structured co-authoring workflow for specs/proposals; heavier than needed and overlaps `documentation-writer`. |
| Generic "technical writer" persona skills | Persona prompts, not procedures; they produce prose without repository evidence. |

---

## 5. Overlap and conflict map

```text
UNDERSTAND THE SYSTEM
  acquire-codebase-knowledge ── CHOSEN (architecture doc, local-first)
  doc-and-modernize ── alternative (not installed)
  architecture-blueprint-generator ── optional template (overlaps both)
  codebase-memory-mcp ── symbol/relationship graph (heavy; only if needed)
  archify (already installed) ── diagrams, not prose

STRUCTURE THE DOC SET
  documentation-writer (Diátaxis) ── primary
  code-tour ── onboarding walkthrough artifact

RECORD DECISIONS
  create-architectural-decision-record ── CHOSEN
  documentation-and-adrs ── alternative (not installed)

DOCUMENT THE CODE ITSELF
  lean-comments ── inline comments / TSDoc

VERIFY AND EDIT
  docs-sync-audit ── code-vs-docs drift (read-only)
  writing-guidelines ── prose QA

ADJACENT (review, not docs)
  typescript-testing, test-gap-audit, security-review, archify-review
```

---

## 6. How these slot into the existing 8-phase plan

| Phase | Skill |
|---|---|
| 1 — static code map | `doc-and-modernize` |
| 2 — route inventory + doc structure | `documentation-writer` |
| 3 — diagrams | `archify` (already present; documentation skills do not replace it) |
| 4 — code review + decisions | `documentation-and-adrs`, `archify-review`, `security-review` |
| 5 — test inventory | `typescript-testing`, `test-gap-audit` |
| 6 — coverage gap report | `typescript-testing`, `test-gap-audit` |
| 7 — traceability matrix | `documentation-writer` + generated artifacts |
| 8 — editorial QA | `writing-guidelines`, `docs-sync-audit` |

---

## 7. Security and hygiene notes

- These are **third-party** skills. Before installing, read the `SKILL.md` and check the audit page at `https://skills.sh/audits`. This repository handles PHI and tenant data; a documentation skill only needs read access, so reject anything that asks for network calls, credential access, or write operations.
- `github/awesome-copilot` is a very large collection; installing one skill with `--skill <name>` avoids pulling the whole catalog.
- Use `-g` (global) as shown. If `npx skills` cannot detect OpenCode, install manually into `~/.config/opencode/skill/<skill-name>/SKILL.md`.
- Pin what you install. `npx skills list` and `npx skills update` manage drift; record versions in `01-environment.md` when the review starts.

---

## 8. Recommended install order

```bash
# 1. Core documentation stack
npx skills@latest add github/awesome-copilot --skill acquire-codebase-knowledge -g -a opencode
npx skills@latest add github/awesome-copilot --skill documentation-writer -g -a opencode
npx skills@latest add github/awesome-copilot --skill create-architectural-decision-record -g -a opencode
npx skills@latest add vercel-labs/agent-skills --skill writing-guidelines -g -a opencode

# 2. Review/coverage companions (from 00-skills-and-plan.md)
npx skills@latest add github/awesome-copilot --skill test-gap-audit -g -a opencode
npx skills@latest add github/awesome-copilot --skill security-review -g -a opencode

# 3. Only if you will author the custom NestJS skills
npx skills@latest add anthropics/skills --skill skill-creator -g -a opencode
```

---

## 9. Log of this session

- Enumerated the installable catalog with `npx skills add <repo> -l` (dry run, no installs performed).
- Verified the exact skill names and descriptions used in this document.
- Confirmed OpenCode is an accepted `--agent` target.
- No skills were installed and nothing was written inside `/Users/apple/repos/VOX/project-hope`.