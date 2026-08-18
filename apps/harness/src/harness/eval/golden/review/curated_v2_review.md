# Clinician review — `curated-v2.0.0`

> **What you are reviewing.** Every rating below was produced by an AI applying the Epic
> PDSQI-9 grade descriptors under the labelling rules in
> [`../curated_v2_spec.md`](../curated_v2_spec.md) §3. **None of these are clinician
> ratings.** Your sign-off is what makes them authoritative.
>
> **How to review efficiently.** The ratings were produced by RULE, not case by case, so
> checking the seven rules in §3 of the spec covers all 36 cases. Read the rules
> first; then spot-check cases, and record only where you DISAGREE.
>
> **The one decision that matters most** is spec §5 rule **R3**: a content error does not
> lower `citation`. It affects 8 cases by 3 points. Please answer that one explicitly.
>
> **Recording your decision.** For each case you want to change, add an entry to
> `curated_v2_amendments.json`:
>
> ```json
> {
>   "reviewer": "<your name or initials>",
>   "reviewed_at": "<YYYY-MM-DD>",
>   "amendments": [
>     {"case_id": "cv2-s01-L2-fabrication",
>      "ratings": {"accurate": 1},
>      "note": "why you changed it"}
>   ]
> }
> ```
>
> Only the dimensions you name are changed; everything else keeps the proposed value.
> Then run `apply_amendments.py`, which ships a NEW version (`curated-v2.1.0`) rather
> than mutating this one, so historical gate runs stay interpretable.

**Set**: `curated-v2.0.0` · **cases**: 36 (12 quality / 24 calibration)
· **paired ratings**: 288 · **status**: PENDING CLINICIAN REVIEW

---

## Contents

- [`cv2-s01-L5-gold`](#cv2-s01-l5-gold) — L5 · quality · Family Medicine · split `dev`
- [`cv2-s01-L2-fabrication`](#cv2-s01-l2-fabrication) — L2 · calibration · Family Medicine · split `dev`
- [`cv2-s01-L4-uncited`](#cv2-s01-l4-uncited) — L4 · calibration · Family Medicine · split `dev`
- [`cv2-s02-L5-gold`](#cv2-s02-l5-gold) — L5 · quality · Internal Medicine · split `holdout`
- [`cv2-s02-L1-severe`](#cv2-s02-l1-severe) — L1 · calibration · Internal Medicine · split `holdout`
- [`cv2-s02-L3-omission`](#cv2-s02-l3-omission) — L3 · calibration · Internal Medicine · split `holdout`
- [`cv2-s03-L5-gold`](#cv2-s03-l5-gold) — L5 · quality · Cardiology · split `dev`
- [`cv2-s03-L2-dose`](#cv2-s03-l2-dose) — L2 · calibration · Cardiology · split `dev`
- [`cv2-s03-L4-verbose`](#cv2-s03-l4-verbose) — L4 · calibration · Cardiology · split `dev`
- [`cv2-s04-L5-gold`](#cv2-s04-l5-gold) — L5 · quality · Pediatrics · split `dev`
- [`cv2-s04-L2-laterality`](#cv2-s04-l2-laterality) — L2 · calibration · Pediatrics · split `dev`
- [`cv2-s04-L3-temporal`](#cv2-s04-l3-temporal) — L3 · calibration · Pediatrics · split `dev`
- [`cv2-s05-L5-gold`](#cv2-s05-l5-gold) — L5 · quality · Obstetrics and Gynecology · split `holdout`
- [`cv2-s05-L2-false-negation`](#cv2-s05-l2-false-negation) — L2 · calibration · Obstetrics and Gynecology · split `holdout`
- [`cv2-s05-L4-minor-omission`](#cv2-s05-l4-minor-omission) — L4 · calibration · Obstetrics and Gynecology · split `holdout`
- [`cv2-s06-L5-gold`](#cv2-s06-l5-gold) — L5 · quality · Psychiatry · split `dev`
- [`cv2-s06-L1-severe`](#cv2-s06-l1-severe) — L1 · calibration · Psychiatry · split `dev`
- [`cv2-s06-L3-misattribution`](#cv2-s06-l3-misattribution) — L3 · calibration · Psychiatry · split `dev`
- [`cv2-s07-L5-gold`](#cv2-s07-l5-gold) — L5 · quality · Pulmonology · split `dev`
- [`cv2-s07-L2-temporal`](#cv2-s07-l2-temporal) — L2 · calibration · Pulmonology · split `dev`
- [`cv2-s07-L3-omission`](#cv2-s07-l3-omission) — L3 · calibration · Pulmonology · split `dev`
- [`cv2-s08-L5-gold`](#cv2-s08-l5-gold) — L5 · quality · Gastroenterology · split `dev`
- [`cv2-s08-L2-omission`](#cv2-s08-l2-omission) — L2 · calibration · Gastroenterology · split `dev`
- [`cv2-s08-L4-under-synthesis`](#cv2-s08-l4-under-synthesis) — L4 · calibration · Gastroenterology · split `dev`
- [`cv2-s09-L5-gold`](#cv2-s09-l5-gold) — L5 · quality · Endocrinology · split `holdout`
- [`cv2-s09-L2-dose`](#cv2-s09-l2-dose) — L2 · calibration · Endocrinology · split `holdout`
- [`cv2-s09-L3-misattribution`](#cv2-s09-l3-misattribution) — L3 · calibration · Endocrinology · split `holdout`
- [`cv2-s10-L5-gold`](#cv2-s10-l5-gold) — L5 · quality · Orthopedics · split `dev`
- [`cv2-s10-L2-laterality`](#cv2-s10-l2-laterality) — L2 · calibration · Orthopedics · split `dev`
- [`cv2-s10-L4-verbose`](#cv2-s10-l4-verbose) — L4 · calibration · Orthopedics · split `dev`
- [`cv2-s11-L5-gold`](#cv2-s11-l5-gold) — L5 · quality · Nephrology · split `dev`
- [`cv2-s11-L1-severe`](#cv2-s11-l1-severe) — L1 · calibration · Nephrology · split `dev`
- [`cv2-s11-L3-false-negation`](#cv2-s11-l3-false-negation) — L3 · calibration · Nephrology · split `dev`
- [`cv2-s12-L5-gold`](#cv2-s12-l5-gold) — L5 · quality · Emergency Medicine · split `holdout`
- [`cv2-s12-L1-severe`](#cv2-s12-l1-severe) — L1 · calibration · Emergency Medicine · split `holdout`
- [`cv2-s12-L2-laterality`](#cv2-s12-l2-laterality) — L2 · calibration · Emergency Medicine · split `holdout`

---

### `cv2-s01-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Family Medicine |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: What brings you in today? Patient: Eight days of nasal congestion and facial pressure. It improved around day four and then got worse again. Doctor: Any fever? Patient: I felt feverish two days ago but I did not measure it. Doctor: On examination your temperature is 37.4 degrees Celsius, there is tenderness over the right maxillary sinus, the nasal mucosa is swollen, and the lungs are clear. Doctor: The double-worsening pattern makes this acute bacterial rhinosinusitis rather than a simple viral cold. I will start amoxicillin-clavulanate 875/125 milligrams twice daily for seven days. Use saline irrigation and take acetaminophen for pain. Return if you develop a high fever, vision changes, or severe headache.

**Source document 2**

> Patient record SYN-0001. Past medical history: no chronic conditions. Current medications: none. No known drug allergies.

**Note under review**

> Subjective: Adult with eight days of nasal congestion and right-sided facial pressure, improving around day four then worsening again; subjective fever two days ago, unmeasured <Note ID:1>. No chronic conditions, no current medications, no known drug allergies <Note ID:2>. Objective: Temperature 37.4 C, right maxillary sinus tenderness, swollen nasal mucosa, clear lungs <Note ID:1>. Assessment: Acute bacterial rhinosinusitis - the double-worsening course plus focal maxillary tenderness distinguishes this from an uncomplicated viral upper respiratory infection <Note ID:1>. Plan: Amoxicillin-clavulanate 875/125 mg twice daily for seven days, saline irrigation, acetaminophen for pain; return for high fever, vision changes, or severe headache <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Every assertion cited to a supporting note (citation 5); all assertions traceable (accurate 5); no omissions (thorough 5); no non-pertinent content and detail level fits a family physician (useful 5); SOAP order and grouping (organized 5); plain language (comprehensible 5); no redundancy (succinct 5); assessment integrates the temporal course with the focal finding into a differential-resolving synopsis (synthesized 5).

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s01-L2-fabrication`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Family Medicine |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: What brings you in today? Patient: Eight days of nasal congestion and facial pressure. It improved around day four and then got worse again. Doctor: Any fever? Patient: I felt feverish two days ago but I did not measure it. Doctor: On examination your temperature is 37.4 degrees Celsius, there is tenderness over the right maxillary sinus, the nasal mucosa is swollen, and the lungs are clear. Doctor: The double-worsening pattern makes this acute bacterial rhinosinusitis rather than a simple viral cold. I will start amoxicillin-clavulanate 875/125 milligrams twice daily for seven days. Use saline irrigation and take acetaminophen for pain. Return if you develop a high fever, vision changes, or severe headache.

**Source document 2**

> Patient record SYN-0001. Past medical history: no chronic conditions. Current medications: none. No known drug allergies.

**Note under review**

> Subjective: Adult with eight days of nasal congestion and right-sided facial pressure, improving around day four then worsening again; subjective fever two days ago, unmeasured <Note ID:1>. No chronic conditions, no current medications, no known drug allergies <Note ID:2>. Objective: Temperature 37.4 C, right maxillary sinus tenderness, swollen nasal mucosa, clear lungs; sinus CT confirms right maxillary air-fluid level <Note ID:1>. Assessment: Acute bacterial rhinosinusitis confirmed on imaging <Note ID:1>. Plan: Amoxicillin-clavulanate 875/125 mg twice daily for seven days, saline irrigation, acetaminophen for pain; return for high fever, vision changes, or severe headache <Note ID:1>.

**Seeded defect(s)**

- **`fabrication`** — span: `sinus CT confirms right maxillary air-fluid level`
  - why it is wrong: No imaging was performed or discussed anywhere in the source documents.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 5 | 5 | 5 | 5 | 5 | 2 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

One overt fabrication -> accurate 2 (rubric: 'a major error in assertion occurs with an overt falsification or fabrication').The fabrication is the stated basis of the diagnosis -> synthesized 2. Nothing else moves: no omissions (thorough 5), structure intact (organized 5), plain language (comprehensible 5), no redundancy (succinct 5), detail level unchanged (useful 5). INDEPENDENT-DIMENSION RULE: a content error does NOT lower 'citation' - the citation dimension grades whether assertions carry correctly-PAIRED <Note ID:#> markers, and every assertion here is cited to the note it purports to summarise, so citation stays 5. See golden/curated_v2_spec.md section 3 rule R3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s01-L4-uncited`

| | |
|---|---|
| Level | **L4** (calibration lane) |
| Specialty | Family Medicine |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: What brings you in today? Patient: Eight days of nasal congestion and facial pressure. It improved around day four and then got worse again. Doctor: Any fever? Patient: I felt feverish two days ago but I did not measure it. Doctor: On examination your temperature is 37.4 degrees Celsius, there is tenderness over the right maxillary sinus, the nasal mucosa is swollen, and the lungs are clear. Doctor: The double-worsening pattern makes this acute bacterial rhinosinusitis rather than a simple viral cold. I will start amoxicillin-clavulanate 875/125 milligrams twice daily for seven days. Use saline irrigation and take acetaminophen for pain. Return if you develop a high fever, vision changes, or severe headache.

**Source document 2**

> Patient record SYN-0001. Past medical history: no chronic conditions. Current medications: none. No known drug allergies.

**Note under review**

> Subjective: Adult with eight days of nasal congestion and right-sided facial pressure, improving around day four then worsening again; subjective fever two days ago, unmeasured <Note ID:1>. No chronic conditions, no current medications, no known drug allergies. Objective: Temperature 37.4 C, right maxillary sinus tenderness, swollen nasal mucosa, clear lungs. Assessment: Acute bacterial rhinosinusitis - the double-worsening course plus focal maxillary tenderness distinguishes this from an uncomplicated viral upper respiratory infection <Note ID:1>. Plan: Amoxicillin-clavulanate 875/125 mg twice daily for seven days, saline irrigation, acetaminophen for pain; return for high fever, vision changes, or severe headache.

**Seeded defect(s)**

- **`uncited_assertion`** — span: `Objective: Temperature 37.4 C, ... clear lungs.`
  - why it is wrong: Correct content, but the assertion carries no citation.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 3 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Rubric citation grade 3 verbatim: 'All citations correct but some assertions missing a citation'. Content is unchanged from the L5 gold note, so every other dimension keeps its gold value.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s02-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Internal Medicine |
| Consultation | long length · high complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Let us review everything today. Your home glucose readings are running 12 to 15 millimoles per litre before meals and the HbA1c drawn last week is 9.1 percent, up from 8.2 percent six months ago. Patient: I have been skipping the evening metformin because it upsets my stomach. Doctor: That matters. Your blood pressure today is 158 over 92 in both arms, repeated after five minutes at 154 over 90. The creatinine is 148 micromoles per litre with an estimated GFR of 42, which is stable compared with 44 six months ago, and the urine albumin-to-creatinine ratio is 28 milligrams per millimole. Feet: pedal pulses present, monofilament sensation intact bilaterally, no ulcers. Doctor: So we have type 2 diabetes with worsening control driven partly by adherence, stage 3b chronic kidney disease that is stable, albuminuria, and uncontrolled hypertension. Plan: switch to modified-release metformin 1000 milligrams once daily with the evening meal to reduce the gastrointestinal upset, add empagliflozin 10 milligrams daily for the kidney and cardiovascular benefit, increase ramipril from 5 to 10 milligrams daily for the blood pressure and albuminuria, repeat renal function and potassium in two weeks, and refer to the diabetes educator. Patient: What about my eyes? Doctor: Your retinal screening is due, I will book it.

**Source document 2**

> Patient record SYN-0002. Active problems: type 2 diabetes mellitus (12 years), essential hypertension, chronic kidney disease stage 3b. Current medications: metformin 1000 milligrams twice daily, ramipril 5 milligrams daily, atorvastatin 20 milligrams daily. Allergy: penicillin - rash.

**Note under review**

> Subjective: Adult with 12-year type 2 diabetes, hypertension and CKD 3b reports pre-meal glucose 12-15 mmol/L and admits omitting the evening metformin because of gastrointestinal upset <Note ID:1>. Background medications metformin, ramipril and atorvastatin; penicillin allergy (rash) <Note ID:2>. Objective: HbA1c 9.1% (was 8.2% six months ago); BP 158/92 then 154/90; creatinine 148 umol/L, eGFR 42 (was 44); urine ACR 28 mg/mmol; feet with intact pulses and monofilament sensation, no ulcers <Note ID:1>. Assessment: Deteriorating glycaemic control attributable to intolerance-driven non-adherence rather than disease progression, on a background of stable stage 3b CKD with albuminuria and uncontrolled hypertension - the three problems share one therapeutic lever <Note ID:1>. Plan: Switch to modified-release metformin 1000 mg once daily with the evening meal; add empagliflozin 10 mg daily for renal and cardiovascular protection; increase ramipril to 10 mg daily; repeat renal function and potassium in two weeks; refer to diabetes education; book due retinal screening <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

All assertions cited and traceable; no pertinent or potentially-pertinent omission (both BP readings, both eGFR values, the foot exam, the retinal screening and the allergy are all carried); grouping is problem-based with an assessment that reasons across the three problems (synthesized 5).

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s02-L1-severe`

| | |
|---|---|
| Level | **L1** (calibration lane) |
| Specialty | Internal Medicine |
| Consultation | long length · high complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Let us review everything today. Your home glucose readings are running 12 to 15 millimoles per litre before meals and the HbA1c drawn last week is 9.1 percent, up from 8.2 percent six months ago. Patient: I have been skipping the evening metformin because it upsets my stomach. Doctor: That matters. Your blood pressure today is 158 over 92 in both arms, repeated after five minutes at 154 over 90. The creatinine is 148 micromoles per litre with an estimated GFR of 42, which is stable compared with 44 six months ago, and the urine albumin-to-creatinine ratio is 28 milligrams per millimole. Feet: pedal pulses present, monofilament sensation intact bilaterally, no ulcers. Doctor: So we have type 2 diabetes with worsening control driven partly by adherence, stage 3b chronic kidney disease that is stable, albuminuria, and uncontrolled hypertension. Plan: switch to modified-release metformin 1000 milligrams once daily with the evening meal to reduce the gastrointestinal upset, add empagliflozin 10 milligrams daily for the kidney and cardiovascular benefit, increase ramipril from 5 to 10 milligrams daily for the blood pressure and albuminuria, repeat renal function and potassium in two weeks, and refer to the diabetes educator. Patient: What about my eyes? Doctor: Your retinal screening is due, I will book it.

**Source document 2**

> Patient record SYN-0002. Active problems: type 2 diabetes mellitus (12 years), essential hypertension, chronic kidney disease stage 3b. Current medications: metformin 1000 milligrams twice daily, ramipril 5 milligrams daily, atorvastatin 20 milligrams daily. Allergy: penicillin - rash.

**Note under review**

> Plan: ramipril 10 mg twice daily and empagliflozin 25 mg daily. Diabetic foot ulceration noted on the left great toe. Assessment: chronic kidney disease is deteriorating with eGFR falling from 44 to 42. Subjective: glucose is high. HbA1c 9.1 percent.

**Seeded defect(s)**

- **`dose_error`** — span: `ramipril 10 mg twice daily and empagliflozin 25 mg daily`
  - why it is wrong: Source says ramipril 10 mg ONCE daily and empagliflozin 10 mg daily.
- **`fabrication`** — span: `Diabetic foot ulceration noted on the left great toe`
  - why it is wrong: Source foot exam explicitly records no ulcers.
- **`temporal_error`** — span: `chronic kidney disease is deteriorating`
  - why it is wrong: Source calls the CKD stable; 44 to 42 was explicitly described as stable.
- **`omission_material`** — span: `(missing) blood pressure, albuminuria, adherence cause, metformin switch, monitoring plan, allergy`
  - why it is wrong: More than one pertinent item is absent.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 2 | 1 | 3 | 4 | 1 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Multiple overt falsifications/fabrications -> accurate 1. No citations at all -> citation 1. More than one pertinent omission -> thorough 1. Assertions presented out of order with incoherent grouping (Plan first, Subjective last) -> organized 1. Some assertions remain pertinent -> useful 2. Words are the source's own and readable -> comprehensible 3. Terse with no redundancy -> succinct 4. Reasoning across assertions is incorrect -> synthesized 1.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s02-L3-omission`

| | |
|---|---|
| Level | **L3** (calibration lane) |
| Specialty | Internal Medicine |
| Consultation | long length · high complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Let us review everything today. Your home glucose readings are running 12 to 15 millimoles per litre before meals and the HbA1c drawn last week is 9.1 percent, up from 8.2 percent six months ago. Patient: I have been skipping the evening metformin because it upsets my stomach. Doctor: That matters. Your blood pressure today is 158 over 92 in both arms, repeated after five minutes at 154 over 90. The creatinine is 148 micromoles per litre with an estimated GFR of 42, which is stable compared with 44 six months ago, and the urine albumin-to-creatinine ratio is 28 milligrams per millimole. Feet: pedal pulses present, monofilament sensation intact bilaterally, no ulcers. Doctor: So we have type 2 diabetes with worsening control driven partly by adherence, stage 3b chronic kidney disease that is stable, albuminuria, and uncontrolled hypertension. Plan: switch to modified-release metformin 1000 milligrams once daily with the evening meal to reduce the gastrointestinal upset, add empagliflozin 10 milligrams daily for the kidney and cardiovascular benefit, increase ramipril from 5 to 10 milligrams daily for the blood pressure and albuminuria, repeat renal function and potassium in two weeks, and refer to the diabetes educator. Patient: What about my eyes? Doctor: Your retinal screening is due, I will book it.

**Source document 2**

> Patient record SYN-0002. Active problems: type 2 diabetes mellitus (12 years), essential hypertension, chronic kidney disease stage 3b. Current medications: metformin 1000 milligrams twice daily, ramipril 5 milligrams daily, atorvastatin 20 milligrams daily. Allergy: penicillin - rash.

**Note under review**

> Subjective: Adult with 12-year type 2 diabetes, hypertension and CKD 3b reports pre-meal glucose 12-15 mmol/L and admits omitting the evening metformin because of gastrointestinal upset <Note ID:1>. Background metformin, ramipril and atorvastatin; penicillin allergy (rash) <Note ID:2>. Objective: HbA1c 9.1% (was 8.2%); BP 158/92 then 154/90; creatinine 148 umol/L, eGFR 42 (was 44); feet with intact pulses and monofilament sensation, no ulcers <Note ID:1>. Assessment: Deteriorating glycaemic control driven by intolerance-related non-adherence, with stable stage 3b CKD and uncontrolled hypertension <Note ID:1>. Plan: Switch to modified-release metformin 1000 mg once daily with the evening meal; add empagliflozin 10 mg daily; increase ramipril to 10 mg daily; repeat renal function and potassium in two weeks; refer to diabetes education; book due retinal screening <Note ID:1>.

**Seeded defect(s)**

- **`omission_material`** — span: `(missing) urine albumin-to-creatinine ratio 28 mg/mmol and the albuminuria problem`
  - why it is wrong: Albuminuria is one of the three named problems and part of the stated reason for uptitrating ramipril.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 3 | 5 | 5 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Exactly one pertinent omission -> thorough 3 (rubric verbatim). Everything present is accurate and cited, so accurate/citation stay 5. The assessment still reasons across problems but has lost one of the three, so synthesized drops one step to 4.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s03-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Cardiology |
| Consultation | medium length · moderate complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You have been getting palpitations for about three weeks. Patient: Yes, my chest flutters, mostly in the evening, and I get short of breath climbing stairs. No chest pain and no blackouts. Doctor: The ECG today shows atrial fibrillation with a ventricular rate of 118 beats per minute and no ischaemic changes. Blood pressure 132 over 80, no murmurs, chest clear, no ankle swelling. Thyroid function and electrolytes are normal. Doctor: This is new atrial fibrillation. Your CHA2DS2-VASc score is 3, so anticoagulation is indicated. I will start apixaban 5 milligrams twice daily and bisoprolol 2.5 milligrams once daily for rate control. Arrange an echocardiogram and review in four weeks. Do not start aspirin.

**Source document 2**

> Patient record SYN-0003. Past medical history: hypertension, type 2 diabetes. Medications: amlodipine 5 milligrams daily, metformin 500 milligrams twice daily. No known drug allergies.

**Note under review**

> Subjective: Adult reports three weeks of evening palpitations with exertional breathlessness, denying chest pain and syncope <Note ID:1>. Background hypertension and type 2 diabetes on amlodipine and metformin, no known allergies <Note ID:2>. Objective: ECG shows atrial fibrillation at a ventricular rate of 118 bpm without ischaemic change; BP 132/80, no murmur, chest clear, no peripheral oedema; thyroid function and electrolytes normal <Note ID:1>. Assessment: New-onset atrial fibrillation with a rapid ventricular response and no reversible precipitant on screening bloods; CHA2DS2-VASc 3, so stroke risk - not symptoms - drives the treatment decision <Note ID:1>. Plan: Apixaban 5 mg twice daily, bisoprolol 2.5 mg once daily for rate control, echocardiogram, review in four weeks; aspirin explicitly not indicated <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Every assertion cited and traceable; the negative findings (no chest pain, no syncope, normal thyroid, no aspirin) are all preserved; the assessment links the score to the therapeutic decision rather than restating it.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s03-L2-dose`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Cardiology |
| Consultation | medium length · moderate complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You have been getting palpitations for about three weeks. Patient: Yes, my chest flutters, mostly in the evening, and I get short of breath climbing stairs. No chest pain and no blackouts. Doctor: The ECG today shows atrial fibrillation with a ventricular rate of 118 beats per minute and no ischaemic changes. Blood pressure 132 over 80, no murmurs, chest clear, no ankle swelling. Thyroid function and electrolytes are normal. Doctor: This is new atrial fibrillation. Your CHA2DS2-VASc score is 3, so anticoagulation is indicated. I will start apixaban 5 milligrams twice daily and bisoprolol 2.5 milligrams once daily for rate control. Arrange an echocardiogram and review in four weeks. Do not start aspirin.

**Source document 2**

> Patient record SYN-0003. Past medical history: hypertension, type 2 diabetes. Medications: amlodipine 5 milligrams daily, metformin 500 milligrams twice daily. No known drug allergies.

**Note under review**

> Subjective: Adult reports three weeks of evening palpitations with exertional breathlessness, denying chest pain and syncope <Note ID:1>. Background hypertension and type 2 diabetes on amlodipine and metformin, no known allergies <Note ID:2>. Objective: ECG shows atrial fibrillation at a ventricular rate of 118 bpm without ischaemic change; BP 132/80, no murmur, chest clear, no peripheral oedema; thyroid function and electrolytes normal <Note ID:1>. Assessment: New-onset atrial fibrillation with rapid ventricular response; CHA2DS2-VASc 3, so anticoagulation is indicated <Note ID:1>. Plan: Apixaban 5 mg once daily, bisoprolol 2.5 mg once daily for rate control, echocardiogram, review in four weeks; aspirin explicitly not indicated <Note ID:1>.

**Seeded defect(s)**

- **`dose_error`** — span: `Apixaban 5 mg once daily`
  - why it is wrong: Source prescribes apixaban 5 mg TWICE daily; halving the frequency of a stroke-prevention anticoagulant is a major error.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 5 | 5 | 5 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

A dosing frequency falsification is an overt falsification of a critical detail -> accurate 2.The error is in the plan, not the diagnostic reasoning, so synthesized drops only one step (4). No omissions, structure and language intact. INDEPENDENT-DIMENSION RULE: a content error does NOT lower 'citation' - the citation dimension grades whether assertions carry correctly-PAIRED <Note ID:#> markers, and every assertion here is cited to the note it purports to summarise, so citation stays 5. See golden/curated_v2_spec.md section 3 rule R3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s03-L4-verbose`

| | |
|---|---|
| Level | **L4** (calibration lane) |
| Specialty | Cardiology |
| Consultation | medium length · moderate complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You have been getting palpitations for about three weeks. Patient: Yes, my chest flutters, mostly in the evening, and I get short of breath climbing stairs. No chest pain and no blackouts. Doctor: The ECG today shows atrial fibrillation with a ventricular rate of 118 beats per minute and no ischaemic changes. Blood pressure 132 over 80, no murmurs, chest clear, no ankle swelling. Thyroid function and electrolytes are normal. Doctor: This is new atrial fibrillation. Your CHA2DS2-VASc score is 3, so anticoagulation is indicated. I will start apixaban 5 milligrams twice daily and bisoprolol 2.5 milligrams once daily for rate control. Arrange an echocardiogram and review in four weeks. Do not start aspirin.

**Source document 2**

> Patient record SYN-0003. Past medical history: hypertension, type 2 diabetes. Medications: amlodipine 5 milligrams daily, metformin 500 milligrams twice daily. No known drug allergies.

**Note under review**

> Subjective: The patient, an adult, reports that for approximately three weeks now they have been experiencing palpitations, which they describe as a fluttering sensation in the chest, occurring mostly in the evening period, and they also report shortness of breath on exertion when climbing stairs; the patient denies chest pain and the patient denies blackouts or syncopal episodes <Note ID:1>. The patient has a background history of hypertension and a background history of type 2 diabetes and is currently taking amlodipine and is currently taking metformin, and has no known drug allergies <Note ID:2>. Objective: The ECG performed today demonstrates atrial fibrillation, and the ventricular rate on that ECG is 118 beats per minute, and there are no ischaemic changes on that same ECG; the blood pressure is 132 over 80; no murmurs are heard; the chest is clear on auscultation; there is no ankle swelling; thyroid function is normal and electrolytes are normal <Note ID:1>. Assessment: New-onset atrial fibrillation with a rapid ventricular response; the CHA2DS2-VASc score is 3, which means anticoagulation is indicated <Note ID:1>. Plan: Apixaban 5 mg twice daily, bisoprolol 2.5 mg once daily for rate control, echocardiogram, review in four weeks; aspirin is explicitly not indicated <Note ID:1>.

**Seeded defect(s)**

- **`verbosity`** — span: `the patient denies chest pain and the patient denies blackouts ... is currently taking amlodipine and is currently taking metformin`
  - why it is wrong: Repeated syntactic frames and restated referents; more than one assertion carries semantic redundancy.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 4 | 5 | 4 | 2 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

More than one assertion carries contextual semantic redundancy -> succinct 2 (rubric verbatim). Detail level is now inappropriate for the target cardiologist -> useful 4 and comprehensible 4. Content is unchanged and fully cited, so accurate/thorough/citation/organized stay 5; the assessment merely restates the score -> synthesized 4.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s04-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Pediatrics |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How long has the ear been sore? Parent: Two days, and there was a fever of 38.6 last night. She had an ear infection about six months ago that cleared with amoxicillin. Doctor: On examination the right tympanic membrane is bulging and erythematous with reduced mobility; the left ear is normal. Throat is mildly injected, chest clear, no rash, and she is well hydrated and playful. Doctor: This is acute otitis media on the right. Given the fever and the bulging drum I will treat with amoxicillin 45 milligrams per kilogram per day divided twice daily for five days, plus ibuprofen for pain. Return if the fever persists beyond 48 hours, if there is discharge from the ear, or if she becomes drowsy.

**Source document 2**

> Patient record SYN-0004. School-age child. No chronic conditions. No regular medications. No known drug allergies.

**Note under review**

> Subjective: School-age child with two days of right ear pain and a fever to 38.6 C last night; one prior episode of otitis media six months ago that resolved with amoxicillin <Note ID:1>. No chronic conditions, no regular medications, no known allergies <Note ID:2>. Objective: Right tympanic membrane bulging and erythematous with reduced mobility, left ear normal; mildly injected throat, clear chest, no rash, well hydrated and playful <Note ID:1>. Assessment: Acute otitis media of the RIGHT ear - the bulging, immobile drum with fever meets treatment criteria rather than watchful waiting, and the prior amoxicillin response supports reusing it <Note ID:1>. Plan: Amoxicillin 45 mg/kg/day divided twice daily for five days and ibuprofen for pain; return for fever beyond 48 hours, ear discharge, or drowsiness <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Correct laterality, both ears documented, prior history correctly framed as past and resolved, safety-netting preserved, assessment reasons from findings to the treat-versus-observe decision.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s04-L2-laterality`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Pediatrics |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How long has the ear been sore? Parent: Two days, and there was a fever of 38.6 last night. She had an ear infection about six months ago that cleared with amoxicillin. Doctor: On examination the right tympanic membrane is bulging and erythematous with reduced mobility; the left ear is normal. Throat is mildly injected, chest clear, no rash, and she is well hydrated and playful. Doctor: This is acute otitis media on the right. Given the fever and the bulging drum I will treat with amoxicillin 45 milligrams per kilogram per day divided twice daily for five days, plus ibuprofen for pain. Return if the fever persists beyond 48 hours, if there is discharge from the ear, or if she becomes drowsy.

**Source document 2**

> Patient record SYN-0004. School-age child. No chronic conditions. No regular medications. No known drug allergies.

**Note under review**

> Subjective: School-age child with two days of ear pain and a fever to 38.6 C last night; one prior episode of otitis media six months ago that resolved with amoxicillin <Note ID:1>. No chronic conditions, no regular medications, no known allergies <Note ID:2>. Objective: Left tympanic membrane bulging and erythematous with reduced mobility, right ear normal; mildly injected throat, clear chest, no rash, well hydrated and playful <Note ID:1>. Assessment: Acute otitis media of the left ear <Note ID:1>. Plan: Amoxicillin 45 mg/kg/day divided twice daily for five days and ibuprofen for pain; return for fever beyond 48 hours, ear discharge, or drowsiness <Note ID:1>.

**Seeded defect(s)**

- **`laterality_error`** — span: `Left tympanic membrane bulging ... Acute otitis media of the left ear`
  - why it is wrong: Source documents the RIGHT drum as abnormal and the left as normal.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 5 | 5 | 5 | 5 | 5 | 2 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Laterality reversal is an overt falsification of a critical detail -> accurate 2;the diagnostic conclusion itself carries the error -> synthesized 2. No content is missing and the structure is untouched, so thorough/organized/comprehensible/succinct/useful stay 5. INDEPENDENT-DIMENSION RULE: a content error does NOT lower 'citation' - the citation dimension grades whether assertions carry correctly-PAIRED <Note ID:#> markers, and every assertion here is cited to the note it purports to summarise, so citation stays 5. See golden/curated_v2_spec.md section 3 rule R3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s04-L3-temporal`

| | |
|---|---|
| Level | **L3** (calibration lane) |
| Specialty | Pediatrics |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How long has the ear been sore? Parent: Two days, and there was a fever of 38.6 last night. She had an ear infection about six months ago that cleared with amoxicillin. Doctor: On examination the right tympanic membrane is bulging and erythematous with reduced mobility; the left ear is normal. Throat is mildly injected, chest clear, no rash, and she is well hydrated and playful. Doctor: This is acute otitis media on the right. Given the fever and the bulging drum I will treat with amoxicillin 45 milligrams per kilogram per day divided twice daily for five days, plus ibuprofen for pain. Return if the fever persists beyond 48 hours, if there is discharge from the ear, or if she becomes drowsy.

**Source document 2**

> Patient record SYN-0004. School-age child. No chronic conditions. No regular medications. No known drug allergies.

**Note under review**

> Subjective: School-age child with two days of right ear pain and a fever to 38.6 C last night; the child is currently on amoxicillin for an ongoing ear infection <Note ID:1>. No chronic conditions, no known allergies <Note ID:2>. Objective: Right tympanic membrane bulging and erythematous with reduced mobility, left ear normal; mildly injected throat, clear chest, no rash, well hydrated and playful <Note ID:1>. Assessment: Acute otitis media of the right ear <Note ID:1>. Plan: Amoxicillin 45 mg/kg/day divided twice daily for five days and ibuprofen for pain; return for fever beyond 48 hours, ear discharge, or drowsiness <Note ID:1>.

**Seeded defect(s)**

- **`temporal_error`** — span: `currently on amoxicillin for an ongoing ear infection`
  - why it is wrong: The source describes an episode six months ago that CLEARED with amoxicillin.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 3 | 5 | 5 | 5 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Rubric accurate grade 3 verbatim: 'at least one assertion contains a misalignment that is stated from a source note but the wrong context'. The item exists in the source; only its timing/status is wrong, and the diagnosis and treatment remain factual, so this is a 3 rather than a 2. Nothing is omitted and the structure is untouched; the assessment no longer reconciles the history with the plan -> synthesized 4.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s05-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Obstetrics and Gynecology |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You are 28 weeks today. How have you been? Patient: Good. The baby moves a lot. I get some heartburn at night. No bleeding, no fluid loss, no headaches or visual changes. Doctor: Blood pressure is 118 over 72, urine dipstick negative for protein, fundal height 28 centimetres, fetal heart rate 148 and regular, cephalic on palpation. Your oral glucose tolerance test came back with a fasting value of 5.4 and a two-hour value of 9.1 millimoles per litre, which is normal by our thresholds. Haemoglobin is 10.4 grams per decilitre. Doctor: So the pregnancy is progressing normally, the glucose tolerance test is normal, and the haemoglobin is mildly low. Start ferrous sulfate 200 milligrams once daily with vitamin C, continue the antacid as needed for reflux, book the anti-D at 28 weeks as you are rhesus negative, and I will see you in four weeks. Call immediately for reduced fetal movements, bleeding, or severe headache.

**Source document 2**

> Patient record SYN-0005. First pregnancy. Blood group O negative. No chronic conditions. Medications: pregnancy multivitamin. No known drug allergies.

**Note under review**

> Subjective: Primigravida at 28 weeks reports good fetal movements and nocturnal heartburn, denying bleeding, fluid loss, headache and visual change <Note ID:1>. Blood group O negative, no chronic conditions, on a pregnancy multivitamin, no known allergies <Note ID:2>. Objective: BP 118/72, urine dipstick negative for protein, fundal height 28 cm, fetal heart rate 148 and regular, cephalic presentation; OGTT fasting 5.4 and 2-hour 9.1 mmol/L (normal); haemoglobin 10.4 g/dL <Note ID:1>. Assessment: Normally progressing 28-week pregnancy with a normal glucose tolerance test; the only active issues are mild anaemia and physiological reflux, and rhesus-negative status makes anti-D prophylaxis due now <Note ID:1>. Plan: Ferrous sulfate 200 mg once daily with vitamin C, antacid as required, anti-D at 28 weeks, review in four weeks; immediate contact for reduced fetal movements, bleeding, or severe headache <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

All findings and negatives carried and cited; the assessment ties rhesus status to the anti-D timing rather than listing it, which is the integrative step the rubric's synthesized grade 5 describes.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s05-L2-false-negation`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Obstetrics and Gynecology |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You are 28 weeks today. How have you been? Patient: Good. The baby moves a lot. I get some heartburn at night. No bleeding, no fluid loss, no headaches or visual changes. Doctor: Blood pressure is 118 over 72, urine dipstick negative for protein, fundal height 28 centimetres, fetal heart rate 148 and regular, cephalic on palpation. Your oral glucose tolerance test came back with a fasting value of 5.4 and a two-hour value of 9.1 millimoles per litre, which is normal by our thresholds. Haemoglobin is 10.4 grams per decilitre. Doctor: So the pregnancy is progressing normally, the glucose tolerance test is normal, and the haemoglobin is mildly low. Start ferrous sulfate 200 milligrams once daily with vitamin C, continue the antacid as needed for reflux, book the anti-D at 28 weeks as you are rhesus negative, and I will see you in four weeks. Call immediately for reduced fetal movements, bleeding, or severe headache.

**Source document 2**

> Patient record SYN-0005. First pregnancy. Blood group O negative. No chronic conditions. Medications: pregnancy multivitamin. No known drug allergies.

**Note under review**

> Subjective: Primigravida at 28 weeks reports good fetal movements and nocturnal heartburn, denying bleeding, fluid loss, headache and visual change <Note ID:1>. No chronic conditions, on a pregnancy multivitamin, no known allergies <Note ID:2>. Objective: BP 118/72, urine dipstick negative for protein, fundal height 28 cm, fetal heart rate 148 and regular, cephalic presentation; OGTT normal; haemoglobin 10.4 g/dL; the patient is rhesus positive so anti-D is not required <Note ID:1>. Assessment: Normally progressing 28-week pregnancy with mild anaemia and physiological reflux <Note ID:1>. Plan: Ferrous sulfate 200 mg once daily with vitamin C, antacid as required, review in four weeks; immediate contact for reduced fetal movements, bleeding, or severe headache <Note ID:1>.

**Seeded defect(s)**

- **`false_negation`** — span: `the patient is rhesus positive so anti-D is not required`
  - why it is wrong: Source records blood group O NEGATIVE and explicitly books anti-D at 28 weeks.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 5 | 5 | 5 | 5 | 5 | 2 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Reversing a documented status and negating the indicated intervention is an overt falsification -> accurate 2;the false premise drives the omission of anti-D from the plan -> synthesized 2. The anti-D absence is a CONSEQUENCE of the falsification rather than an independent omission, so thorough is not double-penalised and stays 5. INDEPENDENT-DIMENSION RULE: a content error does NOT lower 'citation' - the citation dimension grades whether assertions carry correctly-PAIRED <Note ID:#> markers, and every assertion here is cited to the note it purports to summarise, so citation stays 5. See golden/curated_v2_spec.md section 3 rule R3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s05-L4-minor-omission`

| | |
|---|---|
| Level | **L4** (calibration lane) |
| Specialty | Obstetrics and Gynecology |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You are 28 weeks today. How have you been? Patient: Good. The baby moves a lot. I get some heartburn at night. No bleeding, no fluid loss, no headaches or visual changes. Doctor: Blood pressure is 118 over 72, urine dipstick negative for protein, fundal height 28 centimetres, fetal heart rate 148 and regular, cephalic on palpation. Your oral glucose tolerance test came back with a fasting value of 5.4 and a two-hour value of 9.1 millimoles per litre, which is normal by our thresholds. Haemoglobin is 10.4 grams per decilitre. Doctor: So the pregnancy is progressing normally, the glucose tolerance test is normal, and the haemoglobin is mildly low. Start ferrous sulfate 200 milligrams once daily with vitamin C, continue the antacid as needed for reflux, book the anti-D at 28 weeks as you are rhesus negative, and I will see you in four weeks. Call immediately for reduced fetal movements, bleeding, or severe headache.

**Source document 2**

> Patient record SYN-0005. First pregnancy. Blood group O negative. No chronic conditions. Medications: pregnancy multivitamin. No known drug allergies.

**Note under review**

> Subjective: Primigravida at 28 weeks reports good fetal movements and nocturnal heartburn, denying bleeding, fluid loss, headache and visual change <Note ID:1>. Blood group O negative, no chronic conditions, no known allergies <Note ID:2>. Objective: BP 118/72, urine dipstick negative for protein, fundal height 28 cm, fetal heart rate 148 and regular, cephalic presentation; OGTT fasting 5.4 and 2-hour 9.1 mmol/L (normal); haemoglobin 10.4 g/dL <Note ID:1>. Assessment: Normally progressing 28-week pregnancy with a normal glucose tolerance test, mild anaemia and physiological reflux; rhesus-negative status makes anti-D prophylaxis due now <Note ID:1>. Plan: Ferrous sulfate 200 mg once daily with vitamin C, antacid as required, anti-D at 28 weeks, review in four weeks; immediate contact for reduced fetal movements, bleeding, or severe headache <Note ID:1>.

**Seeded defect(s)**

- **`omission_potentially_pertinent`** — span: `(missing) pregnancy multivitamin`
  - why it is wrong: Relevant to the medication list but not needed for any decision made in this encounter.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Rubric thorough grade 4 verbatim: 'some potentially pertinent omissions occur'. Nothing else changes from the L5 gold note.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s06-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Psychiatry |
| Consultation | medium length · moderate complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How have the last six weeks been since we started sertraline? Patient: The mornings are still hard but I am sleeping better, maybe six hours instead of three. My appetite is coming back. I still do not enjoy things much. Doctor: Any thoughts of harming yourself? Patient: No. I had those thoughts in January but not since. Doctor: Good. Your PHQ-9 today is 14, down from 21 at the first visit. On examination you are appropriately dressed, speech is normal in rate and volume, affect is reactive, there is no psychosis and no cognitive impairment. Doctor: This is a partial response to sertraline 50 milligrams. I will increase it to 100 milligrams daily, continue the weekly CBT sessions, and review in four weeks. Contact the crisis line if suicidal thoughts return.

**Source document 2**

> Patient record SYN-0006. Diagnosis: major depressive disorder, first episode, diagnosed four months ago. Medications: sertraline 50 milligrams daily. No known drug allergies. No alcohol or substance use.

**Note under review**

> Subjective: Adult with a first episode of major depressive disorder, six weeks into sertraline 50 mg, reports improved sleep (6 hours from 3) and returning appetite but persistent morning low mood and anhedonia; denies current suicidal ideation, with historical ideation in January and none since <Note ID:1>. No allergies, no alcohol or substance use <Note ID:2>. Objective: PHQ-9 14, down from 21 at baseline; appropriately dressed, normal speech rate and volume, reactive affect, no psychosis, no cognitive impairment <Note ID:1>. Assessment: Partial response to sertraline 50 mg - the neurovegetative symptoms are improving ahead of mood and anhedonia, and the 7-point PHQ-9 fall supports dose optimisation rather than a switch <Note ID:1>. Plan: Increase sertraline to 100 mg daily, continue weekly CBT, review in four weeks; crisis-line contact if suicidal thoughts return <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

The suicide-risk history is carried with its correct time frame (historical, not current); non-stigmatising language throughout (voice_summ 0); the assessment reasons about the SHAPE of the response rather than restating scores.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s06-L1-severe`

| | |
|---|---|
| Level | **L1** (calibration lane) |
| Specialty | Psychiatry |
| Consultation | medium length · moderate complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How have the last six weeks been since we started sertraline? Patient: The mornings are still hard but I am sleeping better, maybe six hours instead of three. My appetite is coming back. I still do not enjoy things much. Doctor: Any thoughts of harming yourself? Patient: No. I had those thoughts in January but not since. Doctor: Good. Your PHQ-9 today is 14, down from 21 at the first visit. On examination you are appropriately dressed, speech is normal in rate and volume, affect is reactive, there is no psychosis and no cognitive impairment. Doctor: This is a partial response to sertraline 50 milligrams. I will increase it to 100 milligrams daily, continue the weekly CBT sessions, and review in four weeks. Contact the crisis line if suicidal thoughts return.

**Source document 2**

> Patient record SYN-0006. Diagnosis: major depressive disorder, first episode, diagnosed four months ago. Medications: sertraline 50 milligrams daily. No known drug allergies. No alcohol or substance use.

**Note under review**

> Assessment: treatment-resistant depression with active psychosis. The patient denies any history of suicidal ideation. Plan: increase sertraline. Subjective: sleeping better. PHQ-9 14.

**Seeded defect(s)**

- **`fabrication`** — span: `active psychosis`
  - why it is wrong: Source examination explicitly records no psychosis.
- **`fabrication`** — span: `treatment-resistant depression`
  - why it is wrong: Source describes a PARTIAL RESPONSE to a first agent at sub-maximal dose.
- **`false_negation`** — span: `denies any history of suicidal ideation`
  - why it is wrong: Source documents suicidal ideation in January; only CURRENT ideation is denied.
- **`omission_material`** — span: `(missing) dose target, CBT, review interval, crisis-line safety-netting, mental state exam`
  - why it is wrong: More than one pertinent item is absent, including the safety plan.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 2 | 1 | 3 | 4 | 1 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Multiple overt fabrications/falsifications -> accurate 1; no citations -> citation 1; more than one pertinent omission -> thorough 1; assertions out of order with incoherent grouping -> organized 1; some assertions still pertinent -> useful 2; language is plain and unchanged from input -> comprehensible 3; terse, no redundancy -> succinct 4; reasoning across assertions is wrong -> synthesized 1.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s06-L3-misattribution`

| | |
|---|---|
| Level | **L3** (calibration lane) |
| Specialty | Psychiatry |
| Consultation | medium length · moderate complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How have the last six weeks been since we started sertraline? Patient: The mornings are still hard but I am sleeping better, maybe six hours instead of three. My appetite is coming back. I still do not enjoy things much. Doctor: Any thoughts of harming yourself? Patient: No. I had those thoughts in January but not since. Doctor: Good. Your PHQ-9 today is 14, down from 21 at the first visit. On examination you are appropriately dressed, speech is normal in rate and volume, affect is reactive, there is no psychosis and no cognitive impairment. Doctor: This is a partial response to sertraline 50 milligrams. I will increase it to 100 milligrams daily, continue the weekly CBT sessions, and review in four weeks. Contact the crisis line if suicidal thoughts return.

**Source document 2**

> Patient record SYN-0006. Diagnosis: major depressive disorder, first episode, diagnosed four months ago. Medications: sertraline 50 milligrams daily. No known drug allergies. No alcohol or substance use.

**Note under review**

> Subjective: Adult with a first episode of major depressive disorder, six weeks into sertraline 50 mg; denies current suicidal ideation, with historical ideation in January and none since <Note ID:1>. No allergies, no alcohol or substance use <Note ID:2>. Objective: Observed sleep of six hours per night and objectively improved appetite documented on examination; PHQ-9 14, down from 21; appropriately dressed, normal speech, reactive affect, no psychosis, no cognitive impairment <Note ID:1>. Assessment: Partial response to sertraline 50 mg <Note ID:1>. Plan: Increase sertraline to 100 mg daily, continue weekly CBT, review in four weeks; crisis-line contact if suicidal thoughts return <Note ID:1>.

**Seeded defect(s)**

- **`misattribution`** — span: `Observed sleep of six hours per night and objectively improved appetite documented on examination`
  - why it is wrong: Both are patient-reported in the source; neither was observed or measured by the clinician.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 3 | 5 | 5 | 4 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

The facts exist in the source but are placed in the wrong evidential context -> accurate 3 (rubric grade 3, 'stated from a source note but the wrong context'). Because the mis-placement also moves subjective content into the Objective grouping, organized drops one step to 4 ('logical order or grouping ... but not both'). Nothing is omitted or mis-cited.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s07-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Pulmonology |
| Consultation | long length · high complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Tell me what changed this week. Patient: My breathing got much worse over four days and my sputum turned green. I am using the blue inhaler every two hours instead of twice a day. My ankles have been swelling for about ten days as well. Doctor: Your oxygen saturation on room air is 88 percent, respiratory rate 26, temperature 37.1, heart rate 104. On examination there are widespread wheezes with a prolonged expiratory phase, bibasal crackles, raised jugular venous pressure and pitting oedema to mid-shin bilaterally. The chest X-ray shows hyperinflation and upper-lobe blood diversion but no consolidation. Brain natriuretic peptide is 640. Doctor: So you have an infective exacerbation of COPD together with decompensated heart failure - the green sputum and wheeze are the COPD, the raised JVP, oedema and BNP are the heart failure, and each is making the other worse. Plan: controlled oxygen targeting 88 to 92 percent, prednisolone 30 milligrams daily for five days, doxycycline 200 milligrams on day one then 100 milligrams daily for four days, nebulised salbutamol and ipratropium, add furosemide 40 milligrams daily, daily weights, and repeat renal function in three days. We will admit you for 48 hours.

**Source document 2**

> Patient record SYN-0007. Active problems: COPD GOLD stage 3, heart failure with preserved ejection fraction, ex-smoker 40 pack-years. Medications: tiotropium daily, salbutamol as required, bisoprolol 2.5 milligrams daily. Allergy: penicillin - anaphylaxis.

**Note under review**

> Subjective: Adult with GOLD stage 3 COPD and HFpEF reports four days of worsening dyspnoea with green sputum, escalating salbutamol from twice daily to two-hourly, and ten days of ankle swelling <Note ID:1>. Background tiotropium, salbutamol and bisoprolol; penicillin anaphylaxis <Note ID:2>. Objective: SpO2 88% on room air, respiratory rate 26, temperature 37.1 C, heart rate 104; widespread wheeze with prolonged expiration, bibasal crackles, raised JVP, bilateral pitting oedema to mid-shin; chest X-ray with hyperinflation and upper-lobe blood diversion, no consolidation; BNP 640 <Note ID:1>. Assessment: Two concurrent decompensations - an infective COPD exacerbation and decompensated heart failure - which are mutually aggravating, so treating either alone would fail; the penicillin anaphylaxis is what selects doxycycline <Note ID:1>. Plan: Controlled oxygen to a target of 88-92%, prednisolone 30 mg daily for five days, doxycycline 200 mg day one then 100 mg daily for four days, nebulised salbutamol and ipratropium, furosemide 40 mg daily, daily weights, repeat renal function in three days, 48-hour admission <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Both diagnoses, all vitals, the imaging, the BNP and the allergy are carried and cited; the assessment states the interaction between the two problems and the allergy-to-antibiotic link, which is the reasoning step synthesized grade 5 requires.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s07-L2-temporal`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Pulmonology |
| Consultation | long length · high complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Tell me what changed this week. Patient: My breathing got much worse over four days and my sputum turned green. I am using the blue inhaler every two hours instead of twice a day. My ankles have been swelling for about ten days as well. Doctor: Your oxygen saturation on room air is 88 percent, respiratory rate 26, temperature 37.1, heart rate 104. On examination there are widespread wheezes with a prolonged expiratory phase, bibasal crackles, raised jugular venous pressure and pitting oedema to mid-shin bilaterally. The chest X-ray shows hyperinflation and upper-lobe blood diversion but no consolidation. Brain natriuretic peptide is 640. Doctor: So you have an infective exacerbation of COPD together with decompensated heart failure - the green sputum and wheeze are the COPD, the raised JVP, oedema and BNP are the heart failure, and each is making the other worse. Plan: controlled oxygen targeting 88 to 92 percent, prednisolone 30 milligrams daily for five days, doxycycline 200 milligrams on day one then 100 milligrams daily for four days, nebulised salbutamol and ipratropium, add furosemide 40 milligrams daily, daily weights, and repeat renal function in three days. We will admit you for 48 hours.

**Source document 2**

> Patient record SYN-0007. Active problems: COPD GOLD stage 3, heart failure with preserved ejection fraction, ex-smoker 40 pack-years. Medications: tiotropium daily, salbutamol as required, bisoprolol 2.5 milligrams daily. Allergy: penicillin - anaphylaxis.

**Note under review**

> Subjective: Adult with GOLD stage 3 COPD and HFpEF, a current smoker of 40 pack-years, reports four days of worsening dyspnoea with green sputum, escalating salbutamol to two-hourly, and ten days of ankle swelling <Note ID:2>. Background tiotropium, salbutamol and bisoprolol; penicillin anaphylaxis <Note ID:2>. Objective: SpO2 88% on room air, respiratory rate 26, temperature 37.1 C, heart rate 104; widespread wheeze, bibasal crackles, raised JVP, bilateral pitting oedema; chest X-ray with hyperinflation and upper-lobe blood diversion, no consolidation; BNP 640 <Note ID:1>. Assessment: Infective COPD exacerbation with concurrent decompensated heart failure <Note ID:1>. Plan: Controlled oxygen to 88-92%, prednisolone 30 mg daily for five days, doxycycline 200 mg day one then 100 mg daily for four days, nebulised salbutamol and ipratropium, furosemide 40 mg daily, daily weights, repeat renal function in three days, 48-hour admission <Note ID:1>.

**Seeded defect(s)**

- **`temporal_error`** — span: `a current smoker of 40 pack-years`
  - why it is wrong: Source records EX-smoker, 40 pack-years. Smoking status changes the treatment pathway, so this is a status reversal rather than a timing nuance.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 5 | 5 | 5 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Unlike the S04 temporal case, this reverses a documented STATUS rather than shifting a timeframe, so it meets accurate grade 2 ('a major error ... with an overt falsification').Content is otherwise complete and well-formed; the assessment lists the two diagnoses without reasoning about their interaction -> synthesized 4. INDEPENDENT-DIMENSION RULE: a content error does NOT lower 'citation' - the citation dimension grades whether assertions carry correctly-PAIRED <Note ID:#> markers, and every assertion here is cited to the note it purports to summarise, so citation stays 5. See golden/curated_v2_spec.md section 3 rule R3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s07-L3-omission`

| | |
|---|---|
| Level | **L3** (calibration lane) |
| Specialty | Pulmonology |
| Consultation | long length · high complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Tell me what changed this week. Patient: My breathing got much worse over four days and my sputum turned green. I am using the blue inhaler every two hours instead of twice a day. My ankles have been swelling for about ten days as well. Doctor: Your oxygen saturation on room air is 88 percent, respiratory rate 26, temperature 37.1, heart rate 104. On examination there are widespread wheezes with a prolonged expiratory phase, bibasal crackles, raised jugular venous pressure and pitting oedema to mid-shin bilaterally. The chest X-ray shows hyperinflation and upper-lobe blood diversion but no consolidation. Brain natriuretic peptide is 640. Doctor: So you have an infective exacerbation of COPD together with decompensated heart failure - the green sputum and wheeze are the COPD, the raised JVP, oedema and BNP are the heart failure, and each is making the other worse. Plan: controlled oxygen targeting 88 to 92 percent, prednisolone 30 milligrams daily for five days, doxycycline 200 milligrams on day one then 100 milligrams daily for four days, nebulised salbutamol and ipratropium, add furosemide 40 milligrams daily, daily weights, and repeat renal function in three days. We will admit you for 48 hours.

**Source document 2**

> Patient record SYN-0007. Active problems: COPD GOLD stage 3, heart failure with preserved ejection fraction, ex-smoker 40 pack-years. Medications: tiotropium daily, salbutamol as required, bisoprolol 2.5 milligrams daily. Allergy: penicillin - anaphylaxis.

**Note under review**

> Subjective: Adult with GOLD stage 3 COPD and HFpEF, ex-smoker of 40 pack-years, reports four days of worsening dyspnoea with green sputum, escalating salbutamol to two-hourly, and ten days of ankle swelling <Note ID:1>. Background tiotropium, salbutamol and bisoprolol <Note ID:2>. Objective: SpO2 88% on room air, respiratory rate 26, temperature 37.1 C, heart rate 104; widespread wheeze, bibasal crackles, raised JVP, bilateral pitting oedema; chest X-ray with hyperinflation and upper-lobe blood diversion, no consolidation; BNP 640 <Note ID:1>. Assessment: Infective COPD exacerbation with concurrent decompensated heart failure, each aggravating the other <Note ID:1>. Plan: Controlled oxygen to 88-92%, prednisolone 30 mg daily for five days, doxycycline 200 mg day one then 100 mg daily for four days, nebulised salbutamol and ipratropium, furosemide 40 mg daily, daily weights, repeat renal function in three days, 48-hour admission <Note ID:1>.

**Seeded defect(s)**

- **`omission_material`** — span: `(missing) penicillin allergy - anaphylaxis`
  - why it is wrong: A life-threatening allergy and the stated rationale for the antibiotic choice.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 3 | 5 | 5 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Exactly one pertinent omission -> thorough 3. Everything stated is accurate and correctly cited; the assessment retains the interaction reasoning but has lost the allergy-to-antibiotic link -> synthesized 4.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s08-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Gastroenterology |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Describe the burning. Patient: It is behind my breastbone after meals and when I lie down, about four evenings a week for three months. No trouble swallowing, no weight loss, no vomiting blood, no black stools. Doctor: Examination is unremarkable, the abdomen is soft and non-tender, and you are not anaemic on today's bloods. Doctor: This is uncomplicated gastro-oesophageal reflux disease with no alarm features, so no endoscopy is needed now. Start omeprazole 20 milligrams once daily before breakfast for eight weeks, raise the head of the bed, avoid late meals, and review at eight weeks. Come back sooner for swallowing difficulty, vomiting blood, or weight loss.

**Source document 2**

> Patient record SYN-0008. No chronic conditions. Medications: occasional antacid. No known drug allergies.

**Note under review**

> Subjective: Adult with three months of post-prandial and recumbent retrosternal burning about four evenings weekly, denying dysphagia, weight loss, haematemesis and melaena <Note ID:1>. No chronic conditions, occasional antacid use, no known allergies <Note ID:2>. Objective: Unremarkable examination with a soft, non-tender abdomen; not anaemic on today's bloods <Note ID:1>. Assessment: Uncomplicated gastro-oesophageal reflux disease - the absence of every alarm feature plus a normal haemoglobin is what makes endoscopy unnecessary at this stage <Note ID:1>. Plan: Omeprazole 20 mg once daily before breakfast for eight weeks, head-of-bed elevation, avoid late meals, review at eight weeks; return sooner for dysphagia, haematemesis, or weight loss <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

All alarm-feature negatives carried and cited; the assessment explains WHY endoscopy is deferred rather than asserting it.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s08-L2-omission`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Gastroenterology |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Describe the burning. Patient: It is behind my breastbone after meals and when I lie down, about four evenings a week for three months. No trouble swallowing, no weight loss, no vomiting blood, no black stools. Doctor: Examination is unremarkable, the abdomen is soft and non-tender, and you are not anaemic on today's bloods. Doctor: This is uncomplicated gastro-oesophageal reflux disease with no alarm features, so no endoscopy is needed now. Start omeprazole 20 milligrams once daily before breakfast for eight weeks, raise the head of the bed, avoid late meals, and review at eight weeks. Come back sooner for swallowing difficulty, vomiting blood, or weight loss.

**Source document 2**

> Patient record SYN-0008. No chronic conditions. Medications: occasional antacid. No known drug allergies.

**Note under review**

> Subjective: Adult with three months of post-prandial and recumbent retrosternal burning about four evenings weekly <Note ID:1>. No chronic conditions, no known allergies <Note ID:2>. Objective: Unremarkable examination with a soft, non-tender abdomen <Note ID:1>. Assessment: Gastro-oesophageal reflux disease <Note ID:1>. Plan: Omeprazole 20 mg once daily before breakfast for eight weeks, head-of-bed elevation, avoid late meals, review at eight weeks <Note ID:1>.

**Seeded defect(s)**

- **`omission_material`** — span: `(missing) absence of dysphagia/weight loss/haematemesis/melaena, normal haemoglobin, return precautions`
  - why it is wrong: The alarm-feature negatives are the documented justification for not endoscoping, and the return precautions are the safety net.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 1 | 4 | 5 | 5 | 5 | 3 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

MORE THAN ONE pertinent omission -> thorough 1 (rubric verbatim). Nothing stated is untrue and the citations that remain are correct, so accurate and citation stay 5 - this case exists to prove the judge does not bleed an omission into accuracy. Detail level is now insufficient for the target gastroenterologist -> useful 4; the assessment loses the reasoning that justified deferring endoscopy -> synthesized 3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s08-L4-under-synthesis`

| | |
|---|---|
| Level | **L4** (calibration lane) |
| Specialty | Gastroenterology |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Describe the burning. Patient: It is behind my breastbone after meals and when I lie down, about four evenings a week for three months. No trouble swallowing, no weight loss, no vomiting blood, no black stools. Doctor: Examination is unremarkable, the abdomen is soft and non-tender, and you are not anaemic on today's bloods. Doctor: This is uncomplicated gastro-oesophageal reflux disease with no alarm features, so no endoscopy is needed now. Start omeprazole 20 milligrams once daily before breakfast for eight weeks, raise the head of the bed, avoid late meals, and review at eight weeks. Come back sooner for swallowing difficulty, vomiting blood, or weight loss.

**Source document 2**

> Patient record SYN-0008. No chronic conditions. Medications: occasional antacid. No known drug allergies.

**Note under review**

> Subjective: Retrosternal burning after meals <Note ID:1>. Retrosternal burning when lying down <Note ID:1>. Duration three months <Note ID:1>. Frequency four evenings weekly <Note ID:1>. No dysphagia <Note ID:1>. No weight loss <Note ID:1>. No haematemesis <Note ID:1>. No melaena <Note ID:1>. No chronic conditions <Note ID:2>. Occasional antacid <Note ID:2>. No known allergies <Note ID:2>. Objective: Examination unremarkable <Note ID:1>. Abdomen soft <Note ID:1>. Abdomen non-tender <Note ID:1>. Not anaemic <Note ID:1>. Assessment: Gastro-oesophageal reflux disease <Note ID:1>. No alarm features <Note ID:1>. Endoscopy not required now <Note ID:1>. Plan: Omeprazole 20 mg once daily before breakfast for eight weeks <Note ID:1>. Head-of-bed elevation <Note ID:1>. Avoid late meals <Note ID:1>. Review at eight weeks <Note ID:1>. Return for dysphagia, haematemesis, or weight loss <Note ID:1>.

**Seeded defect(s)**

- **`under_synthesis`** — span: `one assertion per sentence with no grouping or reasoning`
  - why it is wrong: A clear opportunity to abstract and group was missed.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 4 | 3 | 4 | 4 | 3 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Rubric synthesized grade 3 verbatim: 'assertions are independently stated without any reasoning or groups ... (missed opportunity to abstract)'. Order and grouping are unchanged from the input -> organized 3. Repeated syntactic frames without semantic redundancy -> succinct 4. Detail level appropriate but fragmented -> useful 4, comprehensible 4. Content and citations are complete and correct -> accurate/thorough/citation 5.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s09-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Endocrinology |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You are planning a pregnancy, so we need to look at the thyroid carefully. Patient: Yes, we want to start trying in the next couple of months. I take my levothyroxine every morning. Doctor: Your TSH today is 4.8 milli-international units per litre with a free T4 of 13 picomoles per litre. For preconception we want the TSH under 2.5. Examination shows no goitre, pulse 72 and regular, no tremor. Doctor: So this is treated hypothyroidism that is adequately controlled for the general population but not for pregnancy planning. I will increase levothyroxine from 75 to 100 micrograms daily, recheck thyroid function in six weeks, and once you confirm a pregnancy increase the dose by two extra tablets per week immediately and contact us. Keep taking it fasting, half an hour before food, and separate it from iron by four hours.

**Source document 2**

> Patient record SYN-0009. Diagnosis: primary hypothyroidism (Hashimoto thyroiditis), 6 years. Medications: levothyroxine 75 micrograms daily, ferrous sulfate 200 milligrams daily. No known drug allergies.

**Note under review**

> Subjective: Adult with six-year Hashimoto hypothyroidism, adherent to morning levothyroxine, planning conception within two months <Note ID:1>. Background levothyroxine 75 micrograms daily and ferrous sulfate; no known allergies <Note ID:2>. Objective: TSH 4.8 mIU/L, free T4 13 pmol/L; no goitre, pulse 72 regular, no tremor <Note ID:1>. Assessment: Treated hypothyroidism that is adequate for the general population but ABOVE the preconception target of 2.5 mIU/L - the target, not the symptoms, is what makes this uncontrolled <Note ID:1>. Plan: Increase levothyroxine to 100 micrograms daily, repeat thyroid function in six weeks, and on a confirmed pregnancy add two extra tablets per week immediately and contact the service; continue fasting dosing 30 minutes before food and separate from iron by four hours <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

The clinically important nuance - normal-range TSH that is nonetheless above the preconception target - is stated as reasoning, not just as a number; the iron interaction and the pregnancy-confirmation instruction are both carried.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s09-L2-dose`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Endocrinology |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You are planning a pregnancy, so we need to look at the thyroid carefully. Patient: Yes, we want to start trying in the next couple of months. I take my levothyroxine every morning. Doctor: Your TSH today is 4.8 milli-international units per litre with a free T4 of 13 picomoles per litre. For preconception we want the TSH under 2.5. Examination shows no goitre, pulse 72 and regular, no tremor. Doctor: So this is treated hypothyroidism that is adequately controlled for the general population but not for pregnancy planning. I will increase levothyroxine from 75 to 100 micrograms daily, recheck thyroid function in six weeks, and once you confirm a pregnancy increase the dose by two extra tablets per week immediately and contact us. Keep taking it fasting, half an hour before food, and separate it from iron by four hours.

**Source document 2**

> Patient record SYN-0009. Diagnosis: primary hypothyroidism (Hashimoto thyroiditis), 6 years. Medications: levothyroxine 75 micrograms daily, ferrous sulfate 200 milligrams daily. No known drug allergies.

**Note under review**

> Subjective: Adult with six-year Hashimoto hypothyroidism, adherent to morning levothyroxine, planning conception within two months <Note ID:1>. Background levothyroxine 75 micrograms daily and ferrous sulfate; no known allergies <Note ID:2>. Objective: TSH 4.8 mIU/L, free T4 13 pmol/L; no goitre, pulse 72 regular, no tremor <Note ID:1>. Assessment: Treated hypothyroidism above the preconception TSH target of 2.5 mIU/L <Note ID:1>. Plan: Decrease levothyroxine to 50 micrograms daily, repeat thyroid function in six weeks, and on a confirmed pregnancy add two extra tablets per week immediately and contact the service; continue fasting dosing 30 minutes before food and separate from iron by four hours <Note ID:1>.

**Seeded defect(s)**

- **`dose_error`** — span: `Decrease levothyroxine to 50 micrograms daily`
  - why it is wrong: Source increases levothyroxine from 75 to 100 micrograms daily; the note inverts both the direction and the value.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 5 | 5 | 5 | 5 | 5 | 2 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

An inverted dose direction is an overt falsification of a critical detail -> accurate 2;the plan now contradicts the assessment it is supposed to follow from -> synthesized 2. Nothing is omitted; structure and language unchanged. INDEPENDENT-DIMENSION RULE: a content error does NOT lower 'citation' - the citation dimension grades whether assertions carry correctly-PAIRED <Note ID:#> markers, and every assertion here is cited to the note it purports to summarise, so citation stays 5. See golden/curated_v2_spec.md section 3 rule R3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s09-L3-misattribution`

| | |
|---|---|
| Level | **L3** (calibration lane) |
| Specialty | Endocrinology |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: You are planning a pregnancy, so we need to look at the thyroid carefully. Patient: Yes, we want to start trying in the next couple of months. I take my levothyroxine every morning. Doctor: Your TSH today is 4.8 milli-international units per litre with a free T4 of 13 picomoles per litre. For preconception we want the TSH under 2.5. Examination shows no goitre, pulse 72 and regular, no tremor. Doctor: So this is treated hypothyroidism that is adequately controlled for the general population but not for pregnancy planning. I will increase levothyroxine from 75 to 100 micrograms daily, recheck thyroid function in six weeks, and once you confirm a pregnancy increase the dose by two extra tablets per week immediately and contact us. Keep taking it fasting, half an hour before food, and separate it from iron by four hours.

**Source document 2**

> Patient record SYN-0009. Diagnosis: primary hypothyroidism (Hashimoto thyroiditis), 6 years. Medications: levothyroxine 75 micrograms daily, ferrous sulfate 200 milligrams daily. No known drug allergies.

**Note under review**

> Subjective: Adult with six-year Hashimoto hypothyroidism planning conception within two months <Note ID:1>. Background levothyroxine 75 micrograms daily and ferrous sulfate; no known allergies <Note ID:2>. Objective: Adherence to levothyroxine confirmed by pill count at today's visit; TSH 4.8 mIU/L, free T4 13 pmol/L; no goitre, pulse 72 regular, no tremor <Note ID:1>. Assessment: Treated hypothyroidism above the preconception TSH target of 2.5 mIU/L <Note ID:1>. Plan: Increase levothyroxine to 100 micrograms daily, repeat thyroid function in six weeks, and on a confirmed pregnancy add two extra tablets per week immediately and contact the service; continue fasting dosing 30 minutes before food and separate from iron by four hours <Note ID:1>.

**Seeded defect(s)**

- **`misattribution`** — span: `Adherence to levothyroxine confirmed by pill count at today's visit`
  - why it is wrong: Adherence is patient-reported in the source; no pill count was performed.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 3 | 5 | 5 | 4 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

The adherence fact is in the source but its evidential basis is invented; treated as a wrong-context misalignment -> accurate 3, consistent with the S06 mis-attribution case. Subjective content placed in Objective -> organized 4. The assessment restates rather than reasons -> synthesized 4.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s10-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Orthopedics |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How did it happen? Patient: I rolled my left ankle inwards stepping off a kerb yesterday. I could walk four steps afterwards, painfully. Doctor: There is swelling and tenderness over the left lateral malleolus, no tenderness over the posterior edge of either malleolus, no midfoot or navicular tenderness, and you can bear weight for four steps here. The Ottawa ankle rules are therefore negative, so no X-ray is needed. Doctor: This is a grade 2 lateral ligament sprain of the left ankle. Rest, ice, compression and elevation, weight-bear as pain allows, ibuprofen 400 milligrams three times daily with food for five days, and start ankle range-of-motion exercises after 48 hours. Review in two weeks if not improving.

**Source document 2**

> Patient record SYN-0010. No chronic conditions. No regular medications. No known drug allergies. No history of gastric ulcer.

**Note under review**

> Subjective: Adult reports an inversion injury of the LEFT ankle stepping off a kerb yesterday, with four painful weight-bearing steps immediately afterwards <Note ID:1>. No chronic conditions, no regular medications, no known allergies, no gastric ulcer history <Note ID:2>. Objective: Swelling and tenderness over the left lateral malleolus; no posterior malleolar tenderness on either side, no midfoot or navicular tenderness; able to weight-bear four steps <Note ID:1>. Assessment: Grade 2 lateral ligament sprain of the LEFT ankle - the Ottawa ankle rules are negative on all elements, which is what excludes the need for radiography <Note ID:1>. Plan: Rest, ice, compression, elevation; weight-bear as pain allows; ibuprofen 400 mg three times daily with food for five days; ankle range-of-motion exercises from 48 hours; review in two weeks if not improving <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Laterality correct and repeated; every Ottawa-rule element carried; the no-ulcer history is retained because it underwrites the NSAID choice; assessment reasons from rule to decision.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s10-L2-laterality`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Orthopedics |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How did it happen? Patient: I rolled my left ankle inwards stepping off a kerb yesterday. I could walk four steps afterwards, painfully. Doctor: There is swelling and tenderness over the left lateral malleolus, no tenderness over the posterior edge of either malleolus, no midfoot or navicular tenderness, and you can bear weight for four steps here. The Ottawa ankle rules are therefore negative, so no X-ray is needed. Doctor: This is a grade 2 lateral ligament sprain of the left ankle. Rest, ice, compression and elevation, weight-bear as pain allows, ibuprofen 400 milligrams three times daily with food for five days, and start ankle range-of-motion exercises after 48 hours. Review in two weeks if not improving.

**Source document 2**

> Patient record SYN-0010. No chronic conditions. No regular medications. No known drug allergies. No history of gastric ulcer.

**Note under review**

> Subjective: Adult reports an inversion injury of the right ankle stepping off a kerb yesterday, with four painful weight-bearing steps immediately afterwards <Note ID:1>. No chronic conditions, no regular medications, no known allergies, no gastric ulcer history <Note ID:2>. Objective: Swelling and tenderness over the right lateral malleolus; no posterior malleolar tenderness, no midfoot or navicular tenderness; able to weight-bear four steps <Note ID:1>. Assessment: Grade 2 lateral ligament sprain of the right ankle with negative Ottawa ankle rules, so no radiography is required <Note ID:1>. Plan: Rest, ice, compression, elevation; weight-bear as pain allows; ibuprofen 400 mg three times daily with food for five days; ankle range-of-motion exercises from 48 hours; review in two weeks if not improving <Note ID:1>.

**Seeded defect(s)**

- **`laterality_error`** — span: `right ankle / right lateral malleolus`
  - why it is wrong: Source documents the LEFT ankle throughout.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 5 | 5 | 5 | 5 | 5 | 2 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Same rule as the S04 laterality case: overt falsification of a critical detail -> accurate 2;the diagnostic statement itself carries the error -> synthesized 2. No omissions, structure intact. INDEPENDENT-DIMENSION RULE: a content error does NOT lower 'citation' - the citation dimension grades whether assertions carry correctly-PAIRED <Note ID:#> markers, and every assertion here is cited to the note it purports to summarise, so citation stays 5. See golden/curated_v2_spec.md section 3 rule R3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s10-L4-verbose`

| | |
|---|---|
| Level | **L4** (calibration lane) |
| Specialty | Orthopedics |
| Consultation | short length · low complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: How did it happen? Patient: I rolled my left ankle inwards stepping off a kerb yesterday. I could walk four steps afterwards, painfully. Doctor: There is swelling and tenderness over the left lateral malleolus, no tenderness over the posterior edge of either malleolus, no midfoot or navicular tenderness, and you can bear weight for four steps here. The Ottawa ankle rules are therefore negative, so no X-ray is needed. Doctor: This is a grade 2 lateral ligament sprain of the left ankle. Rest, ice, compression and elevation, weight-bear as pain allows, ibuprofen 400 milligrams three times daily with food for five days, and start ankle range-of-motion exercises after 48 hours. Review in two weeks if not improving.

**Source document 2**

> Patient record SYN-0010. No chronic conditions. No regular medications. No known drug allergies. No history of gastric ulcer.

**Note under review**

> Subjective: The patient reports that the patient sustained an inversion-type injury to the left ankle, and this injury to the left ankle occurred while the patient was stepping off a kerb, and this occurred yesterday; following the injury the patient was able to ambulate four steps, and those four steps were painful steps <Note ID:1>. The patient has no chronic conditions and the patient has no regular medications and the patient has no known drug allergies and the patient has no history of gastric ulcer <Note ID:2>. Objective: There is swelling over the left lateral malleolus and there is tenderness over the left lateral malleolus; there is no tenderness over the posterior edge of either malleolus; there is no midfoot tenderness and there is no navicular tenderness; the patient is able to bear weight for four steps <Note ID:1>. Assessment: Grade 2 lateral ligament sprain of the left ankle with negative Ottawa ankle rules, so no radiography is required <Note ID:1>. Plan: Rest, ice, compression and elevation; weight-bear as pain allows; ibuprofen 400 mg three times daily with food for five days; ankle range-of-motion exercises from 48 hours; review in two weeks if not improving <Note ID:1>.

**Seeded defect(s)**

- **`verbosity`** — span: `the patient has no chronic conditions and the patient has no regular medications and the patient has no...`
  - why it is wrong: Repeated syntactic frames and restated referents across more than one assertion.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 4 | 5 | 4 | 2 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Same labelling rule as the S03 verbosity case: more than one assertion carries contextual semantic redundancy -> succinct 2; detail level inappropriate for the reader -> useful 4 and comprehensible 4; content, citations, completeness and structure untouched.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s11-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Nephrology |
| Consultation | long length · high complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Let us go through the results. Your creatinine is 285 micromoles per litre with an estimated GFR of 19, down from 24 four months ago. Potassium is 5.9, bicarbonate 19, haemoglobin 9.2 grams per decilitre with ferritin 68 and transferrin saturation 14 percent. Patient: I have been more tired and my legs cramp at night. No chest pain, no palpitations. Doctor: Blood pressure 146 over 84, no fluid overload, no pericardial rub, and the ECG shows no peaked T waves. Doctor: So this is stage 4 chronic kidney disease that is progressing, with hyperkalaemia, metabolic acidosis and iron-deficient anaemia of chronic kidney disease. The hyperkalaemia is the immediate issue, and because it is 5.9 without ECG changes I am holding rather than stopping the ramipril: pause ramipril for one week, start a potassium binder, low-potassium diet advice, sodium bicarbonate 500 milligrams three times daily for the acidosis, intravenous iron for the anaemia, repeat potassium and renal function in one week, and refer to the pre-dialysis education clinic. Come to the emergency department for palpitations, muscle weakness, or chest pain.

**Source document 2**

> Patient record SYN-0011. Active problems: chronic kidney disease stage 4 (diabetic nephropathy), type 2 diabetes, hypertension. Medications: ramipril 10 milligrams daily, insulin glargine 28 units nightly, amlodipine 10 milligrams daily. No known drug allergies.

**Note under review**

> Subjective: Adult with stage 4 CKD from diabetic nephropathy, type 2 diabetes and hypertension reports increasing fatigue and nocturnal leg cramps, denying chest pain and palpitations <Note ID:1>. Background ramipril 10 mg daily, insulin glargine 28 units nightly, amlodipine 10 mg daily; no known allergies <Note ID:2>. Objective: Creatinine 285 umol/L with eGFR 19 (was 24 four months ago), potassium 5.9 mmol/L, bicarbonate 19 mmol/L, haemoglobin 9.2 g/dL, ferritin 68, transferrin saturation 14%; BP 146/84, euvolaemic, no pericardial rub, ECG without peaked T waves <Note ID:1>. Assessment: Progressive stage 4 CKD with three linked complications - hyperkalaemia, metabolic acidosis and iron-deficient anaemia. The potassium of 5.9 WITHOUT ECG change is what permits holding rather than discontinuing the ramipril <Note ID:1>. Plan: Pause ramipril for one week, start a potassium binder with low-potassium dietary advice, sodium bicarbonate 500 mg three times daily, intravenous iron, repeat potassium and renal function in one week, refer to pre-dialysis education; emergency attendance for palpitations, muscle weakness, or chest pain <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

All four problems and every value carried and cited; the ECG-negative reasoning that justifies holding rather than stopping the ACE inhibitor is preserved as reasoning, which is what separates synthesized 5 from 4.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s11-L1-severe`

| | |
|---|---|
| Level | **L1** (calibration lane) |
| Specialty | Nephrology |
| Consultation | long length · high complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Let us go through the results. Your creatinine is 285 micromoles per litre with an estimated GFR of 19, down from 24 four months ago. Potassium is 5.9, bicarbonate 19, haemoglobin 9.2 grams per decilitre with ferritin 68 and transferrin saturation 14 percent. Patient: I have been more tired and my legs cramp at night. No chest pain, no palpitations. Doctor: Blood pressure 146 over 84, no fluid overload, no pericardial rub, and the ECG shows no peaked T waves. Doctor: So this is stage 4 chronic kidney disease that is progressing, with hyperkalaemia, metabolic acidosis and iron-deficient anaemia of chronic kidney disease. The hyperkalaemia is the immediate issue, and because it is 5.9 without ECG changes I am holding rather than stopping the ramipril: pause ramipril for one week, start a potassium binder, low-potassium diet advice, sodium bicarbonate 500 milligrams three times daily for the acidosis, intravenous iron for the anaemia, repeat potassium and renal function in one week, and refer to the pre-dialysis education clinic. Come to the emergency department for palpitations, muscle weakness, or chest pain.

**Source document 2**

> Patient record SYN-0011. Active problems: chronic kidney disease stage 4 (diabetic nephropathy), type 2 diabetes, hypertension. Medications: ramipril 10 milligrams daily, insulin glargine 28 units nightly, amlodipine 10 milligrams daily. No known drug allergies.

**Note under review**

> Plan: continue ramipril 10 mg daily and give insulin glargine 82 units nightly. The ECG shows peaked T waves consistent with severe hyperkalaemia. Stage 3 chronic kidney disease, stable. Potassium 5.9. Tired.

**Seeded defect(s)**

- **`fabrication`** — span: `The ECG shows peaked T waves`
  - why it is wrong: Source ECG explicitly shows NO peaked T waves.
- **`dose_error`** — span: `insulin glargine 82 units nightly`
  - why it is wrong: Source records 28 units nightly; the digits are transposed.
- **`temporal_error`** — span: `Stage 3 chronic kidney disease, stable`
  - why it is wrong: Source records stage 4 that is PROGRESSING (eGFR 24 to 19).
- **`omission_material`** — span: `(missing) ramipril hold, potassium binder, bicarbonate, IV iron, follow-up, safety-netting`
  - why it is wrong: The entire management plan and safety net are absent.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 2 | 1 | 3 | 4 | 1 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Multiple overt fabrications/falsifications, including one that reverses the plan -> accurate 1; no citations -> citation 1; more than one pertinent omission -> thorough 1; assertions out of order and incoherently grouped -> organized 1; some assertions remain pertinent -> useful 2; plain unchanged wording -> comprehensible 3; terse without redundancy -> succinct 4; reasoning across assertions is incorrect -> synthesized 1.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s11-L3-false-negation`

| | |
|---|---|
| Level | **L3** (calibration lane) |
| Specialty | Nephrology |
| Consultation | long length · high complexity |
| Split | `dev` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Let us go through the results. Your creatinine is 285 micromoles per litre with an estimated GFR of 19, down from 24 four months ago. Potassium is 5.9, bicarbonate 19, haemoglobin 9.2 grams per decilitre with ferritin 68 and transferrin saturation 14 percent. Patient: I have been more tired and my legs cramp at night. No chest pain, no palpitations. Doctor: Blood pressure 146 over 84, no fluid overload, no pericardial rub, and the ECG shows no peaked T waves. Doctor: So this is stage 4 chronic kidney disease that is progressing, with hyperkalaemia, metabolic acidosis and iron-deficient anaemia of chronic kidney disease. The hyperkalaemia is the immediate issue, and because it is 5.9 without ECG changes I am holding rather than stopping the ramipril: pause ramipril for one week, start a potassium binder, low-potassium diet advice, sodium bicarbonate 500 milligrams three times daily for the acidosis, intravenous iron for the anaemia, repeat potassium and renal function in one week, and refer to the pre-dialysis education clinic. Come to the emergency department for palpitations, muscle weakness, or chest pain.

**Source document 2**

> Patient record SYN-0011. Active problems: chronic kidney disease stage 4 (diabetic nephropathy), type 2 diabetes, hypertension. Medications: ramipril 10 milligrams daily, insulin glargine 28 units nightly, amlodipine 10 milligrams daily. No known drug allergies.

**Note under review**

> Subjective: Adult with stage 4 CKD from diabetic nephropathy, type 2 diabetes and hypertension reports increasing fatigue; denies leg cramps, chest pain and palpitations <Note ID:1>. Background ramipril 10 mg daily, insulin glargine 28 units nightly, amlodipine 10 mg daily; no known allergies <Note ID:2>. Objective: Creatinine 285 umol/L with eGFR 19 (was 24), potassium 5.9 mmol/L, bicarbonate 19 mmol/L, haemoglobin 9.2 g/dL, ferritin 68, transferrin saturation 14%; BP 146/84, euvolaemic, no pericardial rub, ECG without peaked T waves <Note ID:1>. Assessment: Progressive stage 4 CKD with hyperkalaemia, metabolic acidosis and iron-deficient anaemia <Note ID:1>. Plan: Pause ramipril for one week, start a potassium binder with low-potassium dietary advice, sodium bicarbonate 500 mg three times daily, intravenous iron, repeat potassium and renal function in one week, refer to pre-dialysis education; emergency attendance for palpitations, muscle weakness, or chest pain <Note ID:1>.

**Seeded defect(s)**

- **`false_negation`** — span: `denies leg cramps`
  - why it is wrong: Source records nocturnal leg cramps as a presenting symptom; cramps are a recognised hyperkalaemia/uraemia signal.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 3 | 5 | 5 | 5 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Graded 3 rather than 2 because the negated item is a MINOR symptom that does not change the diagnosis or the plan - the labelling rule reserves accurate 2 for falsification of a MAJOR assertion (diagnosis, dose, laterality, documented status). The symptom appears in the source, so this is a wrong-context misalignment. The assessment no longer links the cramps to the hyperkalaemia -> synthesized 4.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s12-L5-gold`

| | |
|---|---|
| Level | **L5** (quality lane) |
| Specialty | Emergency Medicine |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Talk me through the pain. Patient: It started three hours ago while I was watching television, a tightness in the middle of my chest going down my left arm, lasting about twenty minutes, now gone. I felt sweaty with it. Doctor: Your ECG is normal sinus rhythm at 76 with no ST-segment or T-wave changes. The first high-sensitivity troponin is 4 nanograms per litre and the three-hour repeat is 5 nanograms per litre, both below our assay threshold. Blood pressure 128 over 76, chest clear, heart sounds normal, no calf swelling. Doctor: Your HEART score is 3, which is low risk, and with two negative high-sensitivity troponins we can safely discharge you. This was not a heart attack. Plan: discharge with aspirin held, arrange an outpatient exercise tolerance test within two weeks, GP follow-up, and return immediately if the pain recurs, especially at rest or lasting more than fifteen minutes.

**Source document 2**

> Patient record SYN-0012. Past medical history: hyperlipidaemia. Medications: atorvastatin 20 milligrams daily. Family history: father with myocardial infarction at 62. No known drug allergies. Non-smoker.

**Note under review**

> Subjective: Adult with three hours since onset of central chest tightness radiating to the LEFT arm, lasting about twenty minutes with associated diaphoresis, now resolved <Note ID:1>. Background hyperlipidaemia on atorvastatin, non-smoker, father with myocardial infarction at 62, no known allergies <Note ID:2>. Objective: ECG normal sinus rhythm at 76 without ST or T-wave change; high-sensitivity troponin 4 ng/L at presentation and 5 ng/L at three hours, both below assay threshold; BP 128/76, chest clear, normal heart sounds, no calf swelling <Note ID:1>. Assessment: Low-risk chest pain, HEART score 3, with a negative serial high-sensitivity troponin pathway - the combination of the score AND the delta-negative troponins is what makes discharge safe rather than either alone; acute myocardial infarction is excluded <Note ID:1>. Plan: Discharge without aspirin, outpatient exercise tolerance test within two weeks, GP follow-up, and immediate return for recurrent pain, particularly at rest or lasting beyond fifteen minutes <Note ID:1>.

**Seeded defect(s)**

_None — this is a gold-standard (L5) note; the review question is whether it genuinely merits 5 on every dimension._

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Both troponin values, the score, the family history and the return precautions are carried and cited; the assessment states why the discharge decision is safe rather than asserting it.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s12-L1-severe`

| | |
|---|---|
| Level | **L1** (calibration lane) |
| Specialty | Emergency Medicine |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Talk me through the pain. Patient: It started three hours ago while I was watching television, a tightness in the middle of my chest going down my left arm, lasting about twenty minutes, now gone. I felt sweaty with it. Doctor: Your ECG is normal sinus rhythm at 76 with no ST-segment or T-wave changes. The first high-sensitivity troponin is 4 nanograms per litre and the three-hour repeat is 5 nanograms per litre, both below our assay threshold. Blood pressure 128 over 76, chest clear, heart sounds normal, no calf swelling. Doctor: Your HEART score is 3, which is low risk, and with two negative high-sensitivity troponins we can safely discharge you. This was not a heart attack. Plan: discharge with aspirin held, arrange an outpatient exercise tolerance test within two weeks, GP follow-up, and return immediately if the pain recurs, especially at rest or lasting more than fifteen minutes.

**Source document 2**

> Patient record SYN-0012. Past medical history: hyperlipidaemia. Medications: atorvastatin 20 milligrams daily. Family history: father with myocardial infarction at 62. No known drug allergies. Non-smoker.

**Note under review**

> Assessment: acute myocardial infarction with a rising troponin. The patient reported on examination that the chest was clear. Plan: admit. Chest pain three hours. ECG done.

**Seeded defect(s)**

- **`fabrication`** — span: `acute myocardial infarction with a rising troponin`
  - why it is wrong: Both troponins are below the assay threshold (4 then 5 ng/L) and the source states explicitly that this was not a heart attack.
- **`misattribution`** — span: `The patient reported on examination that the chest was clear`
  - why it is wrong: A clear chest is a clinician examination finding, not a patient report.
- **`omission_material`** — span: `(missing) HEART score, troponin values, discharge decision, follow-up, return precautions, risk factors`
  - why it is wrong: More than one pertinent item is absent, including the disposition rationale.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 2 | 1 | 3 | 4 | 1 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Multiple overt fabrications, one of which inverts the disposition -> accurate 1; no citations -> citation 1; more than one pertinent omission -> thorough 1; order and grouping destroyed -> organized 1; some assertions still pertinent -> useful 2; plain wording -> comprehensible 3; terse -> succinct 4; reasoning across assertions incorrect -> synthesized 1.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---

### `cv2-s12-L2-laterality`

| | |
|---|---|
| Level | **L2** (calibration lane) |
| Specialty | Emergency Medicine |
| Consultation | medium length · moderate complexity |
| Split | `holdout` |
| Label provenance | `ai-authored-rubric-literal` · review status `pending` |

**Source document 1**

> Doctor: Talk me through the pain. Patient: It started three hours ago while I was watching television, a tightness in the middle of my chest going down my left arm, lasting about twenty minutes, now gone. I felt sweaty with it. Doctor: Your ECG is normal sinus rhythm at 76 with no ST-segment or T-wave changes. The first high-sensitivity troponin is 4 nanograms per litre and the three-hour repeat is 5 nanograms per litre, both below our assay threshold. Blood pressure 128 over 76, chest clear, heart sounds normal, no calf swelling. Doctor: Your HEART score is 3, which is low risk, and with two negative high-sensitivity troponins we can safely discharge you. This was not a heart attack. Plan: discharge with aspirin held, arrange an outpatient exercise tolerance test within two weeks, GP follow-up, and return immediately if the pain recurs, especially at rest or lasting more than fifteen minutes.

**Source document 2**

> Patient record SYN-0012. Past medical history: hyperlipidaemia. Medications: atorvastatin 20 milligrams daily. Family history: father with myocardial infarction at 62. No known drug allergies. Non-smoker.

**Note under review**

> Subjective: Adult with three hours since onset of central chest tightness radiating to the right arm, lasting about twenty minutes with associated diaphoresis, now resolved <Note ID:1>. Background hyperlipidaemia on atorvastatin, non-smoker, father with myocardial infarction at 62, no known allergies <Note ID:2>. Objective: ECG normal sinus rhythm at 76 without ST or T-wave change; high-sensitivity troponin 4 ng/L at presentation and 5 ng/L at three hours, both below assay threshold; BP 128/76, chest clear, normal heart sounds, no calf swelling <Note ID:1>. Assessment: Low-risk chest pain, HEART score 3, with negative serial high-sensitivity troponins; acute myocardial infarction is excluded <Note ID:1>. Plan: Discharge without aspirin, outpatient exercise tolerance test within two weeks, GP follow-up, and immediate return for recurrent pain, particularly at rest or lasting beyond fifteen minutes <Note ID:1>.

**Seeded defect(s)**

- **`laterality_error`** — span: `radiating to the right arm`
  - why it is wrong: Source documents radiation to the LEFT arm; the side is a scored element of the presentation.

**Proposed reference rating**

| citation | accurate | thorough | useful | organized | comprehensible | succinct | synthesized |
|---|---|---|---|---|---|---|---|
| 5 | 2 | 5 | 5 | 5 | 5 | 5 | 4 |

Binary items: `abstraction` = 1, `voice_summ` = 0, `voice_note` = 0

**Rationale (the rule that produced it)**

Laterality reversal of a documented symptom feature -> accurate 2;Unlike the S04/S10 laterality cases the error does NOT sit in the diagnostic conclusion (the diagnosis and disposition are unchanged), so synthesized drops only one step to 4. Nothing omitted, structure intact. INDEPENDENT-DIMENSION RULE: a content error does NOT lower 'citation' - the citation dimension grades whether assertions carry correctly-PAIRED <Note ID:#> markers, and every assertion here is cited to the note it purports to summarise, so citation stays 5. See golden/curated_v2_spec.md section 3 rule R3.

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---
