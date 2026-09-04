import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { TranscriptionJobStatus, TranscriptionJobType } from '../../../generated/core-prisma-client/enums';
import {
  SEED_TENANT_ID,
  SEED_CUSTOMER_TENANT_IDS,
  SEED_USER_IDS,
  SEED_DEPARTMENT_IDS,
  SEED_CONSULTATION_IDS,
  SEED_CONTEXT_ITEM_IDS,
  SEED_SUMMARY_META_IDS,
  SEED_AUDIO_RECORDING_IDS,
  SEED_CONTEXT_VERSION_IDS,
  SEED_NAMED_ENTITY_IDS,
  SEED_TRANSCRIPTION_JOB_IDS,
  SYSTEM_USER_ID,
} from './00-constants';
import { GLOBAL_AGENT_SPECS, PLATFORM_AGENT_SPECS } from './25-agents';
// The plaintext clinical PHI columns were dropped; seed rows must
// persist Vault-Transit ciphertext into the sibling `encrypted*` columns.
import { encryptSeedRow } from './phi-encryption';

/**
 * Consultation Seed Data — E2E-Ready Clinical Workflow
 *
 * Creates realistic consultations with linked context items, summaries,
 * audio recordings, versions, and NER entities so that e2e tests can
 * exercise the full clinical workflow without additional setup.
 *
 * Seeded entities:
 *   9 Consultations — full lifecycle coverage across 6 statuses and 6 departments
 *   +2 Consultations — customer-tenant (ArcaAI) NEW + REVISIT pair (doc-08 F1)
 *   21 ContextItems — transcripts, summaries, audio, worknotes, pre-summaries, case notes
 *   +2 ContextItems — one transcript per customer-tenant consultation (doc-08 F1)
 *   4 SummaryMetas — AI generation metadata
 *   3 Media — dual-capture demo blobs (primary + raw + processed) for the GEN recording
 *   4 AudioRecordings — linked to audio context items (GEN row carries raw+processed dual-capture ids)
 *   18 ContextItemVersions — content-at-version audit trail (v1 initials + multi-version edit history)
 *   8 NamedEntities — NER results for medications, conditions, procedures, anatomy
 *
 * Consultation chains:
 *   GEN_COMPLETED → GEN_REOPENED (follow-up with addendum)
 *   SURG_NEW → SURG_FOLLOWUP (surgical follow-up chain)
 *   CARD_NEW → CARD_CROSS_DEPT (cross-department referral to Neurology)
 */

// Exported (consent-abac Phase 6) so 22-consent-grant.ts seeds
// grants against the SAME literal patient ids these demo consultations use —
// one source of truth rather than a second hardcoded copy.
export const PATIENT_IDS = {
  PAT_001: 'PAT-20250101-001',
  PAT_002: 'PAT-20250115-002',
  PAT_003: 'PAT-20260110-003',
  PAT_004: 'PAT-20260205-004',
  PAT_005: 'PAT-20260210-005',
  PAT_006: 'PAT-20260223-006',
  PAT_007: 'PAT-20260218-007',
};

// =============================================================================
// CONSULTATIONS (9)
// =============================================================================

export const DEFAULT_CONSULTATIONS = [
  {
    id: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_001,
    appointmentDate: new Date('2025-12-15'),
    doctorId: SEED_USER_IDS.DOCTOR,
    departmentId: SEED_DEPARTMENT_IDS.OPD,
    parentConsultationId: null,
    metadata: {
      visitType: 'NEW_PATIENT',
      status: 'CLOSED',
      chiefComplaint: 'Persistent cough and low-grade fever for 5 days',
      language: 'en',
      closedAt: '2025-12-15T11:00:00Z',
      closedBy: SEED_USER_IDS.DOCTOR,
    },
    createdBy: SEED_USER_IDS.DOCTOR,
  },
  {
    id: SEED_CONSULTATION_IDS.CARD_NEW,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_002,
    appointmentDate: new Date('2026-01-20'),
    doctorId: SEED_USER_IDS.DOCTOR2,
    departmentId: SEED_DEPARTMENT_IDS.OPD,
    parentConsultationId: null,
    metadata: {
      visitType: 'REVISIT',
      status: 'REVIEW',
      chiefComplaint: 'Follow-up for hypertension management and chest tightness',
      language: 'en',
    },
    createdBy: SEED_USER_IDS.DOCTOR2,
  },
  {
    id: SEED_CONSULTATION_IDS.SURG_NEW,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_003,
    appointmentDate: new Date('2026-01-10'),
    doctorId: SEED_USER_IDS.DOCTOR_SURGERY,
    departmentId: SEED_DEPARTMENT_IDS.PERI,
    parentConsultationId: null,
    metadata: {
      visitType: 'NEW_PATIENT',
      status: 'SUMMARIZING',
      chiefComplaint: 'Right iliac fossa pain for 2 days with nausea and fever',
      language: 'en',
    },
    createdBy: SEED_USER_IDS.DOCTOR_SURGERY,
  },
  {
    id: SEED_CONSULTATION_IDS.SURG_FOLLOWUP,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_003,
    appointmentDate: new Date('2026-02-05'),
    doctorId: SEED_USER_IDS.DOCTOR_SURGERY,
    departmentId: SEED_DEPARTMENT_IDS.PERI,
    parentConsultationId: SEED_CONSULTATION_IDS.SURG_NEW,
    metadata: {
      visitType: 'REVISIT',
      status: 'OPEN',
      chiefComplaint: 'Post-appendectomy follow-up — wound review and recovery assessment',
      language: 'en',
    },
    createdBy: SEED_USER_IDS.DOCTOR_SURGERY,
  },
  {
    id: SEED_CONSULTATION_IDS.NEUR_REFERRAL,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_004,
    appointmentDate: new Date('2026-02-05'),
    doctorId: SEED_USER_IDS.DOCTOR_NEURO,
    departmentId: SEED_DEPARTMENT_IDS.OPD,
    parentConsultationId: null,
    metadata: {
      visitType: 'REFERRAL',
      status: 'TRANSCRIBING',
      chiefComplaint: 'Recurrent headaches with visual disturbance — referred from General Practice',
      language: 'en',
      referredFrom: 'General Practice',
      referringDoctorId: SEED_USER_IDS.DOCTOR,
    },
    createdBy: SEED_USER_IDS.DOCTOR_NEURO,
  },
  {
    id: SEED_CONSULTATION_IDS.PEDS_COMPLETED,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_005,
    appointmentDate: new Date('2026-02-10'),
    doctorId: SEED_USER_IDS.DOCTOR_PEDS,
    departmentId: SEED_DEPARTMENT_IDS.PEDS,
    parentConsultationId: null,
    metadata: {
      visitType: 'NEW_PATIENT',
      status: 'CLOSED',
      chiefComplaint: 'Right ear pain and fever for 3 days — 4-year-old male',
      language: 'en',
      closedAt: '2026-02-10T15:30:00Z',
      closedBy: SEED_USER_IDS.DOCTOR_PEDS,
    },
    createdBy: SEED_USER_IDS.DOCTOR_PEDS,
  },
  {
    id: SEED_CONSULTATION_IDS.ER_RECORDING,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_006,
    appointmentDate: new Date('2026-02-23'),
    doctorId: SEED_USER_IDS.DOCTOR_ER,
    departmentId: SEED_DEPARTMENT_IDS.ER,
    parentConsultationId: null,
    metadata: {
      visitType: 'NEW_PATIENT',
      status: 'RECORDING',
      chiefComplaint: 'Acute chest pain radiating to left arm — onset 45 minutes ago',
      language: 'en',
      triageCategory: 'RED',
    },
    createdBy: SEED_USER_IDS.DOCTOR_ER,
  },
  {
    id: SEED_CONSULTATION_IDS.GEN_REOPENED,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_001,
    appointmentDate: new Date('2026-01-05'),
    doctorId: SEED_USER_IDS.DOCTOR,
    departmentId: SEED_DEPARTMENT_IDS.OPD,
    parentConsultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    metadata: {
      visitType: 'REVISIT',
      status: 'OPEN',
      chiefComplaint: 'Follow-up after pneumonia treatment — persistent mild cough',
      language: 'en',
      reopenReason: 'addendum',
      reopenedAt: '2026-01-05T09:00:00Z',
      reopenedBy: SEED_USER_IDS.DOCTOR,
    },
    createdBy: SEED_USER_IDS.DOCTOR,
  },
  {
    id: SEED_CONSULTATION_IDS.CARD_CROSS_DEPT,
    tenantId: SEED_TENANT_ID,
    patientId: PATIENT_IDS.PAT_002,
    appointmentDate: new Date('2026-02-15'),
    doctorId: SEED_USER_IDS.DOCTOR2,
    departmentId: SEED_DEPARTMENT_IDS.OPD,
    parentConsultationId: SEED_CONSULTATION_IDS.CARD_NEW,
    metadata: {
      visitType: 'REFERRAL',
      status: 'OPEN',
      chiefComplaint: 'Neurology referral for recurrent syncope during hypertension follow-up',
      language: 'en',
      referredFrom: 'Cardiology',
      referringDoctorId: SEED_USER_IDS.DOCTOR2,
    },
    createdBy: SEED_USER_IDS.DOCTOR2,
  },
];

// =============================================================================
// CUSTOMER-TENANT CONSULTATIONS
//
// ArcaAI seeds clinicians (91-user.ts) but previously had ZERO
// consultations, so admin clinical lists & analytics rendered empty for the
// customer tenant. The tenant now gets a NEW_PATIENT visit + a REVISIT
// follow-up for the same patient, owned by that tenant's canonical DOCTOR
// (SEED_USER_IDS) in that tenant's GEN department. IDs use the per-tenant
// 4th-UUID-group convention (0001 ArcaAI); the NEW
// row precedes the REVISIT so the parentConsultationId FK resolves in order.
// =============================================================================
export const CUSTOMER_TENANT_CONSULTATIONS = [
  // ── ArcaAI ──────────────────────────────────────────────────────────
  {
    id: SEED_CONSULTATION_IDS.ARCAAI_GEN_NEW,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    patientId: 'PAT-20260221-101',
    appointmentDate: new Date('2026-02-21'),
    doctorId: SEED_USER_IDS.ARCAAI_DOCTOR,
    departmentId: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
    parentConsultationId: null,
    metadata: {
      visitType: 'NEW_PATIENT',
      status: 'OPEN',
      chiefComplaint: 'Sore throat and mild fever for 3 days',
      language: 'en',
    },
    createdBy: SEED_USER_IDS.ARCAAI_DOCTOR,
  },
  {
    id: SEED_CONSULTATION_IDS.ARCAAI_GEN_REVISIT,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    patientId: 'PAT-20260221-101',
    appointmentDate: new Date('2026-02-28'),
    doctorId: SEED_USER_IDS.ARCAAI_DOCTOR,
    departmentId: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
    parentConsultationId: SEED_CONSULTATION_IDS.ARCAAI_GEN_NEW,
    metadata: {
      visitType: 'REVISIT',
      status: 'REVIEW',
      chiefComplaint: 'Follow-up: persistent sore throat, review of throat swab results',
      language: 'en',
    },
    createdBy: SEED_USER_IDS.ARCAAI_DOCTOR,
  },
];

// One transcript per customer-tenant consultation, mirroring the Global
// TRANSCRIPT context-item shape so customer clinical views are not empty.
export const CUSTOMER_TENANT_CONTEXT_ITEMS = [
  {
    id: SEED_CONTEXT_ITEM_IDS.ARCAAI_GEN_NEW_TRANSCRIPT,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    consultationId: SEED_CONSULTATION_IDS.ARCAAI_GEN_NEW,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content:
      'Doctor: What brings you in today? Patient: Sore throat and a mild fever for about three days. Doctor: Any cough or difficulty swallowing? Patient: Some difficulty swallowing, no cough. Doctor: I will examine your throat and order a rapid swab.',
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.ARCAAI_GEN_REVISIT_TRANSCRIPT,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    consultationId: SEED_CONSULTATION_IDS.ARCAAI_GEN_REVISIT,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content:
      'Doctor: How is the throat now? Patient: A little better but still sore. Doctor: Your swab was positive for strep; we will continue the antibiotics and review in a week.',
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
];

// =============================================================================
// CONTEXT ITEMS (24)
// =============================================================================

const GEN_TRANSCRIPT_CONTENT = `Doctor: Good morning, Alice. What brings you in today?
Patient: I've had this cough that won't go away for about five days now. And I've been running a low fever, around 37.8 degrees.
Doctor: I see. Is the cough productive? Are you bringing anything up?
Patient: Yes, there's some yellowish phlegm, especially in the morning.
Doctor: Any shortness of breath or chest pain?
Patient: No chest pain, but I do feel a bit short of breath when I climb stairs.
Doctor: Any recent travel or contact with anyone who's been sick?
Patient: My son had a cold about a week ago.
Doctor: Alright. Let me listen to your lungs. Take a deep breath please.
Doctor: I can hear some crackles in the right lower lobe. Your vitals show temperature 37.8, blood pressure 120/78, heart rate 82, and oxygen saturation 97%.
Doctor: Based on the examination, I suspect a lower respiratory tract infection, possibly early pneumonia. I'd like to order a chest X-ray and a complete blood count.
Patient: Is it serious?
Doctor: We'll know more after the tests. In the meantime, I'm going to start you on amoxicillin 500mg three times daily for seven days. Please also take paracetamol for the fever. Come back in three days or sooner if your symptoms worsen.`;

const GEN_SUMMARY_V1 = JSON.stringify({
  summary:
    '**Chief Complaint**: Persistent productive cough with low-grade fever (37.8°C) for 5 days.\n\n**History of Present Illness**: The patient presented with a 5-day history of persistent cough productive of yellowish sputum, predominantly in the mornings. She reported associated low-grade fever and mild exertional dyspnea on stair climbing. She denied chest pain. Her son had a recent upper respiratory tract infection approximately one week prior.\n\n**Examination**: Vitals: T 37.8°C, BP 120/78 mmHg, HR 82 bpm, SpO₂ 97%. Auscultation revealed crackles in the right lower lobe.\n\n**Assessment**: Lower respiratory tract infection, possible early community-acquired pneumonia.\n\n**Plan**:\n- Chest X-ray ordered\n- CBC ordered\n- Amoxicillin 500 mg PO TID × 7 days\n- Paracetamol PRN for fever\n- Follow-up in 3 days or sooner if symptoms worsen',
});

const GEN_SUMMARY_V2 = JSON.stringify({
  summary:
    '**Chief Complaint**: Persistent productive cough with low-grade fever (37.8°C) for 5 days.\n\n**History of Present Illness**: The patient presented with a 5-day history of persistent cough productive of yellowish sputum, predominantly in the mornings. She reported associated low-grade fever and mild exertional dyspnea on stair climbing. She denied chest pain. Her son had a recent upper respiratory tract infection approximately one week prior.\n\n**Examination**: Vitals: T 37.8°C, BP 120/78 mmHg, HR 82 bpm, SpO₂ 97%. Auscultation revealed crackles in the right lower lobe.\n\n**Assessment**: Lower respiratory tract infection, possible early community-acquired pneumonia (ICD-10: J18.9).\n\n**Plan**:\n- Chest X-ray ordered\n- CBC ordered\n- Amoxicillin 500 mg PO TID × 7 days (corrected from 250 mg)\n- Paracetamol 500 mg PRN for fever (max 4g/day)\n- Follow-up in 3 days or sooner if symptoms worsen\n- Return precautions: worsening dyspnea, hemoptysis, high fever >39°C',
});

const CARD_TRANSCRIPT_CONTENT = `Doctor: Hello Robert. How have you been since our last visit?
Patient: The blood pressure medication seems to be helping. My home readings have been around 135 over 85 most days.
Doctor: That's improving. Any side effects from the amlodipine?
Patient: I've noticed some ankle swelling, especially by the end of the day.
Doctor: That's a known side effect. Let's discuss that. You also mentioned chest tightness on the phone?
Patient: Yes, occasionally when I walk briskly. It passes when I rest.
Doctor: How long does it last?
Patient: Maybe two to three minutes.
Doctor: Any associated symptoms — sweating, nausea, arm pain?
Patient: No, just the tightness.
Doctor: Let me check your ECG today. Your blood pressure now is 132/82, heart rate 74, regular. The ECG shows normal sinus rhythm, no ST changes.
Doctor: The chest tightness with exertion is something we should investigate further. I'd like to order a stress ECG. For the ankle swelling, let's switch you from amlodipine to a combination of losartan 50mg and hydrochlorothiazide 12.5mg once daily. Continue your aspirin and statin.`;

const CARD_WORKNOTE_CONTENT = `Follow-up visit — hypertension management.
BP improved on amlodipine but experiencing peripheral edema (ankles bilateral).
New symptom: exertional chest tightness lasting 2-3 min, relieved by rest. No radiation, no diaphoresis.
ECG: NSR, no acute changes. Ordered stress ECG to rule out stable angina.
Plan: Switch amlodipine → losartan/HCTZ 50/12.5 mg daily. Continue ASA + statin. F/U after stress test.`;

const CARD_WORKNOTE_V2_CONTENT = `Follow-up visit — hypertension management.
BP improved on amlodipine but experiencing peripheral edema (ankles bilateral).
New symptom: exertional chest tightness lasting 2-3 min, relieved by rest. No radiation, no diaphoresis.
ECG: NSR, no acute changes. Ordered stress ECG to rule out stable angina.
Plan: Switch amlodipine → losartan/HCTZ 50/12.5 mg daily. Continue ASA + statin. F/U after stress test.
ADDENDUM (2026-01-22): Stress ECG completed — no inducible ischemia. Chest tightness likely musculoskeletal. Continue current plan. Reassess BP in 4 weeks on new regimen.`;

const SURG_TRANSCRIPT_CONTENT = `Doctor: Good morning, Mr. Kumar. I'm Dr. Patel from Surgery. Tell me about the pain you've been having.
Patient: Doctor, I've had this pain in my right lower belly for two days. It started around my navel and moved down.
Doctor: How would you rate the pain on a scale of 1 to 10?
Patient: It's about 7 right now. It gets worse when I move or cough.
Doctor: Any nausea or vomiting?
Patient: Yes, I vomited twice yesterday. I've also had a fever since last night.
Doctor: Let me examine you. I can feel tenderness and guarding in the right iliac fossa. McBurney's point is positive. Rebound tenderness is present.
Doctor: Your temperature is 38.2, heart rate 96, blood pressure 130/84. White cell count from the blood work is elevated at 14,500.
Doctor: Based on the clinical picture, this is most likely acute appendicitis. We need to do a CT abdomen to confirm and plan for surgery. I'm recommending a laparoscopic appendectomy.
Patient: Is that keyhole surgery?
Doctor: Yes, it's minimally invasive. We'll make three small incisions. Recovery is typically 1-2 weeks. Let's get you started on IV fluids and antibiotics while we arrange the scan.`;

const SURG_CASE_NOTE_CONTENT = `Acute appendicitis — clinical diagnosis.
RIF tenderness, positive McBurney's, rebound +ve. WBC 14,500. T 38.2°C.
CT abdomen ordered. NPO from now. IV NS 1L, IV Ceftriaxone 2g + IV Metronidazole 500mg.
Consented for laparoscopic appendectomy. OT booking requested for tomorrow AM.`;

const SURG_CASE_NOTE_V2_CONTENT = `Acute appendicitis — clinical diagnosis.
RIF tenderness, positive McBurney's, rebound +ve. WBC 14,500. T 38.2°C.
CT abdomen: confirmed appendicitis with periappendiceal fat stranding, no abscess.
NPO from now. IV NS 1L, IV Ceftriaxone 2g + IV Metronidazole 500mg.
Consented for laparoscopic appendectomy. OT booking confirmed for tomorrow 08:00.
POST-OP NOTE: Laparoscopic appendectomy completed successfully. Operative time 45 min. No complications. Histopath sent.`;

const SURG_FOLLOWUP_TRANSCRIPT_CONTENT = `Doctor: Welcome back, Mr. Kumar. How are you feeling after the surgery?
Patient: Much better, doctor. The wound sites are healing well. There's some mild discomfort when I stretch but no severe pain.
Doctor: Good to hear. Let me check the incision sites. All three ports look clean, no signs of infection. Sutures are dissolving nicely.
Doctor: Any fever, nausea, or change in bowel habits?
Patient: No fever. Bowel movements are back to normal since last week. Appetite is improving.
Doctor: Excellent. The histopathology came back — it confirmed acute suppurative appendicitis. No complications.
Doctor: You can gradually return to normal activities. Avoid heavy lifting for another two weeks. No dietary restrictions. Come back in four weeks for a final check.`;

const NEUR_TRANSCRIPT_CONTENT = `Doctor: Good afternoon, Mrs. Shah. I'm Dr. Chen from Neurology. You've been referred here for recurrent headaches with visual disturbance?
Patient: Yes, doctor. I've been getting these terrible headaches about three times a week for the past two months. They start behind my left eye and spread to the whole left side.
Doctor: How long do they last?
Patient: Usually 4 to 6 hours if I don't take medication. Sometimes longer.
Doctor: You mentioned visual disturbance — can you describe that?
Patient: Before the headache starts, I see zigzag lines and flashing lights for about 20 minutes. Then my vision goes blurry on one side.
Doctor: That sounds like a classic migraine with aura. Any nausea or sensitivity to light?
Patient: Yes, both. I have to lie down in a dark room.
Doctor: I'm going to order an MRI brain to rule out any structural causes, and we'll start you on propranolol 40mg twice daily for prevention. For acute attacks, continue sumatriptan but no more than 10 days per month to avoid medication overuse headache.`;

const PEDS_TRANSCRIPT_CONTENT = `Doctor: Hello, Mrs. Rodriguez. And this must be little Carlos. What's been going on?
Parent: He's been pulling at his right ear for three days and has a fever of 38.5. He's been very cranky and not sleeping well.
Doctor: Poor little one. Any runny nose or cough?
Parent: A bit of a runny nose, yes.
Doctor: Let me take a look. Carlos, can you sit still for me? I'm going to look in your ear. The right tympanic membrane is erythematous and bulging. Left ear looks normal. Throat is mildly erythematous.
Doctor: His temperature is 38.3 now, heart rate 120 which is normal for his age. Weight is 16.2 kg, which is on the 50th percentile — good.
Doctor: This is acute otitis media — a middle ear infection. Given his age and the severity, I'd like to start amoxicillin 45 mg/kg/day divided into two doses for 10 days. Also ibuprofen for pain and fever.
Parent: Should I be worried?
Doctor: It's very common at this age. Most children recover well. Bring him back in 3 days if the fever persists, or sooner if he seems worse. Watch for fluid draining from the ear.`;

const PEDS_SUMMARY_CONTENT = JSON.stringify({
  summary:
    '**Chief Complaint**: Right ear pain and fever for 3 days in a 4-year-old male.\n\n**History**: 3-day history of right ear pulling, fever (38.5°C), irritability, and sleep disturbance. Associated mild rhinorrhea. No cough.\n\n**Growth & Development**: Weight 16.2 kg (50th percentile). Age-appropriate development.\n\n**Examination**: T 38.3°C, HR 120 bpm. Right tympanic membrane erythematous and bulging. Left ear normal. Mild pharyngeal erythema.\n\n**Assessment**: Acute otitis media (right ear) — ICD-10: H66.91.\n\n**Plan**:\n- Amoxicillin 45 mg/kg/day (365 mg) PO BID × 10 days\n- Ibuprofen 5 mg/kg PRN for pain and fever\n- Return in 3 days if fever persists\n- Return precautions: ear drainage, worsening symptoms, high fever',
});

const GEN_REOPENED_TRANSCRIPT_CONTENT = `Doctor: Welcome back, Alice. How are you feeling after the antibiotic course?
Patient: Much better overall, doctor. The fever is completely gone and I can breathe normally now. But I still have a mild dry cough, especially at night.
Doctor: That's common after a respiratory infection — post-infectious cough can last 2-4 weeks. The chest X-ray from last time showed mild infiltrates that should be resolving. Let me listen to your lungs.
Doctor: Lungs are clear now — no crackles. That's a good sign. Your vitals are normal — temperature 36.6, blood pressure 118/76, oxygen saturation 99%.
Doctor: The persistent cough is likely post-infectious bronchial hyperreactivity. I'll prescribe a short course of montelukast 10mg at bedtime for two weeks. If the cough persists beyond that, we'll do a follow-up chest X-ray. No further antibiotics needed.`;

const GEN_REOPENED_WORKNOTE_CONTENT = `Addendum to consultation PAT-20250101-001 (2025-12-15).
Post-infectious follow-up. Antibiotic course completed. Fever resolved. Persistent mild dry nocturnal cough.
Examination: lungs clear, vitals normal. CXR infiltrates expected to be resolving.
Dx: Post-infectious cough / bronchial hyperreactivity.
Rx: Montelukast 10 mg PO QHS × 14 days. Reassess if cough persists beyond 2 weeks.`;

const CARD_CROSS_TRANSCRIPT_CONTENT = `Doctor: Good afternoon, Robert. I'm seeing you today for a neurology evaluation following your cardiology referral for recurrent syncope.
Patient: Yes, Dr. Doe referred me because I've had two episodes where I completely blacked out in the past month.
Doctor: Were these associated with any physical exertion?
Patient: The first one happened while I was standing in a queue. The second was after getting up quickly from a chair.
Doctor: Any warning signs before you faint — lightheadedness, tunnel vision, nausea?
Patient: Yes, I feel lightheaded and my vision gets dim for about 10-15 seconds before everything goes black.
Doctor: How long are you unconscious?
Patient: My wife says about 30 seconds to a minute. No shaking or tongue biting.
Doctor: Given the prodromal symptoms and the cardiac workup being unremarkable — your stress ECG and echo were normal — this pattern is consistent with vasovagal syncope. However, I'd like to do a tilt-table test and an EEG to be thorough.`;

const GEN_PRE_SUMMARY_CONTENT = `**Pre-Summary for General Practice Consultation**\n\n**Patient**: PAT-20250101-001\n**Historical Context**: No prior consultations in the system.\n**Relevant History**: First visit — no prior case notes available.\n\n**Summary**: New patient presenting with acute respiratory symptoms. No prior medical history documented in the system.`;

const CARD_PRE_SUMMARY_CONTENT = `**Pre-Summary for Cardiology Follow-up**\n\n**Patient**: PAT-20250115-002\n**Previous Visits**: Initial cardiology assessment 3 months ago.\n**Key Findings from Prior Visits**:\n- Diagnosed with essential hypertension (I10)\n- Started on Amlodipine 5 mg OD\n- Baseline ECG: NSR, normal intervals\n- ECHO: LVEF 60%, no structural abnormality\n- Lipids: LDL 132, started on Atorvastatin 20 mg\n\n**Medications at Last Visit**: Amlodipine 5 mg OD, Aspirin 75 mg OD, Atorvastatin 20 mg OD.`;

const DEFAULT_CONTEXT_ITEMS = [
  // --- GEN_COMPLETED (7 items) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.GEN_TRANSCRIPT,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: GEN_TRANSCRIPT_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.GEN_RAW_SUMMARY,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    type: 'RAW_SUMMARY' as const,
    source: 'AI' as const,
    currentVersionNumber: 2,
    content: GEN_SUMMARY_V2,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.GEN_MODIFIED_SUMMARY,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    type: 'MODIFIED_SUMMARY' as const,
    source: 'USER' as const,
    currentVersionNumber: 1,
    content: GEN_SUMMARY_V2,
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.GEN_AUDIO,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    type: 'AUDIO_RECORDING' as const,
    source: 'USER' as const,
    currentVersionNumber: 1,
    content: null,
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.GEN_CASE_NOTE,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    type: 'CASE_NOTE' as const,
    source: 'USER' as const,
    currentVersionNumber: 1,
    content: 'Patient Alice, 45F. Known history: seasonal allergies. No chronic conditions. Non-smoker. Family hx: father had COPD.',
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.GEN_PRE_SUMMARY,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    type: 'PRE_SUMMARY' as const,
    source: 'AI' as const,
    currentVersionNumber: 1,
    content: GEN_PRE_SUMMARY_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  // --- CARD_NEW (3 items) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.CARD_TRANSCRIPT,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.CARD_NEW,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: CARD_TRANSCRIPT_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.CARD_WORKNOTE,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.CARD_NEW,
    type: 'WORKNOTE' as const,
    source: 'USER' as const,
    currentVersionNumber: 2,
    content: CARD_WORKNOTE_V2_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR2,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.CARD_PRE_SUMMARY,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.CARD_NEW,
    type: 'PRE_SUMMARY' as const,
    source: 'AI' as const,
    currentVersionNumber: 1,
    content: CARD_PRE_SUMMARY_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  // --- SURG_NEW (3 items) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.SURG_TRANSCRIPT,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.SURG_NEW,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: SURG_TRANSCRIPT_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.SURG_AUDIO,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.SURG_NEW,
    type: 'AUDIO_RECORDING' as const,
    source: 'USER' as const,
    currentVersionNumber: 1,
    content: null,
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR_SURGERY,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.SURG_CASE_NOTE,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.SURG_NEW,
    type: 'CASE_NOTE' as const,
    source: 'USER' as const,
    currentVersionNumber: 2,
    content: SURG_CASE_NOTE_V2_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR_SURGERY,
  },
  // --- SURG_FOLLOWUP (1 item) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.SURG_FOLLOWUP_TRANSCRIPT,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.SURG_FOLLOWUP,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: SURG_FOLLOWUP_TRANSCRIPT_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  // --- NEUR_REFERRAL (1 item — still transcribing) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.NEUR_TRANSCRIPT,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.NEUR_REFERRAL,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: NEUR_TRANSCRIPT_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  // --- PEDS_COMPLETED (3 items) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.PEDS_TRANSCRIPT,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.PEDS_COMPLETED,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: PEDS_TRANSCRIPT_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.PEDS_RAW_SUMMARY,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.PEDS_COMPLETED,
    type: 'RAW_SUMMARY' as const,
    source: 'AI' as const,
    currentVersionNumber: 1,
    content: PEDS_SUMMARY_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.PEDS_AUDIO,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.PEDS_COMPLETED,
    type: 'AUDIO_RECORDING' as const,
    source: 'USER' as const,
    currentVersionNumber: 1,
    content: null,
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR_PEDS,
  },
  // --- ER_RECORDING (1 item — still recording, no transcript yet) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.ER_AUDIO,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.ER_RECORDING,
    type: 'AUDIO_RECORDING' as const,
    source: 'USER' as const,
    currentVersionNumber: 1,
    content: null,
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR_ER,
  },
  // --- GEN_REOPENED (2 items) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.GEN_REOPENED_TRANSCRIPT,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_REOPENED,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: GEN_REOPENED_TRANSCRIPT_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
  {
    id: SEED_CONTEXT_ITEM_IDS.GEN_REOPENED_WORKNOTE,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_REOPENED,
    type: 'WORKNOTE' as const,
    source: 'USER' as const,
    currentVersionNumber: 1,
    content: GEN_REOPENED_WORKNOTE_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SEED_USER_IDS.DOCTOR,
  },
  // --- CARD_CROSS_DEPT (1 item) ---
  {
    id: SEED_CONTEXT_ITEM_IDS.CARD_CROSS_TRANSCRIPT,
    tenantId: SEED_TENANT_ID,
    consultationId: SEED_CONSULTATION_IDS.CARD_CROSS_DEPT,
    type: 'TRANSCRIPT' as const,
    source: 'TRANSCRIPTION' as const,
    currentVersionNumber: 1,
    content: CARD_CROSS_TRANSCRIPT_CONTENT,
    dnaWritingStyleId: null,
    createdBy: SYSTEM_USER_ID,
  },
];

// =============================================================================
// SUMMARY METAS (4)
// =============================================================================

export const DEFAULT_SUMMARY_METAS = [
  {
    id: SEED_SUMMARY_META_IDS.GEN_SUMMARY,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_RAW_SUMMARY,
    aiModelId: 'gpt-4o',
    aiModelVersion: '2025-01-01',
    promptVersion: '1',
    processingTimeMs: 4200,
    inputTokens: 850,
    outputTokens: 420,
    // Quality analytics so the SavedSummariesPanel
    // QualityBadge renders on demo data. Freshly generated (not cached),
    // high quality.
    cacheHit: false,
    qualityScore: 0.91,
    caseNoteIds: [SEED_CONTEXT_ITEM_IDS.GEN_CASE_NOTE],
    preSummaryIds: [SEED_CONTEXT_ITEM_IDS.GEN_PRE_SUMMARY],
    previousSummaryIds: [],
    generatedAt: new Date('2025-12-15T10:35:00Z'),
  },
  {
    id: SEED_SUMMARY_META_IDS.PEDS_SUMMARY,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.PEDS_RAW_SUMMARY,
    aiModelId: 'gpt-4o',
    aiModelVersion: '2025-01-01',
    promptVersion: '1',
    processingTimeMs: 3800,
    inputTokens: 720,
    outputTokens: 380,
    // Served from cache; slightly lower quality so the
    // QualityBadge demos the cached + lower-score state alongside GEN above.
    cacheHit: true,
    qualityScore: 0.84,
    caseNoteIds: [],
    preSummaryIds: [],
    previousSummaryIds: [],
    generatedAt: new Date('2026-02-10T15:00:00Z'),
  },
];

// =============================================================================
// MEDIA (3) — dual-capture demo blobs for the GEN recording
//
// `Media` is not seeded by any other seed file, so the dual-capture demo rows
// live here, immediately before the AudioRecording rows that reference them.
// AudioRecording.mediaId / rawMediaId / processedMediaId are plain soft string
// references (no FK), so ordering is for readability, not referential integrity.
// IDs use a dedicated 96000000-… block (90=consultation … 95=named-entity → 96=media).
// =============================================================================

export const SEED_MEDIA_IDS = {
  GEN_AUDIO_PRIMARY: '96000000-0000-0000-0000-000000000001',
  GEN_AUDIO_RAW: '96000000-0000-0000-0000-000000000002',
  GEN_AUDIO_PROCESSED: '96000000-0000-0000-0000-000000000003',
} as const;

export const DEFAULT_MEDIA = [
  {
    // Primary recording — browser-captured WebM kept as the back-compat
    // playback reference (matches AudioRecording.format = 'webm').
    id: SEED_MEDIA_IDS.GEN_AUDIO_PRIMARY,
    tenantId: SEED_TENANT_ID,
    name: 'gen-consultation-recording.webm',
    uri: `s3://hope-audio/${SEED_TENANT_ID}/2025/12/gen-consultation-recording.webm`,
    extension: 'webm',
    mimeType: 'audio/webm',
    size: 2960000,
    hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    createdBy: SEED_USER_IDS.DOCTOR,
  },
  {
    // RAW stream — unprocessed PCM captured BEFORE noise removal / VAD.
    id: SEED_MEDIA_IDS.GEN_AUDIO_RAW,
    tenantId: SEED_TENANT_ID,
    name: 'gen-consultation-recording.raw.wav',
    uri: `s3://hope-audio/${SEED_TENANT_ID}/2025/12/gen-consultation-recording.raw.wav`,
    extension: 'wav',
    mimeType: 'audio/wav',
    size: 5920000,
    hash: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    createdBy: SEED_USER_IDS.DOCTOR,
  },
  {
    // PROCESSED stream — denoised + VAD-trimmed + 16 kHz-resampled PCM fed
    // to the ASR model (shorter than raw after silence trimming).
    id: SEED_MEDIA_IDS.GEN_AUDIO_PROCESSED,
    tenantId: SEED_TENANT_ID,
    name: 'gen-consultation-recording.processed.wav',
    uri: `s3://hope-audio/${SEED_TENANT_ID}/2025/12/gen-consultation-recording.processed.wav`,
    extension: 'wav',
    mimeType: 'audio/wav',
    size: 5120000,
    hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    createdBy: SEED_USER_IDS.DOCTOR,
  },
];

// =============================================================================
// AUDIO RECORDINGS (4)
// =============================================================================

interface AudioRecordingSeed {
  id: string;
  tenantId: string;
  contextItemId: string;
  mediaId: string;
  // Dual capture — optional raw/processed media references.
  rawMediaId?: string;
  processedMediaId?: string;
  duration: number | null;
  format: string;
  sampleRate: number;
  channels: number;
  bitrate: number;
  language: string;
  sequenceNumber: number;
  recordedAt: Date;
}

export const DEFAULT_AUDIO_RECORDINGS: AudioRecordingSeed[] = [
  {
    // Dual-capture demo: real primary media + raw and
    // processed media ids so the playground's "Dual capture" badge renders.
    id: SEED_AUDIO_RECORDING_IDS.GEN_AUDIO,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_AUDIO,
    mediaId: SEED_MEDIA_IDS.GEN_AUDIO_PRIMARY,
    rawMediaId: SEED_MEDIA_IDS.GEN_AUDIO_RAW,
    processedMediaId: SEED_MEDIA_IDS.GEN_AUDIO_PROCESSED,
    duration: 185000,
    format: 'webm',
    sampleRate: 48000,
    channels: 1,
    bitrate: 128000,
    language: 'en',
    sequenceNumber: 1,
    recordedAt: new Date('2025-12-15T10:30:00Z'),
  },
  {
    id: SEED_AUDIO_RECORDING_IDS.SURG_AUDIO,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.SURG_AUDIO,
    mediaId: 'seed-media-placeholder-002',
    duration: 240000,
    format: 'webm',
    sampleRate: 48000,
    channels: 1,
    bitrate: 128000,
    language: 'en',
    sequenceNumber: 1,
    recordedAt: new Date('2026-01-10T09:15:00Z'),
  },
  {
    id: SEED_AUDIO_RECORDING_IDS.PEDS_AUDIO,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.PEDS_AUDIO,
    mediaId: 'seed-media-placeholder-003',
    duration: 150000,
    format: 'webm',
    sampleRate: 48000,
    channels: 1,
    bitrate: 128000,
    language: 'en',
    sequenceNumber: 1,
    recordedAt: new Date('2026-02-10T14:00:00Z'),
  },
  {
    id: SEED_AUDIO_RECORDING_IDS.ER_AUDIO,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.ER_AUDIO,
    mediaId: 'seed-media-placeholder-004',
    duration: null, // still recording
    format: 'webm',
    sampleRate: 48000,
    channels: 1,
    bitrate: 128000,
    language: 'en',
    sequenceNumber: 1,
    recordedAt: new Date('2026-02-23T22:15:00Z'),
  },
];

// =============================================================================
// CONTEXT ITEM VERSIONS — content-at-version semantics
//
// Each version record stores the content AS IT WAS at that version number.
// v1 = initial creation, v2+ = subsequent edits.
// This matches the service-layer behavior in ContextService.updateContext().
// =============================================================================

const DEFAULT_CONTEXT_VERSIONS = [
  // --- GEN_COMPLETED: raw summary (2 versions — AI initial + doctor correction) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.GEN_SUMMARY_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_RAW_SUMMARY,
    versionNumber: 1,
    content: GEN_SUMMARY_V1,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial SOAP-format summary generated from consultation transcript',
    changedBy: SYSTEM_USER_ID,
    changeSource: 'ai_model_v2',
  },
  {
    id: SEED_CONTEXT_VERSION_IDS.GEN_SUMMARY_V2,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_RAW_SUMMARY,
    versionNumber: 2,
    content: GEN_SUMMARY_V2,
    contentDiff: JSON.stringify({
      Plan: {
        old: 'Amoxicillin 500 mg PO TID × 7 days',
        new: 'Amoxicillin 500 mg PO TID × 7 days (corrected from 250 mg)',
      },
      Assessment: {
        old: 'possible early community-acquired pneumonia.',
        new: 'possible early community-acquired pneumonia (ICD-10: J18.9).',
      },
    }),
    changeReason: 'user_edit',
    changeSummary: 'Doctor corrected amoxicillin dosage from 250mg to 500mg and added ICD-10 code J18.9',
    changedBy: SEED_USER_IDS.DOCTOR,
    changeSource: 'manual',
  },
  // --- GEN_COMPLETED: modified summary (1 version — initial user edit) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.GEN_MODIFIED_SUMMARY_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_MODIFIED_SUMMARY,
    versionNumber: 1,
    content: GEN_SUMMARY_V2,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version — doctor-approved summary with corrections applied',
    changedBy: SEED_USER_IDS.DOCTOR,
    changeSource: 'manual',
  },
  // --- GEN_COMPLETED: transcript (1 version — initial transcription) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.GEN_TRANSCRIPT_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_TRANSCRIPT,
    versionNumber: 1,
    content: GEN_TRANSCRIPT_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SYSTEM_USER_ID,
    changeSource: 'system',
  },
  // --- GEN_COMPLETED: case note (1 version — initial) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.GEN_CASE_NOTE_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_CASE_NOTE,
    versionNumber: 1,
    content: 'Patient Alice, 45F. Known history: seasonal allergies. No chronic conditions. Non-smoker. Family hx: father had COPD.',
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SEED_USER_IDS.DOCTOR,
    changeSource: 'system',
  },
  // --- GEN_COMPLETED: pre-summary (1 version — initial AI) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.GEN_PRE_SUMMARY_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_PRE_SUMMARY,
    versionNumber: 1,
    content: GEN_PRE_SUMMARY_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SYSTEM_USER_ID,
    changeSource: 'system',
  },
  // --- CARD_NEW: worknote (2 versions — initial + addendum after stress ECG) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.CARD_WORKNOTE_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.CARD_WORKNOTE,
    versionNumber: 1,
    content: CARD_WORKNOTE_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SEED_USER_IDS.DOCTOR2,
    changeSource: 'system',
  },
  {
    id: SEED_CONTEXT_VERSION_IDS.CARD_WORKNOTE_V2,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.CARD_WORKNOTE,
    versionNumber: 2,
    content: CARD_WORKNOTE_V2_CONTENT,
    contentDiff: JSON.stringify({
      Plan: {
        old: 'F/U after stress test.',
        new: 'F/U after stress test.\nADDENDUM (2026-01-22): Stress ECG completed — no inducible ischemia.',
      },
    }),
    changeReason: 'user_edit',
    changeSummary: 'Added stress ECG results addendum — no inducible ischemia, chest tightness likely musculoskeletal',
    changedBy: SEED_USER_IDS.DOCTOR2,
    changeSource: 'manual',
  },
  // --- CARD_NEW: transcript (1 version — initial) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.CARD_TRANSCRIPT_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.CARD_TRANSCRIPT,
    versionNumber: 1,
    content: CARD_TRANSCRIPT_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SYSTEM_USER_ID,
    changeSource: 'system',
  },
  // --- CARD_NEW: pre-summary (1 version — initial AI) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.CARD_PRE_SUMMARY_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.CARD_PRE_SUMMARY,
    versionNumber: 1,
    content: CARD_PRE_SUMMARY_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SYSTEM_USER_ID,
    changeSource: 'system',
  },
  // --- SURG_NEW: case note (2 versions — initial + post-op addendum) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.SURG_CASE_NOTE_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.SURG_CASE_NOTE,
    versionNumber: 1,
    content: SURG_CASE_NOTE_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SEED_USER_IDS.DOCTOR_SURGERY,
    changeSource: 'system',
  },
  {
    id: SEED_CONTEXT_VERSION_IDS.SURG_CASE_NOTE_V2,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.SURG_CASE_NOTE,
    versionNumber: 2,
    content: SURG_CASE_NOTE_V2_CONTENT,
    contentDiff: JSON.stringify({
      CT_Result: {
        old: 'CT abdomen ordered.',
        new: 'CT abdomen: confirmed appendicitis with periappendiceal fat stranding, no abscess.',
      },
      Post_Op: {
        old: null,
        new: 'POST-OP NOTE: Laparoscopic appendectomy completed successfully.',
      },
    }),
    changeReason: 'user_edit',
    changeSummary: 'Added CT results and post-operative note after successful laparoscopic appendectomy',
    changedBy: SEED_USER_IDS.DOCTOR_SURGERY,
    changeSource: 'manual',
  },
  // --- SURG_NEW: transcript (1 version — initial) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.SURG_TRANSCRIPT_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.SURG_TRANSCRIPT,
    versionNumber: 1,
    content: SURG_TRANSCRIPT_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SYSTEM_USER_ID,
    changeSource: 'system',
  },
  // --- PEDS_COMPLETED: raw summary (1 version — initial AI) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.PEDS_SUMMARY_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.PEDS_RAW_SUMMARY,
    versionNumber: 1,
    content: PEDS_SUMMARY_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SYSTEM_USER_ID,
    changeSource: 'system',
  },
  // --- PEDS_COMPLETED: transcript (1 version — initial) ---
  {
    id: SEED_CONTEXT_VERSION_IDS.PEDS_TRANSCRIPT_V1,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.PEDS_TRANSCRIPT,
    versionNumber: 1,
    content: PEDS_TRANSCRIPT_CONTENT,
    contentDiff: null,
    changeReason: 'initial_creation',
    changeSummary: 'Initial version',
    changedBy: SYSTEM_USER_ID,
    changeSource: 'system',
  },
];

// =============================================================================
// NAMED ENTITIES (8) — NER results
// =============================================================================

const DEFAULT_NAMED_ENTITIES = [
  // GEN_COMPLETED entities (5)
  {
    id: SEED_NAMED_ENTITY_IDS.GEN_MED_AMOXICILLIN,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_TRANSCRIPT,
    text: 'amoxicillin 500mg',
    className: 'MEDICATION',
    normalizedText: 'Amoxicillin',
    startOffset: 1042,
    endOffset: 1059,
    confidence: 0.97,
    aiModelId: 'biomedical-ner-v1',
    aiModelVersion: '2025-06-01',
    processingTimeMs: 120,
    metadata: { rxnorm: '723', atcCode: 'J01CA04', route: 'oral', frequency: 'TID', duration: '7 days' },
  },
  {
    id: SEED_NAMED_ENTITY_IDS.GEN_MED_PARACETAMOL,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_TRANSCRIPT,
    text: 'paracetamol',
    className: 'MEDICATION',
    normalizedText: 'Paracetamol (Acetaminophen)',
    startOffset: 1115,
    endOffset: 1126,
    confidence: 0.95,
    aiModelId: 'biomedical-ner-v1',
    aiModelVersion: '2025-06-01',
    processingTimeMs: 80,
    metadata: { rxnorm: '161', atcCode: 'N02BE01', route: 'oral', frequency: 'PRN' },
  },
  {
    id: SEED_NAMED_ENTITY_IDS.GEN_COND_PNEUMONIA,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_TRANSCRIPT,
    text: 'early pneumonia',
    className: 'CONDITION',
    normalizedText: 'Community-acquired pneumonia',
    startOffset: 945,
    endOffset: 960,
    confidence: 0.88,
    aiModelId: 'biomedical-ner-v1',
    aiModelVersion: '2025-06-01',
    processingTimeMs: 95,
    metadata: { icd10: 'J18.9', snomed: '385093006', severity: 'mild' },
  },
  {
    id: SEED_NAMED_ENTITY_IDS.GEN_PROC_CHEST_XRAY,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_TRANSCRIPT,
    text: 'chest X-ray',
    className: 'PROCEDURE',
    normalizedText: 'Chest radiograph',
    startOffset: 990,
    endOffset: 1001,
    confidence: 0.99,
    aiModelId: 'biomedical-ner-v1',
    aiModelVersion: '2025-06-01',
    processingTimeMs: 60,
    metadata: { cpt: '71046', loinc: '30746-2' },
  },
  {
    id: SEED_NAMED_ENTITY_IDS.GEN_ANAT_RIGHT_LOWER_LOBE,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_TRANSCRIPT,
    text: 'right lower lobe',
    className: 'ANATOMY',
    normalizedText: 'Right lower lobe of lung',
    startOffset: 780,
    endOffset: 796,
    confidence: 0.96,
    aiModelId: 'biomedical-ner-v1',
    aiModelVersion: '2025-06-01',
    processingTimeMs: 55,
    metadata: { snomed: '266005' },
  },
  // PEDS_COMPLETED entities (3)
  {
    id: SEED_NAMED_ENTITY_IDS.PEDS_MED_AMOXICILLIN,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.PEDS_TRANSCRIPT,
    text: 'amoxicillin 45 mg/kg/day',
    className: 'MEDICATION',
    normalizedText: 'Amoxicillin',
    startOffset: 680,
    endOffset: 703,
    confidence: 0.96,
    aiModelId: 'biomedical-ner-v1',
    aiModelVersion: '2025-06-01',
    processingTimeMs: 110,
    metadata: { rxnorm: '723', atcCode: 'J01CA04', route: 'oral', frequency: 'BID', duration: '10 days', weightBased: true },
  },
  {
    id: SEED_NAMED_ENTITY_IDS.PEDS_COND_OTITIS_MEDIA,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.PEDS_TRANSCRIPT,
    text: 'acute otitis media',
    className: 'CONDITION',
    normalizedText: 'Acute otitis media',
    startOffset: 640,
    endOffset: 658,
    confidence: 0.94,
    aiModelId: 'biomedical-ner-v1',
    aiModelVersion: '2025-06-01',
    processingTimeMs: 85,
    metadata: { icd10: 'H66.91', snomed: '3135009' },
  },
  {
    id: SEED_NAMED_ENTITY_IDS.PEDS_ANAT_TYMPANIC_MEMBRANE,
    tenantId: SEED_TENANT_ID,
    contextItemId: SEED_CONTEXT_ITEM_IDS.PEDS_TRANSCRIPT,
    text: 'right tympanic membrane',
    className: 'ANATOMY',
    normalizedText: 'Tympanic membrane of right ear',
    startOffset: 420,
    endOffset: 443,
    confidence: 0.98,
    aiModelId: 'biomedical-ner-v1',
    aiModelVersion: '2025-06-01',
    processingTimeMs: 50,
    metadata: { snomed: '726682005' },
  },
];

// =============================================================================
// SEED FUNCTION
// =============================================================================

// =============================================================================
// TRANSCRIPTION JOBS
//
// ASR job-queue rows across the full status lifecycle (QUEUED / PROCESSING /
// COMPLETED / FAILED) for the Global tenant + one customer tenant (ArcaAI) so
// the admin job views and EU analytics are populated for more than one tenant.
//
// FK/coherence rules honoured:
//   - `agentVersionId` (TASK-861) is the ASR Agent VERSION that ran the job
//     (`Agent.id` — rows are versions; deliberately NO FK, the job stays
//     readable history after the agent is archived). Each job names the agent
//     the tenant's cascade resolves: the Global playground runs its OWN
//     `example-transcription`; ArcaAI seeds no agents and inherits the SYSTEM
//     `platform-transcription` through the TENANT-scope assignment. Both ids
//     are deterministic (`25-agents.ts`), so seed ORDER does not matter.
//     `pipelineId` is deprecated and NEVER written: `06-stt.ts` seeds no
//     `AsrPipeline` rows any more, and the column's FK would refuse a dangling
//     pointer.
//   - `consultationId` / `contextItemId` / `mediaId` are soft references (no
//     DB FK); each points at a seeded row in the SAME tenant.
//   - `mediaId` is only set where real Media exists (the Global GEN dual-capture
//     recording); other jobs leave it null.
// =============================================================================

const asrAgentVersionId = (specs: ReadonlyArray<{ id: string; slug: string; task: string }>, slug: string): string => {
  const spec = specs.find((candidate) => candidate.slug === slug && candidate.task === 'SPEECH_TO_TEXT');
  if (!spec) throw new Error(`09-consultation: seeded SPEECH_TO_TEXT agent "${slug}" not found in 25-agents.ts`);
  return spec.id;
};
const GLOBAL_ASR_AGENT_VERSION_ID = asrAgentVersionId(GLOBAL_AGENT_SPECS, 'example-transcription');
const PLATFORM_ASR_AGENT_VERSION_ID = asrAgentVersionId(PLATFORM_AGENT_SPECS, 'platform-transcription');

interface TranscriptionJobSeed {
  id: string;
  tenantId: string;
  jobType: TranscriptionJobType;
  status: TranscriptionJobStatus;
  agentVersionId: string;
  consultationId: string | null;
  contextItemId: string | null;
  mediaId: string | null;
  progress: number;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  resultText: string | null;
  resultMetadata: Record<string, unknown> | null;
  errorMessage: string | null;
  errorCode: string | null;
  retryCount: number;
  workerId: string | null;
}

export const DEFAULT_TRANSCRIPTION_JOBS: TranscriptionJobSeed[] = [
  // ── Global tenant — COMPLETED batch (produced the GEN transcript) ──────
  {
    id: SEED_TRANSCRIPTION_JOB_IDS.GEN_COMPLETED,
    tenantId: SEED_TENANT_ID,
    jobType: 'BATCH' as TranscriptionJobType,
    status: 'COMPLETED' as TranscriptionJobStatus,
    agentVersionId: GLOBAL_ASR_AGENT_VERSION_ID,
    consultationId: SEED_CONSULTATION_IDS.GEN_COMPLETED,
    contextItemId: SEED_CONTEXT_ITEM_IDS.GEN_TRANSCRIPT,
    mediaId: SEED_MEDIA_IDS.GEN_AUDIO_PRIMARY,
    progress: 100,
    queuedAt: new Date('2025-12-15T10:30:05Z'),
    startedAt: new Date('2025-12-15T10:30:08Z'),
    completedAt: new Date('2025-12-15T10:33:12Z'),
    resultText:
      'Patient presents with a three-day history of productive cough and low-grade fever. Chest examination reveals scattered crepitations at the right base. Plan: chest X-ray, oral amoxicillin, review in five days.',
    resultMetadata: { confidence: 0.94, language: 'en', durationMs: 185000, wordCount: 38 },
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    workerId: 'asr-worker-01',
  },
  // ── Global tenant — PROCESSING batch (neurology referral) ──────────────
  {
    id: SEED_TRANSCRIPTION_JOB_IDS.NEUR_PROCESSING,
    tenantId: SEED_TENANT_ID,
    jobType: 'BATCH' as TranscriptionJobType,
    status: 'PROCESSING' as TranscriptionJobStatus,
    agentVersionId: GLOBAL_ASR_AGENT_VERSION_ID,
    consultationId: SEED_CONSULTATION_IDS.NEUR_REFERRAL,
    contextItemId: SEED_CONTEXT_ITEM_IDS.NEUR_TRANSCRIPT,
    mediaId: null,
    progress: 45,
    queuedAt: new Date('2026-02-20T09:00:00Z'),
    startedAt: new Date('2026-02-20T09:00:06Z'),
    completedAt: null,
    resultText: null,
    resultMetadata: null,
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    workerId: 'asr-worker-02',
  },
  // ── Global tenant — QUEUED streaming (ER live recording) ───────────────
  {
    id: SEED_TRANSCRIPTION_JOB_IDS.ER_QUEUED,
    tenantId: SEED_TENANT_ID,
    jobType: 'STREAMING' as TranscriptionJobType,
    status: 'QUEUED' as TranscriptionJobStatus,
    agentVersionId: GLOBAL_ASR_AGENT_VERSION_ID,
    consultationId: SEED_CONSULTATION_IDS.ER_RECORDING,
    contextItemId: SEED_CONTEXT_ITEM_IDS.ER_AUDIO,
    mediaId: null,
    progress: 0,
    queuedAt: new Date('2026-02-20T09:15:00Z'),
    startedAt: null,
    completedAt: null,
    resultText: null,
    resultMetadata: null,
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    workerId: null,
  },
  // ── Global tenant — FAILED batch (exhausted retries) ───────────────────
  {
    id: SEED_TRANSCRIPTION_JOB_IDS.CARD_FAILED,
    tenantId: SEED_TENANT_ID,
    jobType: 'BATCH' as TranscriptionJobType,
    status: 'FAILED' as TranscriptionJobStatus,
    agentVersionId: GLOBAL_ASR_AGENT_VERSION_ID,
    consultationId: SEED_CONSULTATION_IDS.CARD_NEW,
    contextItemId: null,
    mediaId: null,
    progress: 20,
    queuedAt: new Date('2026-02-19T14:00:00Z'),
    startedAt: new Date('2026-02-19T14:00:04Z'),
    completedAt: null,
    resultText: null,
    resultMetadata: null,
    errorMessage: 'ASR worker timed out while decoding audio segment 3/7',
    errorCode: 'ASR_DECODE_TIMEOUT',
    retryCount: 3,
    workerId: 'asr-worker-03',
  },
  // ── ArcaAI tenant — COMPLETED batch ────────────────────────────────────
  {
    id: SEED_TRANSCRIPTION_JOB_IDS.ARCAAI_COMPLETED,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    jobType: 'BATCH' as TranscriptionJobType,
    status: 'COMPLETED' as TranscriptionJobStatus,
    agentVersionId: PLATFORM_ASR_AGENT_VERSION_ID,
    consultationId: SEED_CONSULTATION_IDS.ARCAAI_GEN_NEW,
    contextItemId: SEED_CONTEXT_ITEM_IDS.ARCAAI_GEN_NEW_TRANSCRIPT,
    mediaId: null,
    progress: 100,
    queuedAt: new Date('2026-02-21T11:00:02Z'),
    startedAt: new Date('2026-02-21T11:00:05Z'),
    completedAt: new Date('2026-02-21T11:01:40Z'),
    resultText:
      'Patient reports a sore throat and mild fever for three days, with some difficulty swallowing and no cough. Throat examination performed; rapid swab ordered.',
    resultMetadata: { confidence: 0.92, language: 'en', durationMs: 96000, wordCount: 27 },
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    workerId: 'asr-worker-01',
  },
  // ── ArcaAI tenant — QUEUED streaming (revisit) ─────────────────────────
  {
    id: SEED_TRANSCRIPTION_JOB_IDS.ARCAAI_QUEUED,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    jobType: 'STREAMING' as TranscriptionJobType,
    status: 'QUEUED' as TranscriptionJobStatus,
    agentVersionId: PLATFORM_ASR_AGENT_VERSION_ID,
    consultationId: SEED_CONSULTATION_IDS.ARCAAI_GEN_REVISIT,
    contextItemId: null,
    mediaId: null,
    progress: 0,
    queuedAt: new Date('2026-02-28T10:30:00Z'),
    startedAt: null,
    completedAt: null,
    resultText: null,
    resultMetadata: null,
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    workerId: null,
  },
];

export const seedConsultation = async (client: CorePrismaClient) => {
  console.log('Seeding consultations (e2e workflow data)...');

  for (const consultation of [...DEFAULT_CONSULTATIONS, ...CUSTOMER_TENANT_CONSULTATIONS]) {
    await client.consultation.upsert({
      where: { id: consultation.id },
      update: consultation,
      create: consultation,
    });
  }
  console.log(`  Seeded ${DEFAULT_CONSULTATIONS.length} consultations + ${CUSTOMER_TENANT_CONSULTATIONS.length} customer-tenant consultations`);

  for (const item of [...DEFAULT_CONTEXT_ITEMS, ...CUSTOMER_TENANT_CONTEXT_ITEMS]) {
    const data = await encryptSeedRow<Prisma.ContextItemUncheckedCreateInput>('ContextItem', item);
    await client.contextItem.upsert({
      where: { id: item.id },
      update: data,
      create: data,
    });
  }
  console.log(`  Seeded ${DEFAULT_CONTEXT_ITEMS.length} context items + ${CUSTOMER_TENANT_CONTEXT_ITEMS.length} customer-tenant context items`);

  for (const meta of DEFAULT_SUMMARY_METAS) {
    await client.summaryMeta.upsert({
      where: { id: meta.id },
      update: meta,
      create: meta,
    });
  }
  console.log(`  Seeded ${DEFAULT_SUMMARY_METAS.length} summary metas`);

  for (const media of DEFAULT_MEDIA) {
    await client.media.upsert({
      where: { id: media.id },
      update: media,
      create: media,
    });
  }
  console.log(`  Seeded ${DEFAULT_MEDIA.length} media`);

  for (const audio of DEFAULT_AUDIO_RECORDINGS) {
    await client.audioRecording.upsert({
      where: { id: audio.id },
      update: audio,
      create: audio,
    });
  }
  console.log(`  Seeded ${DEFAULT_AUDIO_RECORDINGS.length} audio recordings`);

  for (const version of DEFAULT_CONTEXT_VERSIONS) {
    const data = await encryptSeedRow<Prisma.ContextItemVersionUncheckedCreateInput>('ContextItemVersion', version);
    await client.contextItemVersion.upsert({
      where: {
        contextItemId_versionNumber: {
          contextItemId: version.contextItemId,
          versionNumber: version.versionNumber,
        },
      },
      update: data,
      create: data,
    });
  }
  console.log(`  Seeded ${DEFAULT_CONTEXT_VERSIONS.length} context item versions`);

  for (const entity of DEFAULT_NAMED_ENTITIES) {
    const data = await encryptSeedRow<Prisma.NamedEntityUncheckedCreateInput>('NamedEntity', entity);
    await client.namedEntity.upsert({
      where: { id: entity.id },
      update: data,
      create: data,
    });
  }
  console.log(`  Seeded ${DEFAULT_NAMED_ENTITIES.length} named entities`);

  // Transcription jobs are keyed to their ASR Agent version (no FK — TASK-861)
  // and reference seeded consultations.
  for (const job of DEFAULT_TRANSCRIPTION_JOBS) {
    const data = {
      id: job.id,
      tenantId: job.tenantId,
      jobType: job.jobType,
      status: job.status,
      agentVersionId: job.agentVersionId,
      consultationId: job.consultationId,
      contextItemId: job.contextItemId,
      mediaId: job.mediaId,
      progress: job.progress,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      resultText: job.resultText,
      errorMessage: job.errorMessage,
      errorCode: job.errorCode,
      retryCount: job.retryCount,
      workerId: job.workerId,
      ...(job.resultMetadata != null ? { resultMetadata: job.resultMetadata as Prisma.InputJsonValue } : {}),
    };
    const encrypted = await encryptSeedRow<Prisma.TranscriptionJobUncheckedCreateInput>('TranscriptionJob', data);
    await client.transcriptionJob.upsert({
      where: { id: job.id },
      update: encrypted,
      create: encrypted,
    });
  }
  console.log(`  Seeded ${DEFAULT_TRANSCRIPTION_JOBS.length} transcription jobs`);

  console.log('Consultation seeding completed');
};
