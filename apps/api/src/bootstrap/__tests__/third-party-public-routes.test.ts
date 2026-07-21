/**
 * Verifies the side-effect module applies `SKIP_AUTH_KEY=true` to
 * third-party controllers we don't own.
 *
 * Each route here is legitimately public: there's no scenario in which
 * it should require an authenticated caller. The test pins the metadata
 * so the boot-time route audit and the runtime guard keep agreeing.
 */

import { describe, it, expect } from 'vitest';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { SKIP_AUTH_KEY } from '@arcaai/applications';

import '../third-party-public-routes';

describe('TASK-307 W4a.3 — third-party-public-routes side-effect module', () => {
  it('marks PrometheusController.index as @Public() (SKIP_AUTH_KEY=true)', () => {
    const value = Reflect.getMetadata(SKIP_AUTH_KEY, PrometheusController.prototype.index);
    expect(value).toBe(true);
  });
});
