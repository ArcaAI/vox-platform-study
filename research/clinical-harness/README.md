# HOPE — Clinical Documentation Harness · Research Archive

Detailed, fully-cited research backing the **Clinical Documentation Harness** design
(`docs/implementation/TASK-330-Clinical-Documentation-Harness/`). Lives at `research/clinical-harness/`. Each
document is a standalone, sourced report, written to be reusable across future medical-AI work — not just this ticket.

| Date | Method |
|---|---|
| 2026-06-02 | 5 parallel deep-research agents (scribes, knowledge-grounding, evals/governance, interoperability, India) |
| 2026-06-05 | +1 agent (SOTA harness implementation); foundations consolidated from the original harness-engineering research |

Sources prioritise **peer-reviewed** (NEJM AI, JAMA Network Open, npj Digital Medicine, JMIR, Mayo Clinic
Proceedings, ACL/arXiv), **official** (FDA, EU, NHS, MeitY/NHA/CDSCO, HL7/NLM), and **primary vendor/spec** material,
2024–2026.

## Index
| # | Document | Topic | Sources |
|---|---|---|---|
| 00 | [`00-harness-engineering-foundations.md`](./00-harness-engineering-foundations.md) | What harness engineering is; the control model; agent patterns; context engineering | ~8 |
| 01 | [`01-ambient-clinical-documentation.md`](./01-ambient-clinical-documentation.md) | AI medical scribes — accuracy, omissions, clinician UX, trust, regulation | 25 |
| 02 | [`02-medical-knowledge-grounding.md`](./02-medical-knowledge-grounding.md) | Corpora + licensing, embeddings, hybrid retrieval, ontology linking, faithfulness, benchmarks | 30 |
| 03 | [`03-medical-ai-evaluation-guardrails-governance.md`](./03-medical-ai-evaluation-guardrails-governance.md) | Eval tooling, LLM-as-judge, guardrails, HITL, FDA/EU/UK regulation, audit | 31 |
| 04 | [`04-clinical-interoperability-structured-output.md`](./04-clinical-interoperability-structured-output.md) | FHIR/HL7 mapping, structured output, CDS Hooks/SMART, safe clinical tool-calling | 64 |
| 05 | [`05-india-health-ai-regulation.md`](./05-india-health-ai-regulation.md) | DPDP 2023 + Rules 2025, ABDM/NRCeS FHIR, Telemedicine 2020, CDSCO, MeitY/SAHI | 18 |
| 06 | [`06-sota-harness-implementation.md`](./06-sota-harness-implementation.md) | 2026 implementation SOTA — orchestration libs, eval/guardrail stacks, durable HITL | 44 |

## How the research maps to TASK-330 decisions
| TASK-330 decision | Backed by |
|---|---|
| Accuracy/safety-first; sensors before prompts | 00 (Böckeler), 01 (omissions #1, proofreading weak), 03 (faithfulness metrics) |
| Internal + institutional grounding (no external corpora) | 02 (StatPearls non-commercial; UpToDate/DynaMed proprietary) |
| Mandatory clinician sign-off; architectural HITL + WORM audit | 01 (attestation, AB-3030, FHIR Provenance), 03 (HITL gate, audit retention) |
| Bounded, read-only, cited tools | 00 (ACI), 04 (RxNorm→openFDA), 03 (guardrails) |
| Eval harness first | 00 (build verification first), 03 (PDQI-9 judge, CI gates) |
| Dedicated Python orchestrator | 06 (orchestration-lib selection) |
| India-first governance + FHIR | 05 (DPDP/ABDM/CDSCO), 04 (FHIR mapping) |

## Disclaimer
Regulatory summaries are engineering research, **not legal advice** — confirm with counsel/regulatory affairs.
Several regimes are in flux (DPDP Rules phase-in, CDSCO MDS draft, EU AI Act Digital-Omnibus timeline).
