# 04 · Clinical Interoperability & Structured Output

> FHIR/HL7 mapping for clinical notes, LLM→FHIR structured-output best practices, CDS Hooks / SMART on FHIR v2.2,
> and a safe clinical tool set. **Headline for HOPE:** SMR already supports `json_schema` structured output but it's
> unused — activate it against a FHIR-derived schema; ground every code via a terminology tool + FHIR-validator
> repair loop; and use **RxNorm → openFDA** as the free drug-safety stack (**the NLM DDI API has been dead since Jan
> 2, 2024**).

---

## 1. Key findings

**Interoperability standards**
- FHIR R5 **`DocumentReference`** is the canonical *index* resource for clinical notes of any MIME type; a FHIR
  **document** is a `Bundle[type=document]` whose first entry is a **`Composition`**. They coexist: `DocumentReference`
  → points to a `Composition` bundle. [1][2]
- **US Core v9.0.0** (FHIR R4) defines mandatory profiles for `MedicationRequest` (status/intent/medication/patient
  + must-support dosage SIG, route, dose/rate, category, **reasonCode**), `AllergyIntolerance` (clinicalStatus, code,
  patient), `Condition` (category, code, patient). US Core **Clinical Notes** designates `DocumentReference` as the
  primary discovery mechanism; the 2026 Argonaut project adds `structured-document`/`unstructured-document`
  categories. [5][6][9]
- **Vital signs**: `Observation[category=vital-signs]` must carry LOINC "magic values" (BP panel `85354-9`, systolic
  `8480-6`, diastolic `8462-4`, HR `8867-4`, RR `9279-1`); BP requires both components; UCUM units. [3][12]
- **IPS v2.0.0** (Trial-Use, 2025-10-29) = global minimal patient summary (ISO 27269); **required** sections:
  Allergies, Medications, Problems. Composable with US Core. [13][14]
- **HL7v2** still dominates legacy lab/order messaging (ORU/ADT/ORM) → needs translation middleware (e.g., HAPI FHIR)
  when ingesting; FHIR R4/R5 is the target for new work.

**SOAP → FHIR structure** (Medplum's authoritative mapping)
- Subjective → `Observation[category=survey]`; Objective → `Observation[category=exam]`; **Assessment →
  `ClinicalImpression`** (preferred — structured homes for findings/differentials/reasoning); Plan → `CarePlan` /
  `ServiceRequest` / `MedicationRequest`; full note wraps in a `Composition`. [47]

**Drug-safety data sources**
- **NLM Drug-Drug Interaction API — permanently discontinued Jan 2, 2024.** Any code calling it has been silently
  failing. RxNorm normalization / RxClass / RxTerms remain operational. [31][32]
- **RxNorm API** — free, no key, 20 req/s; `GET rxcui.json?name={name}&search=2` (normalized; handles
  brand/generic/salt/abbreviation); fall through to `search=9` approximate. [26][28][29]
- **openFDA Drug Label API** — free; `GET drug/label.json?search=openfda.rxcui:{rxcui}&sort=effective_time:desc`;
  returns `drug_interactions`, `contraindications`, `boxed_warning`, `warnings_and_precautions` (unstructured prose →
  parse). Pipeline: **RxNorm normalize → openFDA by RxCUI**. [15][33]
- **DrugBank** — free web DDI checker **retired Mar 25, 2026**; academic CC-BY-NC downloads **paused** (May 2026);
  commercial Clinical API is paid. [35][39][36]
- **DDInter 2.0** — free, severity + mechanism + evidence (500K+ pairs) → the recommended free DDI-severity
  alternative. [31]
- **UMLS / SNOMED CT** — free (individual UTS licence, ~5-day approval); REST `uts-ws.nlm.nih.gov/rest`; SNOMED CT
  free in IHTSDO member countries. **SNOMED CT MCP server** (`eigenbau/mcp-snomed-ct`) fronts any FHIR R4 terminology
  server (Snowstorm/Ontoserver/HAPI). [40][42][44]

**Tool-calling / guardrail patterns**
- **TxAgent** (2025): agentic reasoning over **211 biomedical tools** → 92.1% on drug-reasoning; pattern = verify via
  external sources *before* LLM inference on clinical conclusions. [57]
- **Tiered clinical guardrails (2026 norm):** (1) PHI redact + scope check pre-LLM (<50 ms) → (2) drug-safety check
  (openFDA+RxNorm) during inference → (3) lightweight faithfulness/hallucination scorer post-output (<100 ms) → (4)
  clinician HITL. [56]
- **Deterministic pre-LLM safety gates** (rule-based scope/panic-value) emit a fixed safe output without the LLM when
  triggered. [60]
- **`medguard-llm`** (PyPI, OSS): middleware wrapping any LLM with 5 layers — PHI detection, clinical scope, drug
  safety (openFDA+RxNorm), hallucination detection, output annotation. [58]
- **Codes:** the LLM must **never invent codes** — "use only SNOMED-CT/ICD-10-CM/RxNorm/LOINC from the tool; if no
  candidate, set `code.text` only." [50]

## 2. FHIR mapping (SOAP → FHIR)
| Note section | FHIR resource(s) | US Core profile | IPS | Terminology |
|---|---|---|---|---|
| Chief Complaint / Reason | `Condition` (encounter-diagnosis) | US Core Condition | IPS Condition | SNOMED CT, ICD-10-CM |
| Subjective (HPI/symptoms) | `Observation` (survey) | US Core Simple Observation | — | SNOMED CT, LOINC |
| Objective (exam) | `Observation` (exam) | US Core Observation Clinical Result | — | SNOMED CT, LOINC |
| Vital signs | `Observation` (vital-signs) | US Core Vital Signs | — | LOINC magic values; UCUM |
| Assessment / Impression | **`ClinicalImpression`** (preferred) | — | — | SNOMED CT + free text |
| Diagnosis (coded) | `Condition` (problem-list / encounter-diagnosis) | US Core Condition Problems | IPS Condition | SNOMED CT, ICD-10-CM |
| Problem list | `Condition` (problem-list-item) | US Core Condition Problems | IPS Condition | SNOMED CT, ICD-10-CM |
| Plan — Medications | `MedicationRequest` | US Core MedicationRequest | IPS MedicationRequest | **RxNorm** (required) |
| Active meds (historical) | `MedicationStatement` | US Core MedicationStatement | IPS MedicationStatement | RxNorm, NDC |
| Plan — Orders/Referrals/Labs | `ServiceRequest` | US Core ServiceRequest | — | SNOMED CT, LOINC, CPT |
| Plan — Ongoing care | `CarePlan` | US Core CarePlan | — | SNOMED CT |
| Allergies | `AllergyIntolerance` | US Core AllergyIntolerance | IPS AllergyIntolerance | SNOMED CT, RxNorm |
| Encounter metadata | `Encounter` | US Core Encounter | — | SNOMED CT, v3 ActCode |
| Full note (structured+narrative) | `Composition` in `Bundle[type=document]` | — | IPS Composition | LOINC section codes (`34109-9`, `11488-4`, `18842-5`) |
| Note discovery/index | `DocumentReference` | US Core DocumentReference | — | LOINC type; `clinical-note` |
| Minimal cross-border summary | IPS `Bundle` (Composition + Allergy + Medication + Condition + Observation) | IPS v2.0.0 | required: Allergies/Meds/Problems | SNOMED CT, RxNorm, LOINC |

## 3. Structured-output / LLM→FHIR best practices
**Three-stage extraction pipeline (2025–2026 consensus):**
1. **Terminology retrieval (pre-LLM):** SapBERT/embedding search over SNOMED/LOINC/RxNorm → candidate codes injected
   into the prompt as a "RETRIEVED CANDIDATES" block; constraint: *"use only allow-listed code systems; if no
   candidate, set `code.text` only; do not invent codes."* [50]
2. **Schema-constrained decoding (LLM):** derive a JSON Schema from FHIR `StructureDefinitions`; use API
   `json_schema`/`strict` mode (token-level enforcement, not post-hoc); **extract per-section** (meds, conditions,
   allergies separately) — multi-pass beats single-shot. [50][54][55]
3. **FHIR validator repair loop (post-LLM):** validate with HL7 FHIR Validator (Java) or `fhir.resources` (Python
   OOP); on failure, feed structured errors back as a repair prompt; **cap at 3 iterations**, then escalate to human. [51][50]

**Additional rules:** never discard the **narrative** (`Composition.section.text` is the legal, attestable document);
require **source spans** per claim (verify against transcript); don't emit negated/ruled-out conditions as
`Condition`; **temperature 0** for extraction; the **Infherno** agentic pattern (Smolagents + SNOMED RAG +
`fhir.resources`) competes with human baselines. [2][50][51][52][53]

## 4. CDS integration
- **CDS Hooks** (HL7): EHR POSTs JSON context at workflow triggers → service returns **cards**
  (`information`/`suggestion`/`app-link`); ~500 ms latency target. Relevant hooks: `patient-view`, `order-select`,
  `order-sign` (final drug-safety check), `encounter-start` (pre-visit summary). Services can fetch FHIR via
  `fhirServer` + `fhirAuthorization` using the same SMART token. [16][17]
- **SMART on FHIR v2.2** (2024): OAuth 2.0 + **PKCE mandatory for all clients**, granular scopes, asymmetric JWT
  auth, token introspection; discovery via `/.well-known/smart-configuration`. **ONC g(10) certification now
  requires v2.2.** Relevant scopes: `launch/encounter`, `user/Condition.rs`, `user/MedicationRequest.rs`,
  `user/Observation.rs`, `user/DocumentReference.cruds`, `user/Composition.cruds`; backend = `client_credentials` +
  `system/*`. [21][22][24]

## 5. Recommended clinical tool set
| Tool | Backing source | Access | Safety notes |
|---|---|---|---|
| **`drug_normalize`** (name→RxCUI) | NLM RxNorm | `rxcui.json?name=&search=2` — free, 20 req/s | run on every med mention before any DDI check; fall through to `search=9` |
| **`drug_interaction_check`** | openFDA label (primary) + **DDInter 2.0** (severity) | `api.fda.gov/drug/label.json?search=openfda.rxcui:` — free | NLM DDI API **dead**; parse prose `drug_interactions`; never suppress `boxed_warning`; cap ~10 drugs/req |
| **`drug_label_lookup`** | openFDA label | same endpoint | cite `set_id`+`effective_time`; label text ≠ advice |
| **`drugbank_ddi`** *(optional, commercial)* | DrugBank Clinical API | paid | structured severity/mechanism; free checker retired Mar 2026 — don't depend on free tier |
| **`terminology_lookup`** (text→SNOMED/LOINC/ICD) | Snowstorm/Ontoserver + SNOMED MCP | FHIR `$lookup`/`$expand` | accept only tool-returned codes; confidence threshold; log all calls |
| **`umls_search`** (cross-vocab) | UMLS Metathesaurus REST | `uts-ws.nlm.nih.gov/rest` + key | per-developer UTS licence; log queries |
| **`fhir_validate`** | HL7 FHIR Validator / `fhir.resources` | local | run before any write; feed errors to repair loop (≤3) |
| **`knowledge_search`** | PubMed/NCBI E-utilities | free | quote verbatim + PMID; not for drug facts (use label APIs) |
| **PHI redaction** (pre-LLM) | `medguard-llm` / Presidio + clinical NER | local | must run before transcript hits LLM; beware re-identification |
| **Faithfulness scorer** (post-LLM) | DeBERTa-class / `medguard-llm` | local | cross-check drug names vs RxNorm; flag unknowns; <100 ms |

## 6. Recommendations for HOPE
1. **Activate SMR `json_schema` now** against a per-section FHIR-derived schema (Condition, MedicationRequest,
   AllergyIntolerance, Observation); multi-pass extraction. [50][54]
2. **Two-layer output contract:** always emit `narrative` (legal, editable) + `structured` (FHIR-mapped JSON); persist
   both, never discard narrative. [2]
3. **Adopt FHIR Bundle-as-document** as canonical HOPE note (`Composition` sections → discrete resources;
   `DocumentReference` index) — US Core + IPS compatible. [6][13]
4. **Replace any NLM DDI dependency with RxNorm → openFDA** (+ DDInter 2.0 for severity); don't plan on DrugBank free
   tier. [31][15]
5. **Terminology-grounding step before emitting any code** (tool candidates + "don't invent codes"); deploy Snowstorm
   locally. [50][44]
6. **FHIR-validator repair loop** in SMR (`fhir.resources`/HL7 validator; ≤3 iterations). [51][50]
7. **Tiered guardrails around SMR:** PHI redact → drug-safety on NER meds → post-output faithfulness → clinician
   gate. [56][58]
8. **Expose AI output via CDS Hooks** (`order-sign`, `encounter-start`; suggestion + app-link cards). [16]
9. **Register as SMART on FHIR v2.2** (PKCE; encounter/user scopes) — required for ONC + Epic/Cerner sandboxes. [21][22]
10. **Get UMLS individual licences now**; stand up Snowstorm for low-latency SNOMED lookups. [40][42]

> **India note:** the same FHIR machinery maps to ABDM — model the signed note as an NRCeS **OPConsultRecord
> DocumentBundle** with SNOMED CT + LOINC and ABHA linkage (see [`05-india-health-ai-regulation.md`](./05-india-health-ai-regulation.md)).

## Sources
1. HL7 FHIR R5 — DocumentReference: https://www.hl7.org/fhir/R5/DocumentReference.html
2. HL7 FHIR — Documents (Bundle + Composition): https://hl7.org/FHIR/documents.html
3. HL7 FHIR R5 — Vital Signs Observation Profile: https://hl7.org/FHIR/observation-vitalsigns.html
4. HL7 FHIR R6 ballot — Vital Signs (LOINC table): https://build.fhir.org/observation-vitalsigns.html
5. US Core IG v9.0.0 (current build): https://build.fhir.org/ig/HL7/US-Core/
6. US Core — Clinical Notes Guidance v9.0.0: https://build.fhir.org/ig/HL7/US-Core/clinical-notes.html
7. US Core — Clinical Notes Guidance STU6: https://hl7.org/fhir/us/core/STU6/clinical-notes.html
8. US Core — AllergyIntolerance Profile v8.0.0: https://hl7.org/fhir/us/core/2025Jan/StructureDefinition-us-core-allergyintolerance.html
9. US Core — MedicationRequest Profile v9.0.0 (build): http://build.fhir.org/ig/HL7/US-Core/branches/master/StructureDefinition-us-core-medicationrequest.html
10. US Core — MedicationRequest v8.0.1 definitions: https://hl7.org/fhir/us/core/StructureDefinition-us-core-medicationrequest-definitions.html
11. US Core — MedicationRequest 2023Jan: https://hl7.org/fhir/us/core/2023Jan/StructureDefinition-us-core-medicationrequest.html
12. US Core — Vital Signs Profile v9.0.0: https://build.fhir.org/ig/HL7/US-Core/StructureDefinition-us-core-vital-signs.html
13. IPS Implementation Guide v2.0.0: https://build.fhir.org/ig/HL7/fhir-ips/en/
14. IPS IG — Structure of the IPS: https://build.fhir.org/ig/HL7/fhir-ips/en/Structure-of-the-International-Patient-Summary.html
15. openFDA Drug API: https://open.fda.gov/apis/drug/
16. CDS Hooks — Current Specification: https://cds-hooks.org/specification/current/
17. CDS Hooks — Home / card types: https://cds-hooks.org/
18. CDS Hooks raw spec (GitHub): https://raw.githubusercontent.com/cds-hooks/docs/master/docs/specification/current.md
19. CDS Hooks architecture guide (Mindbowser): https://www.mindbowser.com/cds-hooks-guide/
20. AI-Powered CDS Architecture Patterns (2026): https://www.hypertrends.com/2026/05/ai-clinical-decision-support-architecture/
21. SMART App Launch v2.2.0 — Overview: https://build.fhir.org/ig/HL7/smart-app-launch/index.html
22. SMART App Launch v2.2 changes (Nirmitee): https://nirmitee.io/blog/smart-app-launch-v2-granular-scopes-token-introspection-changes/
23. SMART on FHIR explainer (LoginRadius): https://www.loginradius.com/blog/identity/what-is-smart-on-fhir
24. SMART on FHIR — EHR launch / scopes (FirestarterPro): https://firestarterpro.com/canonical/fhir/smart/
25. SMART on FHIR OAuth 2.0 guide (Censinet): https://censinet.com/perspectives/smart-on-fhir-oauth-2-0-implementation-guide
26. NLM RxNorm API — reference: https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html
27. NLM RxNav — overview/changelog: https://lhncbc.nlm.nih.gov/RxNav/
28. RxNorm findRxcuiByString: https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.findRxcuiByString.html
29. RxNorm getApproximateMatch: https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getApproximateMatch.html
30. RxNorm API tutorial (RxLabelGuard): https://rxlabelguard.com/blog/rxnorm-api-tutorial-drug-name-resolution
31. NLM DDI API discontinued — alternatives (DEV): https://dev.to/ben_feeney_f0074083491ec6/the-nlm-drug-interaction-api-is-gone-heres-what-to-use-instead-2ac7
32. NLM DDI API discontinued — migration (RxLabelGuard): https://www.rxlabelguard.com/blog/nlm-rxnav-drug-interaction-api-discontinued-migration-guide
33. openFDA Drug API endpoints: https://open.fda.gov/apis/drug/
34. AI chatbot on FDA drug label retrieval (MDPI 2025): https://www.mdpi.com/2813-2203/4/4/33
35. Drug Interaction API pricing 2026 (RxLabelGuard): https://rxlabelguard.com/blog/drug-interaction-api-pricing-complete-breakdown-2026
36. DrugBank Clinical API — DDI checker: https://go.drugbank.com/clinical/drug_drug_interaction_checker
37. DrugBank drug name search guide: https://dev.drugbank.com/guides/implementation/drug_name_search
38. DrugBank clinical API overview: https://www.drugbank.com/clinical
39. DrugBank Open Data + Academic (latest release): https://go.drugbank.com/releases/latest
40. UMLS licensing and access: https://www.nlm.nih.gov/databases/umls.html
41. UMLS Quick Start Guide: https://www.nlm.nih.gov/research/umls/quickstart.html
42. UMLS REST API home: https://documentation.uts.nlm.nih.gov/rest/home.html
43. UMLS FAQ: https://www.nlm.nih.gov/research/umls/faq_main.html
44. SNOMED CT MCP server (eigenbau/mcp-snomed-ct): https://github.com/eigenbau/mcp-snomed-ct
45. InterSystems IRIS terminology server: https://github.com/intersystems-ib/iris-terminology-server
46. TermHub FHIR service for SDO terminology: https://briefglance.com/articles/termhubs-new-fhir-service-aims-to-unlock-healthcare-standards-data
47. Medplum — SOAP Notes in FHIR: https://www.medplum.com/docs/charting/soap-notes
48. HL7 FHIR R4B — Composition resource: https://hl7.org/fhir/R4B/composition.html
49. HL7 FHIR R6 ballot — Composition definitions: https://build.fhir.org/branches/master/composition-definitions.html
50. Schema-Grounded LLM extraction for FHIR (arXiv 2601.05847): https://arxiv.org/html/2601.05847v2
51. Infherno — Agent-based FHIR synthesis (arXiv 2507.12261): https://arxiv.org/html/2507.12261v1
52. Infherno — GitHub: https://github.com/j-frei/Infherno
53. MedCase-Structured — Text-to-FHIR benchmark (arXiv 2605.30295): https://arxiv.org/html/2605.30295v1
54. Multi-pass LLM extraction from clinical docs (medRxiv 2025): https://www.medrxiv.org/content/10.1101/2025.02.25.25322898.full.pdf
55. LLMs converting clinical data to FHIR (MDPI 2025): https://www.mdpi.com/2076-3417/15/6/3379
56. Real-Time AI Guardrails for Healthcare (2026): https://nirmitee.io/blog/real-time-ai-guardrails-system-healthcare-architecture-2026/
57. TxAgent — 211-tool therapeutic reasoning agent (arXiv): https://arxiv.org/pdf/2503.10970
58. medguard-llm — healthcare LLM guardrails middleware (PyPI): https://pypi.org/project/medguard-llm/
59. Anatomy of a production vertical agent (The AI Runtime): https://theairuntime.com/p/the-anatomy-of-a-production-vertical
60. Deterministic safety gate before LLM (DEV): https://dev.to/frank_brsrk/i-open-sourced-a-4-agent-blood-panel-triage-workflow-on-heym-with-a-deterministic-python-safety-1bhn
61. MCP vs Function Calling — governance (Prefect): https://www.prefect.io/resources/mcp-vs-function-calling
62. LLM tool calling + MCP overview (Medium): https://usmanshahid.medium.com/llm-tool-calling-series-part-1-understanding-tool-calling-and-the-model-context-protocol-mcp-911a7c422fd8
63. Korean IPS FHIR pipeline study (PMC 2025): https://pmc.ncbi.nlm.nih.gov/articles/PMC12835024/
64. HL7 FHIR R5 Vital Signs profile JSON: https://hl7.org/fhir/R5/vitalsigns.profile.json.html
