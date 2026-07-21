/**
 * ModelRegistry STT task persistence.
 *
 * The user's chosen Whisper task (transcribe|translate) persists alongside the
 * selected model in the SAME tenant/user-namespaced localStorage row
 * (`arcaai-selected-models/${tenantId}::${userId}`), per rule 08. It must:
 *   - round-trip across a fresh registry under the same namespace, and
 *   - NOT leak across a different tenant/user namespace.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRegistry } from '../ModelRegistry';

const apiClient = {} as never;

describe('TASK-329 P3 — ModelRegistry STT task persistence (namespaced)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists model + sttTask under the active namespace and reloads them', () => {
    const registry = new ModelRegistry({}, apiClient, undefined, () => 'tenantA::userA');
    registry.selectModel('stt', 'whisper-small');
    registry.selectSttTask('translate');

    const reloaded = new ModelRegistry({}, apiClient, undefined, () => 'tenantA::userA');
    expect(reloaded.getSelectedModelId('stt')).toBe('whisper-small');
    expect(reloaded.getSttTask()).toBe('translate');
    expect(reloaded.getSelected().sttTask).toBe('translate');
  });

  it('does not leak the task to a different tenant/user namespace', () => {
    const a = new ModelRegistry({}, apiClient, undefined, () => 'tenantA::userA');
    a.selectSttTask('translate');

    const b = new ModelRegistry({}, apiClient, undefined, () => 'tenantB::userB');
    expect(b.getSttTask()).toBeUndefined();
  });

  it('returns undefined when no task has been persisted', () => {
    const registry = new ModelRegistry({}, apiClient, undefined, () => 'tenantA::userA');
    expect(registry.getSttTask()).toBeUndefined();
  });
});
