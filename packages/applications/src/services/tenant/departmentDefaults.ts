/**
 * Default department template applied to newly provisioned tenants
 * (TASK-331 r2605 Finding #4).
 *
 * A console-created tenant must own at least one ENABLED department so its
 * first admin can satisfy the TASK-305 Phase F login invariant (an ENABLED
 * role AND an ENABLED department in the tenant). `TenantService.create`
 * clones this General Practice (`GEN`) template into every new tenant.
 *
 * Mirrors the shape of the seed's `CUSTOMER_TENANT_GEN_DEPARTMENTS`. Prompt
 * IDs are null because they reference Global-tenant prompt templates. Declared
 * here (NOT imported from `@arcaai/database`) so the applications layer never
 * takes a dependency on the database package.
 */
export const DEFAULT_GEN_DEPARTMENT = {
  code: 'GEN',
  name: 'General Practice',
  description: 'General medical consultations and primary care',
  defaultSummaryTemplate: 'SOAP',
  preSummaryPromptId: null,
  newPatientPromptId: null,
  revisitPromptId: null,
  promptConfig: {
    contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
    preferredSections: ['Chief Complaint', 'HPI', 'Assessment', 'Plan'],
    abbreviationDensity: 'low',
  },
} as const;
