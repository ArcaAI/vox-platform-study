# 01 · Ambient Clinical Documentation / AI Medical Scribes

> Landscape, accuracy/safety evidence, clinician UX, and what makes ambient documentation trusted (2024–2026).
> **Headline:** omissions are the #1 error and clinician proofreading is a *weak* safeguard → the value is in the
> **harness** (provenance, automated grounding/coverage checks, attestation gates, monitoring), not the model.

---

## Landscape at a glance
All major vendors share the pipeline — **ambient capture → medical ASR → LLM structuring (SOAP/HPI/A&P) → EHR
write-back → clinician review & sign** — and differentiate on grounding, EHR depth, and coding.

| Vendor | Differentiator | Notable trust/architecture feature |
|---|---|---|
| **Nuance / Microsoft DAX Copilot (Dragon Copilot)** | Deep Azure + Epic integration; largest install base | Azure-hosted; RCT-validated; "occasional" inaccuracies; weakest time-savings head-to-head [1][3] |
| **Abridge** | Enterprise Epic co-development; 28+ languages | **Linked Evidence** — every phrase traces to transcript/audio (replayable) [10][11] |
| **Nabla** | Lightweight, fast | Best documentation-time result in the NEJM AI RCT (−9.5%) [1] |
| **Suki** | Voice-first → ambient; pre-charting, order staging, coding | Native multi-EHR (Epic/Oracle/MEDITECH/athena) [13] |
| **Heidi Health** | Specialty/adaptive templates | Context-aware templates; explicit legal/regulatory posture [4] |
| **Corti** | API/platform for *builders* (most relevant to HOPE) | Real-time WebSocket transcripts + streaming clinical facts; "Audio Health" events flag bad audio mid-visit [12] |
| **Ambience** | Enterprise/Epic-first; full-chart awareness | Chart Awareness + real-time HCC/ICD-10 coding & inpatient CDI [11] |
| **Augmedix** | Early ambient pioneer (now Commure); ED/inpatient | Hybrid human-in-the-loop QA heritage |

## Key findings (each sourced)
- **RCT, 2 vendors, 238 physicians / 72k encounters:** Nabla cut time-in-note **9.5%** (significant); DAX **−1.7%**
  (not significant). *Both* improved burnout/task-load. Inaccuracies "occasional"; most common were **omissions,
  structural/format issues, and pronoun/attribution errors.** — NEJM AI 2025 [1][2][3]
- **Burnout drops with deployment:** multicentre QI study (263 clinicians, 6 systems) — burnout **51.9% → 38.8%**
  after 30 days; less after-hours documentation, lower cognitive load. — JAMA Network Open 2025 [4]
- **EHR time:** UChicago matched-cohort — **8.5%** less total EHR time, **>15%** less note-composition time. — JAMA
  Network Open 2025 [5]
- **Omissions are #1 and hardest to catch:** prospective pilot (356 notes) — omissions **18%**, hallucinations
  **11.5%**, accidental inclusions 9.3%, bias 1.1%; **~4–5% of notes carried potential for serious harm** if
  uncorrected. — JMIR Medical Informatics 2026 [6]
- **Simulated-encounter validation:** **127 errors across 70% of draft notes** (mean 2.9/note); omissions most
  frequent and *hardest to detect because they require memory recall.* — JMIR 2025 [7]
- **Quality vs physician "gold" notes:** ambient notes scored higher on thoroughness/organisation but lower on
  accuracy/succinctness; **hallucinations 31% (ambient) vs 20% (gold)**; reviewers still *preferred* ambient notes
  47% vs 39%. — Frontiers in AI 2025 (modified PDQI-9) [8]
- **Failure-mode taxonomy (simulation):** undersynthesis, misgendering, hallucinated test results, **medication
  errors (most common — omission & commission, often propagated from ASR mis-recognition)**, and plausible-but-wrong
  **substitution** errors. Critically: **clinician proofreading may not be an effective safeguard.** — Mayo Clinic
  Proceedings: Digital Health 2025 [9]
- **Provenance is the emerging trust mechanism:** Abridge **Linked Evidence** maps note text → transcript span →
  replayable audio. — Abridge docs [10][11]
- **Regulatory posture (US):** pure documentation scribes are treated as **administrative/EHR-adjacent, under FDA
  enforcement discretion — NOT regulated devices.** Adding "suggested diagnosis"/"recommended next step" pushes into
  **CDS / SaMD.** — FDA & analysis [14][15][16]
- **HIPAA:** audio + transcript = PHI; the vendor is a **Business Associate → signed BAA required before any PHI
  flows**; encryption, audit logs, access controls mandatory. — [17][18]
- **EU AI Act:** if a scribe is a medical device requiring third-party conformity assessment (MDR/IVDR), it is
  **automatically high-risk**; obligations apply ~**Aug 2027** for CE-marked devices. — [19][20]
- **Documentation-integrity / disclosure law:** California **AB-3030** requires conspicuous AI disclosure embedded in
  the note that **survives every export path**; **USCDI v4 (2026) makes FHIR Provenance a required data class**; keep
  model ID/version, clinician NPI, attestation hash, 7-yr retention. — [20]
- **Accountability:** NHS England + governance frameworks — **the clinician (user) is responsible for accuracy**;
  patients must be told recording is happening; every note needs a named accountable reviewer. — NHS 2025 [21];
  American Data Network governance framework [22]

## Best practices
- **Ground everything (provenance-by-design):** link every note sentence/claim to its transcript span (+ timestamp/
  audio) — the Abridge "Linked Evidence" pattern. [10][11]
- **Stream facts live + monitor audio quality** so problems are caught in-room, not post-hoc. [12]
- **Treat it as a workflow system, not "ASR + summarization":** specialty templates; gracefully drop tangents. [13][1]
- **Use a real evaluation harness, not surveys:** human review + computational metrics + LLM-as-judge + simulation
  (SCRIBE; CRAFT-MD); run **silent/shadow** testing before go-live. [23][24]
- **Mandatory HITL with an attestation gate** at signature; named accountable reviewer per note. [22][21]
- **Continuous post-deployment monitoring:** correction/edit rate, omissions, "unsafe acceptance," drift, bias; set
  escalation thresholds (e.g., >15–20% correction → quality review). [22][24]
- **Persistent AI disclosure + FHIR Provenance** (model ID/version, timestamp, clinician NPI, attestation hash) that
  survives exports. [20]
- **Stay on the documentation side of the FDA line**; document the classification rationale; revisit on new features. [15][16]
- **Sign BAAs across the whole chain** (cloud, ASR, LLM provider); confirm each sub-processor is HIPAA-eligible. [17][18]

## Anti-patterns / failure modes
- **Relying on clinician proofreading as the primary safeguard** — weak, especially for **omissions**. [9][7]
- **Hallucinated specifics:** fabricated **medications/dosages, test results, adherence/memory commentary** — highest-harm. [9][6]
- **Omitted findings** (most frequent) and **plausible substitutions** (a term swapped for a wrong-but-contextual one). [7][9]
- **Attribution errors:** wrong speaker, pronoun/misgendering, patient-vs-clinician mix-ups. [1][9]
- **ASR-propagated errors** flowing downstream into med/coding errors. [9]
- **"Unsafe acceptance":** uncorrected acceptance of low-reliability content. [24]
- **No provenance / black-box drafts** → clinicians can't verify → trust collapses. [9][10]
- **Disclosure that doesn't survive export**, **no BAA before PHI flows**, or **silently adding CDS-like suggestions** (regulatory exposure). [20][17][15]
- **One-time validation** with no drift monitoring; over-trusting vendor-reported metrics. [22][24]

## Recommendations for HOPE
1. **Make NER the grounding layer.** Pin every SOAP element (esp. meds, dosages, allergies, diagnoses, numbers) to
   NER spans + transcript offsets; at generation time **reject/flag any med/dose/lab value not traceable to an
   STT/NER span** — directly targets the #1 high-harm failure. [9][6]
2. **Build "Linked Evidence" into the reviewer UI.** Click a SOAP sentence → highlight source transcript span (+
   replay if audio retained); per-element confidence/provenance badge; route unlinked/low-confidence claims to the
   top of the review queue. [10][11]
3. **Attack omissions explicitly:** automated **coverage check** — diff NER entities against the generated note and
   flag discussed-but-not-documented entities for clinician confirmation. [7][6]
4. **Add an attestation gate to the approval step:** no note becomes "approved" without an explicit clinician
   attestation event storing **model name/version, prompt/template version, timestamp, clinician ID, attestation
   hash.** [20][22]
5. **Persist an AI-disclosure line** that survives EHR/CCD/USCDI export; emit **FHIR Provenance** per note. [20]
6. **Instrument the edit/correction loop as a core metric:** capture diff(AI draft, signed note); track edit rate,
   omissions, attribution fixes per doctor/specialty/model backend; escalate >15–20% correction. [22][24]
7. **Feed corrections — not raw style — into personalization carefully:** the per-doctor "writing style" should learn
   *formatting/voice*, but **must not learn to suppress safety content** (never learn to drop meds review). [6][9]
8. **Stand up a SCRIBE-style eval harness** (human + automated + LLM-judge + simulated encounters) and run **shadow
   mode** before exposing a new model/prompt to clinicians. [23][24]
9. **Keep HOPE on the documentation side of FDA SaMD;** isolate any A&P "suggestions" behind clear CDS labelling and
   assess SaMD/EU-high-risk exposure first. [15][16][19]
10. **Lock down the PHI chain:** BAAs/data-handling for every backend; Ollama in-VPC/on-prem for PHI; encrypt audio/
    transcripts; audit-log every access; define retention; capture **patient recording consent.** [17][18][21]

## Sources
1. Ambient AI Scribes in Clinical Practice: A Randomized Trial — PMC: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12768499
2. Same RCT — NEJM AI: https://ai.nejm.org/doi/abs/10.1056/AIoa2501000
3. Same RCT preprint — medRxiv: https://www.medrxiv.org/content/10.1101/2025.07.10.25331333v1
4. Ambient AI Scribes to Reduce Burden & Burnout — JAMA Network Open: https://jamanetwork.com/journals/jamanetworkopen/fullarticle/2839542
5. AI Scribe & EHR Efficiency (UChicago): https://www.uchicagomedicine.org/forefront/research-and-discoveries-articles/2025/november/ambient-ai-saves-time-reduces-burnout-fosters-patient-connection
6. Quality of Clinical Notes Created by Ambient Listening GenAI — JMIR Medical Informatics 2026: https://medinform.jmir.org/2026/1/e86474/PDF
7. Accuracy and Safety of AI-Enabled Scribe Technology: Instrument Validation — JMIR 2025: https://www.jmir.org/2025/1/e64993
8. Assessing the quality of AI-generated clinical notes (modified PDQI-9) — Frontiers in AI 2025: https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1691499/full
9. Evaluating Quality & Safety of Ambient Digital Scribe Platforms — Mayo Clinic Proceedings: Digital Health 2025: https://www.mcpdigitalhealth.org/article/S2949-7612(25)00099-9/fulltext
10. Verify a Note With Linked Evidence — Abridge Support: https://support.abridge.com/hc/en-us/articles/30235128433811-Verify-a-Note-With-Linked-Evidence
11. Abridge vs. Ambience (feature comparison): https://ai.deliverhealth.com/blog/abridge-vs-ambience
12. Building Your Ambient Scribe — Corti developer docs: https://corti.mintlify.app/get_started/ambient-scribe
13. What Is Ambient Clinical Intelligence? — Suki 2026 guide: https://www.suki.ai/blog/what-is-ambient-clinical-intelligence-the-2026-guide-for-health-systems/
14. Artificial Intelligence in Software as a Medical Device — FDA: https://www.fda.gov/medical-devices/software-medical-device-samd/artificial-intelligence-software-medical-device
15. Do I Need FDA Clearance for my health AI? (scribes under enforcement discretion): https://topflightapps.com/ideas/health-ai-medical-device-fda-clearance/
16. FDA Clinical Decision Support Software guidance: https://www.fda.gov/media/109618/download
17. AI Scribes & HIPAA: What Providers Need to Know: https://skriber.com/wp-content/uploads/2025/09/AI-Scribes-HIPAA_-What-Providers-Need-to-Know.pdf
18. HIPAA for AI Scribes: How to Build Compliant Systems: https://artempolynko.com/blog/hipaa-for-ai-scribes/
19. AI Medical Scribe: Legal Implications and Regulatory Considerations — Heidi: https://www.heidihealth.com/blog/ai-medical-scribe-legal-implications
20. California AI Scribe Laws: AB-3030 / FHIR Provenance / USCDI v4: https://www.scribing.io/ai-scribe-laws/california-ab3030-compliance
21. Using AI-enabled ambient scribing products in health and care settings — NHS England: https://transform.england.nhs.uk/information-governance/guidance/using-ai-enabled-ambient-scribing-products-in-health-and-care-settings/
22. Governing AI Scribes in Healthcare: A Quality and Safety Framework — American Data Network: https://www.americandatanetwork.com/healthcare-quality/ai-scribes-in-healthcare-governance-framework/
23. An evaluation framework for ambient digital scribing tools (SCRIBE) — npj Digital Medicine 2025: https://www.nature.com/articles/s41746-025-01622-1
24. Barriers and opportunities of scaling ambient AI scribes — npj Digital Medicine 2026: https://www.nature.com/articles/s41746-026-02554-0
25. AI Scribe & LLM Technology in Healthcare Documentation — PMC: https://pmc.ncbi.nlm.nih.gov/articles/PMC11737491/
