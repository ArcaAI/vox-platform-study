/**
 * Drift gate for the provider-connection capability list.
 *
 * The console cannot import `@arcaai/applications` (BFF boundary), so its copy
 * of `ProviderService` has to live in the app. The failure that produced this
 * test is what happens NEXT: P1-C.1 widened the gateway's `service` union from
 * three values to six, and the console's two hand-typed copies stayed at three
 * — so `embeddings`, `rerank` and `vector` had a working API and no button for
 * an entire phase, with nothing anywhere to say so.
 *
 * This asserts the console's list against the gateway's OWN declaration: the
 * `:service` path-parameter enum in the committed admin OpenAPI projection.
 * The assertion is deliberately two-directional and order-sensitive — a
 * SUPERSET is just as wrong as a subset (it would render a tab whose route
 * 400s), and the order is the one an admin reads left-to-right in the tab bar.
 *
 * When this fails after a gateway change, the fix is to update
 * `../services.ts` to match the snapshot — never to relax the assertion.
 */

import { describe, expect, it } from 'vitest';
import adminSpec from '@/server/api-docs/openapi.admin.json';
import { PROVIDER_SERVICES, isProviderService } from '../services';

const SERVICE_ROUTE = '/api/v1/admin/providers/{service}';

interface OpenApiParameter {
  name: string;
  in: string;
  schema?: { enum?: string[] };
}

interface OpenApiSpec {
  paths: Record<string, Record<string, { parameters?: OpenApiParameter[] }>>;
}

/** The `:service` enum exactly as the gateway declares it. */
function gatewayServiceEnum(): string[] {
  const spec = adminSpec as unknown as OpenApiSpec;
  const operation = spec.paths[SERVICE_ROUTE]?.get;
  // A missing route is itself drift worth failing on: it means the connection
  // plane moved and this gate is now watching nothing.
  expect(operation, `${SERVICE_ROUTE} is absent from the admin OpenAPI projection`).toBeDefined();

  const parameter = operation?.parameters?.find((p) => p.name === 'service' && p.in === 'path');
  expect(parameter?.schema?.enum, '`service` path parameter declares no enum').toBeDefined();
  return parameter!.schema!.enum!;
}

describe('PROVIDER_SERVICES is derived from the gateway contract', () => {
  it('matches the `:service` enum in the committed admin OpenAPI projection, exactly and in order', () => {
    expect([...PROVIDER_SERVICES]).toEqual(gatewayServiceEnum());
  });

  it('covers the capabilities  P1-C.1 added, not just the original three', () => {
    // Named explicitly so a regression to {llm,stt,tts} reads as the specific
    // bug it is, rather than as an opaque array mismatch.
    expect(PROVIDER_SERVICES).toContain('embeddings');
    expect(PROVIDER_SERVICES).toContain('rerank');
    expect(PROVIDER_SERVICES).toContain('vector');
  });

  it('does not claim `nlp` as a connection capability (owner decision D-4: platform-shared, no tenant BYO)', () => {
    expect(PROVIDER_SERVICES).not.toContain('nlp');
  });

  it('narrows an untrusted string', () => {
    expect(isProviderService('vector')).toBe(true);
    expect(isProviderService('nlp')).toBe(false);
    expect(isProviderService('')).toBe(false);
  });
});
