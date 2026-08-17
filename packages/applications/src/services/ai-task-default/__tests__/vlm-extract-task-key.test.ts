/**
 * `vlm.extract` task key (TDD, written before the constant is added).
 *
 * Verifies: the key exists in `AI_TASK_KEYS`, maps to `IMAGE_TEXT_TO_TEXT`
 * (the multimodal task type — see `enums.prisma`), and is tenant-admin
 * configurable (NOT under `SUPER_ADMIN_ONLY_TASK_PREFIXES`) — it lives in
 * SMR's own adapter framework like `smr.*`, not the platform-only
 * `guardrail./nlp./harness.` safety surfaces.
 */
import { ModelTaskType } from '@arcaai/domains';
import { describe, expect, it } from 'vitest';

import { AI_TASK_KEYS, AI_TASK_MODEL_TASK_TYPES, isSuperAdminOnlyTaskKey } from '../constants';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';

describe('vlm.extract task key', () => {
  it('is registered in AI_TASK_KEYS', () => {
    expect(AI_TASK_KEYS).toContain('vlm.extract');
  });

  it('maps to ModelTaskType.IMAGE_TEXT_TO_TEXT', () => {
    expect(AI_TASK_MODEL_TASK_TYPES['vlm.extract']).toBe(ModelTaskType.IMAGE_TEXT_TO_TEXT);
  });

  it('is tenant-admin configurable, not super-admin-only', () => {
    expect(isSuperAdminOnlyTaskKey('vlm.extract')).toBe(false);
  });

  it('registers a models.vlm.extract settings descriptor, db-config, fail-closed, tenant-editable', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow('models.vlm.extract');
    expect(d.tier).toBe('db-config');
    expect(d.dataType).toBe('string');
    expect(d.maxScope).toBe('tenant');
    expect(d.failMode).toBe('closed');
    expect(d.editableBy).toBe('AiTaskDefault');
    expect(d.globalOnly).toBeUndefined();
  });
});
