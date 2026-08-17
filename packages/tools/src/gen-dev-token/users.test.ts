import { describe, expect, it } from 'vitest';

import { DEV_USERS, getDefaultUser } from './users';

describe('gen-dev-token users', () => {
  it('mints SUPER_ADMIN on the default super_admin user, not GLOBAL_ADMIN', () => {
    const user = getDefaultUser();
    expect(user.username).toBe('super_admin');
    expect(user.roles).toContain('SUPER_ADMIN');
    expect(user.roles).not.toContain('GLOBAL_ADMIN');
  });

  it('does not mint GLOBAL_ADMIN on any DEV_USERS role list', () => {
    for (const user of DEV_USERS) {
      expect(user.roles, user.username).not.toContain('GLOBAL_ADMIN');
    }
  });
});
