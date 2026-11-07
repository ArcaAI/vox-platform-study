# Final Install Set — Decisions Applied

- **Date:** 2026-10-23
- **Decisions:** `acquire-codebase-knowledge` replaces `doc-and-modernize`; `create-architectural-decision-record` replaces `documentation-and-adrs`.
- **Install scope:** **global only** (`-g`) so nothing is written inside `project-hope`.

---

## 1. Already available — do **not** install

| Skill | Use |
|---|---|
| `archify` | Architecture, module, sequence, and state-machine diagrams |
| `archify-review` | Evidence-based code review (value / cost / impact) |
| `typescript-testing` | Vitest/Playwright execution, coverage, failure triage |

These three are present in the current session. `python-testing`, `report`, and `opencode` are also present but are out of scope for `apps/api`.

---

## 2. Install now — 4 skills

| # | Skill | Source | Purpose in this task |
|---|---|---|---|
| 1 | `acquire-codebase-knowledge` | `github/awesome-copilot` | Local-first mapping and onboarding: reads the actual 926-file gateway and produces the architecture/module picture |
| 2 | `documentation-writer` | `github/awesome-copilot` | Diátaxis structure — separates reference (749 routes) from explanation and how-to |
| 3 | `create-architectural-decision-record` | `github/awesome-copilot` | ADRs for the guard pipeline, tenancy isolation, consent/ABAC, OCC, error envelope, and boot-time audits |
| 4 | `writing-guidelines` | `vercel-labs/agent-skills` | Final prose/voice QA pass over the completed doc set |

### Commands

```bash
npx skills@latest add github/awesome-copilot --skill acquire-codebase-knowledge -g -a opencode
npx skills@latest add github/awesome-copilot --skill documentation-writer -g -a opencode
npx skills@latest add github/awesome-copilot --skill create-architectural-decision-record -g -a opencode
npx skills@latest add vercel-labs/agent-skills --skill writing-guidelines -g -a opencode
```

---

## 3. Deferred — install only if the need appears

| Skill | Install when |
|---|---|
| `lean-comments` | You want a deliberate inline-comment / TSDoc pass over `src/**` |
| `docs-sync-audit` | Final read-only check that `apps/api/docs/*` and `README.md` still match the code |
| `code-tour` | You want a contributor onboarding `.tour` file with real file/line links |
| `test-gap-audit` | Complement to `typescript-testing` for the "what is not tested" register |
| `security-review` | Complement to `archify-review` for the auth/tenancy/consent review |
| `skill-creator` | Only if authoring the custom `nestjs-gateway-docs` / `test-coverage-gap-analysis` skills |

```bash
npx skills@latest add github/awesome-copilot --skill lean-comments -g -a opencode
npx skills@latest add github/awesome-copilot --skill docs-sync-audit -g -a opencode
npx skills@latest add github/awesome-copilot --skill code-tour -g -a opencode
npx skills@latest add github/awesome-copilot --skill test-gap-audit -g -a opencode
npx skills@latest add github/awesome-copilot --skill security-review -g -a opencode
npx skills@latest add anthropics/skills --skill skill-creator -g -a opencode
```

---

## 4. Phase mapping

| Phase | Skills active |
|---|---|
| 1 — static code map | `acquire-codebase-knowledge` |
| 2 — route inventory + doc structure | `documentation-writer` |
| 3 — diagrams | `archify` |
| 4 — code review + decisions | `archify-review`, `create-architectural-decision-record` (optional: `security-review`) |
| 5 — test inventory | `typescript-testing` (optional: `test-gap-audit`) |
| 6 — coverage gaps | `typescript-testing` (optional: `test-gap-audit`) |
| 7 — traceability matrix | `documentation-writer` + generated artifacts |
| 8 — editorial QA | `writing-guidelines` (optional: `docs-sync-audit`, `lean-comments`) |

---

## 5. Verification after install

```bash
npx skills list
```

Expected new entries: `acquire-codebase-knowledge`, `documentation-writer`, `create-architectural-decision-record`, `writing-guidelines`.

If OpenCode does not pick them up automatically, restart the session. If the CLI cannot target OpenCode, place each skill manually at `~/.config/opencode/skill/<skill-name>/SKILL.md`.

---

## 6. Safety check

Read each `SKILL.md` before the first run. Documentation work needs read-only repository access; reject any skill that requests network access, credentials, or write operations. This gateway carries PHI and tenant data.