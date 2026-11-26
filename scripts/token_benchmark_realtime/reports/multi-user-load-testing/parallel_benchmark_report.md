# HOPE Production Clinical Consultation Benchmark Report

**Generated:** 2026-11-25 13:46:02 UTC  
**Dataset Source:** `web_validation_output.csv` (16 consultations processed)  
**Gateway URL:** `https://adminconsole-vox.arcaai.com`  
**Concurrency Mode:** `16 Concurrent Consultations` (Wall-clock time: 752.9s | Speedup: **9.99x**)  

## End-to-End Real Production Performance

| Row # | Doctor | Case / Patient | Words | Approx Tok | Status | Total E2E | S1 Init | S2 Ingest | S3 Queue | S4 Pipeline | S5 Fetch |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | test1 | **realtime_transcript_sample_w1** | 6047 | 8062 | PASS | **142.85s** | 725.6ms | 665.4ms | 827.6ms | **139.96s** | 670.8ms |
| 2 | test2 | **realtime_transcript_sample_w2** | 6047 | 8062 | PASS | **253.76s** | 708.9ms | 660.8ms | 882.4ms | **250.86s** | 640.4ms |
| 3 | test3 | **realtime_transcript_sample_w3** | 6047 | 8062 | PASS | **377.13s** | 704.8ms | 640.5ms | 892.7ms | **374.27s** | 626.3ms |
| 4 | test4 | **realtime_transcript_sample_w4** | 6047 | 8062 | PASS | **405.30s** | 754.3ms | 637.7ms | 1528.2ms | **401.70s** | 679.3ms |
| 5 | test1 | **realtime_transcript_sample_w5** | 6047 | 8062 | PASS | **405.42s** | 736.3ms | 662.8ms | 1521.6ms | **401.88s** | 622.2ms |
| 6 | test2 | **realtime_transcript_sample_w6** | 6047 | 8062 | PASS | **692.94s** | 719.9ms | 703.1ms | 849.9ms | **690.00s** | 671.2ms |
| 7 | test3 | **realtime_transcript_sample_w7** | 6047 | 8062 | PASS | **407.08s** | 719.5ms | 627.8ms | 836.9ms | **404.21s** | 690.5ms |
| 8 | test4 | **realtime_transcript_sample_w8** | 6047 | 8062 | PASS | **405.60s** | 835.7ms | 705.3ms | 903.2ms | **402.50s** | 659.0ms |
| 9 | test1 | **realtime_transcript_sample_w9** | 6047 | 8062 | PASS | **405.12s** | 702.9ms | 1264.9ms | 947.0ms | **401.54s** | 671.3ms |
| 10 | test2 | **realtime_transcript_sample_w10** | 6047 | 8062 | PASS | **558.40s** | 774.2ms | 1080.0ms | 811.3ms | **555.11s** | 622.5ms |
| 11 | test3 | **realtime_transcript_sample_w11** | 6047 | 8062 | PASS | **661.62s** | 756.6ms | 716.4ms | 762.0ms | **658.71s** | 679.2ms |
| 12 | test4 | **realtime_transcript_sample_w12** | 6047 | 8062 | PASS | **592.69s** | 702.6ms | 675.4ms | 814.1ms | **589.84s** | 658.6ms |
| 13 | test1 | **realtime_transcript_sample_w13** | 6047 | 8062 | PASS | **463.98s** | 725.1ms | 643.3ms | 868.5ms | **461.01s** | 727.9ms |
| 14 | test2 | **realtime_transcript_sample_w14** | 6047 | 8062 | PASS | **624.66s** | 744.9ms | 638.5ms | 840.9ms | **621.82s** | 616.2ms |
| 15 | test3 | **realtime_transcript_sample_w15** | 6047 | 8062 | PASS | **403.07s** | 830.8ms | 634.1ms | 820.3ms | **400.18s** | 605.0ms |
| 16 | test4 | **realtime_transcript_sample_w16** | 6047 | 8062 | PASS | **723.14s** | 726.6ms | 643.8ms | 794.6ms | **720.33s** | 638.1ms |

## Generated Clinical Notes (Sample Section)

### Row #1 (test1): realtime_transcript_sample_w1

```markdown
## Presenting Complaints
1. Three months of heartburn and regurgitation, which feels like fire in the throat after meals, worse at night when lying down, accompanied by chest pain and a feeling of fluid coming into the throat.

## Past History
1. History of open appendectomy at age 22 for acute appendicitis (record, date not stated).

## Family History
1. Father had hypertension and suffered a heart attack at age 68. Mother has Osteoarthritis and Diabetes. Eldest brother had Coronary Artery Disease and underwent coronary angioplasty at age 52. Younger sister has Hypothyroidism.

## Drug History
1. Gelusil (taken as needed for relief).

## Hospital Admissions
1. Open appendectomy at age 22.

## General Examination & Vitals
- Heart rate 78 beats per minute, regular rhythm, good volume, peripheral pulses all palpable bilaterally.
- Blood pressure 128 by 84 mmHg (right arm).
- Respiratory rate 16 breaths per minute, thoracoabdominal.
- Body temperature 98.4 degrees Fahrenheit (afebrile).
- Oxygen saturation 99 percent in room air.
- Weight 72 kilograms, BMI 25.5 kg/m2.
- General physical examination revealed mild conjunctival pallor and mild tenderness in the epigastric region upon palpation.

## Previous Diagnosis
1. Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles Grade B Reflux Esophagitis accompanied by a small 2 cm sliding hiatal hernia and mild erythematous antral gastritis (H. pylori negative).

## Reports
1. Complete Blood Count (CBC) from two weeks prior: Hemoglobin 11.2 g per dL, Total White Blood Cell count 6,800 cells per microliter, Absolute Neutrophil Count 4,200, Lymphocyte count 2,100, Monocyte count 400, Eosinophil count 100, Platelet count 245,000 per microliter, Packed Cell Volume 34.2 percent, Mean Corpuscular Volume 74.5 femtoliters, MCH 24.1 picograms, MCHC 32.7 grams per deciliter, Red Cell Distribution Width 16.8 percent.

## Current Diagnosis
1. Primary Diagnosis: Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles Grade B Reflux Esophagitis accompanied by a small 2 cm sliding hiatal hernia and mild erythematous antral gastritis (H. pylori negative).

## Plan of Care
- Treatment: 1.
- Sompraz-D Capsule, containing Esomeprazole 40 milligrams and Domperidone 30 milligrams sustained release, to be taken once daily at least 30 to 45 minutes before breakfast with a glass of water for 28 days continuously.
- 2.
- Three times daily one hour after lunch and one hour after dinner, and immediately before bedtime for 14 days.
- 3.
- Ferrous Ascorbate with Folic Acid tablet Orofer-XT, containing Elemental Iron 100 milligrams and Folic acid 1.5 milligrams, to be taken twice a day two hours after lunch or around 4 PM with orange juice for 60 days.
- Continue existing medications: Glimepiride 1 mg in the morning before breakfast, Metformin 500 mg twice daily after meals, Telmisartan 40 mg in the morning at 10 AM, and Atorvastatin 10 mg at night before sleep.
- Lifestyle modifications include consuming small, frequent meals instead of large ones
- avoiding caffeine (tea/coffee), carbonated drinks, spicy/oily foods, chocolate, garlic, raw onions, and black pepper.
- Sleep should be after dinner by 8 PM, with a minimum of 2 to 3 hours between finishing dinner and sleeping.
- The head-end of the bed should be elevated by 6 inches using a firm pillow or brick under the mattress
- pillows should not be used to prop up the neck.
- Sleeping on the left lateral decubitus position is recommended.
- Physical activity includes 30 to 40 minutes of brisk walking daily and ankle pump exercises while sitting.
- Avoid taking pain killers like Ibuprofen, Diclofenac, Aceclofenac, or Mefenamic acid for headaches or body aches
- Paracetamol 650 mg may be taken after meals only.
- Follow-up: Return in 4 weeks to review CBC, Fasting and Postprandial Blood Sugar, and Serum Ferritin (to be checked after two months).
- Endoscopy is not required at this time
- consider it after six months if symptoms persist.
```

### Row #2 (test2): realtime_transcript_sample_w2

```markdown
## Presenting Complaints
1. Three months of heartburn and bloating, feeling like fire in the throat after meals, worse at night after dinner, and chest pain/bloating when lying down.

## Past History
1. Appendectomy performed at age 22 for appendicitis (record, date not stated).

## Family History
1. Father had hypertension and heart attack (died at age 68). 2. Eldest brother has diabetes. 3. Mother has Osteoarthritis and Diabetes.

## Drug History
1. Gelusil: taken as needed for relief of heartburn, not consistently prescribed. 2. Glimepiride 1 mg once daily before breakfast. 3. Metformin 500 mg twice daily after meals. 4. Telmisartan 40 mg once daily in the morning. 5. Atorvastatin 10 mg at night.

## Hospital Admissions
- Open appendectomy performed at age 22 for appendicitis (record, date not stated).

## General Examination & Vitals
- Heart rate 76 beats per minute, regular rhythm, good volume.
- Blood pressure 128 by 84 mmHg.
- Respiratory rate 16 breaths per minute, thoracoabdominal.
- Body temperature 98.4 degrees Fahrenheit (afebrile).
- Oxygen saturation 99 percent in room air.
- Height 168 centimeters, Weight 72 kilograms, BMI 25.5 kg/m2.
- Mild conjunctival pallor noted.
- No icterus, cyanosis, clubbing, or generalized lymphadenopathy.
- Mild tenderness in the epigastric region upon palpation.
- Abdomen soft and non-distended with a healthy 4 cm transverse scar in the right iliac fossa from the prior appendectomy, fully healed.
- Bowel sounds are normal and active (approximately 6 to 8 sounds per minute).

## Previous Diagnosis
1. Type 2 Diabetes Mellitus under moderate glycemic control (HbA1c 7.1%). 2. Essential Hypertension under stable pharmacological control.

## Reports
1. Complete Blood Count (CBC) from two points: Hemoglobin 13.8 g per dL (record, date not stated); Hemoglobin 11.2 g per dL (record, date not stated). Total White Blood Cell count 7200 cells per microliter (record, date not stated); Total White Blood Cell count 6,800 cells per microliter (record, date not stated). Platelet count 260,000 per microliter (record, date not stated); Platelet count 2,45,000 per microliter (record, date not stated). Packed Cell Volume (PCV) 34.2 percent (record, date not stated). Mean Corpuscular Volume (MCV) 74.5 femtoliters (record, date not stated); MCH 24.1 picograms (record, date not stated); MCHC 32.7 grams per deciliter (record, date not stated); Red Cell Distribution Width (RDW) 16.8 percent (record, date not stated). Serum Iron 38 micrograms per deciliter (normal range 60 to 170), Total Iron Binding Capacity 420 micrograms per deciliter (normal range 240 to 450), and Serum Ferritin 14 nanograms per milliliter (normal range 30 to 300). Blood Urea Nitrogen 16 mg per dL, Serum Creatinine 0.9 mg per dL, Serum Uric acid 5.2 mg per dL, Serum Sodium 139 milliequivalents per liter, Serum Potassium 4.1 mEq per L, Serum Chloride 101 mEq per L, Bicarbonate 24 mEq per L, eGFR 92 milliliters per minute per 1.73 m2. Total Bilirubin 0.8 mg per dL, Direct Bilirubin 0.2 mg per dL, Indirect Bilirubin 0.6 mg per dL. Aspartate Aminotransferase (AST / SGOT) 24 units per liter, Alanine Aminotransferase (ALT / SGPT) 28 units per liter, Alkaline Phosphatase (ALP) 78 units per liter. Total Protein 7.2 grams per dL, Serum Albumin 4.1 g per dL, Globulin 3.1 g per dL, Albumin to Globulin ratio 1.32, Gamma-glutamyl Transferase (GGT) 22 U per L. Ultrasound Abdomen: Liver shows grade 1 fatty infiltration (mild diffuse increase in parenchymal echogenicity). No focal mass lesion. Gall bladder is well distended with normal wall thickness; no calculi or sludge detected. Spleen size is normal, measuring 9.8 cm in bipolar diameter. Both kidneys are normal in size, shape, and cortical echogenicity. Pancreas visualized normally without ductal dilatation. Urinary bladder is normal. No ascites. No significant intra-abdominal lymphadenopathy.

## Current Diagnosis
1. Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles (LA) Grade B Reflux Esophagitis accompanied by a small 2 cm sliding hiatal hernia and mild erythematous antral gastritis (H. pylori negative). 2. Mild Microcytic Hypochromic Anemia secondary to Iron Deficiency (Hemoglobin 11.2 g/dL, Ferritin 14 ng/mL, Transferrin Saturation 9%), exacerbated by poor oral iron intake and chronic occult mucosal oozing from reflux esophagitis. 3. Type 2 Diabetes Mellitus under moderate glycemic control (HbA1c 7.1%) and Essential Hypertension under stable pharmacological control.

## Plan of Care
- Treatment: 1.
- Sompraz-D Capsule: Esomeprazole 40 milligrams and Domperidone 30 milligrams sustained release, to be taken once daily in the morning 30 to 45 minutes before breakfast with a glass of water for 28 days continuously.
- 2.
- Three times daily, one hour after lunch and one hour after dinner, and immediately before bedtime for 14 days.
- 3.
- Ferrous Ascorbate with Folic Acid Tablet Orofer-XT: Elemental Iron 100 milligrams and Folic acid 1.5 milligrams, to be taken two hours after lunch or at 4 PM with orange juice or a glass of lemon water for 60 days (two months).
- Continue current medications: Glimepiride 1 mg once daily before breakfast; Metformin 500 mg twice daily after meals; Telmisartan 40 mg in the morning at 10 AM; Atorvastatin 10 mg at night before sleeping.
- Lifestyle modifications: 1.
- Diet: Consume small, frequent meals (four to five times a day) instead of large meals.
- Avoid caffeine, carbonated drinks, acidic lemon water on an empty stomach, excessive oil, fried foods, spices, chocolate, garlic, and raw onions as they relax the esophageal valve.
- 2.
- Sleep and Positioning: Do not sleep for at least 2 to 3 hours after dinner; aim to sleep by 10 PM.
- Elevate the head-end of the bed by 6 inches using a firm pillow or bricks under the mattress.
- Sleep on the left side (Left lateral decubitus position).
- Avoid tight belts and restrictive clothing.
- 3.
- Exercise: Practice brisk walking for 30 to 40 minutes daily, and perform ankle pump exercises while sitting at the desk every 45 minutes.
- Pain management: Take Paracetamol 650 mg after meals only for mild headache or fever; avoid NSAIDs like Ibuprofen, Diclofenac, Aceclofenac, Mefenamic acid as they can cause severe ulcers and bleeding.
- Follow-up: Return to this OP in four weeks (one month) with the following tests: 1.
- Complete Blood Count (CBC) to check for improvement from Hemoglobin 11.2 g/dL.
- 2.
- Fasting and Postprandial Blood Sugar levels to monitor diabetes control.
- 3.
- Serum Ferritin after two months.
- Review of Sompraz-D dosage will be considered for step-down therapy after the four-week course is complete.
```

### Row #3 (test3): realtime_transcript_sample_w3

```markdown
## Presenting Complaints
1. Chest pain and burning sensation in the throat after meals for three months, which feels like fire spreading to the throat. 2. Chest tightness when lying down with a feeling of burning and water coming into the throat. 3. Cough occurring at night, which is relieved slightly upon standing. 4. Shortness of breath and mild dyspnea during walking over short distances. 5. Mild heaviness in the upper abdomen after eating for about half an hour.

## Past History
1. Open appendectomy performed at age 22. 2. Lipoma removal on the right leg at age 45. 3. Type 2 Diabetes Mellitus for five years, under moderate glycemic control (HbA1c 7.1%). 4. Essential Hypertension diagnosed three years ago, managed with stable pharmacological treatment.

## Family History
- Father had hypertension and heart attack at age 68.
- Elder brother has diabetes.
- Mother has Osteoarthritis and Diabetes.
- Younger sister has Hypothyroidism.

## Drug History
1. Gelusil for temporary relief of heartburn (as heard — verify). 2. Glimepiride 1 mg in the morning before breakfast for diabetes. 3. Metformin 500 mg twice daily after meals for diabetes. 4. Telmisartan 40 mg in the morning for hypertension. 5. Atorvastatin 10 mg at night for cholesterol.

## Hospital Admissions
- Open appendectomy at age 22.

## General Examination & Vitals
- Patient was conscious and oriented to time, place, and person.
- Mild conjunctival pallor was noted in the eyes.
- No icterus or cyanosis were present.
- Clubbing was absent on the nails.
- Generalised lymphadenopathy was absent in the neck or axilla.
- Bilateral lower limb pedal oedema was absent.
- Mild tenderness was felt in the epigastric region upon palpation, but no guarding, rigidity, or rebound tenderness was noted.
- Bowel sounds were normal and active (approximately 6 to 8 sounds per minute).

## Previous Diagnosis
1. Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles Grade B Reflux Esophagitis accompanied by a small 2 cm sliding hiatal hernia and mild erythematous antral gastritis (H. pylori negative). 2. Mild Microcytic Hypochromic Anemia secondary to Iron Deficiency (Hemoglobin 11.2 g/dL, Ferritin 14 ng/mL, Transferrin Saturation 9%), exacerbated by poor oral iron intake and chronic occult mucosal oozing from reflux esophagitis. 3. Type 2 Diabetes Mellitus under moderate glycemic control (HbA1c 7.1%) and Essential Hypertension under stable pharmacological control.

## Reports
1. Complete Blood Count (CBC) two weeks ago: Hemoglobin 11.2 g/dL, Total White Blood Cell count 6,800 cells per microliter, Platelet count 245,000 per microliter, Packed Cell Volume 34.2 percent, Mean Corpuscular Volume 74.5 femtoliters, MCH 24.1 picograms, Red Cell Distribution Width 16.8 percent. 2. Iron Profile last week: Serum Iron 38 micrograms per deciliter, Total Iron Binding Capacity 420 micrograms per deciliter, Serum Ferritin 14 nanograms per milliliter, Transferrin Saturation 9 percent. 3. Renal Function Test: Blood Urea Nitrogen 16 mg per dL, Serum Creatinine 0.9 mg per dL, eGFR 92 milliliters per minute per 1.73 m2 (Normal). 4. Alkaline Phosphatase 78 units per liter (All normal limits). 5. Ultrasound Abdomen: Grade 1 fatty infiltration in the liver; no focal mass lesion. Gall bladder is well distended with normal wall thickness; no calculi or sludge detected. Spleen size is normal (9.8 cm); both kidneys are normal in size and shape. No ascites. 6. Upper GI Endoscopy: Los Angeles Grade B Reflux Esophagitis, small 2 cm sliding hiatal hernia, mild erythematous antral gastritis (H. pylori RUT negative).

## Current Diagnosis
1. Primary Diagnosis: Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles Grade B Reflux Esophagitis accompanied by a small 2 cm sliding hiatal hernia and mild erythematous antral gastritis (H. pylori negative). 2. Secondary Diagnosis: Mild Microcytic Hypochromic Anemia secondary to Iron Deficiency (Hemoglobin 11.2 g/dL, Ferritin 14 ng/mL, Transferrin Saturation 9%), exacerbated by poor oral iron intake and chronic occult mucosal oozing from reflux esophagitis. 3. Underlying Comorbidities: Type 2 Diabetes Mellitus under moderate glycemic control (HbA1c 7.1%) and Essential Hypertension under stable pharmacological control.

## Plan of Care
- Treatment: 1.
- Sompraz-D Capsule (Esomeprazole 40 mg + Domperidone 30 mg sustained release) once daily at 30 to 45 minutes before breakfast with a glass of water for 28 days.
- 2.
- Mucaine Gel (10 ml) three times daily, one hour after lunch and one hour after dinner, and immediately before bedtime for 14 days.
- 3.
- Two hours after lunch or at 4 PM with orange juice to be continued for 60 days.
- Continue current medications: Glimepiride 1 mg in the morning before breakfast; Metformin 500 mg twice daily after meals; Telmisartan 40 mg in the morning at 10 AM; Atorvastatin 10 mg at night before sleep.
- Dietary modifications: Small, frequent meals (4-5 times a day).
- Avoid caffeine, high fat/spicy foods, chocolate, garlic, onion, pepper.
- Sleep hygiene: Dinner by 8 PM, sleep by 10 PM.
- Elevate head of bed by 6 inches using blocks or bricks
- use left lateral decubitus position for sleeping.
- Exercise: Brisk walking 30 to 40 minutes daily; ankle pump exercises while sitting.
- Investigation: Complete Blood Count (CBC) in four weeks, Fasting and Postprandial Blood Sugar, Serum Ferritin in two months.
- Follow up: Return to the OP in four weeks for CBC, fasting/postprandial blood sugar, and serum ferritin check.
- Sompraz-D dose may be reduced after 4 weeks if symptoms improve.
- Endoscopy is not required again unless needed after six months.
```

### Row #4 (test4): realtime_transcript_sample_w4

```markdown
## Presenting Complaints
1. Chest pain and burning sensation in the throat for three months, worsening after meals, feeling like fire in the throat after eating.
2. Nighttime chest pain and a feeling of thick fluid coming into the throat while lying down.
3. Mild shortness of breath when walking some distance.
4. Cough at night with dry cough, no phlegm.

## Past History
1. Appendectomy performed at age 22 for acute appendicitis (record, date not stated).
2. Hypertension diagnosed three years ago, currently managed on medication.
3. Type 2 Diabetes Mellitus for five years, managed with Glimepiride and Metformin.
4. Lipoma removed from the right leg at age 45.

## Family History
1. Father had hypertension and died at age 68 due to heart disease.
2. Eldest brother has diabetes.
3. Mother has osteoarthritis and Diabetes.
4. Younger sister has Hypothyroidism.

## Drug History
1. Gelusil (taken as needed for relief).
2. Sompraz-D Capsule: Esomeprazole 40 mg and Domperidone 30 mg, taken once daily 30 minutes before breakfast for 30 days.
3. Mucaine Gel: 10 ml, three times daily one hour after meals for 14 days.
4. Glimepiride 1 mg: Taken in the morning before breakfast.
5. Metformin 500 mg: Taken twice daily after meals.
6. Telmisartan 40 mg: Taken in the morning at 10 am.
7. Atorvastatin 10 mg: Taken at night before sleeping.

## Hospital Admissions
Not discussed

## General Examination & Vitals
- Heart rate 76 beats per minute, regular rhythm, good volume, peripheral pulses all palpable bilaterally.
- Blood pressure 128 by 84 mmHg.
- Respiratory rate 16 breaths per minute, thoracoabdominal.
- Body Temperature 98.4 degrees Fahrenheit (afebrile).
- Oxygen Saturation 99 percent in room air.
- Height 168 centimeters, Weight 72 kilograms, Body Mass Index 25.5 kg/m2.
- Mild conjunctival pallor observed.
- No icterus, cyanosis, clubbing, or generalized lymphadenopathy.
- Mild tenderness in the epigastric region upon palpation.
- Abdomen soft and non-distended with a healthy 4 cm transverse scar in the right iliac fossa from prior appendectomy, fully healed.
- Bowel sounds are normal and active.

## Previous Diagnosis
1. Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles (LA) Grade B Reflux Esophagitis.
2. Mild Microcytic Hypochromic Anemia secondary to Iron Deficiency (Hemoglobin 11.2 g/dL, Ferritin 14 ng/mL, Transferrin Saturation 9%).
3. Type 2 Diabetes Mellitus under moderate glycemic control (HbA1c 7.1%) and Essential Hypertension under stable pharmacological control.

## Reports
1. Complete Blood Count (CBC) from two weeks ago: Hemoglobin 11.2 g/dL, Total White Blood Cell count 6,800 cells per microliter, Absolute Neutrophil Count 4,200, Lymphocyte count 2,100, Platelet count 245,000 per microliter, Packed Cell Volume (PCV) 34.2 percent, Mean Corpuscular Volume (MCV) 74.5 femtoliters, MCH 24.1 picograms, MCHC 32.7 grams per deciliter, Red Cell Distribution Width (RDW) 16.8 percent.
2. Iron Profile from last week: Serum Iron 38 micrograms per deciliter (normal range 60 to 170), Total Iron Binding Capacity 420 micrograms per deciliter (normal range 240 to 450), Serum Ferritin 14 nanograms per milliliter (normal range 30 to 300), Transferrin Saturation 9 percent.
3. Renal Function Test: Blood Urea Nitrogen 16 mg per dL, Serum Creatinine 0.9 mg per dL, Serum Uric acid 5.2 mg per dL, Serum Sodium 139 milliequivalents per liter, Serum Potassium 4.1 mEq per L, Serum Chloride 101 mEq per L, Bicarbonate 24 mEq per L, eGFR 92 milliliters per minute per 1.73 m2.
4. Liver Function Test: Total Bilirubin 0.8 mg per dL, Direct Bilirubin 0.2 mg per dL, Indirect Bilirubin 0.6 mg per dL, Total Protein 7.2 grams per dL, Serum Albumin 4.1 g per dL, Globulin 3.1 g per dL, Albumin to Globulin ratio 1.32, Gamma-glutamyl Transferase (GGT) 22 U per L.
5. Ultrasound Abdomen: Liver shows grade 1 fatty infiltration (mild diffuse increase in parenchymal echogenicity). No focal mass lesion. Gall bladder is well distended with normal wall thickness; no calculi or sludge detected. Spleen size is normal, measuring 9.8 cm in bipolar diameter. Both kidneys are normal in size, shape, and cortical echogenicity. No hydronephrosis or renal calculi. Pancreas visualized normally without ductal dilatation. Urinary bladder is normal. No ascites. No significant intra-abdominal lymphadenopathy.

## Current Diagnosis
1. Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles (LA) Grade B Reflux Esophagitis accompanied by a small 2 cm sliding hiatal hernia and mild erythematous antral gastritis (H. pylori negative).
2. Mild Microcytic Hypochromic Anemia secondary to Iron Deficiency, exacerbated by poor oral iron intake and chronic occult mucosal oozing from reflux esophagitis.

## Plan of Care
- Treatment: 1.
- Sompraz-D Capsule: Esomeprazole 40 milligrams and Domperidone 30 milligrams sustained release, taken once daily 30 to 45 minutes before breakfast with a glass of water for 28 days.
2. Mucaine Gel: 10 ml, three times daily one hour after meals, and at bedtime for 14 days.
3. Ferrous Ascorbate with Folic Acid (Tablet Orofer-XT): Elemental Iron 100 milligrams and Folic acid 1.5 milligrams, taken two hours after lunch or in the evening at 4 pm with orange juice. To be continued for 60 days.
4. Maintenance Medications: Tablet Glimepiride 1 mg in the morning before breakfast; Tablet Metformin 500 mg twice daily after meals; Tablet Telmisartan 40 mg in the morning at 10 am; Tablet Atorvastatin 10 mg at night before sleeping.
- Investigation: Complete Blood Count (CBC) to check for improvement from Hemoglobin 11.2 g/dL, Fasting and Postprandial Blood Sugar to monitor diabetes status, Serum Ferritin after two months.
- Follow up: Return to the same OP in four weeks for CBC, Fasting and Postprandial Blood Sugar checks, and Serum Ferritin check (to be done after two months).
- Sompraz-D dose may be reduced by half after 4 weeks if symptoms improve.
- Endoscopy is not required again unless needed after six months.
- Lifestyle Modifications: 1.
- Diet: Eat small, frequent meals instead of three large ones.
- Avoid caffeine, carbonated drinks, sour juices on an empty stomach, excessive oil, fried foods, spices, chocolate, garlic, and raw onions as they relax the esophageal valve.
- 2.
- Sleep: Do not sleep immediately after eating; wait at least 2 to 3 hours.
- Aim for dinner before 8 pm and sleep by 10 pm.
- Elevate the head-end of the bed by 6 inches using a firm pillow or bricks, do not use extra pillows under the head.
3. Exercise: Practice brisk walking for 30 to 40 minutes daily. Perform ankle pump exercises while sitting at the desk every 45 minutes to prevent venous stasis and deep vein thrombosis.
```

### Row #5 (test1): realtime_transcript_sample_w5

```markdown
## Presenting Complaints
1. Chest pain and burning sensation in the throat for three months, worse after meals, with a feeling of fire in the throat when lying down.
2. Cough occurring at night, accompanied by mild shortness of breath upon waking up.
3. Mild fatigue and weakness, with increased shortness of breath during walking over short distances.
4. Occasional chest pain radiating to the left arm or neck, localized primarily to the center of the chest/upper abdomen after eating.

## Past History
1. Appendectomy at age 22 for appendicitis (open procedure).
2. Lipoma removal on the right leg at age 45.
3. Type 2 Diabetes Mellitus for five years, managed with Glimepiride 1 mg in the morning before breakfast and Metformin 500 mg twice daily after meals.
4. Essential Hypertension diagnosed three years ago, managed with Telmisartan 40 mg in the morning.
5. History of mild jaundice in childhood treated with traditional medicine.

## Family History
1. Father had hypertension and heart attack, deceased at age 68.
2. Elder brother has diabetes.
3. Younger sister has Hypothyroidism.

## Drug History
1. Gelusil (taken as needed for relief).
2. Sompraz-D Capsule: Esomeprazole 40 mg and Domperidone 30 mg, taken once daily at 30 minutes to 45 minutes before breakfast for 30 days.
3. Mucaine Gel (10 ml): Taken three times daily one hour after meals for 14 days.
4. Ferrous Ascorbate with Folic Acid (Orofer-XT): Elemental Iron 100 mg and Folic acid 1.5 mg, taken two hours after lunch or at 4 PM with orange juice/lemonade for 60 days.
5. Glimepiride 1 mg: Taken in the morning before breakfast.
6. Metformin 500 mg: Taken twice daily after meals.
7. Telmisartan 40 mg: Taken in the morning at 10 AM.
8. Atorvastatin 10 mg: Taken at night before sleeping.

## Hospital Admissions
- Appendectomy at age 22 (open procedure).

## General Examination & Vitals
- Heart rate 76 beats per minute, regular rhythm, good volume, peripheral pulses palpable bilaterally.
- Blood pressure 128 by 84 mmHg.
- Respiratory rate 16 breaths per minute, thoracoabdominal.
- Body temperature 98.4 degrees Fahrenheit (afebrile).
- Oxygen saturation 99 percent in room air.
- Height 168 centimeters, Weight 72 kilograms, Body Mass Index 25.5 kg/m2.
- General physical examination revealed mild conjunctival pallor, no icterus, no cyanosis, no clubbing, and mild koilonychia on nails suggestive of iron deficiency.
- Abdomen was soft and non-distended with mild tenderness in the epigastric region upon palpation
- no guarding or rebound tenderness noted.
- Bowel sounds were normal and active.
- Central Nervous System examination showed intact cranial nerves the patient throughs XII, normal motor tone, and normal deep tendon reflexes (2+ bilaterally).
- Sensory examination revealed normal perception to fine touch, pain, temperature, vibration, and joint position sense.
- Gait was steady and normal.

## Previous Diagnosis
1. Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles Grade B Reflux Esophagitis.
2. Mild Microcytic Hypochromic Anemia secondary to Iron Deficiency (Hemoglobin 11.2 g/dL, Ferritin 14 ng/mL, Transferrin Saturation 9%).
3. Type 2 Diabetes Mellitus under moderate glycemic control (HbA1c 7.1%) and Essential Hypertension under stable pharmacological control.

## Reports
1. Complete Blood Count (CBC) from two weeks prior: Hemoglobin 11.2 g per dL, Total White Blood Cell count 6,800 cells per microliter, Absolute Neutrophil Count 4,200, Lymphocyte count 2,100, Platelet count 245,000 per microliter, Packed Cell Volume 34.2 percent, Mean Corpuscular Volume 74.5 femtoliters, MCH 24.1 picograms, MCHC 32.7 grams per deciliter, Red Cell Distribution Width 16.8 percent.
2. Serum Iron Profile (from last week): Serum Iron 38 micrograms per deciliter (Normal range 60 to 170), Total Iron Binding Capacity 420 micrograms per deciliter (Normal range 240 to 450), Serum Ferritin 14 nanograms per milliliter (Normal range 30 to 300), Transferrin Saturation 9 percent.
3. Renal Function Test: Blood Urea Nitrogen 16 mg per dL, Serum Creatinine 0.9 mg per dL, Serum Uric acid 5.2 mg per dL, Serum Sodium 139 milliequivalents per liter, Serum Potassium 4.1 mEq per L, Serum Chloride 101 mEq per L, Bicarbonate 24 mEq per L, eGFR 92 milliliters per minute per 1.73 m2 (Normal).
4. Liver Function Test: Total Bilirubin 0.8 mg per dL, Direct Bilirubin 0.2 mg per dL, Indirect Bilirubin 0.6 mg per dL, Total Protein 7.2 grams per dL, Serum Albumin 4.1 g per dL, Globulin 3.1 g per dL, Albumin to Globulin ratio 1.32, Gamma-glutamyl Transferase (GGT) 22 U per L (All liver enzymes were within normal limits).
5. Ultrasound Abdomen: Liver shows grade 1 fatty infiltration (mild diffuse increase in parenchymal echogenicity). No focal mass lesion. Gall bladder is well distended with normal wall thickness; no calculi or sludge detected. Spleen size is normal, measuring 9.8 cm in bipolar diameter. Both kidneys are normal in size, shape, and cortical echogenicity. No hydronephrosis or renal calculi. Pancreas visualized normally without ductal dilatation. Urinary bladder is normal. No ascites. No significant intra-abdominal lymphadenopathy.

## Current Diagnosis
1. Primary Diagnosis: Gastroesophageal Reflux Disease (GERD) with Endoscopy-proven Los Angeles Grade B Reflux Esophagitis accompanied by a small 2 cm sliding hiatal hernia and mild erythematous antral gastritis (H. pylori negative).
2. Secondary Diagnosis: Mild Microcytic Hypochromic Anemia secondary to Iron Deficiency (Hemoglobin 11.2 g/dL, Ferritin 14 ng/mL, Transferrin Saturation 9%), exacerbated by poor oral iron intake and chronic occult mucosal oozing from reflux esophagitis.
3. Underlying Comorbidities: Type 2 Diabetes Mellitus under moderate glycemic control (HbA1c 7.1%) and Essential Hypertension under stable pharmacological control.

## Plan of Care
- Treatment: 1.
- Sompraz-D Capsule: Esomeprazole 40 milligrams and Domperidone 30 milligrams sustained release, to be taken once daily at 30 to 45 minutes before breakfast with a glass of water for 28 days.
2. Mucaine Gel (10 ml): To be taken three times daily one hour after meals for 14 days.
3. Ferrous Ascorbate with Folic Acid (Orofer-XT): Elemental Iron 100 milligrams and Folic acid 1.5 milligrams, to be taken two hours after lunch or at 4 PM with lemonade/orange juice for 60 days.
4. Continue current medications: Tablet Glimepiride 1 mg in the morning before breakfast; Tablet Metformin 500 mg twice daily after meals; Tablet Telmisartan 40 mg in the morning at 10 AM; Tablet Atorvastatin 10 mg at night before sleeping.
- Investigation: Complete Blood Count (CBC) to be done in four weeks to check for improvement from Hemoglobin 11.2 g/dL.
- Fasting and Postprandial Blood Sugar to monitor diabetes control.
- Serum Ferritin to be checked after two months.
- Follow up: Return to this OP in four weeks with the above investigations.
- After completing the Sompraz-D course of 4 weeks, the dose of Sompraz-D may be reduced by half (step-down therapy) once symptoms are fully resolved.
- Endoscopy is not required again unless needed after six months.
- Advice: George should follow a diet consisting of small, frequent meals instead of large ones.
- Avoid caffeine, tea, coffee, sodas, acidic lemonade on an empty stomach, excessive oil, fried foods, spices, chocolate, garlic, and raw onions as they may relax the esophageal sphincter.
- Sleep should be after at least 2 to 3 hours after dinner, aiming for bedtime by 10 PM.
- Elevate the head-end of the bed by 6 inches using a firm pillow or bricks
- do not use extra pillows.
- Lie in the left lateral decubitus position during sleep.
- Engage in light brisk walking for 30 to 40 minutes daily and perform ankle pump exercises while sitting on a chair every 45 minutes.
- Avoid taking pain killers like Ibuprofen, Diclofenac, Aceclofenac, or Mefenamic acid unless severe headache or fever occurs
- only Paracetamol 650 mg after meals should be taken for mild pain.
```

*(... 11 more notes saved individually in `summaries/` directory)*

