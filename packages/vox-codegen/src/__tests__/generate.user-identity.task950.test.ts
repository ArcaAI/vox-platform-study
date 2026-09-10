/**
 * TASK-950 lane F — the `@identity` JSDoc annotation `generate.ts` emits on
 * a `STRUCTURED` kind's marked `userIdentity` property.
 *
 * Mirrors `generate.test.ts`'s fixture shape (see
 * `fixtures/schema-bundle.fixture.ts`) but builds its own minimal bundles
 * inline, since the marker is this ticket's concern alone and the shared
 * fixture is not.
 */

import { describe, expect, it } from 'vitest';
import { generateConsultationSchemaTypes } from '../generate';
import type { ConsultationSchemaBundle, ContextKindDeclaration } from '../types';
import { FIXTURE_SCHEMA_BUNDLE } from './fixtures/schema-bundle.fixture';
import { formatDiagnostics, typeCheckSource } from './support/typecheck';

const GENERATED_AT = new Date('2026-09-11T00:00:00.000Z');

/** A `STRUCTURED`, `cardinality: 'ONE'` kind with a string property that a marker can name. */
const BASE_KIND: ContextKindDeclaration = {
  key: 'context',
  label: 'Context',
  primitive: 'STRUCTURED',
  cardinality: 'ONE',
  fields: {
    type: 'object',
    properties: {
      consultant_id: { type: 'string' },
      visit_type: { type: 'string' },
    },
    required: ['consultant_id'],
  },
};

function bundleWith(kind: ContextKindDeclaration): ConsultationSchemaBundle {
  return {
    schemaId: 'schema-1',
    slug: 'default',
    name: 'Default Schema',
    versionNumber: 1,
    contextSchemaVersionId: 'version-1',
    checksum: 'abc123',
    etag: '"1"',
    definition: {
      schemaVersion: '1.0',
      kinds: [kind],
    },
  };
}

function generate(kind: ContextKindDeclaration) {
  return generateConsultationSchemaTypes(bundleWith(kind), { tenantId: 'tenant-1', generatedAt: GENERATED_AT });
}

describe('generateConsultationSchemaTypes — @identity annotation (TASK-950)', () => {
  it('emits an @identity JSDoc directly on the marked property, and nowhere else', () => {
    const { contents } = generate({ ...BASE_KIND, userIdentity: { field: 'consultant_id' } });

    expect(contents).toMatch(/\/\*\* @identity[^*]*\*\/ consultant_id: string;/);
    expect(contents).toContain('TASK-950');
    // The unmarked sibling property carries no annotation.
    expect(contents).not.toMatch(/@identity[^*]*\*\/ visit_type/);

    const diagnostics = typeCheckSource(contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('produces byte-identical output to an equivalent run when no kind declares userIdentity', () => {
    const first = generate(BASE_KIND);
    const second = generate({ ...BASE_KIND });

    expect(first.contents).toBe(second.contents);
    expect(first.contents).not.toContain('@identity');
  });

  it('leaves the shared fixture (no kind marked) byte-identical to today\'s expectation', () => {
    // FIXTURE_SCHEMA_BUNDLE (generate.test.ts's own fixture) declares no
    // `userIdentity` anywhere — the annotation machinery must be a no-op on
    // it, exactly as it was before this ticket.
    const withAnnotationsWired = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, {
      tenantId: 'tenant-1',
      generatedAt: GENERATED_AT,
    });
    const reference = generateConsultationSchemaTypes(FIXTURE_SCHEMA_BUNDLE, { tenantId: 'tenant-1', generatedAt: GENERATED_AT });

    expect(withAnnotationsWired.contents).toBe(reference.contents);
    expect(withAnnotationsWired.contents).not.toContain('@identity');
  });

  it('a marker naming a property absent from `fields` does not throw, adds no annotation, and leaves output byte-identical to the unmarked run', () => {
    const unmarked = generate(BASE_KIND);

    let dangling!: ReturnType<typeof generate>;
    expect(() => {
      dangling = generate({ ...BASE_KIND, userIdentity: { field: 'does_not_exist' } });
    }).not.toThrow();

    expect(dangling.contents).not.toContain('@identity');
    expect(dangling.contents).toBe(unmarked.contents);
  });
});
