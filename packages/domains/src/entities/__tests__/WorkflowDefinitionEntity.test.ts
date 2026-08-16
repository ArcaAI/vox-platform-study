/**
 * WorkflowDefinitionEntity.validate() Unit Tests
 *
 * Invariants under test (derived from `workflow-definition.prisma` + the
 * TASK-722 exposure plane's slug contract):
 *   - slug: required, `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`
 *   - name, paletteKey, graphChecksum: required non-empty
 *   - versionNumber: positive integer
 *   - graph: a JSON object (not an array, not null)
 *   - status: required
 *   - PUBLISHED rows must carry a compiledConfig
 */

import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionEntity, IWorkflowDefinitionEntity } from '../generated/core/WorkflowDefinitionEntity';
import { ResourceStatusType, WorkflowDefinitionStatus } from '../../enums';

function createValidInit(overrides: Partial<IWorkflowDefinitionEntity> = {}): IWorkflowDefinitionEntity {
  return {
    id: 'wfd-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    slug: 'intake-summary',
    name: 'Intake Summary',
    description: null,
    paletteKey: 'summarization',
    versionNumber: 1,
    parentVersionId: null,
    status: WorkflowDefinitionStatus.DRAFT,
    graph: { nodes: [] },
    graphChecksum: 'sha256:abc',
    compiledConfig: null,
    compiledConfigChecksum: null,
    registryChecksum: null,
    validationReport: null,
    needsReview: false,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    isActive: false,
    tags: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    ...overrides,
  } as IWorkflowDefinitionEntity;
}

describe('WorkflowDefinitionEntity.validate()', () => {
  it('does not throw for a fully valid DRAFT entity', () => {
    const entity = new WorkflowDefinitionEntity(createValidInit());
    expect(() => entity.validate()).not.toThrow();
  });

  it('does not throw for a valid PUBLISHED entity carrying a compiledConfig', () => {
    const entity = new WorkflowDefinitionEntity(
      createValidInit({
        status: WorkflowDefinitionStatus.PUBLISHED,
        compiledConfig: { nodes: [] },
        compiledConfigChecksum: 'sha256:def',
        isActive: true,
        publishedAt: new Date('2026-01-02'),
      }),
    );
    expect(() => entity.validate()).not.toThrow();
  });

  it.each([
    ['ab', false], // too short (< 3 chars)
    ['-abc', false], // starts with hyphen
    ['abc-', false], // ends with hyphen
    ['Abc-Def', false], // uppercase not allowed
    ['abc_def', false], // underscore not allowed
    ['abc', true],
    ['intake-summary-v2', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false], // too long
  ])('slug %s validity is %s', (slug, valid) => {
    const entity = new WorkflowDefinitionEntity(createValidInit({ slug }));
    if (valid) {
      expect(() => entity.validate()).not.toThrow();
    } else {
      expect(() => entity.validate()).toThrow();
    }
  });

  it('throws when name is empty', () => {
    const entity = new WorkflowDefinitionEntity(createValidInit({ name: '   ' }));
    expect(() => entity.validate()).toThrow('name is required');
  });

  it('throws when paletteKey is empty', () => {
    const entity = new WorkflowDefinitionEntity(createValidInit({ paletteKey: '' }));
    expect(() => entity.validate()).toThrow('paletteKey is required');
  });

  it('throws when versionNumber is not a positive integer', () => {
    const entity = new WorkflowDefinitionEntity(createValidInit({ versionNumber: 0 }));
    expect(() => entity.validate()).toThrow('versionNumber must be a positive integer');
  });

  it('throws when graph is not a JSON object', () => {
    const entity = new WorkflowDefinitionEntity(createValidInit({ graph: [] as unknown as IWorkflowDefinitionEntity['graph'] }));
    expect(() => entity.validate()).toThrow('graph must be a JSON object');
  });

  it('throws when graphChecksum is empty', () => {
    const entity = new WorkflowDefinitionEntity(createValidInit({ graphChecksum: '' }));
    expect(() => entity.validate()).toThrow('graphChecksum is required');
  });

  it('throws when a PUBLISHED row carries no compiledConfig', () => {
    const entity = new WorkflowDefinitionEntity(
      createValidInit({ status: WorkflowDefinitionStatus.PUBLISHED, compiledConfig: null }),
    );
    expect(() => entity.validate()).toThrow('PUBLISHED WorkflowDefinition must carry a compiledConfig');
  });
});
