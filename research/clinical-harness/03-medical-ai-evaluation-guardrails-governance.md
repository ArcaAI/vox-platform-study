# 03 · Medical AI — Evaluation, Guardrails & Governance

> How to *prove* a clinical-documentation harness is safe and keep it safe: eval rubrics + tooling, LLM-as-judge,
> guardrails (PHI/groundedness/schema/safety), human-in-the-loop as an architectural gate, FDA/EU/UK regulation, and
> audit. **Headline:** safety in clinical AI is overwhelmingly a **harness** property — measured by evals, enforced by
> guardrails, gated by humans, and proven by audit.

---

## Evaluation — rubrics & frameworks
- **PDQI-9 / PDSQI-9** is the standard physician-rated note-quality instrument; the **2025 PDSQI-9** was revised
  specifically for **AI-generated** notes (9 dims: up-to-date, accurate, thorough, useful, organised, concise,
  consistent, succinct, synthesised), validated across 779 notes / 18 physicians with strong reliability
  (ICC ≈0.86). Use it as the rubric an **LLM-as-judge** applies. [1][2]
- **Use established frameworks, don't reinvent:** **SCRIBE** (npj Digital Medicine 2025) — multidimensional ambient-
  scribe eval (accuracy, completeness, hallucination, bias/safety) blending expert review + automated metrics +
  LLM-as-judge; **CRAFT-MD** for conversational reasoning. [3]
- **Reference-free metrics needed:** there's rarely a single gold note — prefer **source-grounded faithfulness/
  coverage** checks over ROUGE/BLEU. [3][8]

## LLM-as-judge — make it trustworthy
- **It works for medicine when disciplined:** **MedJudge / Med-LFQA** show LLM evaluators correlate well with
  clinicians on faithfulness/comprehensiveness. [5]
- **Practices:** explicit rubric + score definitions; **G-Eval** (chain-of-thought + form-filling); request structured
  per-dimension scores **with rationales**; mitigate position/verbosity/self-preference bias (randomise order, pairwise
  where possible); **calibrate the judge against human ratings (ICC/κ)** before trusting it. [4][6][7]
- **Tooling:** **DeepEval** (pytest-style, G-Eval, faithfulness/hallucination, CI-native); **Ragas**
  (faithfulness/context-precision/recall/answer-relevancy); **promptfoo** (declarative YAML, red-teaming, CI gates);
  **Langfuse** (tracing + dataset evals + production scoring; self-hostable, **MIT**). [8][9][10][11]

## Guardrails (runtime, layered)
| Layer | Purpose | Options | Src |
|---|---|---|---|
| **PHI / de-identification** | strip/justify identifiers (HIPAA Safe Harbor 18) | **MS Presidio** (+ **GLiNER** NER recognizers) | [12][13][14] |
| **Groundedness / hallucination** | block ungrounded clinical claims | **NeMo Guardrails** AlignScore fact-checking; RAG-triad gates | [15][16] |
| **Structure / schema** | force valid typed output | **Guardrails AI** (Pydantic + reask), `json_schema` constrained decoding | [17] |
| **Topical / safety** | stay in-scope, refuse unsafe asks | **NeMo Guardrails** Colang rails | [16] |
| **Safety classifier** | self-hosted I/O moderation | **Llama Guard 3/4** (PHI-safe, on-prem) | [18] |
| **Orchestration** | compose the above | **Guardrails AI** + **NeMo Guardrails** | [16][17] |

**Patterns:** input rails (PHI/jailbreak/scope) → retrieval grounding → output rails (groundedness + schema +
safety) → HITL. Self-host PHI-touching guardrails. Track guardrail-trigger rates as quality signals. [15][16][18]

## Human-in-the-loop as architecture (not a checkbox)
- **Clinician proofreading alone is a weak control** (esp. omissions) → make HITL a **structural gate**, not an
  afterthought. [3][19]
- **Confirm-before-commit:** nothing reaches the record/downstream tools without an explicit clinician action;
  **typed attestation** ("reviewed & verified"). [20][21]
- **Risk-tiered autonomy:** auto-allow low-risk; **require approval** for medications/diagnoses/orders; **never**
  auto-execute high-risk. [19][20]
- **Capture the edit signal:** diff(AI draft, signed note) is your highest-value quality + training feedback. [3]
- **Durable interrupts:** frameworks like **LangGraph** provide `interrupt()` / checkpointed human-approval nodes —
  pause mid-run, persist state, resume on human input. [21]

## Regulation
**US / FDA**
- Pure documentation scribes ≈ administrative → **enforcement discretion**, not a regulated device; adding
  diagnosis/treatment *recommendations* → **CDS** and likely **SaMD/device**. [22][23]
- FDA's **2025 draft guidance on AI-enabled device software** expects a **Total Product Lifecycle** approach +
  **Predetermined Change Control Plans (PCCP)** for models that update. [24]
- **ONExpect Provenance/disclosure:** USCDI v4 (2026) elevates **Provenance**; state laws (e.g., **CA AB-3030**)
  mandate AI-disclosure that survives exports. [25]

**EU**
- **EU AI Act:** AI that is a medical device (or its safety component) requiring third-party conformity assessment is
  **high-risk** → risk management, data governance, logging, transparency, human oversight, accuracy/robustness;
  high-risk obligations phase in to **Aug 2027**; a 2025 **Digital Omnibus** proposed timeline adjustments. Stacks on
  top of **MDR/IVDR**. [26][27]

**UK**
- Ambient scribes must meet **DCB0129/DCB0160** clinical-risk-management standards; **MHRA** guidance + the
  **AI Airlock** sandbox; NHS England's 2025 ambient-scribe guidance reiterates clinician accountability + governance
  before deployment. [28][29]

## Audit & monitoring
- **Immutable, tamper-evident logs** (append-only / **WORM**, hash-chained) for every AI action, retrieval, guardrail
  trigger, edit, and sign-off; store **model + prompt versions**, retrieved evidence IDs, attestation hashes; align
  retention with records law (often **7+ yrs**). [25][30]
- **Continuous post-market monitoring:** correction/edit rate, omission rate, hallucination/groundedness scores,
  guardrail triggers, drift, bias — with escalation thresholds; this is an explicit regulatory expectation
  (FDA TPLC, EU AI Act, UK DCB0160). [24][26][28][31]

## Recommendations for HOPE
1. **Evals before prompt-tuning** (Böckeler): build a **PDSQI-9 LLM-judge** + faithfulness/coverage metrics on a
   golden SOAP set; gate prompt/model changes in CI (DeepEval/promptfoo). [1][2][3][8][10]
2. **Calibrate the judge** vs a clinician-rated sample (ICC/κ) before trusting automated scores. [4][6]
3. **Layer guardrails:** Presidio+GLiNER (PHI) → NeMo groundedness → Guardrails-AI/`json_schema` (structure) →
   Llama Guard (self-hosted) → HITL; log every trigger. [12][14][15][16][17][18]
4. **Make sign-off an architectural gate** (confirm-before-commit + typed attestation + risk-tiered tool approval);
   model it with LangGraph-style durable interrupts. [19][20][21]
5. **Persist the edit diff** as the core quality/feedback signal. [3]
6. **WORM, hash-chained audit log** with model/prompt versions, evidence IDs, attestation hashes; 7-yr retention. [25][30]
7. **Stand up Langfuse** (already staged) for tracing + production scoring + dataset evals. [11]
8. **Document the FDA/EU/UK classification rationale now** (documentation-aid vs CDS/SaMD); add **PCCP** if models
   auto-update; keep India in view (see `05`). [22][23][24][26][28]

## Sources
1. PDSQI-9 — revising PDQI-9 for AI notes (medRxiv 2025): https://www.medrxiv.org/content/10.1101/2025.05.12.25327384v1
2. PDSQI-9 validation (PMC): https://pmc.ncbi.nlm.nih.gov/articles/PMC12132401/
3. SCRIBE — ambient-scribe eval framework (npj Digital Medicine 2025): https://www.nature.com/articles/s41746-025-01622-1
4. G-Eval — NLG eval with GPT-4 (arXiv 2303.16634): https://arxiv.org/abs/2303.16634
5. MedJudge / Med-LFQA — LLM evaluators in medicine (arXiv 2409.07041): https://arxiv.org/abs/2409.07041
6. Survey: LLM-as-a-Judge (arXiv 2411.15594): https://arxiv.org/abs/2411.15594
7. LLM-as-judge biases & mitigations (Confident AI): https://www.confident-ai.com/blog/why-llm-as-a-judge-is-the-best-llm-evaluation-method
8. DeepEval docs: https://docs.confident-ai.com/
9. Ragas docs: https://docs.ragas.io/
10. promptfoo docs: https://www.promptfoo.dev/docs/intro/
11. Langfuse (LLM observability, MIT, self-host): https://langfuse.com/
12. Microsoft Presidio: https://microsoft.github.io/presidio/
13. HIPAA Safe Harbor de-identification (HHS): https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html
14. GLiNER (generalist NER): https://github.com/urchade/GLiNER
15. NeMo Guardrails fact-checking / AlignScore: https://docs.nvidia.com/nemo/guardrails/latest/user-guides/guardrails-library.html
16. NeMo Guardrails (repo): https://github.com/NVIDIA/NeMo-Guardrails
17. Guardrails AI: https://www.guardrailsai.com/docs
18. Llama Guard (Meta): https://www.llama.com/docs/model-cards-and-prompt-formats/llama-guard-3/
19. Why proofreading is a weak control — Mayo Clinic Proc Digital Health 2025: https://www.mcpdigitalhealth.org/article/S2949-7612(25)00099-9/fulltext
20. HITL design for clinical AI (confirm-before-commit): https://www.americandatanetwork.com/healthcare-quality/ai-scribes-in-healthcare-governance-framework/
21. LangGraph human-in-the-loop (durable interrupts): https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/
22. FDA — AI in Software as a Medical Device: https://www.fda.gov/medical-devices/software-medical-device-samd/artificial-intelligence-software-medical-device
23. FDA — Clinical Decision Support Software guidance: https://www.fda.gov/media/109618/download
24. FDA — AI-Enabled Device Software Functions, draft guidance (2025, TPLC/PCCP): https://www.fda.gov/regulatory-information/search-fda-guidance-documents/artificial-intelligence-enabled-device-software-functions-lifecycle-management-and-marketing
25. CA AB-3030 / USCDI v4 Provenance / disclosure: https://www.scribing.io/ai-scribe-laws/california-ab3030-compliance
26. EU AI Act — high-risk & medical devices: https://artificialintelligenceact.eu/
27. EU AI Act × MDR/IVDR (high-risk classification analysis): https://www.emergobyul.com/news/eu-ai-act-and-its-impact-medical-devices
28. NHS England — ambient scribing guidance (2025): https://transform.england.nhs.uk/information-governance/guidance/using-ai-enabled-ambient-scribing-products-in-health-and-care-settings/
29. MHRA — AI Airlock regulatory sandbox: https://www.gov.uk/government/collections/ai-airlock-the-regulatory-sandbox-for-aiamd
30. WORM / immutable audit logging for compliance: https://www.loggly.com/use-cases/what-is-a-worm-compliant-audit-log/
31. FDA — postmarket performance monitoring for AI devices: https://www.fda.gov/medical-devices/digital-health-center-excellence/digital-health-policy-navigator
