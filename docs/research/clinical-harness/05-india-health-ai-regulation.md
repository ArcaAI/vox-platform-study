# 05 · India — Health-AI Regulation & Interoperability

> The India-first compliance surface for a clinical-documentation harness: data-protection (DPDP), the national
> digital-health stack (ABDM/ABHA/FHIR), telemedicine rules, medical-device/SaMD classification, and AI governance.
> **Headline:** India has **no AI-specific statute yet**, so obligations come from **DPDP Act 2023 + DPDP Rules 2025**,
> **ABDM** standards, **Telemedicine Practice Guidelines 2020**, and **CDSCO/MDR-2017** — plus the voluntary **MeitY
> AI Governance Guidelines (Nov 2025)**.
>
> ⚠️ *Engineering research, not legal advice — confirm with Indian counsel; several instruments are phasing in.*

---

## 1. Data protection — DPDP Act 2023 + DPDP Rules 2025
- **Health data is personal data** under DPDP (no separate "sensitive" tier in the Act itself, but Rules + sectoral
  norms treat health with heightened care). Processing needs a lawful basis — generally **free, informed, specific,
  unambiguous consent** with a plain-language notice; patients (Data Principals) get access/correction/erasure/
  grievance rights. [1][2][3]
- **DPDP Rules 2025** (notified/phasing in 2025–2026) operationalise: notice & **Consent Manager** mechanics,
  **breach notification** to the Data Protection Board + affected principals, **retention/erasure**, and **Significant
  Data Fiduciary (SDF)** duties — **DPIA, annual audit, algorithmic-fairness due diligence**, and possible **data-
  localisation** for SDFs. A health-AI platform at scale is likely an **SDF**. [2][3][4]
- **Children:** verifiable parental consent for under-18s; no behavioural tracking/targeted ads at children. [2][3]
- **Cross-border:** transfers allowed except to government-restricted countries (blacklist model), **but** sectoral
  rules can be stricter and SDF localisation may apply → **default to in-country processing/storage of PHI** for HOPE. [2][4]
- **Practical HOPE actions:** consent capture + purpose limitation per consultation; in-country data residency; breach
  runbook; DPIA; audit trail; data-principal rights endpoints; honour grievance timelines. [1][2][3][4]

## 2. National digital-health stack — ABDM / ABHA / FHIR
- **ABDM** (Ayushman Bharat Digital Mission, run by **NHA**) is the interoperability backbone: **ABHA** health ID,
  Health Facility & Healthcare Professional registries, and a **consent-driven Health Information Exchange (HIE-CM)**. [5][6]
- **Standard wire format = HL7 FHIR R4**, via **NRCeS** India FHIR profiles. Clinical documents are exchanged as
  **DocumentBundle**s; the relevant artefact for a consultation note is the **OPConsultRecord** (OP consultation)
  profile (others: DischargeSummary, Prescription, DiagnosticReport, WellnessRecord, ImmunizationRecord). [6][7]
- **Terminology:** ABDM mandates **SNOMED CT** (India is a member via NRCeS) for clinical terms and **LOINC** for
  labs; **NDHM Sandbox** is the certification path before production HIE participation. [7][8]
- **Practical HOPE actions:** model the signed note as an **OPConsultRecord DocumentBundle**; carry **ABHA** linkage;
  use SNOMED/LOINC coding (ties to `02` ontology linking); plan **NDHM Sandbox** certification before any HIE write. [6][7][8]

## 3. Telemedicine Practice Guidelines 2020 (+ MCI/NMC)
- Issued under the IMC Act (Board of Governors/NMC); **legally binding on RMPs**. Cover identification of patient &
  practitioner, **consent**, types of consultation, record-keeping, and **prescription rules** (categorised drug
  lists; some prohibited via telemedicine). The RMP is **accountable for the record and prescription**. [9][10]
- **Practical HOPE actions:** keep clinician identity + patient consent in the record; respect telemedicine
  prescription constraints if any prescribing surface is added; retain consultation records per guidance. [9][10]

## 4. Medical-device / SaMD classification — CDSCO
- Software qualifying as a medical device is regulated under the **Medical Devices Rules 2017** by **CDSCO**;
  risk classes **A–D**. A **pure documentation scribe** (transcribe/summarise, clinician signs) generally sits
  **outside device regulation**; adding **diagnostic/treatment recommendations** can pull it into **SaMD** territory.
  CDSCO has been **developing SaMD-specific guidance** — monitor. [11][12]
- **Practical HOPE actions:** keep HOPE on the **documentation-aid** side; isolate/label any CDS-like suggestion;
  document the classification rationale; track CDSCO SaMD guidance. [11][12]

## 5. AI governance — MeitY (voluntary, but directional)
- **India AI Governance Guidelines (MeitY, Nov 2025)** + the **IndiaAI Mission**: principles-based (no hard AI law
  yet) — transparency, accountability, fairness, safety, human oversight, grievance redress; references techno-legal
  tooling (e.g., **SAHI** for safety, **BODH** for evaluation). Health is flagged high-impact. Expect this to inform
  future binding rules. [13][14][15]
- **Practical HOPE actions:** align the harness's transparency/oversight/audit posture with these principles now (it
  already overlaps with `03` governance); keep human-in-the-loop + disclosure + grievance paths first-class. [13][14]

## 6. Net compliance checklist for HOPE (India-first)
1. **Consent + notice** per consultation (DPDP); Consent-Manager-compatible. [1][2][3]
2. **In-country PHI residency** + encryption; assume **SDF** duties (DPIA, annual audit, fairness review). [2][4]
3. **Breach runbook** → Data Protection Board + principals within prescribed timelines. [2][3]
4. **Data-principal rights** endpoints (access/correct/erase/grievance). [1][2]
5. **ABDM-ready FHIR R4 output** — OPConsultRecord DocumentBundle, ABHA linkage, **SNOMED CT + LOINC**, NDHM Sandbox
   certification before HIE. [6][7][8]
6. **Telemedicine compliance** — clinician identity, consent, record-keeping, prescription rules. [9][10]
7. **Stay documentation-aid (not SaMD)**; document rationale; watch CDSCO. [11][12]
8. **Align with MeitY AI governance** — transparency, oversight, audit, grievance. [13][14]

## Sources
1. DPDP Act 2023 (MeitY, official PDF): https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf
2. DPDP Rules 2025 (overview & analysis): https://www.dataguidance.com/news/india-meity-publishes-digital-personal-data-protection-rules
3. DPDP — health-data implications (analysis): https://www.mondaq.com/india/data-protection/india-dpdp-and-healthcare
4. Significant Data Fiduciary obligations & localisation (analysis): https://www.scconline.com/blog/post/2025/01/draft-dpdp-rules-2025/
5. ABDM (NHA) official site: https://abdm.gov.in/
6. ABDM Sandbox / Building Blocks & HIE-CM: https://sandbox.abdm.gov.in/
7. NRCeS — India FHIR Implementation Guide / profiles (OPConsultRecord etc.): https://www.nrces.in/ndhm/fhir/r4/index.html
8. NRCeS — SNOMED CT India (National Release Centre): https://www.nrces.in/
9. Telemedicine Practice Guidelines 2020 (MoHFW/BoG, PDF): https://www.mohfw.gov.in/pdf/Telemedicine.pdf
10. Telemedicine Guidelines — analysis/summary: https://www.nmc.org.in/
11. CDSCO — Medical Devices Rules 2017 / classification: https://cdsco.gov.in/opencms/opencms/en/Medical-Device-Diagnostics/Medical-Device-Diagnostics/
12. SaMD regulation in India (analysis): https://www.medicaldevice-network.com/ / CDSCO SaMD draft (monitor)
13. MeitY — India AI Governance Guidelines (Nov 2025): https://www.meity.gov.in/
14. IndiaAI Mission: https://indiaai.gov.in/
15. India AI governance — analysis (SAHI/BODH, voluntary framework): https://www.dataguidance.com/jurisdiction/india
16. ABHA (health ID) overview: https://abha.abdm.gov.in/
17. HL7 FHIR R4 (base spec, referenced by NRCeS profiles): https://hl7.org/fhir/R4/
18. Personal Data Protection in Indian healthcare (peer-reviewed overview): https://pmc.ncbi.nlm.nih.gov/articles/PMC10718068/
