# HOPE Bilingual (Malayalam + English) Realtime Latency Benchmark Report

**Generated:** 2026-11-19 12:30:00 UTC  
**Gateway URL:** `https://api-vox2.arcaai.com`  
**Clinician User:** `arcaai_doctor`  
**Flow Tested:** `Raw Malayalam Dialogue ➔ Scribe Summary Generation (Native Gemma Comprehension & Translation on GPU 0)`  

## Latency Bands Summary

### Short Encounters (500 – 2,500 tokens / up to ~1,900 words)
* **Total E2E Range:** ~30.0s to 30.0s (*Average: 30.0s*)
* **LLM Translation & Note Generation (Gemma on GPU 0):** 3.4s – 3.4s (195.1 tps)
* **Medical Guardrails (GPU 1):** 14.3s – 14.3s

## End-to-End Pipeline Latency Table

| Tier | Status | Total E2E | S1 Init | S2 Ingest | S3 Queue | S4.1 NLP | S4.2 Assm | S4.3 LLM Gen & Trans | S4.4 Guard | S5 Fetch | Throughput |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 666 | PASS | 30.03s | 1120.0ms | 1020.1ms | 6211.1ms | 2517.0ms | 774.3ms | 3418.0ms | 14343.9ms | 623.9ms | 195.1 tps |

## Dedicated GPU Hardware Telemetry & Allocation

| Tier | GPU Devices | Prefill TTFT | LLM Decode | Guardrail GPU | Translation Engine | Peak VRAM | Delta VRAM | GPU Avg Util |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 666 | GPU 0 (LLM) + GPU 1 (Guardrail) | 75.0ms | 3418.0ms | 14343.9ms | Native Gemma GPU 0 | 7.79 GB | +320 MB | 45.1% |

## Generated Clinical Summaries (English SOAP Notes)

### Tier 666 Tokens (Encounter: George - Gastroenterology GERD Consultation)

```markdown
# CLINICAL ENCOUNTER NOTE

**Patient Name:** George  
**Encounter Type:** New Visit / Consultation  
**Specialty:** Gastroenterology / General Medicine  

---

### SUBJECTIVE (HPI)
* **Chief Complaint:** Heartburn and acid regurgitation for 3 months.
* **History of Present Illness:**
  - 3-month history of retrosternal burning and sour regurgitation ("burning sensation rising to the throat after meals").
  - Symptoms worsen at night after dinner and upon lying flat. Exacerbated by oily and spicy foods.
  - Denies dysphagia (no difficulty or pain on swallowing).
  - Denies hematemesis (vomiting blood) or melena (black/tarry stools).
  - No significant weight loss; appetite is preserved but patient eats cautiously due to fear of heartburn.
* **Prior Medications:** Over-the-counter Gelusil syrup with transient symptom relief; no regular long-term medications.
* **Past Surgical History:** Open appendectomy at age 22 for appendicitis. No other surgical history.
* **Family History:** Father had hypertension; elder brother has diabetes mellitus. No family history of gastrointestinal or gastric malignancy.

---

### OBJECTIVE
* **Physical Examination:**
  - Blood Pressure: 124/82 mmHg
  - Pulse: 76 bpm, regular
  - Temperature: 98.4°F
  - Respiratory Rate: 16 breaths/min
  - SpO2: 99% on room air
  - Weight: 74 kg
  - General: No pallor, no icterus.
  - Abdomen: Soft, mild tenderness in epigastrium / sub-sternal region. No guarding, no rigidity. Liver and spleen non-palpable. Normal bowel sounds.
* **Diagnostic Investigations & Labs:**
  - **ECG:** Normal sinus rhythm (no evidence of acute coronary event / myocardial infarction).
  - **CBC (2 weeks prior):** Hemoglobin 13.8 g/dL, WBC 7,200/µL, Platelets 260,000/µL (all within normal physiological limits).
  - **Upper GI Endoscopy:** Grade B Reflux Esophagitis in lower esophagus. No ulcers, no mass lesions, no active bleeding.

---

### ASSESSMENT
1. **Gastroesophageal Reflux Disease (GERD)** with **Endoscopic Grade B Reflux Esophagitis**.
2. Rule out cardiac etiology: Normal ECG and stable vitals confirm burning is acid-related reflux, not angina/myocardial ischemia.
3. Rule out gastric malignancy: Endoscopy confirms absence of mass lesions or malignant ulceration.

---

### PLAN & MANAGEMENT
* **Prescription Medications:**
  1. **Tab. Sompraz D** (Esomeprazole 40 mg + Domperidone 30 mg):
     - Dose: 1 tablet orally once daily.
     - Timing: Morning, 30 minutes before food.
     - Duration: 30 days.
  2. **Syrup Mucaine** (Antacid / local anesthetic gel):
     - Dose: 10 ml orally three times daily.
     - Timing: 1 hour after meals.
     - Duration: 14 days (for rapid symptomatic relief of heartburn).
* **Patient Counseling & Instructions:**
  - If a morning dose of Sompraz D is missed, it may be taken at noon; do NOT take a double dose at night.
  - Keep head-end of bed elevated ~6 inches (raise bed frame, do not stack pillows as it bends the neck and increases intra-abdominal pressure).
  - Remain upright for at least 2 hours following dinner; avoid late-night dining.
  - Avoid tea and coffee on an empty stomach; eliminate spicy, oily, and fried foods for 2 weeks.
  - Work and normal daily activities may continue uninterrupted.
* **Red Flags & Follow-up:**
  - Return to Casualty/ER immediately if vomiting blood (hematemesis), passing black stools (melena), or experiencing severe unbearable chest pain.
  - Routine follow-up in clinic after 2 weeks for symptom assessment.
```
