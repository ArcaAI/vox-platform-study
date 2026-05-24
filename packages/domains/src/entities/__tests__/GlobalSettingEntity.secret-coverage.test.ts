/**
 * Phase 0 Item 4 R4 mitigation (TASK-302 Stream A) — coverage pin.
 *
 * Every GlobalSettingEntity field is either marked @Secret or sits in
 * the explicit non-secret allowlist below. Adding a new entity field
 * without one of these two annotations triggers a test failure that
 * forces the author to consciously classify it.
 */
import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { getSecretFields } from '../../common';
import { GlobalSettingEntity } from '../generated/core/GlobalSettingEntity';

const NON_SECRET_ALLOWLIST = new Set([
  'id',
  'key',
  'name',
  'tenantId',
  'Tenant',
  'locked',
  'dataType',
  'namespace',
  'description',
  'resourceStatus',
  'version',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'createdBy',
  'updatedBy',
  'tags',
  'Tags',
  'parsedValue',
  // TASK-302 Phase 4 — Transit key version is forward-compat metadata
  // (which Transit key produced encryptedValue). It is NOT a secret on
  // its own — just an integer telling the decrypt path which key to use.
  'keyVersion',
  'changes',
  'hasChanges',
  'enable',
  'disable',
  'archive',
  'delete',
  'restore',
  'isDeleted',
  'isArchived',
  'isEnabled',
  'isDisabled',
  'toObject',
  'toJSON',
  'validate',
  'setProperty',
  'addProperty',
  'updateProperty',
  'assertValueParseable',
]);

describe('GlobalSettingEntity @Secret coverage (Phase 0 Item 4 / R4)', () => {
  it('value and defaultValue are marked @Secret', () => {
    const fields = new Set(getSecretFields(GlobalSettingEntity.prototype));
    expect(fields).toContain('value');
    expect(fields).toContain('defaultValue');
  });

  it('every entity field is either @Secret or explicitly non-secret', () => {
    const proto = GlobalSettingEntity.prototype;
    const props = Object.getOwnPropertyNames(proto).filter(
      (p) => p !== 'constructor' && !p.startsWith('_'),
    );
    const secrets = new Set(getSecretFields(proto));
    const uncovered = props.filter((p) => !secrets.has(p) && !NON_SECRET_ALLOWLIST.has(p));
    expect(
      uncovered,
      `Add to NON_SECRET_ALLOWLIST or annotate @Secret: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });
});
