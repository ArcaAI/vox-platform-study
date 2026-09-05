import { describe, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

describe('registry size probe', () => {
  it('logs the size', () => {
    const all = HOPE_SETTINGS_REGISTRY.list();
    // eslint-disable-next-line no-console
    console.log('REGISTRY_SIZE=' + HOPE_SETTINGS_REGISTRY.size);
    // eslint-disable-next-line no-console
    console.log('TENANT_SCOPED=' + all.filter((d) => d.maxScope !== 'system' && !d.globalOnly).length);
  });
});
