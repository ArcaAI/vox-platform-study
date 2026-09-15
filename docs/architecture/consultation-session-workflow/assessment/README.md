# Consultation Session Workflow Assessment — a dated codebase audit record

This is a point-in-time engineering assessment (status: Review, dated 2026-08-15) of the
consultation vertical — harness/Temporal, live documentation, domains/applications, the gateway,
the Vox SDK, the admin console, and the Python services on the path (stt, nlp, text, guardrail) —
measured against `../dataset.xml` and `../user-stories-and-use-cases.md` by 9 agents in 2 waves
with adversarial verification of the critical findings. It is an engineering assessment of whether
controls exist and function in code, not legal, regulatory, clinical, or compliance guidance, and
its findings are not re-verified or updated by this rewrite — read the documents below for current
detail rather than treating this index as a summary of where the code stands today.

## Layout

| Path | Contents |
|---|---|
| `01-invariant-register.md` | 449 invariants; story-vs-XML conflicts; persona coverage |
| `02-conformance-matrix.md` | Adjudicated findings and verified positives; coverage table |
| `03-compliance-posture.md` | Non-negotiables, control inventory, PHI flow map |
| `04-target-architecture.md` | Generator decision, target design, spec red-team, sequenced remediation plan |
| `05-critical-verification.md` | Adversarial verification of the two most severe findings |
| `evidence/` | The four wave-1 lane reports (`ai-pipeline.md`, `context-model.md`, `orchestration.md`, `surfaces.md`) |

## Related

- `../dataset.xml`, `../user-stories-and-use-cases.md` — the reference documents this assessment measures against
- `../../overview.md` — current platform architecture overview
- `../../../../.claude/rules/03-domain-layer.md`, `../../../../.claude/rules/04-application-services.md`, `../../../../.claude/rules/06-python-services.md` — the layer rules covering the surfaces this assessment audits
