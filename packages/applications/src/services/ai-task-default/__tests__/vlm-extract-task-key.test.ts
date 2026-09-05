/**
 * `vlm.extract` task key (TDD, written before the constant is added).
 *
 * Verifies: the key exists in `AI_TASK_KEYS`, maps to `IMAGE_TEXT_TO_TEXT`
 * (the multimodal task type — see `enums.prisma`), and is tenant-admin
 * configurable (NOT under `SUPER_ADMIN_ONLY_TASK_PREFIXES`) — it lives in
 * TEXT's own adapter framework like `text.*`, not the platform-only
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

  // TASK-872 removed the `models.*` descriptor(s) for this key: no request
  // path resolves it, so cataloguing it offered a SELECTION control with
  // nothing on the other end. The task key itself is unchanged — it stays
  // `AiRoutingPolicy` vocabulary with its own admin route and seed posture —
  // so the assertion flips to the descriptor's ABSENCE.
  // The seed's own exemption reads: "no deployable vision model is loaded on
  // the LM Studio instance; a SYSTEM default would replace a clean 503 with an
  // upstream 404."
  it('registers NO models.vlm.extract descriptor — no vision model is deployed', () => {
    expect(HOPE_SETTINGS_REGISTRY.has('models.vlm.extract')).toBe(false);
  });
});
