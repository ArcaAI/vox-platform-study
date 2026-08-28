/**
 * The servability read, in one pure function.
 *
 * `resolveForGeneration` FAILS OPEN to a platform SOAP shape, so "this tenant
 * has no document template" is an ordinary state, never an error. The cost of
 * failing open is that every way of NOT being served looks identical from the
 * catalog — a published template that is still DRAFT, a default that was never
 * published, a catalog with no default at all — and in each case the admin
 * sees SOAP come out of a workflow they believe they configured.
 *
 * These cases mirror `isServable` + `findDefaultForTenant`
 * (`document-template.service.ts`) exactly. If that predicate changes, this
 * test is where the console finds out.
 */

import { describe, expect, it } from 'vitest';
import { effectiveTemplate } from '../effective-template';
import type { DocumentTemplate } from '../../api/types';

function template(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: 't-1',
    tenantId: 'tnt-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    status: 'PUBLISHED',
    pinnedVersionNumber: 3,
    isDefault: true,
    sourceTemplateSlug: null,
    templateLocked: false,
    version: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('effectiveTemplate', () => {
  it('reports the platform fallback when the tenant has no templates at all', () => {
    const result = effectiveTemplate([]);
    expect(result.kind).toBe('PLATFORM_FALLBACK');
    expect(result.reason).toBe('NO_TEMPLATES');
    expect(result.template).toBeNull();
  });

  it('reports the platform fallback when no template is marked default (resolution is by isDefault ONLY)', () => {
    const result = effectiveTemplate([template({ isDefault: false })]);
    expect(result.kind).toBe('PLATFORM_FALLBACK');
    expect(result.reason).toBe('NO_DEFAULT');
  });

  it('reports the platform fallback when the default template was never published (no pin)', () => {
    const result = effectiveTemplate([template({ pinnedVersionNumber: null, status: 'DRAFT' })]);
    expect(result.kind).toBe('PLATFORM_FALLBACK');
    expect(result.reason).toBe('NEVER_PUBLISHED');
    expect(result.template?.id).toBe('t-1');
  });

  it('reports the platform fallback when the default template is PINNED but still DRAFT — the silent governance trap', () => {
    const result = effectiveTemplate([template({ status: 'DRAFT', pinnedVersionNumber: 3 })]);
    expect(result.kind).toBe('PLATFORM_FALLBACK');
    expect(result.reason).toBe('NOT_SERVABLE_STATUS');
    expect(result.template?.id).toBe('t-1');
  });

  it('serves a PUBLISHED default that carries a pin', () => {
    const result = effectiveTemplate([template()]);
    expect(result.kind).toBe('SERVING');
    expect(result.template?.id).toBe('t-1');
    expect(result.versionNumber).toBe(3);
  });

  it('serves an APPROVED default that carries a pin', () => {
    const result = effectiveTemplate([template({ status: 'APPROVED', pinnedVersionNumber: 7 })]);
    expect(result.kind).toBe('SERVING');
    expect(result.versionNumber).toBe(7);
  });

  it('ignores non-default templates entirely, however servable they look', () => {
    const result = effectiveTemplate([
      template({ id: 't-other', slug: 'referral', isDefault: false, status: 'APPROVED', pinnedVersionNumber: 9 }),
      template({ id: 't-default', status: 'DRAFT', pinnedVersionNumber: 1 }),
    ]);
    expect(result.kind).toBe('PLATFORM_FALLBACK');
    expect(result.template?.id).toBe('t-default');
  });
});
