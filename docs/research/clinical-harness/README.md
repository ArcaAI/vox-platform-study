# Clinical Documentation Harness Research — a dated research archive

Detailed, fully-cited research backing the Clinical Documentation Harness design, produced
2026-06-02 (5 parallel deep-research agents) plus a 2026-06-05 addition (SOTA harness
implementation). This is a point-in-time research record, not current guidance — each document is
a standalone, sourced report; regulatory summaries in it are engineering research, not legal
advice, and several regimes it describes are in flux (DPDP Rules phase-in, CDSCO MDS draft, EU AI
Act Digital-Omnibus timeline). For the harness as actually built, see
`.claude/rules/06-python-services.md` and `docs/architecture/consultation-session-workflow/`.

## Layout

| Document | Topic |
|---|---|
| `00-harness-engineering-foundations.md` | What harness engineering is; the control model; agent patterns; context engineering |
| `01-ambient-clinical-documentation.md` | AI medical scribes — accuracy, omissions, clinician UX, trust, regulation |
| `02-medical-knowledge-grounding.md` | Corpora + licensing, embeddings, hybrid retrieval, ontology linking, faithfulness, benchmarks |
| `03-medical-ai-evaluation-guardrails-governance.md` | Eval tooling, LLM-as-judge, guardrails, HITL, FDA/EU/UK regulation, audit |
| `04-clinical-interoperability-structured-output.md` | FHIR/HL7 mapping, structured output, CDS Hooks/SMART, safe clinical tool-calling |
| `05-india-health-ai-regulation.md` | DPDP 2023 + Rules 2025, ABDM/NRCeS FHIR, Telemedicine 2020, CDSCO, MeitY/SAHI |
| `06-sota-harness-implementation.md` | 2026 implementation SOTA — orchestration libs, eval/guardrail stacks, durable HITL |

## Related

- [`../README.md`](../README.md) — the top-level research index this folder is part of
- [`../../../.claude/rules/06-python-services.md`](../../../.claude/rules/06-python-services.md) — the harness as actually implemented (Temporal workflows/activities)
- [`../../architecture/consultation-session-workflow/assessment/README.md`](../../architecture/consultation-session-workflow/assessment/README.md) — a later, code-verified assessment of the consultation/harness vertical
