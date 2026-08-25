import type { ListConsentGrantsParams } from './types';

export const consentKeys = {
  root: ['consent-grants'] as const,
  list: (params: ListConsentGrantsParams) => [...consentKeys.root, 'list', params] as const,
  /** Every grant for one patient — the point-of-care read in the consultation workspace. */
  byPatient: (externalPatientId: string) => [...consentKeys.root, 'by-patient', externalPatientId] as const,
};
