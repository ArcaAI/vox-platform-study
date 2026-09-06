/**
 * AiModelEntityMapper — `_version` is database-owned (TASK-860, rule 03).
 *
 * The mapper used to lack the `FIELDS_NOT_WRITABLE = ['version']` strip every
 * other OCC-written model carries, so an entity's `version` could leak into a
 * Prisma write. Pinned here the same way `AiTaskDefaultEntityMapper` is.
 */
import { describe, expect, it } from 'vitest';
import { AiModelEntityMapper } from '../generated/core/AiModelEntityMapper';
import { AiModelEntity } from '../../entities';
import {
  AiDeploymentKind,
  AiModelAvailability,
  AiModelFormat,
  AiModelSource,
  ModelCategory,
  ModelTaskType,
  ModelType,
  ResourceStatusType,
} from '../../enums';

function entity(): AiModelEntity {
  return new AiModelEntity({
    id: '80000000-0000-0000-0007-000000000010',
    tenantId: '00000000-0000-0000-0000-000000000000',
    name: 'Medical NER',
    slug: 'medical-ner',
    description: null,
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'blaze999/Medical-NER',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'transformers',
    servedBy: 'nlp',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    gated: false,
    languages: ['en'],
    availability: AiModelAvailability.UNKNOWN,
    isPlatformDefaultFor: [],
    resourceStatus: ResourceStatusType.ENABLED,
    version: 7,
    tags: [],
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('AiModelEntityMapper — version strip', () => {
  const mapper = AiModelEntityMapper.getInstance();

  it('toPersistence never carries `version` (the DB owns `_version`)', () => {
    const persisted = mapper.toPersistence(entity()) as unknown as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('version');
    // Everything else round-trips.
    expect(persisted.libraryName).toBe('transformers');
    expect(persisted.servedBy).toBe('nlp');
    expect(persisted.languages).toEqual(['en']);
  });

  it('toPersistenceChanges never carries `version` even after a tracked change', () => {
    const e = entity();
    e.name = 'Medical NER v2';
    const changes = mapper.toPersistenceChanges(e) as unknown as Record<string, unknown>;
    expect(changes).toHaveProperty('name', 'Medical NER v2');
    expect(changes).not.toHaveProperty('version');
  });

  it('toDomainEntity maps the registry columns back onto the entity', () => {
    const row = { ...mapper.toPersistence(entity()), version: 7, bucketPrefix: 'medical-ner/abc/', availability: AiModelAvailability.AVAILABLE };
    const e = mapper.toDomainEntity(row as never);
    expect(e.bucketPrefix).toBe('medical-ner/abc/');
    expect(e.availability).toBe(AiModelAvailability.AVAILABLE);
    expect(e.version).toBe(7);
  });
});
