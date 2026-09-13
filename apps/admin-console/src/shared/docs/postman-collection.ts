/**
 * TASK-971 lane D — a Postman Collection v2.1 for ONE published agent or workflow.
 *
 * ## Why generated rather than shipped
 *
 * The repository carries no Postman artifact of any kind, and a static one could not carry the
 * thing that makes this useful: the body derived from THIS lineage's own input schema. A
 * hand-maintained collection would also be a fourth place the flat-vs-enveloped rule could rot.
 *
 * ## What must never appear in the output
 *
 * A credential. `apiKey` ships as an EMPTY collection variable the importer fills in their own
 * Postman environment. The console knows the operator's session, never a tenant API key, and a
 * downloadable file is exactly the artifact that ends up in a chat thread or a ticket.
 *
 * ## Contract note (TASK-971 §3, lane boundary)
 *
 * The signature and the envelope below are the ORCHESTRATOR-OWNED contract that lane C renders
 * against. Lane D owns the body: the workflow follow-up requests (status, stream-ticket), the
 * `runId` capture script, and the conformance tests.
 */

import type { SdkSnippetAgentTask } from './sdk-snippets';

/** Structural shape of the emitted document — enough to type the builder, not a full v2.1 model. */
export interface PostmanCollection {
  info: { name: string; description?: string; schema: string };
  variable: Array<{ key: string; value: string; type?: string }>;
  auth: Record<string, unknown>;
  item: PostmanItem[];
}

export interface PostmanItem {
  name: string;
  request: {
    method: string;
    header: Array<{ key: string; value: string }>;
    url: { raw: string; host: string[]; path: string[]; query?: Array<{ key: string; value: string }> };
    body?: { mode: 'raw'; raw: string; options?: { raw: { language: 'json' } } };
    description?: string;
  };
  /** Postman test/pre-request scripts — how `runId` is captured for the follow-up requests. */
  event?: Array<{ listen: 'test' | 'prerequest'; script: { type: 'text/javascript'; exec: string[] } }>;
}

export interface PostmanCollectionInput {
  kind: 'agent' | 'workflow';
  slug: string;
  /** Agent only. NER shares TEXT_GENERATION's route, so it arrives already mapped. */
  task?: SdkSnippetAgentTask;
  /** Workflow only — the admitted `?mode=` values, `socket` already removed by the caller. */
  modes?: string[];
  /** Derived from the lineage's own input schema; `null` when no usable schema exists. */
  exampleBody: Record<string, unknown> | null;
  /** Gateway ORIGIN only, no `/api/v1` suffix — e.g. `https://api.example.com`. */
  baseUrl: string;
}

export const POSTMAN_SCHEMA_URL = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/**
 * The collection-level auth every request inherits. An API key is the credential a tenant admin
 * has just minted on `/api-keys`, and the only one of the three classes that is theirs to hand to
 * a developer — a JWT is a user session and a service-account token is exchanged, not issued.
 */
export function apiKeyAuth(): Record<string, unknown> {
  return {
    type: 'apikey',
    apikey: [
      { key: 'key', value: 'X-API-Key' },
      { key: 'value', value: '{{apiKey}}' },
      { key: 'in', value: 'header' },
    ],
  };
}

/**
 * Build the collection.
 *
 * TODO(TASK-971 lane D): the returned document is the ENVELOPE only — a single invoke request.
 * Lane D adds, for `kind: 'workflow'`, the `GET runs/{{runId}}` and
 * `POST runs/{{runId}}/stream-ticket` follow-ups plus the test script that captures `runId` from
 * the 202, and the per-task agent routes (`/speech`, `/transcriptions`).
 */
export function buildPostmanCollection(input: PostmanCollectionInput): PostmanCollection {
  const { kind, slug, exampleBody, baseUrl } = input;
  const path =
    kind === 'agent' ? ['api', 'v1', 'agents', slug, 'invocations'] : ['api', 'v1', 'workflows', slug, 'runs'];

  return {
    info: {
      name: `HOPE — ${slug}`,
      description: `Calls the active published version of ${slug}. Set the \`apiKey\` variable to a key minted on the HOPE console's API keys screen.`,
      schema: POSTMAN_SCHEMA_URL,
    },
    variable: [
      { key: 'baseUrl', value: baseUrl, type: 'string' },
      // Never populated by the console — the importer supplies their own.
      { key: 'apiKey', value: '', type: 'string' },
    ],
    auth: apiKeyAuth(),
    item: [
      {
        name: kind === 'agent' ? `Invoke ${slug}` : `Start a run of ${slug}`,
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: `{{baseUrl}}/${path.join('/')}`, host: ['{{baseUrl}}'], path },
          body: {
            mode: 'raw',
            // The agent plane takes its input FLAT; the workflow plane wraps it in `{ input }`.
            raw: JSON.stringify(kind === 'agent' ? (exampleBody ?? { text: '…' }) : { input: exampleBody ?? {} }, null, 2),
            options: { raw: { language: 'json' } },
          },
        },
      },
    ],
  };
}
