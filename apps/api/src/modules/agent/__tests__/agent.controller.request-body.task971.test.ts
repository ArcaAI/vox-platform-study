import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * TASK-971 lane F (finding F-F1) — the three agent invoke routes must carry a
 * request body in the published reference.
 *
 * They are the exact routes the console's Integration panel points a developer
 * at, and `openapi.json` documented NO body for any of them: their bodies are
 * declared as plain TypeScript interfaces (`AgentInvocationBody`,
 * `AgentSpeechBody`; `AgentTranscriptionBody` until TASK-1004), deliberately NOT class-validator
 * DTOs, so the global pipe passes the body through and TIER 3 validation runs
 * against the AGENT's own `inputSchema`. The Nest Swagger plugin only emits a
 * body from a DTO class, so it emitted nothing.
 *
 * The fix is documentation-only: `@ApiBody({ schema })`. Converting the
 * interfaces to DTO classes would re-enable `forbidNonWhitelisted` on a body
 * that is meant to be open-ended and would break every agent whose own
 * `inputSchema` declares fields the gateway has never heard of.
 *
 * The `$ref` assertions below are what pins that: a DTO class emits
 * `schema: { $ref: '#/components/schemas/...' }`, an `@ApiBody({ schema })`
 * emits the object inline. If someone "tidies" these into DTOs, this suite goes
 * red for the right reason.
 */

const OPENAPI_PATH = resolve(__dirname, '..', '..', '..', '..', 'openapi.json');

interface MediaTypeObject {
  schema?: Record<string, unknown>;
}
interface RequestBodyObject {
  required?: boolean;
  description?: string;
  content?: Record<string, MediaTypeObject>;
}

const document = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
  paths: Record<string, Record<string, { requestBody?: RequestBodyObject }>>;
};

function bodyOf(path: string): RequestBodyObject {
  const operation = document.paths[path]?.post;
  expect(operation, `POST ${path} is missing from openapi.json`).toBeDefined();
  const body = operation?.requestBody;
  expect(body, `POST ${path} publishes no requestBody`).toBeDefined();
  return body as RequestBodyObject;
}

function jsonSchemaOf(path: string): Record<string, unknown> {
  const body = bodyOf(path);
  const schema = body.content?.['application/json']?.schema;
  expect(schema, `POST ${path} publishes no application/json schema`).toBeDefined();
  return schema as Record<string, unknown>;
}

describe('openapi.json — POST /agents/{slug}/invocations', () => {
  const path = '/api/v1/agents/{slug}/invocations';

  it('publishes a required request body', () => {
    expect(bodyOf(path).required).toBe(true);
  });

  it('publishes the body INLINE, not as a $ref to a DTO (the pass-through is deliberate)', () => {
    const schema = jsonSchemaOf(path);
    expect(schema.$ref).toBeUndefined();
    expect(schema.type).toBe('object');
  });

  it('documents the flat text / variables / context shape', () => {
    const properties = jsonSchemaOf(path).properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['text', 'variables', 'context']));
  });

  it('stays open-ended, because the agent inputSchema may declare its own fields', () => {
    expect(jsonSchemaOf(path).additionalProperties).not.toBe(false);
  });

  it('names the agent inputSchema as the real authority', () => {
    const body = bodyOf(path);
    const prose = `${body.description ?? ''} ${JSON.stringify(jsonSchemaOf(path))}`;
    expect(prose).toMatch(/inputSchema/);
  });
});

describe('openapi.json — POST /agents/{slug}/speech', () => {
  const path = '/api/v1/agents/{slug}/speech';

  it('publishes a required request body, inline', () => {
    expect(bodyOf(path).required).toBe(true);
    expect(jsonSchemaOf(path).$ref).toBeUndefined();
  });

  // TASK-1036 §3.2 (lane B2) — the speech body gained `delivery: 'stream' | 'blob'` (OD-6: the
  // wire carries `delivery` alongside the content), so the documented properties are three.
  it('documents text and ssml (and the TASK-1036 delivery mode)', () => {
    const properties = jsonSchemaOf(path).properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['delivery', 'ssml', 'text']);
  });

  it('says exactly one of the two is required', () => {
    const body = bodyOf(path);
    const prose = `${body.description ?? ''} ${JSON.stringify(jsonSchemaOf(path))}`;
    expect(prose).toMatch(/[Ee]xactly one/);
  });
});

// TASK-1004 — AMENDED: the transcription body is now a DTO (`AgentTranscriptionRequest`), because
// unlike `invocations`/`speech` its shape is the GATEWAY's (media, consultation, spoken language),
// not the agent's own `inputSchema` — so `forbidNonWhitelisted` is exactly right for it, and the
// pass-through argument above does not apply. It therefore publishes a `$ref`, not an inline schema.
// Green once `openapi.json` is regenerated (`pnpm api:openapi`) with the TASK-1004 routes.
describe('openapi.json — POST /agents/{slug}/transcriptions', () => {
  const path = '/api/v1/agents/{slug}/transcriptions';
  const componentOf = (ref: unknown): Record<string, unknown> => {
    const name = String(ref).replace('#/components/schemas/', '');
    const schemas = (document as unknown as { components: { schemas: Record<string, Record<string, unknown>> } }).components.schemas;
    expect(schemas[name], `component ${name} is missing`).toBeDefined();
    return schemas[name];
  };

  it('publishes a required request body, as the AgentTranscriptionRequest DTO', () => {
    expect(bodyOf(path).required).toBe(true);
    expect(jsonSchemaOf(path).$ref).toBe('#/components/schemas/AgentTranscriptionRequest');
  });

  it('documents mediaId, consultationId, language and languageMode', () => {
    const properties = componentOf(jsonSchemaOf(path).$ref).properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['consultationId', 'language', 'languageMode', 'mediaId']);
  });

  it('marks mediaId as the only required field', () => {
    expect(componentOf(jsonSchemaOf(path).$ref).required).toEqual(['mediaId']);
  });
});
