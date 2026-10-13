// The NLP worker recycle descriptors describe what the worker actually does: the
// request-count recycle applies only with several workers, and the RSS ceiling is
// clamped under the container memory limit.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

describe('NLP worker recycle descriptors', () => {
  it('recycleAfterRequests says a single-process worker never recycles on a count', () => {
    const text = HOPE_SETTINGS_REGISTRY.getOrThrow('nlp.worker.recycleAfterRequests').description;
    expect(text).toMatch(/several .*workers/i);
    expect(text).toMatch(/single/i);
  });

  it('recycleRssMib says it is clamped to 90 % of the container memory limit', () => {
    const text = HOPE_SETTINGS_REGISTRY.getOrThrow('nlp.worker.recycleRssMib').description;
    expect(text).toMatch(/90 ?%/);
    expect(text).toMatch(/memory limit/i);
  });
});
