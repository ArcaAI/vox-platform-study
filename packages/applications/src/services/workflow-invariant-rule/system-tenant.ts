/**
 * The reserved SYSTEM tenant — the platform-configuration TIER (rule 00). Named once here so the
 * ownership gate and the DTO mapper share one literal rather than re-typing the uuid.
 *
 * Deliberately NOT re-exported from this folder's `index.ts`: `services/serviceAccount` already
 * exports a `SYSTEM_TENANT_ID` through the services barrel, and a second one would make the
 * barrel ambiguous (TS2308). Module-local by design.
 */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
