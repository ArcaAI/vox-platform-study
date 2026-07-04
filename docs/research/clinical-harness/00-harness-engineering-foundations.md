# 00 · Harness Engineering — Foundations

> What "harness engineering" is, the control model to adopt, the agent building blocks, and context-engineering
> techniques. Source-grounded; the conceptual base for the HOPE Clinical Documentation Harness.

---

## 1. The three-layer evolution → `Agent = Model + Harness`

| Layer | Answers | Era |
|---|---|---|
| **Prompt engineering** | "What do I *say* this turn?" | 2022–24 |
| **Context engineering** | "What *information lands in the window* before it reasons?" | 2025 |
| **Harness engineering** | "What happens *around* the model — loop, tools, checks, memory, gates — and **what happens when it's wrong**?" | 2026 |

The **harness** is *everything in an agent that isn't the model*: the orchestration loop, tool definitions,
retries, the context pipeline, validation/guardrails, memory, permissions, and observability. The term was coined
by **Mitchell Hashimoto** (Feb 2026) and formalised by **Birgitta Böckeler / Martin Fowler** (Apr 2026) [1],
building on Anthropic's [2][3] and OpenAI's agent-engineering work.

**Core equation:** `Agent = Model + Harness`. A capable model with a weak harness is an unreliable agent; a
disciplined harness turns a probabilistic model into a dependable, verifiable, auditable system — which is exactly
what a regulated clinical workflow requires.

## 2. Böckeler's control model — *the mental model to adopt* [1]

A harness is a **cybernetic control system** with **two control types × two implementation styles**:

|  | **Guides** (feedforward — *before* the model acts) | **Sensors** (feedback — *after* the model acts) |
|---|---|---|
| **Computational** (deterministic, fast, cheap) | JSON schema, template, allowed-tool list, system prompt | Schema validators, entity/string checks, citation-presence, numeric/range rules |
| **Inferential** (LLM-based, semantic) | Retrieved context, few-shot exemplars | LLM-as-judge, NLI/entailment faithfulness, completeness review |

Two theses that should drive any sequencing decision:
- *"Once you have something objective, converting it to a formal deterministic check gives more assurance than
  relying on human review."* → **prefer computational sensors** where a property can be made objective.
- *"A weak harness means better prompts just produce more sophisticated bugs."* → **build verification (sensors +
  evals) before optimising prompts.**

## 3. Anthropic building blocks [2]

Guidance: **do the simplest thing that works; add autonomy only when it demonstrably helps**, and **workflows
(predefined code paths) beat autonomous agents for well-defined, high-stakes tasks.**

- **Augmented LLM** — model + retrieval + tools + memory (the base unit).
- **Prompt chaining** — decompose into verifiable steps with gates between them.
- **Routing** — classify input → dispatch to a specialised path (e.g., by clinical department).
- **Parallelisation** — sectioning + voting → confidence.
- **Orchestrator–workers** — a coordinator dynamically delegates to workers.
- **Evaluator–optimizer** — generate → critique → regenerate. *The key accuracy pattern.*
- **Autonomous agent** — LLM in a tool loop; use sparingly, sandboxed, with stop conditions.
- **ACI (Agent–Computer Interface)** — invest as much in tool docs/schemas as in prompts; make tools
  *poka-yoke* (hard to misuse), token-efficient, and unambiguous.

## 4. Context engineering techniques [3]

"Context rot": more tokens ≠ better. Find the **smallest set of high-signal tokens**. For long-horizon tasks (a
30–45 minute consultation exceeds a comfortable window):

- **Compaction** — periodically summarise + reinitialise the working context.
- **Structured note-taking** — persist state *outside* the window (the agent's durable memory).
- **Sub-agents** — isolate context in a child, return only distilled results.
- **Just-in-time retrieval** — carry lightweight identifiers; pull full content on demand rather than front-loading.

## 5. Why this matters for clinical documentation
- The dominant clinical risks (omission, fabrication, missing provenance — see `01`) are **harness failures**, not
  model-capability failures → the leverage is in sensors/guides/gates.
- Regulated workflows need **auditability + human gates** → the harness is where those live.
- **Workflow-over-autonomy** + **evaluator-optimizer** + **ACI** map directly onto a bounded
  guides→generate→sensors→gate loop with mandatory clinician sign-off.

## Sources
1. Böckeler / Fowler — *Harness engineering*: https://martinfowler.com/articles/harness-engineering.html
2. Anthropic — *Building effective agents*: https://www.anthropic.com/engineering/building-effective-agents
3. Anthropic — *Effective context engineering for AI agents*: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
4. Thoughtworks Technology Podcast — *What is harness engineering?*: https://www.thoughtworks.com/en-us/insights/podcasts/technology-podcasts/what-harness-engineering
5. amux — *Harness Engineering: complete guide (2026)*: https://amux.io/guides/harness-engineering/
6. *The Agentic Harness — how to build AI agents in production*: https://dev.to/mrunmayee_rane_9d0e22b4de/the-agentic-harness-how-to-build-ai-agents-in-production-1id3
7. OpenAI — *A practical guide to building agents* (PDF): https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
8. Anthropic — *Writing effective tools for agents* (ACI): https://www.anthropic.com/engineering/writing-tools-for-agents
