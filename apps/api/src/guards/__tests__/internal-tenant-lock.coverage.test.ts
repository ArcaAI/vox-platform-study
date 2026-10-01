import { describe, expect, it } from 'vitest';
import { HarnessInternalController } from '../../modules/consultation/harness-internal.controller';
import { SttInternalController } from '../../modules/internal/stt-internal.controller';
import { InternalTenantLockGuard } from '../internal-tenant-lock.guard';

const guardsOf = (controller: object): unknown[] => Reflect.getMetadata('__guards__', controller) ?? [];

describe('internal controllers that write tenant data carry the restore lock', () => {
  it.each([
    ['HarnessInternalController', HarnessInternalController],
    ['SttInternalController', SttInternalController],
  ])('%s', (_name, controller) => {
    expect(guardsOf(controller)).toContain(InternalTenantLockGuard);
  });
});
