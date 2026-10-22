# NLP service study

Study notes for `apps/nlp` in `ArcaAI/project-hope`, branch `dev-2.2` (first studied at `dacdc311`, re-checked 2026-10-22 at `8cb2e5e8`).

| File | What it is |
| --- | --- |
| [docs/nlp-project-walkthrough.md](docs/nlp-project-walkthrough.md) | Architecture, folder map, endpoints, models, running locally, deployment, 16 known issues |
| [docs/nlp-hardcoded-domain-values.md](docs/nlp-hardcoded-domain-values.md) | Hardcoded diagnosis labels and spelling dictionaries, with measured quality impact |
| [diagrams/sequence-nlp-llm-flow-20261022-132531/nlp-llm-flow.html](diagrams/sequence-nlp-llm-flow-20261022-132531/nlp-llm-flow.html) | Archify sequence diagram: topic/intent LLM flow on latest dev-2.2 (TASK-1016 fixes) |
| [diagrams/architecture-nlp-service-connections-20261022-132531/nlp-service-connections.html](diagrams/architecture-nlp-service-connections-20261022-132531/nlp-service-connections.html) | Archify architecture diagram: every service connected to NLP, with the parameters of each call |
| [nlp-context.md](nlp-context.md) | Handoff context for starting a new AI session on this work |
| [demo/](demo/) | Request bodies for the Medical-NER demo, with and without the clinical taxonomy |

Live, editable versions of the docs (with diagrams):

- Project walkthrough: https://claude.ai/code/artifact/3b76b2e8-a9e0-47f2-8826-8348778ca423
- Hardcoded domain values: https://claude.ai/code/artifact/80319b0e-86ba-4917-8973-9f6f17e7621b
- Code walkthrough guide (presenter script): https://claude.ai/code/artifact/a212c8d8-548b-4c7e-aefe-aa97ae3e0583

Service tokens are not stored here; ask the team.
