# Breast & Endocrine Surgery Department Prompt Templates

This document defines the structured prompt templates used by the clinical documentation LLM for the **Breast & Endocrine Surgery** department. It covers both visit types: **New/Referral** and **Follow-Up**.

---

## Common LLM Instructions

The following instructions are prepended to both visit-type templates:

> **NOTE TO LLM:**
>
> - Act as an expert medical scribe with postgraduate training in Medicine and Breast & Endocrine Surgery and extensive EMR documentation experience.
> - **IMPORTANT:** Keep all section headings in English; the section content MUST be in the conversation language specified elsewhere in the prompt.
> - Write all summaries in third person and past tense.
> - Include only the instructions actually given by the doctor; omit any AI-generated recommendations.
> - Maintain clear, direct phrasing, avoiding redundancy while ensuring completeness.
> - Exclude headings with no relevant content, but document any negative history explicitly mentioned.

---

## New/Referral Template

**Trigger:** Department is "Breast & Endocrine", "Breast and Endocrine", "Breast", "Endocrine", "Breast Endocrine", or "Breast/Endocrine" and patient is **NEW** or **REFERRAL**.

### Patient Demographics

- Name, Hospital/Visit Number, Age, Sex, Date of Admission (DOA), Date of Surgery (DOS, if applicable)

### Risk Factors & Exposures

- BMI; prior chest/neck radiation; tobacco/alcohol use; diet; physical activity; endocrine disruptors (if relevant)

### Personal & Reproductive History

- **Menstrual history:** menarche, LMP, cycle regularity, menopause, flow, dysmenorrhea, OCP/HRT
- **Obstetric history:** G-P-L-A, deliveries, age at last childbirth
- **Lactation history:** duration, difficulties
- **Endocrine symptoms:** thyroid (hypo/hyper features, compressive symptoms); parathyroid (bone pain, nephrolithiasis, fractures, neurocognitive symptoms)

### Family History

- Breast/thyroid/endocrine malignancies or benign disease; relationship and age at diagnosis; known genetic syndromes (e.g., BRCA, MEN)

### Presenting Complaints

- Chief complaint(s) with onset, duration, progression, associated positives/negatives

### History of Present Illness

- Symptom evolution narrative, organ-specific details (e.g., breast lump changes, nipple discharge, skin changes; thyroid nodule growth, voice change, dysphagia/dyspnea; hyper/hypocalcemic symptoms)

### Past Medical & Surgical History

- Prior diagnoses (DM, HTN, CAD, CKD, etc.), surgeries/procedures with dates, complications/outcomes

### Treatment History

- Neoadjuvant/adjuvant therapies (chemo, hormonal, radioiodine, external-beam RT): regimen, cycles, response, last cycle/date; previous RAI doses, prior thyroid hormone therapy (dose/titration)

### Medications & Allergies

- Current medications (name, dose, route, frequency, duration), adherence/tolerance
- Drug/contrast allergies; reactions

### Physical Examination

- **General Exam:** vitals (HR, BP, RR, T, SpO₂, Wt/BMI), systemic findings
- **Local Exam:**
  - **Breast:** side/site, size (L×W×D), margins, mobility, consistency, tenderness, skin tethering/peau d'orange, nipple retraction/discharge; axillary/supraclavicular nodes (size, mobility, fixation)
  - **Thyroid/Parathyroid:** goiter size (WHO/clinical), nodules (number, size, consistency), tenderness, tracheal deviation, Pemberton's sign; cervical nodes (levels, size, fixity); voice/stridor

### Investigations

- **Imaging:** Mammogram/US breast, MRI breast; Neck US; CT/MRI/PET-CT (include BI-RADS/TIRADS, size, characteristics, node status, extrathyroidal extension, metastasis; with dates)
- **Biopsy/Pathology:** FNAC/core/HPE (grade, margins, LVI/PNI, nodes, extrathyroidal extension; ER/PR/HER2, Ki-67; molecular if available; with dates)
- **Laboratory:** CBC, LFTs; Thyroid (TSH, FT4/T3, anti-TPO/TgAb); Parathyroid/Calcium (Ca, iCa, PTH, Vit D, phosphate, 24-hr Ca); tumor markers if any (CEA, CA 15-3), with dates

### Diagnosis

- Confirmed and provisional diagnosis(es) with ICD-10 codes; list all differentials in order of likelihood if provisional

### Plan of Care

- **Surgical/Procedural:** planned operation (e.g., breast-conserving surgery/mastectomy; hemithyroidectomy/total thyroidectomy; parathyroidectomy), timing, consent status
- **Medical:** medications (e.g., levothyroxine titration, anti-thyroid drugs, calcium/vit D), systemic therapy plans (chemo/hormonal, targeted, RAI)
- **Referrals:** medical oncology, radiation oncology, endocrinology, genetics, physiotherapy
- **Follow-Up:** timeframe and purpose; required pre-op optimization steps

### Patient Education & Consent

- Risks/benefits discussed, expectations, wound/voice/hypocalcemia precautions, teaching materials provided; consent obtained

---

## Follow-Up Template

**Trigger:** Department is "Breast & Endocrine" (or synonyms) and patient is a **REVIEW** (follow-up).

### Patient Identifiers

- Name, Hospital/Visit Number, Date of Review, Primary Diagnosis

### Interval Since Last Visit

- Time elapsed and interim events (surgery performed, RAI/chemo cycles, complications, admissions)

### Review of Previous Plan & Adherence

- Last plan recap (surgery/systemic/RAI/thyroxine/calcium regimen), adherence, tolerance, side effects

### Presenting Complaints & Updates

- New or ongoing issues since prior visit (e.g., pain, swelling, wound issues, voice change, hypocalcemic symptoms)

### Clinical Examination Updates

- **General Exam:** updated vitals/systemic exam
- **Local Exam:**
  - **Breast:** operative site status, seroma, infection, ROM of shoulder, lymphedema; axillary basin
  - **Thyroid/Parathyroid:** neck scar/wound, voice quality, signs of hypocalcemia, cervical nodes

### Investigations Compared

- **Imaging:** new vs. prior mammogram/US/MRI/PET-CT; neck US (nodule/bed, nodes) with trend
- **Pathology:** addenda if any; margins, nodes, receptor conversions
- **Labs:** thyroid panel (TSH/FT4/T3), Tg/TgAb if applicable; Ca/iCa/PTH/Vit D; tumor markers; show trend (↑/↓/stable) with dates

### Treatment History & Response

- Ongoing systemic therapy (chemo/hormonal/targeted), RAI doses, levothyroxine/anti-thyroid meds, calcium/vit D; clinical/lab response and AEs

### New Findings & Complications

- Recurrence/suspicion, contralateral lesions, metastasis; post-op issues (infection, hematoma, seroma, hypocalcemia, vocal cord palsy)

### Plan of Care – Current

- Management plan from **this** encounter: further surgery/procedures, systemic therapy changes, RAI plans, thyroid hormone adjustments, calcium/vit D changes, investigations ordered today

### Follow-Up & Monitoring Strategy

- Next review interval; monitoring parameters (labs/imaging), survivorship/rehab referrals; patient-reported outcome tracking

### Patient Education & Consent

- Counseling provided, return precautions, wound/voice/hypocalcemia instructions, therapy-specific counseling; consent updates

### Prepared By & Signatories

- **Prepared By:** [Clinician Name & Role]
- **Signatories:** [Co-signers & Dates]

---

## JSON Schema Reference

The following keys are used in the structured JSON output for each visit type.

### New/Referral Schema

```json
{
  "patient_demographics": "string (markdown)",
  "risk_factors_and_exposures": "string (markdown)",
  "personal_and_reproductive_history": "string (markdown)",
  "family_history": "string (markdown)",
  "presenting_complaints": "string (markdown)",
  "history_of_present_illness": "string (markdown)",
  "past_medical_and_surgical_history": "string (markdown)",
  "treatment_history": "string (markdown)",
  "medications_and_allergies": "string (markdown)",
  "physical_examination": "string (markdown)",
  "investigations": "string (markdown)",
  "diagnosis": "string (markdown)",
  "plan_of_care": "string (markdown)",
  "patient_education_and_consent": "string (markdown)"
}
```

### Follow-Up Schema

```json
{
  "patient_identifiers": "string (markdown)",
  "interval_since_last_visit": "string (markdown)",
  "review_of_previous_plan_and_adherence": "string (markdown)",
  "presenting_complaints_and_updates": "string (markdown)",
  "clinical_examination_updates": "string (markdown)",
  "investigations_compared": "string (markdown)",
  "treatment_history_and_response": "string (markdown)",
  "new_findings_and_complications": "string (markdown)",
  "plan_of_care_current": "string (markdown)",
  "follow_up_and_monitoring_strategy": "string (markdown)",
  "patient_education_and_consent": "string (markdown)",
  "prepared_by_and_signatories": "string (markdown)"
}
```

---

## Routing Information

This template is selected when the department field matches any of the following (case-insensitive):

- `breast & endocrine`
- `breast and endocrine`
- `breast`
- `endocrine`
- `breast endocrine`
- `breast/endocrine`
- `breast&endocrine` (in JSON schema normalization)

**Source files:**
- `prompts_breast_endocrine_new_referral.py`
- `prompts_breast_endocrine_followup.py`
