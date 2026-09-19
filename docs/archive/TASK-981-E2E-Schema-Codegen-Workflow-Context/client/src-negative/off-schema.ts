/**
 * TASK-981 B3 (negative) — a payload the TENANT's schema does not admit must not compile.
 * `referral` is a platform visit-type ALIAS, but ArcaAI declared `visit_type` as an enum of two
 * keys; the generated type carries exactly that vocabulary.
 */
import type { ConsultationContextKindMap } from '../generated/consultation-context-schema.generated';

export const badEncounter: ConsultationContextKindMap['encounter'] = {
  doctor_id: 'DR-X',
  event_id: 'EVT-X',
  department_code: 'GEN',
  visit_type: 'referral',
};

export const badVitals: ConsultationContextKindMap['vitals'] = {
  bloodPressure: '128/82',
  heartRate: 'eighty-eight',
};

export const missingRequired: ConsultationContextKindMap['encounter'] = {
  doctor_id: 'DR-X',
  event_id: 'EVT-X',
  visit_type: 'new-visit',
};
