/**
 * TASK-635 Lane B — `smr.test` routing-tier registration.
 *
 * Verifies the two additive registration points the prompt-template test
 * bench depends on outside the service itself: the AiTaskDefault task key +
 * its model-task-type mapping (+ tenant-write eligibility), and the
 * `models.smr.test` settings-registry descriptor.
 *
 * `HarnessPolicyService.resolveSmrSelection(tenantId, 'test')` itself (the
 * one line added to `harness-policy.service.ts`) is exercised end-to-end via
 * `PromptManagementService.testPromptTemplate`'s smr.test → smr.finalize
 * cascade tests in `prompt-management.service.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { ModelTaskType } from '@arcaai/domains';
import { AI_TASK_KEYS, AI_TASK_MODEL_TASK_TYPES, isGlobalAdminOnlyTaskKey } from '../../ai-task-default/constants';
import { MODEL_DEFAULT_SETTINGS } from '../../settings-registry/descriptors/model-defaults.descriptors';

describe('smr.test routing tier (TASK-635 Lane B)', () => {
  it('registers smr.test as an AiTaskDefault task key mapped to TEXT_GENERATION', () => {
    expect(AI_TASK_KEYS).toContain('smr.test');
    expect(AI_TASK_MODEL_TASK_TYPES['smr.test']).toBe(ModelTaskType.TEXT_GENERATION);
  });

  it('keeps smr.test tenant-writable (NOT under GLOBAL_ADMIN_ONLY_TASK_PREFIXES)', () => {
    expect(isGlobalAdminOnlyTaskKey('smr.test')).toBe(false);
  });

  it('registers the models.smr.test descriptor as tenant-editable db-config, fail-closed', () => {
    const descriptor = MODEL_DEFAULT_SETTINGS.find((d) => d.key === 'models.smr.test');
    expect(descriptor).toBeDefined();
    expect(descriptor).toMatchObject({
      tier: 'db-config',
      dataType: 'string',
      sensitivity: 'internal',
      maxScope: 'tenant',
      editableBy: 'AiTaskDefault',
      failMode: 'closed',
      category: 'Models',
    });
    expect(descriptor?.globalOnly).toBeUndefined();
  });
});
