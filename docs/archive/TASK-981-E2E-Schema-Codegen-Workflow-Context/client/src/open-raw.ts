/**
 * TASK-981 C4/S3 — open with an ARBITRARY context object (read from CONTEXT_JSON) so the
 * gateway's own refusals can be observed. Deliberately untyped: this is the request the typed
 * client cannot even build.
 */
import { HopeClient } from '@arcaai/vox-node';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};

const hope = new HopeClient({
  baseUrl: env('HOPE_BASE_URL', 'http://localhost:8868'),
  serviceAccount: { clientId: env('HOPE_SVC_CLIENT_ID'), clientSecret: env('HOPE_SVC_CLIENT_SECRET') },
});

async function main(): Promise<void> {
  const context = JSON.parse(env('CONTEXT_JSON')) as Record<string, unknown>;
  const body: Record<string, unknown> = { patientId: env('PATIENT_ID'), language: 'en', context };
  if (process.env.DEPARTMENT_ID) body.departmentId = process.env.DEPARTMENT_ID;
  try {
    const opened = await hope.consultations.open(body as never);
    console.log(JSON.stringify({ ok: true, status: 201, id: opened.id, departmentId: opened.departmentId, doctorId: opened.doctorId, metadata: opened.metadata }));
  } catch (err) {
    const e = err as { status?: number; statusCode?: number; code?: string; body?: unknown; message?: string; details?: unknown };
    console.log(JSON.stringify({ ok: false, status: e.status ?? e.statusCode, code: e.code, message: e.message, body: e.body ?? e.details }));
  }
}

void main();
