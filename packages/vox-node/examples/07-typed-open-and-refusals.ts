/**
 * 07-typed-open-and-refusals.ts
 *
 * Shows: opening a consultation with a TYPED context payload, and branching on
 * every way the gateway can refuse it.
 *
 * The type parameter here would normally be the `OpenConsultationContext` that
 * `vox-codegen --tenant` writes for your tenant. This file declares an
 * equivalent shape by hand so it compiles in this repository with no generated
 * file present — the only difference is that the generated one is regenerated
 * (and `--check`ed in CI) whenever the tenant publishes a new schema version.
 *
 * Env vars needed:
 *   HOPE_API_URL              e.g. http://localhost:8868
 *   HOPE_SVC_CLIENT_ID        a service-account client id
 *   HOPE_SVC_CLIENT_SECRET    its secret
 *   HOPE_PATIENT_ID           the tenant's own patient identifier
 *   HOPE_DOCTOR_STAFF_ID      the clinician's staff id, as your roster spells it
 *   HOPE_DEPARTMENT_CODE      e.g. GEN
 *
 * Run: npx tsx examples/07-typed-open-and-refusals.ts
 */

import { HopeClient, HopeAPIError, OPEN_REFUSAL_CODES, type OpenRefusalCode } from '@arcaai/vox-node';

/** Stand-in for the generated `OpenConsultationContext`. */
interface OpenConsultationContext extends Record<string, unknown> {
  encounter?: {
    event_id: string;
    doctor_id: string;
    department_code: string;
    visit_type: string;
    chief_complaint?: string;
  };
  vitals?: { bloodPressure?: string; heartRate?: number; temperature?: number };
  previous_case_notes?: { notes: { text: string; writtenAt?: string }[] };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/** `true` when this error is one of the documented `open` refusals. */
function refusalCodeOf(error: unknown): OpenRefusalCode | null {
  if (!(error instanceof HopeAPIError)) return null;
  const code = error.code as OpenRefusalCode | undefined;
  return code && (OPEN_REFUSAL_CODES as readonly string[]).includes(code) ? code : null;
}

async function main(): Promise<void> {
  const hope = new HopeClient({
    baseUrl: requireEnv('HOPE_API_URL'),
    serviceAccount: { clientId: requireEnv('HOPE_SVC_CLIENT_ID'), clientSecret: requireEnv('HOPE_SVC_CLIENT_SECRET') },
  });

  try {
    // Every marked field is MAPPED, not merely validated: the staff id resolves (or provisions)
    // the clinician recorded as the consultation's doctor, the department code selects the
    // department — and with it the governing workflow and the note's shape — and the visit type
    // outranks any parent-consultation link.
    const consultation = await hope.consultations.open<OpenConsultationContext>({
      patientId: requireEnv('HOPE_PATIENT_ID'),
      context: {
        encounter: {
          event_id: `EVT-${Date.now()}`,
          doctor_id: requireEnv('HOPE_DOCTOR_STAFF_ID'),
          department_code: requireEnv('HOPE_DEPARTMENT_CODE'),
          visit_type: 'new-visit',
          chief_complaint: 'Dry cough for three days.',
        },
        vitals: { bloodPressure: '128/82', heartRate: 88 },
      },
    });

    console.log(`opened ${consultation.id} — governed by ${consultation.governingRun?.workflowDefinitionSlug ?? 'nothing'}`);
    return;
  } catch (error) {
    const code = refusalCodeOf(error);
    if (code === null) throw error;

    // `problems[]` is the list of unmet requirements, one human-readable string each. Show it to
    // whoever can fix the payload; branch on `code`, never on the message.
    const problems = error instanceof HopeAPIError ? (error.problems ?? []) : [];
    switch (code) {
      case 'CONTEXT_SCHEMA_VIOLATION':
        console.error('the context does not match the tenant’s pinned schema:');
        for (const problem of problems) console.error(`  - ${problem}`);
        break;
      case 'WORKFLOW_CONTEXT_INCOMPATIBLE':
        // The tenant's schema accepts this payload but the governing workflow froze an older
        // version of it. Nothing was written: the consultation does not exist.
        console.error('the governing workflow would refuse this context — it is pinned to an older schema version:');
        for (const problem of problems) console.error(`  - ${problem}`);
        break;
      case 'CLINICIAN_REQUIRED':
        console.error('a machine caller must name the clinician, by `clinicianUserId` or the schema’s identity field');
        break;
      default:
        console.error(`open refused: ${code}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
