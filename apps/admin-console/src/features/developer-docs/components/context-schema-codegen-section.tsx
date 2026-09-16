'use client';

/**
 * Context schema & codegen — the part of the developer portal a client
 * integrator needs and the portal did not have: how to turn a tenant's context
 * schema into types, what `open()` can refuse with, and which scopes a key needs
 * to read the catalogue.
 *
 * Both tables are RENDERED FROM `@arcaai/types`. The refusal codes are
 * `OPEN_REFUSAL_CODES`, the same union the gateway answers with and both SDKs
 * export; the presets are `API_KEY_SCOPE_PRESETS`, the same three the create-key
 * dialog offers and the seed derives its day-one scopes from. A hand-typed copy
 * of either would drift the day a code is added — and documentation that is
 * wrong about a refusal code is worse than documentation that is absent, because
 * an integrator will branch on it.
 *
 * It is a SECTION on the existing `/developer` page, not a new nav entry: it is
 * read once while wiring a client up, alongside the credential classes and the
 * error contract it depends on.
 */

import { API_KEY_SCOPE_PRESETS, OPEN_REFUSAL_CODES, type OpenRefusalCode } from '@arcaai/types';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { CodeBlock } from './code-block';

const API_KEY_COMMAND = `# With an API key — the tenant's published agents and workflows
npx @arcaai/vox-codegen --api-key "$HOPE_API_KEY" --agents --workflows \\
  --out src/hope.generated.ts`;

const SERVICE_ACCOUNT_COMMAND = `# With a service account — the tenant's consultation context schema
npx @arcaai/vox-codegen --tenant "$HOPE_TENANT_ID" \\
  --client-id "$HOPE_SVC_CLIENT_ID" --client-secret "$HOPE_SVC_CLIENT_SECRET" \\
  --out src/hope.context.ts`;

const CI_COMMAND = `# CI: fail the build when the checked-in types no longer match the tenant's schema
npx @arcaai/vox-codegen --tenant "$HOPE_TENANT_ID" --out src/hope.context.ts --check`;

const GENERATED_EXAMPLE = `/** @schemaVersion 4 */
export type OpenConsultationContext = {
  encounter: { consultant_id: string; department_code: string; visit_type: 'new-visit' | 'revisit' };
  vitals?: { bp?: string; pulse?: number };
};

/** @contextSchema general_medicine v4 (follows latest) */
export type Workflow_CardiologyIntake_Input = { /* … */ };

await hope.consultations.open<OpenConsultationContext>({
  patientId,
  clinicianUserId,
  context: { encounter: { consultant_id: 'C-1042', department_code: 'CARD', visit_type: 'new-visit' } },
});`;

/** What each refusal means to the integrator who has to act on it. */
const REFUSAL_MEANING: Record<OpenRefusalCode, string> = {
  CONTEXT_SCHEMA_VIOLATION: 'The context payload does not match the tenant’s pinned schema. `problems[]` names each offending path.',
  DEPARTMENT_UNKNOWN: 'The department field resolved to no department in this tenant.',
  DEPARTMENT_AMBIGUOUS: 'The department field matched more than one department — resolve by code rather than name.',
  DEPARTMENT_MISMATCH: 'The department named in the context is not the one the caller may open for.',
  VISIT_TYPE_INVALID: 'The visit-type field carried a value outside the tenant’s catalogue.',
  CLINICIAN_REQUIRED: 'A machine caller must name `clinicianUserId`; HOPE never records the credential as the clinician.',
  CLINICIAN_MISMATCH: 'The named clinician disagrees with the one the context’s identity field resolved to.',
  CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER: 'A human caller named a clinician other than themselves without the role to do so.',
  USER_IDENTITY_UNKNOWN: 'The identity field held a staff id this tenant does not know and could not provision.',
  USER_IDENTITY_AMBIGUOUS: 'The identity field matched more than one user.',
  USER_IDENTITY_INVALID: 'The identity field was present but not a usable staff identifier.',
  USER_IDENTITY_NOT_USABLE: 'The resolved user cannot act as a clinician in this tenant.',
  USER_IDENTITY_DEPARTMENT_UNRESOLVED: 'The clinician resolved, but no department could be derived for them.',
  WORKFLOW_CONTEXT_INCOMPATIBLE:
    'The governing workflow froze an older schema version and would refuse this payload. Republish the workflow, or send what the frozen version declares.',
};

export function ContextSchemaCodegenSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Context schema &amp; codegen</CardTitle>
        <CardDescription>
          A tenant declares what a consultation may carry; your build turns that declaration into types, and{' '}
          <code className="font-mono text-xs">open()</code> refuses precisely when a payload does not match.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Generate types — one command per credential</h2>
          <p className="text-muted-foreground text-sm">
            An API key types what the tenant PUBLISHES (agents and workflows); a service account additionally types the tenant&apos;s consultation
            context schema. Pass the secret through the environment, never on the command line — argv is visible in{' '}
            <code className="font-mono text-xs">ps</code>.
          </p>
          <CodeBlock label="Codegen with an API key" code={API_KEY_COMMAND} />
          <CodeBlock label="Codegen with a service account" code={SERVICE_ACCOUNT_COMMAND} />
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Keep the checked-in types honest</h2>
          <p className="text-muted-foreground text-sm">
            <code className="font-mono text-xs">--check</code> regenerates and diffs instead of writing: it exits 1 with a unified diff when the
            tenant has published a version your repository has not caught up with. Drift is then a red build, not a runtime refusal.
          </p>
          <CodeBlock label="Codegen drift check in CI" code={CI_COMMAND} />
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">What you get, and how to read it</h2>
          <p className="text-muted-foreground text-sm">
            <code className="font-mono text-xs">OpenConsultationContext</code> types the <code className="font-mono text-xs">context</code> argument
            at the <code className="font-mono text-xs">open()</code> call site. Each workflow carries a{' '}
            <code className="font-mono text-xs">@contextSchema</code> tag naming the schema version it was frozen from, and whether it follows the
            tenant&apos;s pin or is fixed to one version.
          </p>
          <CodeBlock label="Generated types in use" code={GENERATED_EXAMPLE} />
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Key presets</h2>
          <p className="text-muted-foreground text-sm">
            The purpose cards on the API keys screen grant exactly these scopes. Codegen needs the catalogue scopes; a clinic app needs the
            consultation plane.
          </p>
          <dl className="flex flex-col gap-3">
            {API_KEY_SCOPE_PRESETS.map((preset) => (
              <div key={preset.key} className="flex flex-col gap-1 rounded-md border p-3">
                <dt className="text-sm font-medium">{preset.label}</dt>
                <dd className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-sm">{preset.description}</span>
                  <span className="flex flex-wrap gap-1">
                    {preset.scopes.map((scope) => (
                      <Badge key={scope} variant="outline" className="font-mono text-xs font-normal">
                        {scope}
                      </Badge>
                    ))}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Refusal codes on open</h2>
          <p className="text-muted-foreground text-sm">
            Each carries <code className="font-mono text-xs">{'{ message, code, problems? }'}</code>. Most are a{' '}
            <Badge variant="outline" className="font-mono">
              400
            </Badge>
            ; an unknown department or staff id is a{' '}
            <Badge variant="outline" className="font-mono">
              404
            </Badge>{' '}
            and an ambiguous staff id a{' '}
            <Badge variant="outline" className="font-mono">
              409
            </Badge>
            . Branch on <code className="font-mono text-xs">code</code>; show <code className="font-mono text-xs">problems[]</code> to whoever can fix
            the payload.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Code
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    What it means
                  </th>
                </tr>
              </thead>
              <tbody>
                {OPEN_REFUSAL_CODES.map((code) => (
                  <tr key={code} className="border-b align-top last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-mono text-xs font-normal">
                      {code}
                    </th>
                    <td className="py-2">{REFUSAL_MEANING[code]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Guides</h2>
          <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
            <li>
              <span className="font-mono text-xs">docs/guides/client-integration-guide.md</span> — credentials, codegen, open, stream, review gate,
              approve, close.
            </li>
            <li>
              <span className="font-mono text-xs">docs/guides/tenant-admin-user-guide.md</span> — the console side: departments, clinicians, the
              schema, publishing it, and what each refusal means to your integrator.
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
